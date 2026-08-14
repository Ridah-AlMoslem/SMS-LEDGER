"""The cross-institution echo, on the DATABASE path (SPEC §8.2.1).

tests/verify_transfer_dedup.py pins the rule. This suite proves it actually
runs where it matters — the same gap `verify_topup_db.py` was written to close
for top-up linking, which had been correct in the pure harness and absent in
production.

The fixture is the real 2026-08-09 pair from samples/ANALYSIS.md §B2.4:

    Barq : حوالة صادرة محلية  113.00 → لحساب 7001    21:44
    SAIB : حوالة واردة محلية   SAR 113 من XXXX0018    21:44

One movement. Both messages are genuine, both parse, and — because Barq names
the destination and SAIB names the source, and both resolve to accounts you own
— each books BOTH sides. Four legs for one 113.

What that costs is balances, not spending: every leg is internal, so §6 totals
stay right, while `barq` reads −226 and `saib_current` +226. It then surfaces
as reconciliation drift (§3.3) against an account that looks like it lost a
message when it in fact processed one twice.

Run:  python3 tests/verify_transfer_dedup_db.py --serve
"""

import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

import db as store                                     # noqa: E402
from ledger.normalize import shape_hash                # noqa: E402
from ledger.pipeline import body_hash, parse_message   # noqa: E402

PORT = int(os.environ.get("TEST_PG_PORT", "5436"))
DSN = f"postgresql://postgres@127.0.0.1:{PORT}/postgres"
RIYADH = timezone(timedelta(hours=3))

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    detail = "" if ok else f"   got {got!r}, want {want!r}"
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{detail}")


# ------------------------------------------------------------------ fixtures

ACCOUNTS = [
    ("saib_current", "SAIB Current", "SAIB", "checking", 0.00),
    ("saib_savings", "SAIB Savings", "SAIB", "savings", 1000.00),
    ("barq", "Barq Wallet", "barq app", "wallet", 500.00),
]

# Barq's account at ANB ends 0018 — which is how SAIB names it, and the only
# reason SAIB's incoming message resolves the far side at all (§8.3).
IDENTIFIERS = [
    ("barq app", "account", "7001", "saib_current"),
    ("SAIB", "account", "0018", "barq"),
    ("SAIB", "account", "7001", "saib_current"),
    ("SAIB", "account", "7002", "saib_savings"),
]

AT = datetime(2026, 8, 9, 21, 44, tzinfo=RIYADH)

BARQ_OUT = ("barq app", """حوالة صادرة محلية
مبلغ113.00SAR
رسوم0.00SAR
الى رضا مسلم
بنكINVESTMENT BANK
لحساب7001
2026-08-09 21:44""", AT)

SAIB_IN = ("SAIB", """حوالة واردة: محلية (مقبوله)
من: XXXX0018
 RIDAH AL MOSLEM
عبر: البنك العربي الوطني
مبلغ: SAR 113
الى: XXXX7001
في: 08-09 21:44""", AT)

# A minute later, the same 113 moves current → savings. Same bank, same amount,
# same evening: the §8.2.2 hazard. It must survive untouched.
SAIB_TO_SAVINGS = ("SAIB", """حوالة صادرة: بين حساباتك
من: XXX7001
مبلغ: SAR 113
الى: XXX7002
في: 08-09 21:45""", datetime(2026, 8, 9, 21, 45, tzinfo=RIYADH))


def seed(conn):
    for slug, name, inst, typ, opening in ACCOUNTS:
        conn.execute(
            """INSERT INTO accounts (slug, name, institution, type, is_liability,
                                     balance_semantics, reconcilable,
                                     opening_balance, current_balance)
               VALUES (%s,%s,%s,%s,false,'balance',%s,%s,%s)
               ON CONFLICT (slug) DO NOTHING""",
            (slug, name, inst, typ, inst != "SAIB", opening, opening),
        )
    for inst, kind, value, slug in IDENTIFIERS:
        conn.execute(
            """INSERT INTO account_identifiers (account_id, institution, kind, value)
               SELECT id, %s, %s, %s FROM accounts WHERE slug = %s
               ON CONFLICT DO NOTHING""",
            (inst, kind, value, slug),
        )
    conn.commit()


def reset(conn):
    conn.execute("TRUNCATE transactions, balance_snapshots, raw_messages CASCADE")
    conn.execute("UPDATE accounts SET current_balance = opening_balance")
    conn.commit()


def ingest(conn, msg):
    sender, body, received = msg
    store.insert_raw_message(conn, sender, body, received,
                             body_hash(sender, body, received), shape_hash(body))
    conn.commit()


def tick(conn, identifiers, slug_to_id):
    """Mirror of main.parse_tick, minus HTTP. Must stay in step with it."""
    claimed = store.claim_pending(conn, 50)
    conn.commit()
    for msg in claimed:
        result = parse_message(msg["sender"], msg["body"], msg["received_at"],
                               identifiers, "saib_current", "cashback_wallet")
        store.record_outcome(conn, msg["id"], result, slug_to_id)
        conn.commit()
    store.link_topups(conn)
    conn.commit()
    superseded = store.supersede_echoed_transfers(conn)
    conn.commit()
    store.recompute_balances(conn)
    conn.commit()
    return superseded


