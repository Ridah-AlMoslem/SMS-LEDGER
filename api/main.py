"""Ingest and parsing service.

Two responsibilities, deliberately separated (SPEC §10.2, §10.3):

  POST /api/ingest      Verify HMAC, dedup, store raw, return 202. No parsing.
  POST /api/parse-tick  Drain pending messages through the parser. Driven by
                        pg_cron, which doubles as the Supabase keep-alive.

Parsing never happens inside the ingest request. The Shortcut on the phone
gets an answer in under 100 ms and the parser can be slow, retried, or
replayed without the phone ever knowing.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time

from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field

from ledger.normalize import normalize

# Single-user private service: no docs, no schema endpoint, nothing to enumerate.
app = FastAPI(title="sms-ledger", docs_url=None, redoc_url=None, openapi_url=None)

INGEST_SECRET = os.environ.get("INGEST_SECRET", "")
CRON_SECRET = os.environ.get("CRON_SECRET", "")
MAX_SKEW_SECONDS = 300


class IngestPayload(BaseModel):
    sender: str = Field(min_length=1, max_length=64)
    body: str = Field(min_length=1, max_length=4000)
    received_at: str
    device_id: str | None = None


def body_hash(sender: str, normalized_body: str, received_at: str) -> str:
    """Dedup key (SPEC §10.2).

    received_at is truncated to the minute and folded in, because some senders
    omit any timestamp inside the message body. Without it, two genuinely
    separate identical purchases collapse into one.
    """
    minute = received_at[:16]
    return hashlib.sha256(f"{sender}|{normalized_body}|{minute}".encode()).hexdigest()


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
    response: Response,
    x_signature: str = Header(default=""),
    x_timestamp: str = Header(default=""),
) -> dict[str, str]:
    raw = payload.model_dump_json().encode()
    verify_signature(raw, x_signature, x_timestamp)

    normalized = normalize(payload.body)
    digest = body_hash(payload.sender, normalized, payload.received_at)

    # TODO(milestone 2): INSERT INTO raw_messages ... ON CONFLICT (body_hash)
    # DO NOTHING. Raw messages are immutable and never deleted (SPEC §3.1) —
    # they are what makes every future parser fix replayable.
    return {"status": "accepted", "body_hash": digest}


@app.post("/api/parse-tick")
async def parse_tick(x_cron_secret: str = Header(default="")) -> dict[str, int]:
    if not CRON_SECRET or not hmac.compare_digest(x_cron_secret, CRON_SECRET):
        raise HTTPException(401, "unauthorized")

    # TODO(milestone 3-6): claim pending rows, run ledger.Pipeline, write
    # transactions. Claiming must be atomic (SELECT ... FOR UPDATE SKIP LOCKED)
    # so two overlapping ticks can never post the same message twice — dedup on
    # body_hash does not cover this.
    return {"claimed": 0, "parsed": 0, "review": 0}


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
