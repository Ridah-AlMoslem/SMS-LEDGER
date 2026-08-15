"""Ingest and parsing service.

Two responsibilities, deliberately separated (SPEC §10.2, §10.3):

  POST /api/ingest      Verify HMAC, dedup, store raw, return 202. No parsing.
  POST /api/parse-tick  Drain pending messages through the parser. Driven by
                        pg_cron, which doubles as the Supabase keep-alive.

Parsing never happens inside the ingest request. The Shortcut on the phone
gets an answer in under 100 ms, and the parser can be slow, retried, or
replayed across full history without the phone ever knowing.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

import db as store
from ledger.derive import DeriveError, derive
from ledger.normalize import shape_hash
from ledger.pipeline import body_hash, parse_message

# Single-user private service: no docs, no schema endpoint, nothing to enumerate.
app = FastAPI(title="sms-ledger", docs_url=None, redoc_url=None, openapi_url=None)

# .strip() on every one of these. A secret piped into `vercel env add` or typed
# into a dashboard field picks up a trailing newline with no visible trace, and
# the only symptom is a 401 that is indistinguishable from a wrong value — on a
# phone with no logs. Whitespace is never meaningful in a hex token, so there
# is nothing to lose by removing it and a long evening to gain.
INGEST_SECRET = os.environ.get("INGEST_SECRET", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()
# Shared with the web service so it can call the derive endpoint. Separate from
# CRON_SECRET on purpose: different caller, different blast radius.
INTERNAL_SECRET = os.environ.get("INTERNAL_SECRET", "").strip()
MAX_SKEW_SECONDS = 300

# Which account funds a card payment, and which holds cashback. Slugs, not
# UUIDs — the parser never sees a UUID (see accounts.slug in the schema).
FUNDING_ACCOUNT = os.environ.get("FUNDING_ACCOUNT_SLUG", "saib_current")
CASHBACK_ACCOUNT = os.environ.get("CASHBACK_ACCOUNT_SLUG", "cashback_wallet")


class IngestPayload(BaseModel):
    sender: str = Field(min_length=1, max_length=64)
    body: str = Field(min_length=1, max_length=4000)
    # Optional, and defaulted to arrival time when absent (§10.1). The phone
    # fires within a second of the SMS, so the two differ by less than the
    # minute that `body_hash` rounds to and by far less than anything the date
    # rules can see. Requiring it bought nothing and cost an entire Shortcuts
    # action, whose "Include Time" toggle was the single commonest 422.
    received_at: datetime | None = None
    device_id: str | None = None


class SignedEnvelope(BaseModel):
    """The phone's wire format: signature, timestamp and payload in one object.

    Exists for one reason, and it is a UI constraint rather than a protocol
    one. The Shortcuts JavaScript action returns exactly one text value, so
    delivering a signature, a timestamp and a body as three separate HTTP
    fields meant splitting that value and rebuilding it through seven more
    actions — `Split Text`, three `Get Item from List`, three `Set Variable`.
    Seven actions of plumbing, each a place to mis-tap, guarding nothing.

    Folding them into one object moves that work here, where it is three lines
    and cannot be mis-tapped.

    `payload` is deliberately a STRING, not a nested object. The signature has
    to cover the exact bytes the phone hashed, and a nested object would be
    re-serialized by two JSON encoders before it reached the HMAC — which is
    the canonicalization trap this design already removed once.
    """
    sig: str = Field(min_length=1, max_length=128)
    ts: str = Field(min_length=1, max_length=32)
    payload: str = Field(min_length=1, max_length=8000)


def verify_signature(raw_body: bytes, signature: str, timestamp: str) -> None:
    """Reject anything unsigned, mis-signed, or replayed (SPEC §10.1).

    A public unauthenticated ingest URL means anyone who guesses it can inject
    fabricated transactions into the ledger. This is not optional.

    `raw_body` is the exact bytes off the wire, never a re-serialization of the
    parsed model. Signing a re-serialization means the sender has to reproduce
    this server's JSON encoder byte for byte — field order, separator spacing,
    datetime format, unicode escaping — and every one of those is invisible
    from the phone, where the only symptom is a bare 401. It also makes adding
    a field to the model a silent breaking change for a client that cannot be
    redeployed alongside it.
    """
    if not INGEST_SECRET:
        raise HTTPException(500, "INGEST_SECRET is not configured")

    # Checked before the timestamp so that a request carrying no credentials
    # at all says so. Falling through to the timestamp check reported "bad
    # timestamp" for a missing Authorization header — a message that sends you
    # to look at clock skew when the real problem is a header you forgot. This
    # string is what the phone's notification will show, so it has to name the
    # actual fault.
    if not signature:
        raise HTTPException(401, "no bearer token and no signature")

    try:
        age = abs(time.time() - int(timestamp))
    except (TypeError, ValueError):
        raise HTTPException(401, "bad timestamp")
    if age > MAX_SKEW_SECONDS:
        raise HTTPException(401, "stale request")

    expected = hmac.new(INGEST_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature or ""):
        raise HTTPException(401, "bad signature")


def verify_token(authorization: str) -> bool:
    """Bearer auth. Returns True if a valid token was presented.

    The simple path, and the one the iPhone Shortcut uses. HMAC costs a
    third-party app, a hand-rolled SHA-256 and three extra actions on the
    phone; measured against the actual threat — someone guessing a URL — a
    256-bit token in a header over TLS closes it just as completely. Replay is
    already inert because ingest dedups on `body_hash`, and TLS supplies the
    integrity the signature would have.

    What is genuinely given up: the secret travels on every request instead of
    never leaving the device. That is the whole delta, and on a single-user
    ledger posting to its own domain it is a reasonable price for a shortcut
    that is one action long and cannot be mis-wired.

    The signed paths below are kept so that decision stays reversible from the
    phone alone, with no server change.
    """
    if not authorization.startswith("Bearer "):
        return False
    if not INGEST_SECRET:
        raise HTTPException(500, "INGEST_SECRET is not configured")
    if not hmac.compare_digest(authorization[7:].strip(), INGEST_SECRET):
        raise HTTPException(401, "bad token")
    return True


@app.post("/api/ingest", status_code=202)
async def ingest(
    request: Request,
    authorization: str = Header(default=""),
    x_signature: str = Header(default=""),
    x_timestamp: str = Header(default=""),
) -> dict:
    # Three accepted shapes. One rule holds across all of them: nothing is
    # parsed as a message until the caller has been authenticated.
    #
    #   bearer    Authorization: Bearer <INGEST_SECRET>  — the phone.
    #   envelope  {"sig","ts","payload"}                 — signed over payload.
    #   headers   X-Signature / X-Timestamp              — signed over the body.
    #
    # The signed forms remain because they are the upgrade path, and an
    # upgrade path that is not exercised is not a path. Both are covered by
    # tests/verify_endpoints.py and tests/verify_shortcut_signer.py.
    raw = await request.body()

    if verify_token(authorization):
        signed = raw
    else:
        try:
            envelope = SignedEnvelope.model_validate_json(raw)
        except ValidationError:
            envelope = None

        if envelope is not None:
            signed, signature, timestamp = (
                envelope.payload.encode(), envelope.sig, envelope.ts)
        else:
            signed, signature, timestamp = raw, x_signature, x_timestamp

        # Signature first, parsing second. An unsigned request should never
        # reach the message parser at all — that is unauthenticated
        # attacker-controlled input, and validating it before authenticating
        # it is backwards.
        verify_signature(signed, signature, timestamp)

    try:
        payload = IngestPayload.model_validate_json(signed)
    except ValidationError as exc:
        # 422 with the field errors, matching what FastAPI would have returned
        # if the model were still a route parameter. The phone needs to be able
        # to tell "you signed it wrong" (401) from "the body is malformed"
        # (422); collapsing both into one status is a debugging dead end.
        #
        # Without `include_input`, Pydantic echoes the offending value back —
        # which is the raw bytes, so the response is both unserializable and a
        # reflection of a bank SMS into an error body. Which field failed is
        # the whole diagnostic; the value is already on the phone.
        raise HTTPException(
            422, exc.errors(include_url=False, include_input=False,
                            include_context=False))

    # Riyadh, not UTC, when the phone leaves it out. The value is compared
    # against the wall-clock the bank printed and decides which salary cycle a
    # payday lands in, so a 00:30 transaction stored as UTC would read as the
    # previous day and therefore the previous cycle (§10.4.1). Saudi Arabia has
    # never observed daylight saving, so the offset is fixed.
    received = payload.received_at or datetime.now(timezone(timedelta(hours=3)))
    if received.tzinfo is None:
        received = received.replace(tzinfo=timezone.utc)

    digest = body_hash(payload.sender, payload.body, received)

    with store.connect() as conn:
        result = store.insert_raw_message(
            conn, payload.sender, payload.body, received, digest, shape_hash(payload.body)
        )
        conn.commit()

    # A duplicate is still a 202. The phone has no delivery guarantee and will
    # retry anything that isn't a success, forever.
    return {"status": "duplicate" if result["duplicate"] else "accepted",
            "body_hash": digest}


@app.post("/api/parse-tick")
async def parse_tick(x_cron_secret: str = Header(default=""), limit: int = 50) -> dict:
    if not CRON_SECRET or not hmac.compare_digest(x_cron_secret, CRON_SECRET):
        raise HTTPException(401, "unauthorized")

    counts = {"claimed": 0, "parsed": 0, "ignored": 0, "review": 0, "failed": 0,
              "parked": 0, "legs": 0, "topup_pairs": 0, "alerts": 0}

    with store.connect() as conn:
        identifiers, slug_to_id = store.load_account_map(conn)
        # Templates derived from the review screen, tried ahead of the code
        # ones so a correction actually takes effect (§10.7).
        templates = store.load_templates(conn)

        # Before claiming anything: retire rows this tick has already failed to
        # finish MAX_ATTEMPTS times. Without it they are re-claimed forever and
        # stay invisible — in no ledger and in no review queue. See
        # db.park_exhausted for why record_failure does not cover this.
        counts["parked"] = store.park_exhausted(conn)
        conn.commit()

        claimed = store.claim_pending(conn, limit)
        conn.commit()
        counts["claimed"] = len(claimed)

        for msg in claimed:
            # Each message commits on its own. One poison message must not roll
            # back the work of every message that parsed cleanly beside it.
            try:
                result = parse_message(
                    msg["sender"], msg["body"], msg["received_at"],
                    identifiers, FUNDING_ACCOUNT, CASHBACK_ACCOUNT,
                    templates=templates,
                )
                counts["legs"] += store.record_outcome(conn, msg["id"], result, slug_to_id)
                conn.commit()
                counts[{"parsed": "parsed", "ignored": "ignored",
                        "needs_review": "review"}[result.status]] += 1
            except Exception as exc:  # noqa: BLE001 — a parse bug must not stop the tick
                conn.rollback()
                store.record_failure(conn, msg["id"], f"{type(exc).__name__}: {exc}")
                conn.commit()
                counts["failed"] += 1

        # Cross-message, so it cannot live in parse_message: a wallet top-up
        # and the card purchase funding it are two messages from two different
        # senders, and the second one routinely lands on a later tick than the
        # first. Runs every tick over the recent window rather than only over
        # what was just claimed, which is what makes arrival order stop
        # mattering.
        counts["topup_pairs"] = store.link_topups(conn)
        conn.commit()

        # Same class of problem, opposite shape: a cross-bank transfer is one
        # movement that BOTH institutions describe in full, so it books twice.
        # Must run before balances, which is what it exists to protect.
        counts["superseded_legs"] = store.supersede_echoed_transfers(conn)
        conn.commit()

        # Balances are derived, so this runs every tick regardless of whether
        # anything parsed — a manual edit or a deleted transaction changes them
        # too, and recomputing costs one aggregate.
        store.recompute_balances(conn)
        alerts = store.reconcile(conn)
        conn.commit()
        counts["alerts"] = len(alerts)

    return counts


class DerivePayload(BaseModel):
    """What the review screen sends when you mark up a message."""
    message_id: str
    kind: str = Field(min_length=1, max_length=32)
    direction: str
    date_format: str | None = None
    account_hint: str | None = None
    fields: dict[str, str]
    apply: bool = True


@app.post("/api/templates/derive")
async def derive_template(
    payload: DerivePayload,
    x_internal_secret: str = Header(default=""),
) -> dict:
    """Turn one hand-marked message into a stored template (SPEC §10.7).

    Guarded by a shared secret rather than left open: this endpoint writes
    parsing rules, so anyone who could call it could make future messages parse
    however they liked.

    Derivation happens here, in Python, next to the normalizer and the regex
    conventions it has to match. Doing it in the web service would mean a
    second implementation of the same rules, and the two would drift.
    """
    if not INTERNAL_SECRET or not hmac.compare_digest(x_internal_secret, INTERNAL_SECRET):
        raise HTTPException(401, "unauthorized")

    with store.connect() as conn:
        msg = conn.execute(
            "SELECT id, sender, body, shape_hash FROM raw_messages WHERE id = %s",
            (payload.message_id,),
        ).fetchone()
        if msg is None:
            raise HTTPException(404, "message not found")

        try:
            template = derive(
                msg["body"], payload.fields, payload.kind, payload.direction,
                payload.date_format, msg["sender"], payload.account_hint,
            )
        except DeriveError as exc:
            # A refusal is a 422, not a 500: the input was understood and
            # rejected, and the message says exactly why.
            raise HTTPException(422, str(exc))

        shape = msg["shape_hash"] or shape_hash(msg["body"])
        template_id = store.save_template(conn, shape, template)
        requeued = store.requeue_shape(conn, shape) if payload.apply else 0
        conn.commit()

    return {
        "template_id": template_id,
        "shape_hash": shape,
        "pattern": template["pattern"],
        "requeued": requeued,
    }


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
