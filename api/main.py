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

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

import db as store
from ledger.normalize import shape_hash
from ledger.pipeline import body_hash, parse_message

# Single-user private service: no docs, no schema endpoint, nothing to enumerate.
app = FastAPI(title="sms-ledger", docs_url=None, redoc_url=None, openapi_url=None)

INGEST_SECRET = os.environ.get("INGEST_SECRET", "")
CRON_SECRET = os.environ.get("CRON_SECRET", "")
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


def verify_signature(raw_body: bytes, signature: str, timestamp: str) -> None:
    """Reject anything unsigned, mis-signed, or replayed (SPEC §10.1).

    A public unauthenticated ingest URL means anyone who guesses it can inject
    fabricated transactions into the ledger. This is not optional.
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
    payload: IngestPayload,
    x_signature: str = Header(default=""),
    x_timestamp: str = Header(default=""),
) -> dict:
    verify_signature(payload.model_dump_json().encode(), x_signature, x_timestamp)

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

    counts = {"claimed": 0, "parsed": 0, "ignored": 0, "review": 0, "failed": 0, "legs": 0}

    with store.connect() as conn:
        identifiers, slug_to_id = store.load_account_map(conn)
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

    return counts


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
