"""Derived templates surviving a round trip through Postgres (SPEC §10.7).

verify_derive.py proves a template can be built and validated in memory. This
proves the thing that actually matters in use: derive from one parked message,
and the other messages of that shape parse on the next tick — without a code
change, without a deploy.

Run: python3 tests/verify_template_store.py --serve
"""

import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

import db as store  # noqa: E402
from ledger.derive import derive  # noqa: E402
from ledger.normalize import shape_hash  # noqa: E402
from ledger.pipeline import body_hash, parse_message  # noqa: E402

PORT = int(os.environ.get("TEST_PG_PORT", "5438"))
DSN = f"postgresql://postgres@127.0.0.1:{PORT}/postgres"
UTC = timezone.utc

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


# Three messages of a genuinely unsupported format — a cash withdrawal, which
# classifies as a ledger event and then matches no template.
#
# All three name the SAME ATM on purpose. shape_hash generalises digits but not
# free text, so a different merchant produces a different shape and therefore a
# different group. That is a real limitation, recorded in the README; this test
# covers what the code does, not what it ought to.
def barq(amount, balance, when, merchant="TAMIMI ATM"):
    return (f"سحب نقدي\nالمبلغ {amount} SAR\nالرصيد {balance}\n"
            f"الصراف {merchant}\n{when}")


MESSAGES = [
    barq("45.50", "158.51", "2026-08-09 14:22"),
    barq("210.75", "947.76", "2026-08-09 15:00"),
    barq("12.00", "935.76", "2026-08-09 16:30"),
]
# A different unsupported format, to prove a requeue does not spill across shapes.
OTHER_SHAPE = "ايداع نقدي\nالمبلغ 300.00 SAR\nالرصيد 1235.76\nالفرع RIYADH\n2026-08-09 17:00"


def seed(conn):
    conn.execute(
        """INSERT INTO accounts (slug, name, institution, type, opening_balance,
                                 current_balance, reconcilable)
           VALUES ('barq','Barq','barq app','wallet',0,0,true)""")
    conn.commit()


def ingest_all(conn):
    when = datetime(2026, 8, 9, 14, 25, tzinfo=UTC)
    ids = []
    for i, body in enumerate(MESSAGES + [OTHER_SHAPE]):
        at = when + timedelta(minutes=i)
        r = store.insert_raw_message(
            conn, "barq app", body, at, body_hash("barq app", body, at), shape_hash(body))
        ids.append(r["id"])
    conn.commit()
    return ids


def tick(conn):
    """Mirror of main.parse_tick, including loading derived templates."""
    identifiers, slug_to_id = store.load_account_map(conn)
    templates = store.load_templates(conn)
    claimed = store.claim_pending(conn, 50)
    conn.commit()
    for msg in claimed:
        result = parse_message(msg["sender"], msg["body"], msg["received_at"],
                               identifiers, "barq", "cashback_wallet",
                               templates=templates)
        store.record_outcome(conn, msg["id"], result, slug_to_id)
        conn.commit()
    store.recompute_balances(conn)
    conn.commit()
    return len(claimed)


def statuses(conn):
    return {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, count(*)::int n FROM raw_messages GROUP BY status").fetchall()}


def main():
    with store.connect(DSN) as conn:
        seed(conn)
        ingest_all(conn)

        print("\n[1] WITHOUT A TEMPLATE, EVERYTHING PARKS")
        tick(conn)
        s = statuses(conn)
        check("all four parked for review", s.get("needs_review"), 4)
        check("nothing posted",
              conn.execute("SELECT count(*) c FROM transactions").fetchone()["c"], 0)

        print("\n[2] DERIVE FROM ONE MESSAGE")
        parked = conn.execute(
            "SELECT id, body, shape_hash FROM raw_messages "
            "WHERE status='needs_review' ORDER BY received_at").fetchall()
        first = parked[0]

        template = derive(
            first["body"],
            {"amount": "45.50", "balance": "158.51",
             "merchant": "TAMIMI ATM", "date_raw": "2026-08-09 14:22"},
            kind="withdrawal", direction="debit", date_format="ISO",
            sender="barq app", account_hint="barq")

        template_id = store.save_template(conn, first["shape_hash"], template)
        requeued = store.requeue_shape(conn, first["shape_hash"])
        conn.commit()
        check("stored", bool(template_id), True)
        check("requeued every message of that shape", requeued, 3)
        check("the unrelated shape was left alone", statuses(conn).get("needs_review"), 1)

        print("\n[3] ONE DERIVATION RESOLVES THE WHOLE CLUSTER")
        tick(conn)
        s = statuses(conn)
        check("three parsed", s.get("parsed"), 3)
        check("the other format still parks", s.get("needs_review"), 1)
        check("three transactions posted",
              conn.execute("SELECT count(*) c FROM transactions").fetchone()["c"], 3)

        print("\n[4] THE VALUES ARE RIGHT, NOT JUST PRESENT")
        rows = conn.execute(
            "SELECT amount, direction, merchant_raw FROM transactions "
            "ORDER BY amount").fetchall()
        check("amounts", [str(r["amount"]) for r in rows],
              ["12.00", "45.50", "210.75"])
        check("all debits", {r["direction"] for r in rows}, {"debit"})
        check("merchant captured on every one",
              [r["merchant_raw"] for r in rows], ["TAMIMI ATM"] * 3)

        print("\n[5] BALANCES MOVED AS A RESULT")
        check("wallet reflects the three purchases",
              conn.execute("SELECT current_balance b FROM accounts "
                           "WHERE slug='barq'").fetchone()["b"],
              __import__("decimal").Decimal("-268.25"))

        print("\n[6] REDERIVING CORRECTS RATHER THAN DUPLICATES")
        fixed = derive(
            first["body"],
            {"amount": "45.50", "merchant": "TAMIMI ATM"},
            kind="withdrawal", direction="debit", sender="barq app", account_hint="barq")
        store.save_template(conn, first["shape_hash"], fixed)
        conn.commit()
        check("still one template for this shape",
              conn.execute("SELECT count(*) c FROM sms_templates "
                           "WHERE shape_hash=%s", (first["shape_hash"],)).fetchone()["c"], 1)

        print("\n[7] ALREADY-PARSED MESSAGES ARE NOT DISTURBED")
        again = store.requeue_shape(conn, first["shape_hash"])
        conn.commit()
        check("requeue skips messages that already parsed", again, 0)
        check("no duplicate transactions",
              conn.execute("SELECT count(*) c FROM transactions").fetchone()["c"], 3)

        print("\n[8] A BROKEN STORED TEMPLATE DOES NOT STOP THE TICK")
        conn.execute(
            """INSERT INTO sms_templates (sender, shape_hash, language, pattern,
                                          field_map, kind, created_by)
               VALUES ('barq app','deadbeef','ar','^(unclosed', '{}'::jsonb,
                       'purchase','manual')""")
        conn.commit()
        loaded = store.load_templates(conn)
        check("the invalid one is skipped, the good one survives", len(loaded), 1)

    print()
    if all(checks):
        print("=" * 70)
        print(f"ALL {len(checks)} TEMPLATE-STORE CHECKS PASS")
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
