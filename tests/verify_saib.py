"""SAIB templates, against raw attested text (SPEC §8.2, §8.3).

SAIB is the account that matters most and the one the system can verify least:
it holds the salary, the current account and the savings, and it reports a
balance in no message at all. Every figure here is inferred from message flow
against an opening balance, so a missed or misread transfer never self-corrects.

The two transfer directions between own accounts are covered explicitly,
because a template that only works one way would silently invert half of them.
"""

import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

from ledger.classify import classify              # noqa: E402
from ledger.pipeline import parse_message         # noqa: E402
from ledger.registry import match                 # noqa: E402

# Barq custodies client money at ANB, so money moving between the wallet and a
# bank account appears here as a transfer to/from that ANB account, carrying the
# account holder's own name (§8.2 — the name decides nothing, the account does).
IDENT = {
    ("SAIB", "7001"): "saib_current",
    ("SAIB", "7002"): "saib_savings",
    ("SAIB", "0018"): "barq",
    ("SAIB", "1625"): "barq",
}

M = {
"SA-01": """حوالة واردة: محلية (مقبوله)
من: XXXX0018
 RIDAH AL MOSLEM
عبر: البنك العربي الوطني
مبلغ: SAR 113
الى: XXXX7001
في: 08-09 21:44""",

"SA-02-out": """حوالة صادرة: بين حساباتك
من: XXX7001
مبلغ: SAR 113
الى: XXX7002
في: 08-09 21:45""",

"SA-02-back": """حوالة صادرة: بين حساباتك
من: XXX7002
مبلغ: SAR 113
الى: XXX7001
في: 08-09 21:38""",

"SA-03": """حوالة محلية
المصرفARNB
المبلغSAR 4,534.07
منX7001
الى:BARQ SAFE AND DEPOSIT CLIENT MONEY
الىX1625
الرسوم SAR 0
في07-25 08:49""",

"SA-04": """قيد راتب دائن 13,120.45 SAR في 14:04 23-07
حساب 0341xx17001 تاريخ استحقاق 07/25""",

"SA-05": """ايداع أرباح شهر يوليو لحساب البركة الادخاري
بقيمة SAR 190.53
في حساب XXX7002
بتاريخ 07-31 22:34""",
}

RECEIVED = {
    "SA-01": datetime(2026, 8, 9, 21, 45),
    "SA-02-out": datetime(2026, 8, 9, 21, 46),
    "SA-02-back": datetime(2026, 8, 9, 21, 39),
    "SA-03": datetime(2026, 7, 25, 8, 50),
    "SA-04": datetime(2026, 7, 23, 14, 5),
    "SA-05": datetime(2026, 7, 31, 22, 35),
}

EXPECT_TEMPLATE = {
    "SA-01": "SA-01", "SA-02-out": "SA-02", "SA-02-back": "SA-02",
    "SA-03": "SA-03", "SA-04": "SA-04", "SA-05": "SA-05",
}

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


def fields(key):
    tp, f = match("SAIB", M[key])
    assert tp is not None, f"{key} matched no template"
    return f


def parsed(key, identifiers=None):
    return parse_message("SAIB", M[key], RECEIVED[key],
                         IDENT if identifiers is None else identifiers,
                         "saib_current", "cashback_wallet")


print("\n[1] EVERY FORMAT MATCHES ITS TEMPLATE")
for key, want in EXPECT_TEMPLATE.items():
    tp, _ = match("SAIB", M[key])
    check(f"{key} → {want}", tp["id"] if tp else None, want)

print("\n[2] CLASSIFICATION")
for key in M:
    check(f"{key} is actionable", classify(M[key], "SAIB")["ledger_effect"], "ledger")

print("\n[3] INCOMING FROM BARQ'S CUSTODY ACCOUNT  (§8.2)")
f = fields("SA-01")
check("amount", f["amount"], 113.0)
check("sending account", f["from_account"], "0018")
check("sender name captured but unused", f["counterparty"], "RIDAH AL MOSLEM")
check("sending bank", f["counterparty_bank"], "البنك العربي الوطني")
check("lands in the current account", f["to_account"], "7001")

