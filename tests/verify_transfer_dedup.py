"""One movement described by two institutions books twice (SPEC §8.2.1).

Built from the REAL 2026-08-09 pair in samples/ANALYSIS.md §B2.4:

    Barq : حوالة صادرة محلية  113.00 → لحساب 7001   21:44
    SAIB : حوالة واردة محلية   SAR 113 من XXXX0018   21:44

Both messages parse correctly and each resolves both sides, so each books the
full movement. Four legs for one 113, and both balances move twice.

The tests below run the real parser over the real message text — not a model of
it — because the whole defect lives in the interaction between `_legs_for`
booking both sides and two institutions each describing the same event.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from ledger.pipeline import parse_message
from ledger.transfers import find_duplicate_descriptions

RIYADH = timezone(timedelta(hours=3))
RX = datetime(2026, 8, 9, 21, 50, tzinfo=RIYADH)

# The identifiers that make both sides resolvable — the same ones seeded in
# scripts/seed.sql. Barq's account at ANB ends 0018; SAIB names it that way.
IDENT = {
    ("barq app", "7001"): "saib_current",
    ("barq app", "0256"): "alrajhi_card",
    ("SAIB", "0018"): "barq",
    ("SAIB", "7001"): "saib_current",
    ("SAIB", "7002"): "saib_savings",
}

BARQ_OUT = (
    "barq app",
    "حوالة صادرة محلية\nمبلغ113.00SAR\nرسوم0.00SAR\nالى رضا مسلم\n"
    "بنكINVESTMENT BANK\nلحساب7001\n2026-08-09 21:44",
)
SAIB_IN = (
    "SAIB",
    "حوالة واردة: محلية (مقبوله)\nمن: XXXX0018 \n RIDAH AL MOSLEM\n"
    "عبر: البنك العربي الوطني \nمبلغ: SAR 113\nالى: XXXX7001 \nفي: 08-09 21:44",
)
# Same institution, same amount, same two accounts, a minute later — the
# ordinary Sunday-evening case from §8.2.2 that must NEVER be merged.
SAIB_INTERNAL = (
    "SAIB",
    "حوالة صادرة: بين حساباتك\nمن: XXX7001 \nمبلغ: SAR 113\nالى: XXX7002 \nفي: 08-09 21:45",
)

n = 0


def check(name, cond):
    global n
    assert cond, f"FAIL: {name}"
    n += 1
    print(f"  PASS  {name}")


def describe(sender, body, ts_offset=0):
    """Parse one message into the shape the deduper consumes."""
    r = parse_message(sender, body, RX, IDENT)
    assert r.status == "parsed", f"{sender} did not parse: {r.status} / {r.error}"
    return dict(
        id=f"{sender}:{body[:12]}",
        institution=sender,
        ts=r.posted_at + timedelta(seconds=ts_offset),
        legs=[
            dict(id=f"{sender}-{i}", account=leg["account"],
                 direction=leg["direction"], amount=leg["amount"])
            for i, leg in enumerate(r.legs)
        ],
    )


print("\n[1] THE DEFECT: ONE MOVEMENT, FOUR LEGS")
barq = describe(*BARQ_OUT)
saib = describe(*SAIB_IN)

check("Barq's own message books both sides", len(barq["legs"]) == 2)
check("SAIB's own message books both sides too", len(saib["legs"]) == 2)
check("so one 113 movement produces four legs", len(barq["legs"]) + len(saib["legs"]) == 4)
check(
    "every leg is internal, so SPENDING is unaffected — balances are the casualty",
    all(leg["direction"] in ("debit", "credit") for leg in barq["legs"] + saib["legs"]),
)

print("\n[2] THE ECHO IS COLLAPSED")
pairs = find_duplicate_descriptions([barq, saib])
check("exactly one description is superseded", len(pairs) == 1)
check("the earlier one is kept", pairs[0][0] == barq["id"] or pairs[0][0] == saib["id"])

kept = {p[0] for p in pairs}
dropped = {p[1] for p in pairs}
check("keeper and dropped are different messages", kept.isdisjoint(dropped))
check(
    "two legs survive, which is the real movement",
    sum(len(d["legs"]) for d in (barq, saib) if d["id"] not in dropped) == 2,
)

print("\n[3] SAME-INSTITUTION REPEATS ARE NEVER MERGED (§8.2.2)")
# The 113 hazard: 113.00 seven times in seven minutes across three accounts.
internal = describe(*SAIB_INTERNAL)
check(
    "a 7001->7002 move is a different signature from 0018->7001",
    find_duplicate_descriptions([saib, internal]) == [],
)

# Two byte-identical SAIB messages a minute apart are two real transfers.
twin_a = describe(*SAIB_INTERNAL)
twin_b = describe(*SAIB_INTERNAL, ts_offset=60)
twin_b["id"] = "SAIB:twin-b"
check(
    "two identical transfers from ONE bank stay two transfers",
    find_duplicate_descriptions([twin_a, twin_b]) == [],
)

print("\n[4] THE WINDOW AND THE GUARDS")
late = describe(*SAIB_IN)
late["id"] = "SAIB:late"
late["ts"] = barq["ts"] + timedelta(minutes=30)
check("an echo outside the window is left alone", find_duplicate_descriptions([barq, late]) == [])

one_leg = dict(barq, id="one-leg", legs=barq["legs"][:1])
check(
    "a one-sided description is never merged — its counterparty never resolved",
    find_duplicate_descriptions([one_leg, saib]) == [],
)

different_amount = describe(*SAIB_IN)
different_amount["id"] = "SAIB:other-amount"
different_amount["legs"] = [dict(l, amount=114.0) for l in different_amount["legs"]]
check("a different amount is a different movement", find_duplicate_descriptions([barq, different_amount]) == [])

print("\n[5] IDEMPOTENT AND STABLE")
check(
    "the same input picks the same keeper every run",
    find_duplicate_descriptions([barq, saib]) == find_duplicate_descriptions([saib, barq]),
)
check(
    "running over an already-collapsed set is a no-op",
    find_duplicate_descriptions([d for d in (barq, saib) if d["id"] not in dropped]) == [],
)

print(f"\n{'=' * 60}\nALL {n} TRANSFER-DEDUP CHECKS PASS\n{'=' * 60}")
