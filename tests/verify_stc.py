"""STC Bank templates, against raw attested text (SPEC §10.4.1, §8.2).

Every message body below is verbatim from the sample batch — pre-normalization,
with the original إلى/الى and في/فى spellings intact. That is deliberate: the
patterns are written in post-normalization spelling, so testing against
already-normalized text would prove only that the patterns match themselves.
"""

import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

from ledger.classify import classify              # noqa: E402
from ledger.pipeline import parse_message         # noqa: E402
from ledger.registry import match                 # noqa: E402

# STC cards are the account holder's own. The three-digit values (318, 713) are
# other people's accounts and deliberately absent.
IDENT = {("STC Bank", "5842"): "stc", ("STC Bank", "1152"): "stc"}

# Each message gets a received_at a minute after the timestamp it states,
# because that is what live ingest looks like. A single shared "now" would fail
# the 72-hour freshness window (§10.4.1 rule 3) for the older samples — which
# is the check working, not a bug. Backfill relaxes that window; live never does.
RECEIVED = {
    "ST-01": datetime(2026, 8, 8, 11, 45),
    "ST-02": datetime(2026, 8, 3, 16, 49),
    "ST-03": datetime(2026, 8, 8, 2, 14),
    "ST-04": datetime(2026, 8, 2, 10, 56),
    "ST-05": datetime(2026, 7, 17, 22, 55),
    "ST-06": datetime(2026, 8, 6, 22, 27),
    "ST-07": datetime(2026, 7, 21, 21, 7),
    "ST-08": datetime(2026, 7, 11, 21, 32),
}


def parsed(tid, identifiers=None):
    return parse_message("STC Bank", M[tid], RECEIVED[tid],
                         IDENT if identifiers is None else identifiers)

M = {
"ST-01": """حوالة داخلية صادرة
بـ:23ر.س
إلى:A ALMARHOON
الى:318
في:08/08/26 11:44""",

"ST-02": """دفع قطة
مبلغ:200.00 ر.س
إلى:MOHAMMAD QURAISH
في:03/08/26 16:48""",

"ST-03": """حوالة داخلية واردة
بـ:55 رس
من:A ALMAKHLOOK
من:713
في:08/08/26 02:13""",

"ST-04": """استلام قطة
مبلغ:68.50 ر.س
من:MOHAMMAD ALSHURAFA
في:02/08/26 10:55""",

"ST-05": """حوالة واردة (سريع)
59.00 رس
من RIDAH MOSLEM
من بنك ANB
حساب *692
17-07-2026 22:54
مرجع *F87C""",

"ST-06": """عملية انترنت
ب: 5.5 SAR
من:barq
بطاقة:*5842
في:06/08/26 22:26""",

"ST-07": """شراء Apple Pay
من:*1152
بـ:8 SAR
من:Nasaq
في: 21/07/26 21:06""",

"ST-08": """شراء إنترنت
عبر: *5842, Visa
ب: 23.99 SAR
من: Google
رسوم تحويل العملات: 1
ضريبة القيمة المضافة: 0.00 SAR
رسوم العملية: 0.48 SAR
إجمالى المبلغ المستحق: 24.47 SAR
الرصيد المتبقى: 944.78 SAR
الدولة: US
فى: 11/07/26 21:31""",
}

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


def fields(tid):
    tp, f = match("STC Bank", M[tid])
    assert tp is not None, f"{tid} matched no template"
    assert tp["id"] == tid, f"{M[tid][:20]!r} matched {tp['id']}, expected {tid}"
    return f


print("\n[1] EVERY FORMAT MATCHES ITS OWN TEMPLATE")
for tid in M:
    tp, _ = match("STC Bank", M[tid])
    check(f"{tid} matches", tp["id"] if tp else None, tid)

print("\n[2] CLASSIFICATION — all eight are ledger events")
for tid, body in M.items():
    c = classify(body, "STC Bank")
    check(f"{tid} is actionable", c["ledger_effect"], "ledger")

print("\n[3] OVERLOADED LABELS RESOLVE CORRECTLY")
# إلى and الى both fold to الي — name first, account second.
f = fields("ST-01")
check("ST-01 amount", f["amount"], 23.0)
check("ST-01 counterparty is the name", f["counterparty"], "A ALMARHOON")
check("ST-01 counterparty account is the digits", f["counterparty_account"], "318")
check("ST-01 leaves the account", f["direction"], "debit")

f = fields("ST-03")
check("ST-03 counterparty is the name", f["counterparty"], "A ALMAKHLOOK")
check("ST-03 counterparty account", f["counterparty_account"], "713")
check("ST-03 enters the account", f["direction"], "credit")