r = parsed("SA-01")
check("two legs — this is the wallet, not a stranger", len(r.legs), 2)
check("debit leaves the wallet", (r.legs[0]["account"], r.legs[0]["direction"]),
      ("barq", "debit"))
check("credit reaches current", (r.legs[1]["account"], r.legs[1]["direction"]),
      ("saib_current", "credit"))
check("internal", all(l["is_internal"] for l in r.legs), True)
check("so it is NOT income — net worth does not move",
      sum(l["amount"] if l["direction"] == "credit" else -l["amount"] for l in r.legs), 0)

# Without the identifier it reads as money arriving from outside, which is
# what it looked like before Barq's custody arrangement was known.
r = parsed("SA-01", {("SAIB", "7001"): "saib_current"})
check("unregistered sender falls back to one external leg", len(r.legs), 1)
check("and is not internal", r.legs[0]["is_internal"], False)

print("\n[4] BOTH DIRECTIONS BETWEEN OWN ACCOUNTS")
r = parsed("SA-02-out")
check("current → savings: two legs", len(r.legs), 2)
check("debit leaves current", (r.legs[0]["account"], r.legs[0]["direction"]),
      ("saib_current", "debit"))
check("credit reaches savings", (r.legs[1]["account"], r.legs[1]["direction"]),
      ("saib_savings", "credit"))

r = parsed("SA-02-back")
check("savings → current: two legs", len(r.legs), 2)
check("debit leaves savings", (r.legs[0]["account"], r.legs[0]["direction"]),
      ("saib_savings", "debit"))
check("credit reaches current", (r.legs[1]["account"], r.legs[1]["direction"]),
      ("saib_current", "credit"))
check("neither direction moves net worth",
      sum(l["amount"] if l["direction"] == "credit" else -l["amount"] for l in r.legs), 0)

print("\n[5] OUTGOING TO ANOTHER BANK")
f = fields("SA-03")
check("thousands separator parsed", f["amount"], 4534.07)
check("sending account", f["from_account"], "7001")
check("recipient bank", f["counterparty_bank"], "ARNB")
check("recipient name", f["counterparty"], "BARQ SAFE AND DEPOSIT CLIENT MONEY")
check("recipient account", f["to_account"], "1625")
check("zero fee still captured", f["fee_amount"], 0.0)

# 1625 is Barq's custody account: this is topping up the wallet, not spending.
r = parsed("SA-03")
check("two legs", len(r.legs), 2)
check("debit leaves current", (r.legs[0]["account"], r.legs[0]["direction"]),
      ("saib_current", "debit"))
check("credit reaches the wallet", (r.legs[1]["account"], r.legs[1]["direction"]),
      ("barq", "credit"))
check("internal — 4,534.07 is not spending",
      all(l["is_internal"] for l in r.legs), True)
check("net worth unmoved",
      sum(l["amount"] if l["direction"] == "credit" else -l["amount"] for l in r.legs), 0)

print("\n[6] SALARY AND PROFIT UNCHANGED")
f = fields("SA-04")
check("salary amount read from the message", f["amount"], 13120.45)
check("due date drives the cycle", f["due_raw"], "07/25")
check("salary cycle is August, not July", parsed("SA-04").cycle, "August 2026")

f = fields("SA-05")
check("profit amount", f["amount"], 190.53)
check("into savings", f["to_account"], "7002")
check("profit is income, not a transfer", fields("SA-05").get("direction"), "credit")

print("\n[7] DATES — MM-DD, year inferred")
check("SA-01", parsed("SA-01").posted_at, datetime(2026, 8, 9, 21, 44))
check("SA-03", parsed("SA-03").posted_at, datetime(2026, 7, 25, 8, 49))
check("SA-05", parsed("SA-05").posted_at, datetime(2026, 7, 31, 22, 34))

print("\n[8] EVERYTHING PARSES END TO END")
for key in M:
    check(f"{key} parsed", parsed(key).status, "parsed")

print()
if all(checks):
    print("=" * 70)
    print(f"ALL {len(checks)} SAIB CHECKS PASS")
    print("=" * 70)
    sys.exit(0)
print(f"{checks.count(False)} of {len(checks)} FAILED")
sys.exit(1)
