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
import uuid
from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

from ledger.topup import WINDOW as TOPUP_WINDOW
from ledger.topup import link_topups as _link_topups
from ledger.transfers import find_duplicate_descriptions

CENTS = Decimal("0.01")

# How far back `link_topups` re-scans for legs that have not been paired yet.
# A counterpart cannot be more than TOPUP_WINDOW from its top-up, so this is
# not about finding older pairs — it is about how long a top-up whose funding
# message never arrived keeps being reconsidered, in case that message is
# backfilled later. `dates.LIVE_WINDOW` accepts messages up to 72 hours old.
TOPUP_LOOKBACK = timedelta(days=7)

# Same reasoning for the cross-institution echo: the two sides arrive from two
# senders and routinely land on different ticks, so the scan has to keep
# reconsidering recent transfers rather than only what was just written.
TRANSFER_LOOKBACK = timedelta(days=7)


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
    a crashed or timed-out tick leaves behind. That recovery is unbounded on its
    own — see `park_exhausted`, which the caller runs first so a row that can
    never finish stops being re-claimed and becomes visible instead.
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


def park_exhausted(conn, max_attempts: int = MAX_ATTEMPTS) -> int:
    """Park a message that keeps being claimed and never produces an outcome.

    `record_failure` only runs when the parser RAISES. A tick that dies between
    the claim and the outcome raises nothing this process ever sees — a Vercel
    function timeout, the pg_net cancellation at 25s, a cold start, or an
    exception in the post-loop passes (`link_topups`, `recompute_balances`)
    that aborts the request after rows were already claimed. Those rows stay
    'processing' with `last_error` NULL, and `claim_pending` picks them up
    again ten minutes later. Nothing capped that loop.

    A message cycling that way is the one state this system had no name for:
    never parsed, never failed, so it appears in no ledger AND in no review
    queue, and `attempts` — the only trace it leaves — is displayed nowhere.
    §8.3 says a message is never dropped; a message nobody can see has been
    dropped in every sense that matters.

    After `max_attempts` claims it becomes 'failed', which the review screen
    lists. Nothing is lost by parking it — the body is still there and Retry is
    one button — only by not parking it.

    Runs before the claim so a parked row is not re-claimed in the same tick.
    """
    result = conn.execute(
        """
        UPDATE raw_messages
        SET status = 'failed',
            last_error = COALESCE(
                last_error,
                'claimed ' || attempts || ' times without completing — the tick '
                || 'ended before recording an outcome (timeout or crash)'),
            processed_at = now()
        WHERE status = 'processing'
          AND attempts >= %s
          AND last_attempt_at < now() - interval '10 minutes'
        """,
        (max_attempts,),
    )
    return result.rowcount


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
        # OTP bodies are the one documented exception to raw_messages being
        # immutable (§8, §10.1): the row survives, the passcode does not.
        #
        # Redacted here, on the tick, rather than by a 24-hour sweep. The tick
        # runs every minute, so a live passcode sits in the database for about
        # a minute instead of a day — and a sweep is one more moving part that
        # fails silently when it stops running. The phone no longer filters
        # OTPs, so this is the only thing standing between a one-time passcode
        # and permanent storage.
        #
        # body_hash is computed at ingest from what arrived, so redelivery of
        # the same OTP still dedups against this row rather than inserting a
        # fresh unredacted copy.
        redact = result.ignored_reason == "otp"
        conn.execute(
            """
            UPDATE raw_messages
            SET status = %s, ignored_reason = %s, template_id = NULL,
                shape_hash = %s, language = %s::language,
                last_error = %s, processed_at = now(),
                body = CASE WHEN %s THEN '[redacted: otp]' ELSE body END
            WHERE id = %s
            """,
            (result.status, result.ignored_reason, result.shape,
             _language(result.language), result.error, redact, message_id),
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
                fee_amount, original_currency, card_last4, parser_kind,
                origin, state
            ) VALUES (
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s, %s,
                'parsed', 'posted'
            )
            ON CONFLICT (raw_message_id, account_id, direction) DO NOTHING
            """,
            (
                message_id, account_id, leg["ts"], money(leg["amount"]),
                leg["direction"], _txn_type(leg["kind"]),
                leg.get("merchant"), leg.get("biller"), leg["is_internal"],
                money(leg.get("balance")),
                money(leg.get("fee_amount")), leg.get("original_currency"),
                # Both are what `link_topups` needs and what `type` alone
                # cannot supply — see the column comments in schema.ts.
                leg.get("card_last4"), leg["kind"],
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


def link_topups(conn, window=TOPUP_WINDOW, lookback=TOPUP_LOOKBACK) -> int:
    """Mark wallet top-ups and the card purchases that fund them as internal.

    The one rule in the system that cannot be decided from a single message.
    A Barq `اضافة اموال` and the AlRajhi `شراء انترنت` that funds it are the
    same 8 SAR described twice by two institutions; book both as they arrive
    and the money is spent once and counted twice. `parse_message` sees one
    message at a time and structurally cannot catch it, so it runs here, after
    the legs are written.

    Deliberately delegates to `ledger.topup.link_topups` rather than
    reimplementing the pairing rule in SQL. That rule has seven invariants
    pinned in tests/verify_topup_link.py — the 5-minute window, the 1:1
    claiming, the refusal to absorb a same-amount bill payment — and a second
    copy in another language would be one edit away from disagreeing with the
    tested one. This function's job is loading rows and writing back, nothing
    more.

    Idempotent: linked pairs carry a `transfer_group_id` and are skipped on
    the next tick. Bounded: only the recent window is scanned, since a
    counterpart more than `window` from a top-up can never pair with it.
    """
    owned = {
        r["value"]
        for r in conn.execute(
            "SELECT value FROM account_identifiers WHERE kind = 'card'"
        ).fetchall()
        if r["value"]
    }
    if not owned:
        return 0

    # A margin past the lookback so a top-up sitting exactly on the boundary
    # can still see a counterpart that falls just outside it.
    rows = conn.execute(
        """
        SELECT id, account_id, posted_at, amount, card_last4, parser_kind,
               is_internal_transfer, transfer_group_id
        FROM transactions
        WHERE parser_kind IN ('wallet_topup', 'purchase')
          AND state = 'posted'
          AND posted_at > now() - %s::interval - %s::interval
        ORDER BY posted_at
        """,
        (lookback, window),
    ).fetchall()

    txns = [
        dict(id=r["id"], institution=None, account=r["account_id"],
             card_last4=r["card_last4"], amount=float(r["amount"]),
             ts=r["posted_at"], kind=r["parser_kind"],
             is_internal=r["is_internal_transfer"],
             transfer_group_id=r["transfer_group_id"])
        for r in rows
    ]
    before = {t["id"]: t["is_internal"] for t in txns}

    pairs = _link_topups(txns, owned, window)

    # The pure function labels groups `tg-<id>`; the column is a uuid. The
    # label is not carried over — only the grouping it expresses.
    for topup_id, purchase_id in pairs:
        group = uuid.uuid4()
        conn.execute(
            """
            UPDATE transactions
            SET is_internal_transfer = true, transfer_group_id = %s
            WHERE id = ANY(%s)
            """,
            (group, [topup_id, purchase_id]),
        )

    # An unpaired top-up from a card you own is still internal — it is money
    # moving between two of your own accounts whether or not the funding
    # message ever arrives. No group, so it stays eligible for pairing later.
    orphans = [t["id"] for t in txns if t["is_internal"] and not before[t["id"]]
               and t["transfer_group_id"] is None]
    if orphans:
        conn.execute(
            "UPDATE transactions SET is_internal_transfer = true WHERE id = ANY(%s)",
            (orphans,),
        )

    return len(pairs)



def supersede_echoed_transfers(conn, window=None, lookback=TRANSFER_LOOKBACK) -> int:
    """Collapse a movement that two institutions each described in full.

    A cross-bank transfer sends one SMS from each side. Both parse, and both
    resolve BOTH accounts — Barq names the destination `لحساب7001`, SAIB names
    the source `XXXX0018` — so `pipeline._legs_for` books the whole movement
    twice. Four legs for one 113, and both balances move twice.

    Spending is unaffected, since every leg is internal (SPEC §6). The damage
    is to balances, and it surfaces as a reconciliation alert against an
    account that looks like it dropped a message when it actually processed one
    twice — which is the most misleading direction for that alert to point.

    Delegates the rule to `ledger.transfers`, for the same reason `link_topups`
    delegates to `ledger.topup`: the guards are what make it safe, they are
    pinned in tests/verify_transfer_dedup.py against the real 2026-08-09
    messages, and a second copy in SQL would be one edit away from disagreeing
    with the tested one.

    Idempotent — a superseded leg is excluded from the next scan, so re-running
    over a set that grows between ticks converges instead of oscillating.
    """
    from ledger.transfers import WINDOW as TRANSFER_WINDOW

    window = window or TRANSFER_WINDOW

    rows = conn.execute(
        """
        SELECT t.id, t.raw_message_id, t.account_id, t.direction, t.amount,
               t.posted_at, m.sender
        FROM transactions t
        JOIN raw_messages m ON m.id = t.raw_message_id
        WHERE t.is_internal_transfer
          AND t.superseded_by IS NULL
          AND t.state = 'posted'
          AND t.type = 'transfer'
          AND t.posted_at > now() - %s::interval
        ORDER BY t.posted_at
        """,
        (lookback,),
    ).fetchall()

    # One entry per message: what that message said happened.
    descriptions = {}
    for r in rows:
        d = descriptions.setdefault(
            r["raw_message_id"],
            dict(id=r["raw_message_id"], institution=r["sender"],
                 ts=r["posted_at"], legs=[]),
        )
        d["legs"].append(dict(id=r["id"], account=r["account_id"],
                              direction=r["direction"], amount=float(r["amount"])))

    pairs = find_duplicate_descriptions(list(descriptions.values()), window)
    if not pairs:
        return 0

    superseded = 0
    for kept_msg, echo_msg in pairs:
        # Point each echoed leg at the surviving leg for the SAME account and
        # direction, so the link explains itself: this row is that row, said
        # twice. A single group id would lose which leg maps to which.
        keep_by_side = {
            (leg["account"], leg["direction"]): leg["id"]
            for leg in descriptions[kept_msg]["legs"]
        }
        for leg in descriptions[echo_msg]["legs"]:
            target = keep_by_side.get((leg["account"], leg["direction"]))
            if target is None:
                continue
            conn.execute(
                "UPDATE transactions SET superseded_by = %s WHERE id = %s",
                (target, leg["id"]),
            )
            superseded += 1

    return superseded


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
                  -- A second institution's description of a movement already
                  -- booked is not a second movement (SPEC 8.2.1). Counting it
                  -- moves both balances twice and shows up as reconciliation
                  -- drift on an account that processed one message twice.
                  AND tx.superseded_by IS NULL
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
