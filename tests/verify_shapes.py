"""Shape hashing across every attested format (SPEC §3.2).

The shape hash is supposed to identify a message FORMAT, and everything
downstream assumes it: the review queue groups by it, `requeue_shape`
reprocesses by it, derived templates are keyed on it, and §3.2's economics —
"template count scales with formats (tens), not messages (thousands)" — is
simply false if it doesn't hold.

Two failure directions, and they pull against each other:

  too specific — merchant names leak into the shape, so one format becomes one
    shape per shop. Grouping does nothing and every merchant needs its own
    derivation. This was the actual behaviour until now.

  too general — two genuinely different formats collapse into one shape, so a
    template derived for one silently mis-parses the other. Worse, and the
    reason the header line is left untouched.

This file pins both.
"""

import os
import re
import sys
from datetime import datetime as D

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))
sys.path.insert(0, HERE)

from ledger.normalize import shape_hash  # noqa: E402
from ledger.registry import match  # noqa: E402
from scenario import Scenario  # noqa: E402

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


def corpus():
    """Every format the generator can produce, with varied merchants, plus the
    eight attested STC messages read from verify_stc.py so the two files cannot
    drift apart."""
    S = Scenario()
    S.salary(D(2026, 6, 25, 14, 4), 12500.0, D(2026, 6, 25))
    S.to_savings(D(2026, 6, 25, 20, 10), 3000)
    for i, m in enumerate(["TAMIMI MARKETS", "LAZEZ", "Zid", "Muvicinem", "DAWAR ALS"]):
        S.card_pos(D(2026, 6, 26, 13, 20 + i), 42.50 + i, m)
        S.card_online(D(2026, 6, 27, 10, 15 + i), 155.22 + i, m)
    for i, (cur, m) in enumerate([("USD", "ANTHROPIC"), ("GBP", "DELIVEROO")]):
        S.card_foreign(D(2026, 6, 28, 21, 5 + i), 12.57, cur, 62.89, 1.44, 5.0, m, "GBR")
    S.card_payment(D(2026, 7, 10, 10, 13), 500.0)
    S.cashback_accrual(D(2026, 6, 29, 10, 13), 5.85)
    S.cashback_redeem(D(2026, 7, 18, 10, 0), 30.0)
    S.profit(D(2026, 7, 23, 22, 34), 176.31, "يونيو")
    S.bill(D(2026, 7, 8, 21, 39), 113.0, "المخالفات المرورية", "1012412852")
    for i, m in enumerate(["FAL", "Cloud", "BARQ"]):
        S.barq_pos(D(2026, 7, 2, 8, 51 + i), 17.0 + i, m)
    S.barq_topup(D(2026, 7, 1, 21, 7), 120.0)

    msgs = [(s, b) for s, b, _ in S.msgs]
    src = open(os.path.join(HERE, "verify_stc.py"), encoding="utf-8").read()
    msgs += [("STC Bank", b) for b in re.findall(r'"ST-\d+": """(.*?)"""', src, re.S)]
    return msgs


MSGS = corpus()

print("\n[1] NO TWO FORMATS SHARE A SHAPE")
groups = {}
for sender, body in MSGS:
    tp, _ = match(sender, body)
    groups.setdefault(shape_hash(body), set()).add((sender, tp["id"] if tp else "NONE"))

collisions = {s: t for s, t in groups.items() if len(t) > 1}
for shape, templates in collisions.items():
    print(f"        COLLISION {shape}: {sorted(templates)}")
check("every shape maps to exactly one template", len(collisions), 0)
check("the corpus is broad enough to be meaningful", len(MSGS) >= 25, True)

print("\n[2] MERCHANT VARIATION DOES NOT FRAGMENT A FORMAT")


def pos(m):
    return (f"شراء عبر نقاط البيع\nبطاقة:مدى0256;مدى\nلدى: {m}\n"
            f"مبلغ: 42.50 SAR\nرصيد: 12000.00 SAR\n26/8/9 13:20")


def stc_internet(m):
    return f"عملية انترنت\nب: 5.5 SAR\nمن:{m}\nبطاقة:*5842\nفي:06/08/26 22:26"


for name, fn in [("AlRajhi POS", pos), ("STC internet", stc_internet)]:
    shapes = {shape_hash(fn(m)) for m in
              ["TAMIMI MARKETS", "LAZEZ", "Jarir Bookstore", "X", "Al Nahdi Pharmacy"]}
    check(f"{name}: five merchants, one shape", len(shapes), 1)

print("\n[3] AMOUNTS AND DATES STILL GENERALISE")
check("different amounts, same shape",
      len({shape_hash(pos("SHOP").replace("42.50", a)) for a in
           ["42.50", "1.00", "13,935.76"]}), 1)

print("\n[4] THE HEADER IS STILL STRUCTURAL")
# STC's Apple Pay header differs from its internet-purchase header only in
# Latin text. Collapsing it would merge two unrelated templates.
apple = "شراء Apple Pay\nمن:*1152\nب:8 SAR\nمن:Nasaq\nفي: 21/07/26 21:06"
internet = "شراء انترنت\nعبر: *5842, Visa\nب: 23.99 SAR\nمن: Google\nفي: 11/07/26 21:31"
check("Apple Pay and internet purchase stay distinct",
      shape_hash(apple) != shape_hash(internet), True)

other_header = apple.replace("شراء Apple Pay", "شراء نقاط بيع")
check("changing only the header changes the shape",
      shape_hash(apple) != shape_hash(other_header), True)

print("\n[5] STRUCTURE STILL MATTERS BELOW THE HEADER")
missing_line = "عملية انترنت\nب: 5.5 SAR\nبطاقة:*5842\nفي:06/08/26 22:26"
check("a format missing a field line is a different shape",
      shape_hash(stc_internet("X")) != shape_hash(missing_line), True)

print("\n[6] MEASURED EFFECT")
shapes = {shape_hash(b) for _, b in MSGS}
print(f"        {len(MSGS)} messages → {len(shapes)} shapes")
check("shapes are far fewer than messages", len(shapes) < len(MSGS) * 0.75, True)

print()
if all(checks):
    print("=" * 70)
    print(f"ALL {len(checks)} SHAPE CHECKS PASS")
    print("=" * 70)
    sys.exit(0)
print(f"{checks.count(False)} of {len(checks)} FAILED")
sys.exit(1)
