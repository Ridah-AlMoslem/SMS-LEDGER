"""Balance derivation and reconciliation, against real Postgres (SPEC §3.3).

Two things are being proven here, and they fail in opposite directions:

  - Balances must MOVE. Before this, transactions posted correctly and account
    balances never changed, so the dashboard could only ever show what was
    typed into the seed.
  - Balances must move in the RIGHT direction on a credit card, where the
    stored figure is available credit rather than debt. Getting that backwards
    is invisible on screen and moves net worth by roughly the credit limit.

Run: python3 tests/verify_balances.py --serve
"""

import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

import db as store  # noqa: E402

PORT = int(os.environ.get("TEST_PG_PORT", "5437"))
DSN = f"postgresql://postgres@127.0.0.1:{PORT}/postgres"
UTC = timezone.utc
T0 = datetime(2026, 8, 1, 12, 0, tzinfo=UTC)

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


ACCOUNTS = [
    # slug, liability, semantics, reconcilable, opening, limit
    ("current",  False, "balance",          True,  "1000.00", None),
    ("savings",  False, "balance",          False, "50000.00", None),
    ("card",     True,  "available_credit", True,  "7500.00", "10000.00"),
]


def seed(conn):
    for slug, liab, sem, rec, opening, limit in ACCOUNTS:
        conn.execute(
            """INSERT INTO accounts (slug, name, institution, type, is_liability,
                                     balance_semantics, reconcilable,
                                     opening_balance, current_balance, credit_limit)
               VALUES (%s,%s,'T',%s,%s,%s,%s,%s,%s,%s)""",
            (slug, slug, "credit_card" if liab else "checking", liab, sem, rec,
             opening, opening, limit))
    conn.commit()


def ids(conn):
    return {r["slug"]: r["id"] for r in conn.execute("SELECT id, slug FROM accounts").fetchall()}


def post(conn, account_id, amount, direction, at, msg=None):
    conn.execute(
        """INSERT INTO transactions (raw_message_id, account_id, posted_at, amount,
                                     direction, type, state)
           VALUES (%s,%s,%s,%s,%s,'purchase','posted')""",
        (msg, account_id, at, amount, direction))
    conn.commit()


def snapshot(conn, account_id, balance, at):
    conn.execute(
        """INSERT INTO balance_snapshots (account_id, balance, source, as_of)
           VALUES (%s,%s,'sms',%s)""", (account_id, balance, at))
    conn.commit()


def balances(conn):
    return {r["slug"]: str(r["current_balance"])
            for r in conn.execute("SELECT slug, current_balance FROM accounts").fetchall()}


def open_alerts(conn):
    return conn.execute(
        """SELECT a.slug, r.delta FROM reconciliation_alerts r
           JOIN accounts a ON a.id = r.account_id
           WHERE r.resolved_at IS NULL ORDER BY a.slug""").fetchall()


