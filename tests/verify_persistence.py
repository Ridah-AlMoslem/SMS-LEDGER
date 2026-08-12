"""Persistence invariants, against real Postgres (SPEC §13).

The pure-logic suite proves the parser computes the right answer. It
structurally cannot see the failures that live in the gap between parsing and
storage, which is where the expensive ones hide:

  - the same message ingested twice becoming two transactions
  - two overlapping ticks both claiming one row
  - an ignored message quietly acquiring a transaction anyway
  - float amounts landing in a NUMERIC column

Run:  python3 tests/verify_persistence.py --serve   (starts and stops its own)
Or:   node web/scripts/pgserver.mjs &  then  python3 tests/verify_persistence.py

The server lives under web/ because that is where both the Drizzle migrations
and the PGlite dependency are — Node resolves node_modules from the script's
own location, not the working directory.
"""

import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

import db as store                              # noqa: E402
from ledger.normalize import shape_hash          # noqa: E402
from ledger.pipeline import body_hash, parse_message  # noqa: E402

PORT = int(os.environ.get("TEST_PG_PORT", "5433"))
DSN = f"postgresql://postgres@127.0.0.1:{PORT}/postgres"
UTC = timezone.utc

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    status = "PASS" if ok else "FAIL"
    detail = "" if ok else f"   got {got!r}, want {want!r}"
    print(f"  {status}  {name}{detail}")


# ------------------------------------------------------------------ fixtures

ACCOUNTS = [
    # slug,             name,             institution,    type,          liability, semantics
    ("saib_current",    "SAIB Current",   "SAIB",         "checking",    False, "balance"),
    ("saib_savings",    "SAIB Savings",   "SAIB",         "savings",     False, "balance"),
    ("alrajhi_card",    "AlRajhi Card",   "AlRajhiBank",  "credit_card", True,  "available_credit"),
    ("barq",            "Barq Wallet",    "barq app",     "wallet",      False, "balance"),
    ("cashback_wallet", "Cashback",       "AlRajhiBank",  "cashback_wallet", False, "balance"),
]

IDENTIFIERS = [
    ("SAIB", "account", "7001", "saib_current"),
    ("SAIB", "account", "7002", "saib_savings"),
    ("AlRajhiBank", "card", "0256", "alrajhi_card"),
    ("barq app", "card", "0256", "alrajhi_card"),
]

SALARY = ("SAIB", "قيد راتب دائن 12,500.00 SAR في 14:04 25-06\n"
                  "حساب 0000xx17001 تاريخ استحقاق 06/25")
TRANSFER = ("SAIB", "حوالة صادرة: بين حساباتك\nمن: XXX7001 \nمبلغ: SAR 3000\n"
                    "الى: XXX7002 \nفي: 06-25 20:10")
OTP = ("SAIB", "كلمة مرور لمرة واحدة 449812\nمبلغ: SAR 113.00\nلا تشاركها مع أحد")


