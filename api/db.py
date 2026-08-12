"""Persistence for the parser service.

Plain SQL against the schema Drizzle owns (`web/src/db/schema.ts`). No ORM
here on purpose: defining the model a second time in a second language is how
two definitions drift apart, and only one of them can be right.

Money is Decimal end to end. The parser works in float because it does
arithmetic on parsed text, but nothing reaches a NUMERIC column without going
through `money()` first — binding a float to NUMERIC(14,2) is how you get
0.30000000000000004 in a ledger.
"""

from __future__ import annotations

import os
from decimal import Decimal, ROUND_HALF_UP

import psycopg
from psycopg.rows import dict_row

CENTS = Decimal("0.01")


def money(value) -> Decimal | None:
    """float/str/Decimal → Decimal quantized to 2dp, half-up.

    Half-up rather than Python's default banker's rounding: bank statements
    round half away from zero, and reconciliation compares against what the
    bank printed.
    """
    if value is None:
        return None
    return Decimal(str(value)).quantize(CENTS, rounding=ROUND_HALF_UP)


def connect(url: str | None = None) -> psycopg.Connection:
    url = url or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg.connect(url, row_factory=dict_row, autocommit=False)


# ----------------------------------------------------------------- accounts

def load_account_map(conn) -> tuple[dict, dict]:
    """Build what the parser needs to resolve accounts, plus the slug → id map.

    identifiers: {(institution, masked_value): slug}. §8.3 — keyed by
    institution as well as value, because two banks can legitimately mask
    different accounts to the same suffix, and matching on the suffix alone
    posts your salary to a stranger's card.
    """
    rows = conn.execute("""
        SELECT ai.institution, ai.value, a.slug
        FROM account_identifiers ai
        JOIN accounts a ON a.id = ai.account_id
    """).fetchall()
    identifiers = {(r["institution"], r["value"]): r["slug"] for r in rows}

    slug_to_id = {
        r["slug"]: r["id"]
        for r in conn.execute("SELECT id, slug FROM accounts").fetchall()
    }
    return identifiers, slug_to_id


# ------------------------------------------------------------ raw  messages

def insert_raw_message(conn, sender, body, received_at, body_hash, shape_hash) -> dict:
    """Append-only store (§3.1). Returns {'id', 'duplicate'}.

    ON CONFLICT DO NOTHING makes redelivery harmless: the iPhone Shortcut has
    no reliable delivery guarantee, so the same message genuinely does arrive
    twice. A duplicate is a success, not an error — the caller still returns
    202, or the phone will keep retrying something that already worked.
    """
    row = conn.execute(
        """
        INSERT INTO raw_messages (sender, body, received_at, body_hash, shape_hash, status)
        VALUES (%s, %s, %s, %s, %s, 'pending')
        ON CONFLICT (body_hash) DO NOTHING
        RETURNING id
        """,
        (sender, body, received_at, body_hash, shape_hash),
    ).fetchone()

    if row is not None:
        return {"id": row["id"], "duplicate": False}

    existing = conn.execute(
        "SELECT id FROM raw_messages WHERE body_hash = %s", (body_hash,)
    ).fetchone()
    return {"id": existing["id"], "duplicate": True}


def claim_pending(conn, limit: int = 50) -> list[dict]:
    """Atomically claim work for this tick.

    SKIP LOCKED is what makes overlapping ticks safe. Dedup on body_hash does
    NOT cover this: two ticks running at once would both read the same pending
    row, both parse it, and both insert — same message, two transactions, and
    body_hash is identical for both so nothing catches it. The row lock is the
    only thing standing between you and double-counted spending.

    Also recovers rows stuck in 'processing' for over 10 minutes, which is what
    a crashed or timed-out tick leaves behind.
    """
    return conn.execute(
        """
        WITH claimed AS (
            SELECT id FROM raw_messages
            WHERE status = 'pending'
               OR (status = 'processing' AND last_attempt_at < now() - interval '10 minutes')
            ORDER BY received_at
            FOR UPDATE SKIP LOCKED
            LIMIT %s
        )
        UPDATE raw_messages r
        SET status = 'processing',
            attempts = r.attempts + 1,
            last_attempt_at = now()
        FROM claimed
        WHERE r.id = claimed.id
        RETURNING r.id, r.sender, r.body, r.received_at, r.attempts
        """,
        (limit,),
    ).fetchall()


