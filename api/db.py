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
import re
from decimal import Decimal, ROUND_HALF_UP

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

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


def _language(value: str | None) -> str | None:
    """Only values the `language` enum accepts.

    Every attested format is Arabic, so this is a canary rather than a routing
    decision: a row tagged 'en' means a sender started writing in English, which
    no template covers. 'unknown' has no enum member and is stored as NULL —
    absence of Arabic AND of Latin means there was nothing to judge.
    """
    return value if value in ("ar", "en") else None


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
                shape_hash = %s, language = %s::language,
                last_error = %s, processed_at = now()
            WHERE id = %s
            """,
            (result.status, result.ignored_reason, result.shape,
             _language(result.language), result.error, message_id),
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
            language = %s::language, last_error = NULL, processed_at = now()
        WHERE id = %s
        """,
        (result.shape, _language(result.language), message_id),
    )
    return posted


# ---------------------------------------------------- derived templates

def load_templates(conn) -> list[dict]:
    """Templates derived from the review screen, as runtime template dicts.

    Loaded per tick and handed to the parser, so `ledger/` never gains database
    access and stays testable without one.

    A template whose stored regex no longer compiles is skipped rather than
    allowed to crash the tick — one bad row must not stop every message.
    """
    from ledger.derive import to_runtime_template

    rows = conn.execute(
        """
        SELECT id, sender, shape_hash, pattern, field_map, kind
        FROM sms_templates
        ORDER BY created_at
        """
    ).fetchall()

    out = []
    for row in rows:
        meta = row["field_map"] or {}
        try:
            out.append(to_runtime_template({
                "id": str(row["id"])[:8],
                "sender": row["sender"],
                "kind": row["kind"],
                "pattern": row["pattern"],
                "direction": meta.get("direction", "debit"),
                "date_format": meta.get("date_format"),
                "field_order": meta.get("field_order", []),
                "account_hint": meta.get("account_hint"),
            }))
        except re.error:
            continue
    return out


def save_template(conn, shape_hash: str, template: dict) -> str:
    """Store a derived template against its shape hash.

    ON CONFLICT updates rather than erroring: deriving a second time for the
    same shape means the first attempt was wrong, and refusing the correction
    would leave the wrong one in place.
    """
    row = conn.execute(
        """
        INSERT INTO sms_templates
            (sender, shape_hash, language, pattern, field_map, kind, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, 'manual')
        ON CONFLICT (shape_hash) DO UPDATE
            SET pattern = EXCLUDED.pattern,
                field_map = EXCLUDED.field_map,
                kind = EXCLUDED.kind,
                sender = EXCLUDED.sender
        RETURNING id
        """,
        (
            template["sender"],
            shape_hash,
            template.get("language", "ar"),
            template["pattern"],
            Json({
                "field_order": template["field_order"],
                "direction": template["direction"],
                "date_format": template.get("date_format"),
                "account_hint": template.get("account_hint"),
            }),
            template["kind"],
        ),
    ).fetchone()
    return str(row["id"])


def requeue_shape(conn, shape_hash: str) -> int:
    """Send every message of this shape back through the parser.

    This is the payoff (§10.7): hand-process one message and the other
    forty-nine resolve themselves. Includes messages already parked as `failed`
    — they failed for want of this template.

    Deliberately does NOT touch messages already parsed. Re-parsing them would
    risk duplicate transactions, and anything that did parse did so against a
    template that already worked.
    """
    result = conn.execute(
        """
        UPDATE raw_messages
        SET status = 'pending', attempts = 0, last_error = NULL, processed_at = NULL
        WHERE shape_hash = %s
          AND status IN ('needs_review', 'failed')
        """,
        (shape_hash,),
    )
    return result.rowcount


