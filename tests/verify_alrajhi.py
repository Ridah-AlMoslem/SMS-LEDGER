"""AlRajhi templates, against raw attested text (SPEC §3.3a, §11.5).

Two things here are unlike any other institution:

  The card's `رصيد` is AVAILABLE CREDIT, not debt. Confirmed by the account
  holder: total 14,000, and the figure falls with each purchase. Reading it as
  debt turns a liability into an asset and moves net worth by roughly the
  credit limit.

  Cashback is a TWO-STAGE flow. Points accrue into a separate wallet, and a
  later message moves them onto the card. Booking both as income double-counts;
  booking only the redemption understates and delays it (§11.5).
"""

import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

from ledger.classify import classify              # noqa: E402
from ledger.pipeline import parse_message         # noqa: E402
from ledger.registry import match                 # noqa: E402

# 0824 is the current account, 0256 the credit card. Only AR-01 ever names the
# current account.
IDENT = {
    ("AlRajhiBank", "0824"): "alrajhi_current",
    ("AlRajhiBank", "0256"): "alrajhi_card",
}
CARD_LIMIT = 14000.0

M = {
"AR-01": """		حوالة داخلية واردة بـSR 1000
لـ0824
من4458;حسين المرهون
26/8/9 22:53""",

"AR-02": """شراء عبر نقاط البيع
بطاقة:0256 ;فيزا-ابل باي
لدى:MODAWAR S
مبلغ:15 SAR
رصيد:10588.54 SAR
؜11/8/26 8:08""",

"AR-03": """شراء إنترنت بـSR 150
عبر0256;فيزا-ابل باي
لـMuvicinem
رصيد:10694.44 SR
؜5/8/26 17:03""",

"AR-04": """شراء انترنت
بطاقة: 0256 ;فيزا
مبلغ: 23 USD (86.37 ريال)
لدى: ANTHROPIC
رسوم وضريبة: 1.99 SAR
سعر الصرف~ 3.755217
إجمالي المبلغ المستحق: 88.36 SAR
دولة: USA
رصيد: 12912.9 SAR
؜ 29/7/26 14:33""",

"AR-05": """بطاقة فيزا:سداد بـSR 1000
عبر0256;فيزا
رصيد:10720.52 SR
؜10/8/26 10:13""",

"AR-06": """بطاقة ائتمانية استرجاع نقدي :
تم إضافة 7.59 ريال إلى محفظة الاسترجاع النقدي لبطاقة كاش باك بلس""",

"AR-07": """استرداد نقدي إلى البطاقة:
تم استرداد و إضافة 215.00 ريال مبلغ الاسترداد النقدي إلى رصيد بطاقتك 0256""",
}

RECEIVED = {
    "AR-01": datetime(2026, 8, 9, 22, 54),
    "AR-02": datetime(2026, 8, 11, 8, 9),
    "AR-03": datetime(2026, 8, 5, 17, 4),
    "AR-04": datetime(2026, 7, 29, 14, 34),
    "AR-05": datetime(2026, 8, 10, 10, 14),
    "AR-06": datetime(2026, 8, 11, 10, 14),
    "AR-07": datetime(2026, 8, 11, 10, 15),
}

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


def fields(tid):
    tp, f = match("AlRajhiBank", M[tid])
    assert tp is not None and tp["id"] == tid, f"{tid} matched {(tp or {}).get('id')}"
    return f


def parsed(tid):
    return parse_message("AlRajhiBank", M[tid], RECEIVED[tid], IDENT,
                         "alrajhi_current", "cashback_wallet")


print("\n[1] ALL SEVEN FORMATS MATCH")
for tid in M:
    tp, _ = match("AlRajhiBank", M[tid])
    check(f"{tid} matches", tp["id"] if tp else None, tid)

print("\n[2] CLASSIFICATION")
for tid in M:
    check(f"{tid} is actionable", classify(M[tid], "AlRajhiBank")["ledger_effect"], "ledger")