MAX_ATTEMPTS = 3


def record_outcome(conn, message_id, result, slug_to_id) -> int:
    """Write one message's parse result. Returns the number of legs posted.

    Caller controls the transaction. The status update and the transaction rows
    must commit together or not at all — a message marked 'parsed' with no
    transaction behind it is invisible data loss, and it is exactly the kind of
    thing that only shows up in a reconciliation drift weeks later.
    """
    if result.status != "parsed":
        conn.execute(
            """
            UPDATE raw_messages
            SET status = %s, ignored_reason = %s, template_id = NULL,
                shape_hash = %s, last_error = %s, processed_at = now()
            WHERE id = %s
            """,
            (result.status, result.ignored_reason, result.shape, result.error, message_id),
        )
        return 0

    posted = 0
    for leg in result.legs:
        account_id = slug_to_id.get(leg["account"])
        if account_id is None:
            # The parser resolved a slug the database has no account for.
            # Park it rather than guessing — §8.3, never drop.
            conn.execute(
                """
                UPDATE raw_messages
                SET status = 'needs_review', shape_hash = %s,
                    last_error = %s, processed_at = now()
                WHERE id = %s
                """,
                (result.shape, f"unknown account slug: {leg['account']}", message_id),
            )
            return 0

        conn.execute(
            """
            INSERT INTO transactions (
                raw_message_id, account_id, posted_at, amount, direction, type,
                merchant_raw, biller, is_internal_transfer, reported_balance,
                fee_amount, original_currency, origin, state
            ) VALUES (
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, 'parsed', 'posted'
            )
            ON CONFLICT (raw_message_id, account_id, direction) DO NOTHING
            """,
            (
                message_id, account_id, leg["ts"], money(leg["amount"]),
                leg["direction"], _txn_type(leg["kind"]),
                leg.get("merchant"), leg.get("biller"), leg["is_internal"],
                money(leg.get("balance")),
                money(leg.get("fee_amount")), leg.get("original_currency"),
            ),
        )
        posted += 1

    if result.snapshot is not None:
        snap_account = slug_to_id.get(result.snapshot["account"])
        if snap_account is not None:
            conn.execute(
                """
                INSERT INTO balance_snapshots (account_id, balance, source, as_of)
                VALUES (%s, %s, 'sms', %s)
                """,
                (snap_account, money(result.snapshot["balance"]), result.snapshot["ts"]),
            )

    conn.execute(
        """
        UPDATE raw_messages
        SET status = 'parsed', template_id = NULL, shape_hash = %s,
            last_error = NULL, processed_at = now()
        WHERE id = %s
        """,
        (result.shape, message_id),
    )
    return posted


def record_failure(conn, message_id, error: str) -> None:
    """A message that raised. Parks after MAX_ATTEMPTS so one poison message
    cannot occupy every tick forever."""
    conn.execute(
        """
        UPDATE raw_messages
        SET status = (CASE WHEN attempts >= %s THEN 'failed' ELSE 'pending' END)::message_status,
            last_error = %s
        WHERE id = %s
        """,
        (MAX_ATTEMPTS, error[:2000], message_id),
    )


# The parser's vocabulary is finer than the ledger's: it distinguishes a
# cashback accrual from a salary because the templates do, while the ledger
# only needs to know both are income.
_KIND_TO_TYPE = {
    "purchase": "purchase",
    "withdrawal": "withdrawal",
    "transfer": "transfer",
    "transfer_in": "transfer",
    "card_payment": "card_payment",
    "bill_payment": "bill_payment",
    "salary": "income",
    "profit": "profit",
    "cashback_accrual": "profit",
    "cashback_redeem": "transfer",
    "wallet_topup": "transfer",
    "fee": "fee",
    "refund": "refund",
}


def _txn_type(kind: str) -> str:
    return _KIND_TO_TYPE.get(kind, "purchase")
