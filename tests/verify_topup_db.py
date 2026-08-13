"""Top-up linking on the DATABASE path, against real Postgres (SPEC §8.2.1).

tests/verify_topup_link.py already pins the pairing rule itself. This suite
exists because that rule used to be reachable only from `Pipeline.process_all`
— the in-memory harness — and never ran in production at all. DEPLOY.md listed
it under "Known gaps at switch-on": every wallet top-up and the card purchase
funding it were both counted, inflating spending by the amount topped up.

The fixture is the real batch of five messages collected 12–13 Aug 2026, and it
is a harder case than the one the pure suite tests. Three of the five are 8 SAR
within the same minute:

    AlRajhi   شراء انترنت  8.00  لـbarq        ← the money leaving the card
    Barq      اضافة اموال  8.00  card 0256     ← the same money arriving
    Barq      شراء نقاط بيع 8.00  لدىNasaq     ← the money then being SPENT

The first two are one movement and must not count as spending. The third is
real spending, for the same amount, in the same minute — and it is not a
coincidence that can be tuned out, because spending the wallet is the entire
reason the top-up happened. Amount and time cannot separate them. Only the card
can, which is why `transactions.card_last4` exists.

Run:  python3 tests/verify_topup_db.py --serve
"""

import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

import db as store                                    # noqa: E402
from ledger.normalize import shape_hash               # noqa: E402
from ledger.pipeline import body_hash, parse_message   # noqa: E402

PORT = int(os.environ.get("TEST_PG_PORT", "5434"))
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
    # slug,          name,           institution,   type,          liability, semantics, opening
    ("saib_current", "SAIB Current", "SAIB",        "checking",    False, "balance",          0.00),
    ("alrajhi_card", "AlRajhi Card", "AlRajhiBank", "credit_card", True,  "available_credit", 9610.09),
    ("barq",         "Barq Wallet",  "barq app",    "wallet",      False, "balance",          0.00),
    ("cashback_wallet", "Cashback",  "AlRajhiBank", "cashback_wallet", False, "balance",      0.00),
]

IDENTIFIERS = [
    ("AlRajhiBank", "card", "0256", "alrajhi_card"),
    ("barq app", "card", "0256", "alrajhi_card"),
    ("SAIB", "account", "7001", "saib_current"),
]

# Verbatim, as they arrived. Not cleaned up: the bidi marks, the stray spaces
# and the `SR`/`SAR` inconsistency are all things the normalizer has to survive,
# and a fixture that tidies them tests a message no bank ever sent.
CARD_POS_MOVIE = ("AlRajhiBank", """شراء عبر نقاط البيع
بطاقة:0256 ;فيزا-ابل باي
لدى:MOVIE CIN
مبلغ:116 SAR
رصيد:9494.09 SAR
؜12/8/26 19:38""", datetime(2026, 8, 12, 19, 38, tzinfo=RIYADH))

CARD_FUNDS_BARQ = ("AlRajhiBank", """شراء إنترنت بـSR 8
عبر0256;فيزا-ابل باي
لـbarq
رصيد:9486.09 SR
؜12/8/26 22:46""", datetime(2026, 8, 12, 22, 46, tzinfo=RIYADH))

BARQ_TOPUP = ("barq app", """إضافة اموال
 8.0 SAR
البطاقة: **0256 , ابل باي
2026-08-12 22:46""", datetime(2026, 8, 12, 22, 46, tzinfo=RIYADH))

BARQ_SPEND = ("barq app", """شراء نقاط بيع
مدى8.00 SAR
رصيد0.00
لدىNasaq
2026-08-12 22:46""", datetime(2026, 8, 12, 22, 46, tzinfo=RIYADH))

CARD_POS_MODAWAR = ("AlRajhiBank", """شراء عبر نقاط البيع
بطاقة:0256 ;فيزا-ابل باي
لدى:MODAWAR S
مبلغ:6 SAR
رصيد:9480.09 SAR
؜13/8/26 7:43""", datetime(2026, 8, 13, 7, 43, tzinfo=RIYADH))