def main():
    with store.connect(DSN) as conn:
        seed(conn)
        acc = ids(conn)

        print("\n[1] BALANCES ACTUALLY MOVE")
        check("start at opening", balances(conn)["current"], "1000.00")
        post(conn, acc["current"], "250.00", "debit", T0)
        store.recompute_balances(conn); conn.commit()
        check("a debit lowers the balance", balances(conn)["current"], "750.00")
        post(conn, acc["current"], "12500.00", "credit", T0 + timedelta(days=1))
        store.recompute_balances(conn); conn.commit()
        check("a credit raises it", balances(conn)["current"], "13250.00")

        print("\n[2] CREDIT CARD — stored figure is AVAILABLE CREDIT (§3.3a)")
        post(conn, acc["card"], "500.00", "debit", T0)
        store.recompute_balances(conn); conn.commit()
        check("a purchase REDUCES available credit",
              balances(conn)["card"], "7000.00")
        # debt = limit − available
        check("so debt rose to 3,000.00",
              str(round(10000 - float(balances(conn)["card"]), 2)), "3000.0")

        post(conn, acc["card"], "2000.00", "credit", T0 + timedelta(days=2))
        store.recompute_balances(conn); conn.commit()
        check("a payment RESTORES available credit",
              balances(conn)["card"], "9000.00")
        check("debt fell to 1,000.00",
              str(round(10000 - float(balances(conn)["card"]), 2)), "1000.0")

        print("\n[3] RECOMPUTE IS IDEMPOTENT (replay safety, §3.1)")
        before = balances(conn)
        for _ in range(3):
            store.recompute_balances(conn)
        conn.commit()
        check("running it repeatedly changes nothing", balances(conn), before)

        print("\n[4] OUT-OF-ORDER ARRIVAL STILL LANDS CORRECTLY")
        # A backfilled transaction dated BEFORE everything already posted.
        post(conn, acc["current"], "100.00", "debit", T0 - timedelta(days=30))
        store.recompute_balances(conn); conn.commit()
        check("a backdated debit is included", balances(conn)["current"], "13150.00")

        print("\n[5] RECONCILIATION — drift is detected")
        check("no alerts yet", len(open_alerts(conn)), 0)
        # Bank says the card has 9,000.00 available. We computed the same.
        snapshot(conn, acc["card"], "9000.00", T0 + timedelta(days=2))
        store.reconcile(conn); conn.commit()
        check("agreement raises nothing", len(open_alerts(conn)), 0)

        # Now the bank reports a figure we cannot account for — a missed message.
        snapshot(conn, acc["card"], "8790.00", T0 + timedelta(days=3))
        store.reconcile(conn); conn.commit()
        alerts = open_alerts(conn)
        check("drift raises exactly one alert", len(alerts), 1)
        check("on the right account", alerts[0]["slug"], "card")
        check("with the size of the gap", str(alerts[0]["delta"]), "210.00")

        print("\n[6] ALERTS DO NOT DUPLICATE EVERY TICK")
        for _ in range(5):
            store.reconcile(conn)
        conn.commit()
        check("still one open alert", len(open_alerts(conn)), 1)

        print("\n[7] AN EXPLAINED DRIFT RESOLVES ITSELF")
        # The missing 210 arrives late and is posted.
        post(conn, acc["card"], "210.00", "debit", T0 + timedelta(days=3))
        store.recompute_balances(conn)
        store.reconcile(conn); conn.commit()
        check("balance now agrees with the bank", balances(conn)["card"], "8790.00")
        check("alert closed automatically", len(open_alerts(conn)), 0)

        print("\n[8] UNRECONCILABLE ACCOUNTS NEVER CLAIM TO BE VERIFIED (§3.3b)")
        # SAIB-style: reports no balance. Even if a snapshot somehow exists,
        # a false alarm here would be worse than silence.
        post(conn, acc["savings"], "3000.00", "credit", T0)
        snapshot(conn, acc["savings"], "1.00", T0)
        store.recompute_balances(conn)
        store.reconcile(conn); conn.commit()
        check("savings balance still tracks transactions",
              balances(conn)["savings"], "53000.00")
        check("but raises no reconciliation alert",
              [a["slug"] for a in open_alerts(conn)], [])

        print("\n[9] NON-POSTED STATES ARE EXCLUDED")
        conn.execute(
            """INSERT INTO transactions (account_id, posted_at, amount, direction, type, state)
               VALUES (%s,%s,'999.00','debit','purchase','declined')""",
            (acc["current"], T0))
        conn.commit()
        store.recompute_balances(conn); conn.commit()
        check("a declined transaction does not move the balance",
              balances(conn)["current"], "13150.00")

    print()
    if all(checks):
        print("=" * 70)
        print(f"ALL {len(checks)} BALANCE + RECONCILIATION CHECKS PASS")
        print("=" * 70)
        return 0
    print(f"{checks.count(False)} of {len(checks)} FAILED")
    return 1


def serve_and_run():
    server = os.path.join(HERE, "..", "web", "scripts", "pgserver.mjs")
    proc = subprocess.Popen(["node", server, str(PORT)],
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