def balance(conn, slug):
    return float(conn.execute(
        "SELECT current_balance FROM accounts WHERE slug = %s", (slug,)
    ).fetchone()["current_balance"])


def counts(conn):
    row = conn.execute(
        """SELECT count(*) AS legs,
                  count(*) FILTER (WHERE superseded_by IS NOT NULL) AS echoed
             FROM transactions""").fetchone()
    return int(row["legs"]), int(row["echoed"])


# --------------------------------------------------------------------- tests

def main():
    with store.connect(DSN) as conn:
        seed(conn)
        identifiers, slug_to_id = store.load_account_map(conn)

        print("\n[1] BOTH SIDES ARRIVE — ONE MOVEMENT, FOUR LEGS WRITTEN")
        reset(conn)
        for msg in (BARQ_OUT, SAIB_IN):
            ingest(conn, msg)
        superseded = tick(conn, identifiers, slug_to_id)

        legs, echoed = counts(conn)
        check("both messages parsed", conn.execute(
            "SELECT count(*) c FROM raw_messages WHERE status='parsed'").fetchone()["c"], 2)
        check("four legs were written", legs, 4)
        check("two of them are marked as the echo", echoed, 2)
        check("the tick reports what it superseded", superseded, 2)

        print("\n[2] BALANCES REFLECT ONE MOVEMENT, NOT TWO")
        check("barq moved 113, not 226", balance(conn, "barq"), 500.00 - 113.00)
        check("saib_current moved 113, not 226", balance(conn, "saib_current"), 113.00)

        print("\n[3] THE ECHO IS EXPLAINED, NOT DELETED")
        pair = conn.execute(
            """SELECT e.id AS echo, e.superseded_by AS kept, e.account_id = k.account_id AS same_acct,
                      e.direction = k.direction AS same_dir, e.amount = k.amount AS same_amt
                 FROM transactions e JOIN transactions k ON k.id = e.superseded_by
                WHERE e.superseded_by IS NOT NULL LIMIT 1""").fetchone()
        check("each echo points at a surviving leg", pair is not None, True)
        check("on the same account", pair["same_acct"], True)
        check("in the same direction", pair["same_dir"], True)
        check("for the same amount", pair["same_amt"], True)
        check("the raw messages are both still there", conn.execute(
            "SELECT count(*) c FROM raw_messages").fetchone()["c"], 2)

        print("\n[4] THE VIEW COUNTS THE MOVEMENT ONCE")
        check("v_categorized_amounts excludes the echo", conn.execute(
            "SELECT count(*) c FROM v_categorized_amounts").fetchone()["c"], 2)
        check("spending is unaffected either way — every leg is internal", conn.execute(
            """SELECT COALESCE(SUM(amount),0) t FROM v_categorized_amounts
                WHERE direction='debit' AND NOT is_internal_transfer"""
        ).fetchone()["t"], 0)

        print("\n[5] IDEMPOTENT ACROSS TICKS")
        again = tick(conn, identifiers, slug_to_id)
        legs2, echoed2 = counts(conn)
        check("a second tick supersedes nothing new", again, 0)
        check("leg count is unchanged", legs2, 4)
        check("echo count is unchanged", echoed2, 2)
        check("balances did not drift", balance(conn, "barq"), 500.00 - 113.00)

        print("\n[6] ARRIVAL ORDER DOES NOT MATTER")
        reset(conn)
        for msg in (SAIB_IN, BARQ_OUT):          # reversed
            ingest(conn, msg)
        tick(conn, identifiers, slug_to_id)
        check("still four legs, two echoed", counts(conn), (4, 2))
        check("and the same balance", balance(conn, "saib_current"), 113.00)

        print("\n[7] THE 113 HAZARD — A SAME-BANK TRANSFER IS NEVER SWALLOWED")
        reset(conn)
        for msg in (BARQ_OUT, SAIB_IN, SAIB_TO_SAVINGS):
            ingest(conn, msg)
        tick(conn, identifiers, slug_to_id)

        legs3, echoed3 = counts(conn)
        check("six legs written (2 + 2 + 2)", legs3, 6)
        check("only the cross-bank echo is superseded", echoed3, 2)
        check("the current->savings move survives in full", conn.execute(
            """SELECT count(*) c FROM transactions t JOIN accounts a ON a.id=t.account_id
                WHERE a.slug='saib_savings' AND t.superseded_by IS NULL"""
        ).fetchone()["c"], 1)
        check("savings received its 113", balance(conn, "saib_savings"), 1113.00)
        check("current is 113 in and 113 out", balance(conn, "saib_current"), 0.00)

    print()
    if all(checks):
        print("=" * 70)
        print(f"ALL {len(checks)} TRANSFER-ECHO CHECKS PASS ON THE DB PATH")
        print("=" * 70)
        return 0
    print(f"{checks.count(False)} of {len(checks)} FAILED")
    return 1


def serve_and_run():
    server = os.path.join(HERE, "..", "web", "scripts", "pgserver.mjs")
    proc = subprocess.Popen(
        ["node", server, str(PORT)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        deadline = time.time() + 60
        while time.time() < deadline:
            line = proc.stdout.readline()
            if line.startswith("READY"):
                break
            if proc.poll() is not None:
                print(line, proc.stdout.read())
                return 1
        else:
            print("pgserver did not become ready")
            return 1
        return main()
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    sys.exit(serve_and_run() if "--serve" in sys.argv else main())