# Same two من: labels, opposite meanings — card first, merchant second.
f = fields("ST-07")
check("ST-07 first من: is the card", f["card"], "1152")
check("ST-07 second من: is the merchant", f["merchant"], "Nasaq")
check("ST-07 amount", f["amount"], 8.0)

print("\n[4] QATTA — person-to-person pools")
f = fields("ST-02")
check("ST-02 amount", f["amount"], 200.0)
check("ST-02 recipient", f["counterparty"], "MOHAMMAD QURAISH")
check("ST-02 is a debit", f["direction"], "debit")
f = fields("ST-04")
check("ST-04 amount", f["amount"], 68.50)
check("ST-04 is a credit", f["direction"], "credit")

print("\n[5] SARIE — the name is your own, and must not decide anything (§8.2)")
f = fields("ST-05")
check("ST-05 amount", f["amount"], 59.0)
check("ST-05 counterparty name captured", f["counterparty"], "RIDAH MOSLEM")
check("ST-05 counterparty bank", f["counterparty_bank"], "ANB")
check("ST-05 counterparty account", f["counterparty_account"], "692")
check("ST-05 reference", f["reference"], "*F87C")

print("\n[6] FOREIGN PURCHASE — total due wins over the base amount")
f = fields("ST-08")
check("amount is the TOTAL due, not 23.99", f["amount"], 24.47)
check("base converted amount kept separately", f["converted"], 23.99)
check("transaction fee", f["fee_amount"], 0.48)
check("VAT", f["vat"], 0.00)
check("base + fee reconciles to total",
      round(f["converted"] + f["fee_amount"], 2), f["amount"])
check("card", f["card"], "5842")
check("scheme", f["scheme"], "Visa")
check("merchant", f["merchant"], "Google")
check("country", f["country"], "US")
check("balance is reported — STC is partially reconcilable", f["balance"], 944.78)

print("\n[7] EVERY MESSAGE PARSES END TO END")
for tid in M:
    check(f"{tid} parsed", parsed(tid).status, "parsed")

print("\n[8] DATES RESOLVE, AND TWO FORMATS COEXIST")
check("ST-01 D/M/YY → 8 Aug", parsed("ST-01").posted_at, datetime(2026, 8, 8, 11, 44))
check("ST-05 DD-MM-YYYY → 17 Jul", parsed("ST-05").posted_at, datetime(2026, 7, 17, 22, 54))
check("ST-07 D/M/YY → 21 Jul", parsed("ST-07").posted_at, datetime(2026, 7, 21, 21, 6))
check("ST-08 FX purchase → 11 Jul", parsed("ST-08").posted_at, datetime(2026, 7, 11, 21, 31))

print("\n[9] ACCOUNT RESOLUTION")
for tid in ("ST-01", "ST-02", "ST-03", "ST-04", "ST-05"):
    check(f"{tid} posts to the STC account", parsed(tid).legs[0]["account"], "stc")

for tid in ("ST-06", "ST-07", "ST-08"):
    check(f"{tid} resolves via its card", parsed(tid).legs[0]["account"], "stc")

# An unknown card must park, never post. This is the guard that stops a card
# belonging to someone else from landing in your ledger (§8.3).
r = parsed("ST-07", {})
check("unknown card goes to review", r.status, "needs_review")
check("and posts nothing", len(r.legs), 0)

print("\n[10] NOTHING PRODUCES MORE THAN ONE LEG")
# No STC message names two owned accounts, so none should split.
for tid in M:
    check(f"{tid} single leg", len(parsed(tid).legs), 1)

print("\n[11] TRANSFERS TO UNOWNED ACCOUNTS ARE EXTERNAL")
for tid in ("ST-01", "ST-03", "ST-05"):
    check(f"{tid} not marked internal", parsed(tid).legs[0]["is_internal"], False)

print("\n[12] STALE MESSAGES ARE REJECTED, NOT GUESSED  (§10.4.1)")
stale = parse_message("STC Bank", M["ST-01"], datetime(2026, 8, 12, 12, 0), IDENT)
check("a 4-day-old message fails the live window", stale.status, "needs_review")
check("and says why", stale.error.startswith("date:"), True)

print()
if all(checks):
    print("=" * 70)
    print(f"ALL {len(checks)} STC CHECKS PASS")
    print("=" * 70)
    sys.exit(0)
print(f"{checks.count(False)} of {len(checks)} FAILED")
sys.exit(1)