print("\n[3] INCOMING TO THE CURRENT ACCOUNT — the only format that names it")
f = fields("AR-01")
check("amount", f["amount"], 1000.0)
check("destination is the current account", f["to_account"], "0824")
check("sender account", f["from_account"], "4458")
check("sender name", f["counterparty"], "حسين المرهون")
r = parsed("AR-01")
check("credited to alrajhi_current", r.legs[0]["account"], "alrajhi_current")
check("as a credit", r.legs[0]["direction"], "credit")
check("not internal — 4458 is a stranger", r.legs[0]["is_internal"], False)
check("YY/M/D date", r.posted_at, datetime(2026, 8, 9, 22, 53))

print("\n[4] CARD BALANCE IS AVAILABLE CREDIT  (§3.3a)")
# Confirmed by the account holder: 14,000 total, falling with each purchase.
f = fields("AR-02")
check("purchase amount", f["amount"], 15.0)
check("reported figure", f["balance"], 10588.54)
check("so debt is limit − reported",
      round(CARD_LIMIT - f["balance"], 2), 3411.46)
check("a purchase is a debit", f["direction"], "debit")

f = fields("AR-05")
check("a payment is a CREDIT on the card", f["direction"], "credit")
check("and raises available credit", f["balance"], 10720.52)
check("payment amount", f["amount"], 1000.0)

r = parsed("AR-05")
check("payment produces two legs", len(r.legs), 2)
check("card credited", (r.legs[0]["account"], r.legs[0]["direction"]),
      ("alrajhi_card", "credit"))
check("funding account debited", (r.legs[1]["account"], r.legs[1]["direction"]),
      ("alrajhi_current", "debit"))
check("net worth unchanged by paying a card",
      sum(l["amount"] if l["direction"] == "credit" else -l["amount"] for l in r.legs), 0)

print("\n[5] FOREIGN PURCHASE — the total due is the amount")
f = fields("AR-04")
check("charges the total, not the converted subtotal", f["amount"], 88.36)
check("converted subtotal kept", f["converted"], 86.37)
check("fee and VAT", f["fee_amount"], 1.99)
check("subtotal + fee reconciles", round(f["converted"] + f["fee_amount"], 2), f["amount"])
check("original amount", f["original_amount"], 23.0)
check("original currency", f["original_currency"], "USD")
check("fx rate", f["fx_rate"], 3.755217)
check("country", f["country"], "USA")

print("\n[6] CASHBACK IS TWO STAGES, NOT ONE  (§11.5)")
# Accrual lands in the wallet; redemption moves it to the card. Counting both
# as income doubles it.
f = fields("AR-06")
check("accrual amount", f["amount"], 7.59)
check("accrual is a credit", f["direction"], "credit")
r = parsed("AR-06")
check("accrual goes to the cashback wallet, not the card",
      r.legs[0]["account"], "cashback_wallet")
check("one leg", len(r.legs), 1)

f = fields("AR-07")
check("redemption amount", f["amount"], 215.0)
check("names the card", f["card"], "0256")
r = parsed("AR-07")
check("redemption moves wallet → card", len(r.legs), 2)
check("card credited", (r.legs[0]["account"], r.legs[0]["direction"]),
      ("alrajhi_card", "credit"))
check("wallet debited", (r.legs[1]["account"], r.legs[1]["direction"]),
      ("cashback_wallet", "debit"))
check("redemption is not income — it moves money already earned",
      sum(l["amount"] if l["direction"] == "credit" else -l["amount"] for l in r.legs), 0)

print("\n[7] EVERYTHING PARSES END TO END")
for tid in M:
    check(f"{tid} parsed", parsed(tid).status, "parsed")

print("\n[8] SR AND SAR ARE THE SAME TOKEN")
# AR-03 and AR-05 print `SR`, everything else `SAR`. The normalizer folds both.
check("AR-03 amount", fields("AR-03")["amount"], 150.0)
check("AR-03 balance", fields("AR-03")["balance"], 10694.44)

print()
if all(checks):
    print("=" * 70)
    print(f"ALL {len(checks)} ALRAJHI CHECKS PASS")
    print("=" * 70)
    sys.exit(0)
print(f"{checks.count(False)} of {len(checks)} FAILED")
sys.exit(1)
