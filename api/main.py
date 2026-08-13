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
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

import db as store
from ledger.derive import DeriveError, derive
from ledger.normalize import shape_hash
from ledger.pipeline import body_hash, parse_message

# Single-user private service: no docs, no schema endpoint, nothing to enumerate.
app = FastAPI(title="sms-ledger", docs_url=None, redoc_url=None, openapi_url=None)

INGEST_SECRET = os.environ.get("INGEST_SECRET", "")
CRON_SECRET = os.environ.get("CRON_SECRET", "")
# Shared with the web service so it can call the derive endpoint. Separate from
# CRON_SECRET on purpose: different caller, different blast radius.
INTERNAL_SECRET = os.environ.get("INTERNAL_SECRET", "")
MAX_SKEW_SECONDS = 300

# Which account funds a card payment, and which holds cashback. Slugs, not
# UUIDs — the parser never sees a UUID (see accounts.slug in the schema).
FUNDING_ACCOUNT = os.environ.get("FUNDING_ACCOUNT_SLUG", "saib_current")
CASHBACK_ACCOUNT = os.environ.get("CASHBACK_ACCOUNT_SLUG", "cashback_wallet")


class IngestPayload(BaseModel):
    sender: str = Field(min_length=1, max_length=64)
    body: str = Field(min_length=1, max_length=4000)
    received_at: datetime
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

    try:
        age = abs(time.time() - int(timestamp))
    except (TypeError, ValueError):
        raise HTTPException(401, "bad timestamp")
    if age > MAX_SKEW_SECONDS:
        raise HTTPException(401, "stale request")

    expected = hmac.new(INGEST_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature or ""):
        raise HTTPException(401, "bad signature")


@app.post("/api/ingest", status_code=202)
async def ingest(
    request: Request,
    x_signature: str = Header(default=""),
    x_timestamp: str = Header(default=""),
) -> dict:
    # Two accepted shapes, one rule: the HMAC always covers the exact bytes of
    # the JSON that describes the message, never a re-serialization of it.
    #
    #   envelope  {"sig","ts","payload"}   — the phone. Signed over `payload`.
    #   headers   X-Signature/X-Timestamp  — curl, tools/send.mjs, anything
    #                                        that can set headers freely.
    #
    # Both are kept because the envelope exists to work around a Shortcuts
    # limitation, and a limitation of one client is a poor reason to make
    # every other caller carry the same workaround.
    raw = await request.body()

    try:
        envelope = SignedEnvelope.model_validate_json(raw)
    except ValidationError:
        envelope = None

    if envelope is not None:
        signed, signature, timestamp = (
            envelope.payload.encode(), envelope.sig, envelope.ts)
    else:
        signed, signature, timestamp = raw, x_signature, x_timestamp

    # Signature first, parsing second. An unsigned request should never reach
    # the message parser at all — that is unauthenticated attacker-controlled
    # input, and validating it before authenticating it is backwards.
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

    received = payload.received_at
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
              "legs": 0, "alerts": 0}

    with store.connect() as conn:
        identifiers, slug_to_id = store.load_account_map(conn)
        # Templates derived from the review screen, tried ahead of the code
        # ones so a correction actually takes effect (§10.7).
        templates = store.load_templates(conn)
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