BATCH = [CARD_POS_MOVIE, CARD_FUNDS_BARQ, BARQ_TOPUP, BARQ_SPEND, CARD_POS_MODAWAR]


def seed(conn):
    for slug, name, inst, typ, liab, sem, opening in ACCOUNTS:
        conn.execute(
            """INSERT INTO accounts (slug, name, institution, type, is_liability,
                                     balance_semantics, reconcilable,
                                     opening_balance, current_balance, credit_limit)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (slug) DO NOTHING""",
            (slug, name, inst, typ, liab, sem, inst != "SAIB", opening, opening,
             14000.00 if slug == "alrajhi_card" else None),
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
    pairs = store.link_topups(conn)
    conn.commit()
    store.recompute_balances(conn)
    conn.commit()
    return pairs


def spending(conn):
    """What the ledger calls spending: outward money that left your control."""
    row = conn.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE type IN ('purchase', 'bill_payment')
             AND NOT is_internal_transfer AND state = 'posted'"""
    ).fetchone()
    return float(row["total"])


def leg(conn, merchant):
    return conn.execute(
        """SELECT t.*, a.slug FROM transactions t JOIN accounts a ON a.id = t.account_id
           WHERE t.merchant_raw = %s""", (merchant,)).fetchone()


def balance(conn, slug):
    return float(conn.execute(
        "SELECT current_balance FROM accounts WHERE slug = %s", (slug,)
    ).fetchone()["current_balance"])


# --------------------------------------------------------------------- tests

def main():
    with store.connect(DSN) as conn:
        seed(conn)
        identifiers, slug_to_id = store.load_account_map(conn)

        print("\n[1] THE BATCH, ALL FIVE AT ONCE")
        reset(conn)
        for msg in BATCH:
            ingest(conn, msg)
        pairs = tick(conn, identifiers, slug_to_id)

        check("every message parsed", conn.execute(
            "SELECT count(*) c FROM raw_messages WHERE status = 'parsed'"
        ).fetchone()["c"], 5)
        check("five legs posted", conn.execute(
            "SELECT count(*) c FROM transactions").fetchone()["c"], 5)
        check("exactly one top-up pair linked", pairs, 1)

        print("\n[2] THE PAIR IS INTERNAL AND GROUPED")
        funding = leg(conn, "barq")           # AlRajhi purchase, merchant 'barq'
        topup = conn.execute(
            "SELECT * FROM transactions WHERE parser_kind = 'wallet_topup'").fetchone()
        check("the AlRajhi funding leg is internal", funding["is_internal_transfer"], True)
        check("the Barq top-up leg is internal", topup["is_internal_transfer"], True)
        check("both carry a transfer group",
              funding["transfer_group_id"] is not None, True)
        check("and it is the SAME group",
              funding["transfer_group_id"] == topup["transfer_group_id"], True)
        check("the funding leg sits on the card", funding["slug"], "alrajhi_card")
        check("the card is recorded on the leg", funding["card_last4"], "0256")

        print("\n[3] THE SAME-MINUTE 8.00 WALLET PURCHASE IS NOT SWALLOWED")
        # The whole reason card_last4 is stored. This purchase matches the
        # top-up on amount and on minute; only the absent card separates them.
        nasaq = leg(conn, "Nasaq")
        check("Nasaq purchase is 8.00 in the same minute as the top-up",
              (float(nasaq["amount"]), nasaq["posted_at"] == topup["posted_at"]),
              (8.0, True))
        check("it is NOT marked internal", nasaq["is_internal_transfer"], False)
        check("it was NOT absorbed into the group", nasaq["transfer_group_id"], None)
        check("it carries no card, which is what saved it", nasaq["card_last4"], None)

        print("\n[4] SPENDING  — the number this was all for")
        check("spending is 130.00, not 138.00", spending(conn), 130.00)

        print("\n[5] BALANCES STILL RECONCILE")
        # Linking changes classification only. Both legs still moved money, so
        # neither balance may shift — if one did, the fix would have traded a
        # reporting bug for an accounting one.
        check("card matches the last رصيد it printed", balance(conn, "alrajhi_card"), 9480.09)
        check("wallet matches its last رصيد", balance(conn, "barq"), 0.00)
        check("no reconciliation alert raised", len(store.reconcile(conn)), 0)

        print("\n[6] IDEMPOTENT  — the tick runs every minute")
        before = spending(conn)
        groups_before = conn.execute(
            "SELECT count(DISTINCT transfer_group_id) c FROM transactions "
            "WHERE transfer_group_id IS NOT NULL").fetchone()["c"]
        for _ in range(3):
            check("re-running the tick links nothing new",
                  tick(conn, identifiers, slug_to_id), 0)
        check("spending unchanged by re-ticking", spending(conn), before)
        check("no second group created", conn.execute(
            "SELECT count(DISTINCT transfer_group_id) c FROM transactions "
            "WHERE transfer_group_id IS NOT NULL").fetchone()["c"], groups_before)

        print("\n[7] SPLIT ACROSS TICKS  — top-up first, funding message later")
        # The realistic failure. Two senders, two automations, one tick every
        # minute: the two halves land on different ticks more often than not.
        # An implementation that retires a top-up on first sight passes [1] and
        # fails here.
        reset(conn)
        ingest(conn, BARQ_TOPUP)
        check("top-up alone links no pair", tick(conn, identifiers, slug_to_id), 0)
        orphan = conn.execute(
            "SELECT * FROM transactions WHERE parser_kind = 'wallet_topup'").fetchone()
        check("an unpaired top-up is still internal on sight",
              orphan["is_internal_transfer"], True)
        check("but keeps no group, so it stays eligible",
              orphan["transfer_group_id"], None)

        ingest(conn, CARD_FUNDS_BARQ)
        check("the funding message arriving later still pairs",
              tick(conn, identifiers, slug_to_id), 1)
        check("retro-linked leg is internal", leg(conn, "barq")["is_internal_transfer"], True)
        check("and shares the top-up's group", conn.execute(
            "SELECT count(DISTINCT transfer_group_id) c FROM transactions "
            "WHERE transfer_group_id IS NOT NULL").fetchone()["c"], 1)

        print("\n[8] REVERSE ORDER  — funding message first")
        reset(conn)
        ingest(conn, CARD_FUNDS_BARQ)
        check("a card purchase alone is ordinary spending",
              tick(conn, identifiers, slug_to_id), 0)
        check("and counts as spending until the top-up shows up",
              spending(conn), 8.00)
        ingest(conn, BARQ_TOPUP)
        check("the top-up arriving later pairs retroactively",
              tick(conn, identifiers, slug_to_id), 1)
        check("and the spending is withdrawn", spending(conn), 0.00)

        print("\n[9] A REAL PURCHASE OF THE SAME AMOUNT IS NEVER ABSORBED")
        # Guard against fixing double-counting by hiding real spending, which
        # is the same bug facing the other way.
        reset(conn)
        for msg in (BARQ_TOPUP, CARD_POS_MOVIE, CARD_POS_MODAWAR):
            ingest(conn, msg)
        tick(conn, identifiers, slug_to_id)
        check("the two genuine card purchases still count", spending(conn), 122.00)
        check("MOVIE CIN untouched", leg(conn, "MOVIE CIN")["is_internal_transfer"], False)
        check("MODAWAR S untouched", leg(conn, "MODAWAR S")["is_internal_transfer"], False)

    print()
    if all(checks):
        print("=" * 70)
        print(f"ALL {len(checks)} TOP-UP LINKING CHECKS PASS ON THE DB PATH")
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