def recompute_balances(conn) -> int:
    """Derive every account balance from opening_balance + its posted legs.

    Recomputed, never incremented. An incremental `balance += amount` looks
    cheaper and is wrong here for three separate reasons:

      - Messages arrive out of order. iOS automations retry, and a manual
        backfill can insert a transaction dated last month.
      - Replay is a design requirement (§3.1). Re-parsing history against an
        improved parser would apply every delta a second time.
      - A failed tick that committed a transaction but not its balance update
        would leave a permanent, invisible skew.

    Recomputing is idempotent, so none of those can drift. It costs one
    aggregate over a table that holds thousands of rows, not millions.

    The sign rule is uniform: credit adds, debit subtracts — for assets AND for
    credit cards. On a card the stored figure is available credit, and a
    purchase (debit) genuinely does reduce it while a payment (credit) raises
    it. What differs is only the INTERPRETATION: net worth reads a card as
    −(limit − balance). Getting that distinction backwards is §3.3a.
    """
    result = conn.execute(
        """
        UPDATE accounts a
        SET current_balance = a.opening_balance + COALESCE(t.delta, 0),
            balance_as_of   = COALESCE(t.last_at, a.balance_as_of)
        FROM (
            SELECT acc.id,
                   SUM(CASE WHEN tx.direction = 'credit' THEN tx.amount
                            ELSE -tx.amount END) AS delta,
                   MAX(tx.posted_at) AS last_at
            FROM accounts acc
            LEFT JOIN transactions tx
                   ON tx.account_id = acc.id
                  AND tx.state = 'posted'
            GROUP BY acc.id
        ) t
        WHERE a.id = t.id
        """
    )
    return result.rowcount


def reconcile(conn) -> list[dict]:
    """Compare computed balances against what the bank actually printed (§3.3).

    Drift means a message was missed, double-counted, or misparsed. This is the
    check that makes the ledger trustworthy rather than decorative — without
    it, silent data loss is invisible, and on a pipeline that depends on an iOS
    automation staying enabled, silent data loss is a matter of time.

    Only accounts flagged `reconcilable` are checked. SAIB reports no balance
    in any message, so comparing it against nothing would either raise a
    permanent false alarm or, worse, report a clean reconciliation it has not
    earned (§3.3b).

    For a credit card the reported رصيد IS available credit, which is exactly
    what `current_balance` holds — so the comparison is direct, with no
    limit arithmetic in between.
    """
    drifted = conn.execute(
        """
        WITH latest AS (
            SELECT DISTINCT ON (account_id) account_id, balance, as_of
            FROM balance_snapshots
            WHERE source = 'sms'
            ORDER BY account_id, as_of DESC, id
        )
        SELECT a.id, a.slug, a.current_balance AS computed,
               l.balance AS reported,
               a.current_balance - l.balance AS delta
        FROM accounts a
        JOIN latest l ON l.account_id = a.id
        WHERE a.reconcilable
          AND a.is_active
          AND abs(a.current_balance - l.balance) > 0.01
        """
    ).fetchall()

    raised = []
    for row in drifted:
        # One open alert per account. Re-raising the same drift every minute
        # would bury the signal under its own noise.
        existing = conn.execute(
            """
            SELECT id FROM reconciliation_alerts
            WHERE account_id = %s AND resolved_at IS NULL
              AND abs(delta - %s) <= 0.01
            """,
            (row["id"], row["delta"]),
        ).fetchone()
        if existing:
            continue

        conn.execute(
            """
            INSERT INTO reconciliation_alerts
                (account_id, computed_balance, reported_balance, delta)
            VALUES (%s, %s, %s, %s)
            """,
            (row["id"], row["computed"], row["reported"], row["delta"]),
        )
        raised.append(dict(row))

    # A drift that has since been explained away by later messages should stop
    # shouting. Anything no longer drifting gets closed.
    conn.execute(
        """
        UPDATE reconciliation_alerts ra
        SET resolved_at = now(),
            resolution_note = 'balance agrees after later messages'
        FROM accounts a,
             LATERAL (
                 SELECT balance FROM balance_snapshots
                 WHERE account_id = a.id AND source = 'sms'
                 ORDER BY as_of DESC, id LIMIT 1
             ) l
        WHERE ra.account_id = a.id
          AND ra.resolved_at IS NULL
          AND abs(a.current_balance - l.balance) <= 0.01
        """
    )
    return raised


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
