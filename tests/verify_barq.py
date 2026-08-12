"""Barq wallet templates, against raw attested text (SPEC §8.2, §8.3).

Barq was the last dark institution — 2 of 8 formats. The interesting ones are
the transfers, because a wallet message names only the OTHER side: the wallet
itself is implied by the sender, so a transfer between two accounts you own
arrives looking one-sided.
"""

import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

from ledger.classify import classify              # noqa: E402
from ledger.pipeline import parse_message         # noqa: E402
from ledger.registry import match                 # noqa: E402

# What the account holder actually owns, as Barq refers to it. The AlRajhi card
# funds top-ups; 7001 is the SAIB current account, which Barq names when money
# is sent there. 9936 and 8801 are other people.
IDENT = {
    ("barq app", "0256"): "alrajhi_card",
    ("barq app", "7001"): "saib_current",
}

M = {
"BQ-01": """إضافة اموال
 12.0 SAR
البطاقة: **0256 , ابل باي
2026-08-07 21:07""",

"BQ-02": """حوالة واردة داخلية
59.00 SAR
حساب المرسل: **9936
2026-07-17 20:51""",

"BQ-03": """حوالة صادرة محلية
مبلغ113.00SAR
رسوم0.00SAR
الى رضا مسلم
بنكINVESTMENT BANK
لحساب7001
2026-08-09 21:44""",

"BQ-04": """حوالة صادرة داخلية
المبلغ: 2692.00 SAR
إلى : **8801
2026-07-19 16:13""",

"BQ-05": """شراء نقاط بيع
مدى10.00 SAR
رصيد10.00
لدىLAZEZ
2026-08-07 21:08""",

"BQ-06": """شراء إنترنت
مدى 21.99 SAR
الرصيد0.00
ب:Cloud
حساب:**1625
2026-06-28 18:26""",

"BQ-07": """شراء نقاط البيع دولية
فيزا
المبلغ17.34 GBP (86.26 SAR)  الصرف ≈ 4.9747
الرصيد 48.62
لدى: WH
2026-06-20 16:53""",

"BQ-08": """شراء إنترنت
فيزا 12.57 GBP (62.89 SAR)
رصيد  35.34
لدى  DELIVEROO
2026-06-20 00:32""",
}

RECEIVED = {
    "BQ-01": datetime(2026, 8, 7, 21, 8),
    "BQ-02": datetime(2026, 7, 17, 20, 52),
    "BQ-03": datetime(2026, 8, 9, 21, 45),
    "BQ-04": datetime(2026, 7, 19, 16, 14),
    "BQ-05": datetime(2026, 8, 7, 21, 9),
    "BQ-06": datetime(2026, 6, 28, 18, 27),
    "BQ-07": datetime(2026, 6, 20, 16, 54),
    "BQ-08": datetime(2026, 6, 20, 0, 33),
}

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


def fields(tid):
    tp, f = match("barq app", M[tid])
    assert tp is not None, f"{tid} matched no template"
    assert tp["id"] == tid, f"{tid} matched {tp['id']}"
    return f


def parsed(tid, identifiers=None):
    return parse_message("barq app", M[tid], RECEIVED[tid],
                         IDENT if identifiers is None else identifiers,
                         "saib_current", "cashback_wallet")


print("\n[1] ALL EIGHT FORMATS MATCH THEIR OWN TEMPLATE")
for tid in M:
    tp, _ = match("barq app", M[tid])
    check(f"{tid} matches", tp["id"] if tp else None, tid)

print("\n[2] CLASSIFICATION")
for tid in M:
    check(f"{tid} is actionable", classify(M[tid], "barq app")["ledger_effect"], "ledger")

print("\n[3] TRANSFERS IN")
f = fields("BQ-02")
check("BQ-02 amount", f["amount"], 59.0)
check("BQ-02 sender account", f["from_account"], "9936")
check("BQ-02 is a credit", f["direction"], "credit")