def seed(conn):
    for slug, name, inst, typ, liab, sem in ACCOUNTS:
        conn.execute(
            """INSERT INTO accounts (slug, name, institution, type, is_liability,
                                     balance_semantics, reconcilable)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (slug, name, inst, typ, liab, sem, inst != "SAIB"),
        )
    for inst, kind, value, slug in IDENTIFIERS:
        conn.execute(
            """INSERT INTO account_identifiers (account_id, institution, kind, value)
               SELECT id, %s, %s, %s FROM accounts WHERE slug = %s""",
            (inst, kind, value, slug),
        )
    conn.commit()


def reset(conn):
    conn.execute("TRUNCATE transactions, balance_snapshots, raw_messages CASCADE")
    conn.commit()


def ingest(conn, sender, body, received_at):
    return store.insert_raw_message(
        conn, sender, body, received_at, body_hash(sender, body, received_at),
        shape_hash(body))


def run_tick(conn, identifiers, slug_to_id, limit=50):
    """Mirror of main.parse_tick, minus HTTP."""
    claimed = store.claim_pending(conn, limit)
    conn.commit()
    legs = 0
    for msg in claimed:
        result = parse_message(msg["sender"], msg["body"], msg["received_at"],
                               identifiers, "saib_current", "cashback_wallet")
        legs += store.record_outcome(conn, msg["id"], result, slug_to_id)
        conn.commit()
    return len(claimed), legs


# --------------------------------------------------------------------- tests

def main():
    with store.connect(DSN) as conn:
        seed(conn)
        identifiers, slug_to_id = store.load_account_map(conn)

        print("\n[1] ACCOUNT RESOLUTION")
        check("identifiers are scoped by institution",
              identifiers[("SAIB", "7001")], "saib_current")
        check("same masked value, different institution, different account",
              identifiers[("AlRajhiBank", "0256")] == identifiers[("barq app", "0256")], True)

        print("\n[2] INGEST DEDUP  (§10.2)")
        reset(conn)
        t = datetime(2026, 6, 25, 14, 4, tzinfo=UTC)
        first = ingest(conn, *SALARY, t)
        second = ingest(conn, *SALARY, t)
        conn.commit()
        check("first insert is not a duplicate", first["duplicate"], False)
        check("verbatim resubmission is a duplicate", second["duplicate"], True)
        check("same row id returned", first["id"], second["id"])
        check("one raw row stored",
              conn.execute("SELECT count(*) c FROM raw_messages").fetchone()["c"], 1)

        print("\n[3] IDEMPOTENCY  — one message, one transaction")
        run_tick(conn, identifiers, slug_to_id)
        after_first = conn.execute("SELECT count(*) c FROM transactions").fetchone()["c"]
        # Force a replay of the same message and re-run.
        conn.execute("UPDATE raw_messages SET status = 'pending'")
        conn.commit()
        run_tick(conn, identifiers, slug_to_id)
        after_replay = conn.execute("SELECT count(*) c FROM transactions").fetchone()["c"]
        check("salary posted one transaction", after_first, 1)
        check("replaying the same message posts no second transaction",
              after_replay, after_first)

        print("\n[4] AMOUNT FIDELITY  — NUMERIC, not float")
        row = conn.execute("SELECT amount, direction, type FROM transactions").fetchone()
        check("amount is exact to the cent", str(row["amount"]), "12500.00")
        check("salary is a credit", row["direction"], "credit")
        check("salary maps to income", row["type"], "income")

        print("\n[5] TWO LEGS FROM ONE MESSAGE  (AUDIT §4.5)")
        reset(conn)
        ingest(conn, *TRANSFER, datetime(2026, 6, 25, 20, 10, tzinfo=UTC))
        conn.commit()
        _, legs = run_tick(conn, identifiers, slug_to_id)
        rows = conn.execute("""
            SELECT a.slug, t.direction, t.amount, t.is_internal_transfer
            FROM transactions t JOIN accounts a ON a.id = t.account_id
            ORDER BY t.direction
        """).fetchall()
        check("one message produced two legs", legs, 2)
        check("debit leaves current",
              (rows[0]["slug"], rows[0]["direction"]), ("saib_current", "debit"))
        check("credit lands in savings",
              (rows[1]["slug"], rows[1]["direction"]), ("saib_savings", "credit"))
        check("both marked internal",
              all(r["is_internal_transfer"] for r in rows), True)
        check("net worth unchanged by an internal transfer",
              sum(r["amount"] if r["direction"] == "credit" else -r["amount"] for r in rows),
              0)

        print("\n[6] NON-TRANSACTIONS NEVER REACH THE LEDGER  (§7.1)")
        reset(conn)
        ingest(conn, *OTP, datetime(2026, 7, 8, 21, 38, tzinfo=UTC))
        conn.commit()
        run_tick(conn, identifiers, slug_to_id)
        msg = conn.execute("SELECT status, ignored_reason FROM raw_messages").fetchone()
        check("OTP carrying an amount is ignored", msg["status"], "ignored")
        check("ignored for the right reason", msg["ignored_reason"], "otp")
        check("OTP produced zero transactions",
              conn.execute("SELECT count(*) c FROM transactions").fetchone()["c"], 0)

        print("\n[7] CLAIM SAFETY  (§10.6)")
        reset(conn)
        ingest(conn, *SALARY, datetime(2026, 6, 25, 14, 4, tzinfo=UTC))
        conn.commit()
        claimed_a = store.claim_pending(conn, 50)
        conn.commit()
        claimed_b = store.claim_pending(conn, 50)
        conn.commit()
        check("first tick claims the row", len(claimed_a), 1)
        check("second tick claims nothing already in flight", len(claimed_b), 0)
        check("claim marks the row processing",
              conn.execute("SELECT status FROM raw_messages").fetchone()["status"],
              "processing")
        check("attempts incremented on claim",
              conn.execute("SELECT attempts FROM raw_messages").fetchone()["attempts"], 1)

        print("\n[8] STUCK ROWS RECOVER")
        conn.execute("UPDATE raw_messages SET last_attempt_at = now() - interval '11 minutes'")
        conn.commit()
        recovered = store.claim_pending(conn, 50)
        conn.commit()
        check("a tick that died mid-flight releases its row", len(recovered), 1)

        print("\n[9] POISON MESSAGE PARKS  (§10.6)")
        reset(conn)
        ingest(conn, *SALARY, datetime(2026, 6, 25, 14, 4, tzinfo=UTC))
        conn.commit()
        for _ in range(3):
            store.claim_pending(conn, 50)
            store.record_failure(conn, conn.execute(
                "SELECT id FROM raw_messages").fetchone()["id"], "boom")
            conn.commit()
        check("parks as failed after 3 attempts",
              conn.execute("SELECT status FROM raw_messages").fetchone()["status"], "failed")

    print()
    if all(checks):
        print("=" * 70)
        print(f"ALL {len(checks)} PERSISTENCE CHECKS PASS")
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
