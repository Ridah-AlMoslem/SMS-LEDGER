"""Language handling (SPEC §1, §10.4).

English is out of scope by decision, confirmed 2026-08-12 — not an untested
gap. That decision has two consequences worth pinning, and they point in
opposite directions:

  Nothing English may PARSE. There is no English template and there should not
  be one until an English message actually arrives.

  Something English must still be SAFELY HANDLED. An English OTP or decline has
  to be discarded, not treated as a transaction. §7.1 calls an OTP reaching the
  ledger the most expensive misclassification in the system.

Without this file, the English patterns in classify.py look like dead code
covering a case that never happens, and the next person deletes them.
"""

import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

from ledger.classify import classify                    # noqa: E402
from ledger.normalize import detect_language            # noqa: E402
from ledger.pipeline import parse_message               # noqa: E402
from ledger.registry import T, match                    # noqa: E402

IDENT = {("SAIB", "7001"): "saib_current", ("AlRajhiBank", "0256"): "alrajhi_card"}
NOW = datetime(2026, 8, 12, 12, 0)

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


print("\n[1] A LATIN MERCHANT NAME DOES NOT MAKE A MESSAGE ENGLISH")
# This is why the earlier 'mixed' classification was useless: it fired on most
# normal purchases, so it could not be used as a signal for anything.
ARABIC_WITH_LATIN_MERCHANT = """شراء عبر نقاط البيع
بطاقة:0256 ;فيزا
لدى:TAMIMI MARKETS
مبلغ:15 SAR
رصيد:10588.54 SAR
؜11/8/26 8:08"""
check("Arabic message naming a Latin merchant is 'ar'",
      detect_language(ARABIC_WITH_LATIN_MERCHANT), "ar")
check("even with two Latin words", detect_language("لدى: TAMIMI MARKETS"), "ar")
check("a genuinely English message is 'en'",
      detect_language("Dear customer, a purchase of SAR 250.00 was made"), "en")
check("digits alone are 'unknown'", detect_language("113.00 250"), "unknown")

print("\n[2] NO TEMPLATE IS ENGLISH")
import re  # noqa: E402
english_templates = [t["id"] for t in T if not re.search(r"[؀-ۿ]", t["rx"].pattern)]
check("every template anchors on Arabic text", english_templates, [])

print("\n[3] AN ENGLISH FINANCIAL MESSAGE PARKS — it never parses")
EN_PURCHASE = "Dear customer, a purchase of SAR 250.00 was made on your account XXX7001 at IKEA."
r = parse_message("SAIB", EN_PURCHASE, NOW, IDENT)
check("does not parse", r.status, "needs_review")
check("posts nothing", len(r.legs), 0)
check("tagged as English", r.language, "en")
check("no template claimed it", match("SAIB", EN_PURCHASE)[0], None)

print("\n[4] AN ENGLISH OTP IS STILL DISCARDED  (§7.1)")
# The guard that must survive. An OTP carries an amount and a currency, so an
# amount-first parser books it and doubles a real payment.
for body in [
    "Your verification code is 4471. Do not share it.",
    "Your OTP is 883021 for a payment of SAR 113.00",
    "Your one-time password is 5567",
    "Account Code is 8891",
]:
    r = parse_message("SAIB", body, NOW, IDENT)
    check(f"ignored: {body[:38]!r}", (r.status, len(r.legs)), ("ignored", 0))
    check("  reason is otp", r.ignored_reason, "otp")

print("\n[5] AN ENGLISH DECLINE IS STILL DISCARDED")
for body in [
    "Your transaction was declined.",
    "Payment failed: insufficient funds on card 0256",
]:
    r = parse_message("AlRajhiBank", body, NOW, IDENT)
    check(f"ignored: {body[:38]!r}", (r.status, len(r.legs)), ("ignored", 0))

print("\n[6] AN ENGLISH STATEMENT NOTICE DOES NOT BECOME A TRANSACTION")
r = parse_message("AlRajhiBank", "Your statement is ready. Minimum due SAR 250.00", NOW, IDENT)
check("not a ledger entry", len(r.legs), 0)
check("not parsed", r.status != "parsed", True)

print("\n[7] ARABIC IS UNAFFECTED")
r = parse_message("AlRajhiBank", ARABIC_WITH_LATIN_MERCHANT,
                  datetime(2026, 8, 11, 8, 9), IDENT)
check("still parses", r.status, "parsed")
check("tagged 'ar'", r.language, "ar")
check("amount intact", r.legs[0]["amount"], 15.0)

print("\n[8] CLASSIFICATION IS LANGUAGE-BLIND WHERE IT MATTERS")
# The same event in both languages must reach the same non-ledger verdict.
check("Arabic OTP", classify("رمز التحقق 4471", "SAIB")["ledger_effect"], "none")
check("English OTP", classify("Your verification code is 4471", "SAIB")["ledger_effect"], "none")
check("Arabic decline", classify("لم تتم العملية", "SAIB")["ledger_effect"], "none")
check("English decline", classify("Transaction declined", "SAIB")["ledger_effect"], "none")

print()
if all(checks):
    print("=" * 70)
    print(f"ALL {len(checks)} LANGUAGE CHECKS PASS")
    print("=" * 70)
    sys.exit(0)
print(f"{checks.count(False)} of {len(checks)} FAILED")
sys.exit(1)