print("\n[4] TRANSFER TO AN ACCOUNT YOU OWN PRODUCES TWO LEGS  (§8.2, AUDIT §4.5)")
f = fields("BQ-03")
check("BQ-03 amount", f["amount"], 113.0)
check("BQ-03 fee captured separately", f["fee_amount"], 0.0)
check("BQ-03 recipient account", f["to_account"], "7001")
check("BQ-03 counterparty bank", f["counterparty_bank"], "INVESTMENT BANK")

r = parsed("BQ-03")
check("two legs", len(r.legs), 2)
check("debit leaves the wallet",
      (r.legs[0]["account"], r.legs[0]["direction"]), ("barq", "debit"))
check("credit lands in the owned account",
      (r.legs[1]["account"], r.legs[1]["direction"]), ("saib_current", "credit"))
check("both internal", all(l["is_internal"] for l in r.legs), True)
check("net worth unchanged",
      sum(l["amount"] if l["direction"] == "credit" else -l["amount"] for l in r.legs), 0)

# Without the identifier, 7001 is a stranger's account and this is real spending.
r = parsed("BQ-03", {("barq app", "0256"): "alrajhi_card"})
check("unowned recipient gives one leg", len(r.legs), 1)
check("and is not internal", r.legs[0]["is_internal"], False)

print("\n[5] TRANSFER OUT TO A STRANGER STAYS ONE-SIDED")
f = fields("BQ-04")
check("BQ-04 amount", f["amount"], 2692.0)
check("BQ-04 recipient", f["to_account"], "8801")
r = parsed("BQ-04")
check("one leg", len(r.legs), 1)
check("debited from the wallet", r.legs[0]["account"], "barq")
check("not internal", r.legs[0]["is_internal"], False)

print("\n[6] PURCHASES")
f = fields("BQ-06")
check("BQ-06 amount", f["amount"], 21.99)
check("BQ-06 balance", f["balance"], 0.0)
check("BQ-06 merchant", f["merchant"], "Cloud")

print("\n[7] FOREIGN PURCHASES — the SAR figure is the amount")
f = fields("BQ-07")
check("BQ-07 charges the SAR total, not the GBP", f["amount"], 86.26)
check("BQ-07 keeps the original amount", f["original_amount"], 17.34)
check("BQ-07 original currency", f["original_currency"], "GBP")
check("BQ-07 fx rate", f["fx_rate"], 4.9747)
check("BQ-07 balance", f["balance"], 48.62)
check("BQ-07 merchant", f["merchant"], "WH")

f = fields("BQ-08")
check("BQ-08 charges the SAR total", f["amount"], 62.89)
check("BQ-08 original amount", f["original_amount"], 12.57)
check("BQ-08 balance", f["balance"], 35.34)
check("BQ-08 merchant", f["merchant"], "DELIVEROO")

print("\n[8] THE TWO `شراء انترنت` FORMATS DO NOT COLLIDE")
# Same header, different bodies. Matching the wrong one would read a foreign
# amount as a SAR amount, understating spend by the exchange rate.
check("mada variant", match("barq app", M["BQ-06"])[0]["id"], "BQ-06")
check("visa variant", match("barq app", M["BQ-08"])[0]["id"], "BQ-08")

print("\n[9] EVERYTHING PARSES END TO END")
for tid in M:
    check(f"{tid} parsed", parsed(tid).status, "parsed")

print("\n[10] DATES")
check("BQ-03 ISO date", parsed("BQ-03").posted_at, datetime(2026, 8, 9, 21, 44))
check("BQ-07 ISO date", parsed("BQ-07").posted_at, datetime(2026, 6, 20, 16, 53))

print("\n[11] TOP-UP STILL RESOLVES TO THE FUNDING CARD")
# BQ-01 names the AlRajhi card, and account resolution must prefer that over
# the wallet hint — the money leaves the card.
check("BQ-01 card", fields("BQ-01")["card"], "0256")

print()
if all(checks):
    print("=" * 70)
    print(f"ALL {len(checks)} BARQ CHECKS PASS")
    print("=" * 70)
    sys.exit(0)
print(f"{checks.count(False)} of {len(checks)} FAILED")
sys.exit(1)
