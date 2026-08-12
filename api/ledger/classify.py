"""Message classification. Runs BEFORE field extraction (SPEC §7.1).

Order matters. An OTP authorising a payment contains an amount, a currency and a
timestamp, so any amount-first parser books it and double-counts every authorised
payment. Non-ledger classes are therefore matched first and short-circuit.
"""
import re
from .normalize import normalize

# (label, ledger_effect, patterns, whole_body) -- in order, first match wins.
# whole_body=True means the pattern must describe the ENTIRE message, not a line.
# Without it, `رصيد: 10720.52 SR` inside a card-payment message classifies the
# whole thing as a balance alert and the payment silently vanishes.
#
# The ENGLISH patterns below stay even though every attested message is Arabic
# and English is out of scope (SPEC §1). They are not there to parse English —
# no English template exists — they are there so an English OTP or decline is
# still DISCARDED rather than treated as a transaction. Classification failing
# open is the expensive direction: §7.1 calls an OTP reaching the ledger the
# single most costly misclassification in the system, because it silently
# doubles an authorised payment. Deleting these as dead code would remove a
# guard, not clutter.
RULES = [
 ("otp", "none", [
    r"رمز التحقق", r"كلمة مرور لمرة واحدة", r"لا تشارك الرمز", r"رمز:\s*\d",
    r"\bOTP\b", r"verification code", r"Account Code is", r"one[- ]time (?:pass|code)"], False),
 ("notification", "none", [
    r"New beneficiary activated", r"تم اعادة تعيين كلمة المرور", r"تم تفعيل خدمة",
    r"تفعيل خدمة تسجيل الدخول", r"بصمة (?:الوجه|الاصبع)"], False),
 ("declined", "none", [
    r"لم تتم", r"مرفوض", r"غير كافي", r"رصيد غير كاف", r"فشل",
    r"declined", r"insufficient"], False),
 ("statement", "statement", [
    r"كشف حساب", r"الحد الادنى للسداد", r"statement", r"minimum due"], False),
 ("balance_alert", "snapshot", [
    r"\A\s*رصيد(?:ك)?\s*[:：]?\s*[\d.,]+\s*SAR\s*\Z"], True),
 ("bill_payment", "ledger", [
    r"مدفوعات\s+\S+", r"سداد فاتورة", r"رقم الفاتورة", r"\bSADAD\b"], False),
 ("cashback_redeem", "ledger", [r"استرداد نقدي الي البطاقة"], False),
 ("cashback_accrual", "ledger", [r"استرجاع نقدي"], False),
 ("profit", "ledger", [r"ايداع ارباح", r"ارباح شهر", r"عايد"], False),
 ("salary", "ledger", [r"قيد راتب", r"راتب دائن", r"\bراتب\b"], False),
 ("card_payment", "ledger", [r"بطاقة فيزا\s*[:：]\s*سداد", r"سداد بـ"], False),
 ("transfer", "ledger", [
    r"حوالة", r"اضافة اموال", r"دفع قطة", r"استلام قطة"], False),
 ("purchase", "ledger", [
    r"شراء", r"عملية انترنت", r"نقاط البيع", r"نقاط بيع"], False),
 ("withdrawal", "ledger", [r"سحب نقدي", r"صراف"], False),
]
PROMO_SENDERS = {"Salla","Virgin-AD","ITHRA","SAB","iisal","Zid","Apple"}
BANK_SENDERS  = {"AlRajhiBank","SAIB","barq app","STC Bank"}

def classify(body: str, sender: str = "") -> dict:
    t = normalize(body)
    for label, effect, pats, whole in RULES:
        for p in pats:
            if re.search(p, t, re.I | (0 if whole else re.M)):
                if effect == "ledger" and sender:
                    # Known junk sender -> discard. UNKNOWN sender -> review, never
                    # discard: silently dropping a new bank is how months of data
                    # go missing without any visible error.
                    if sender in PROMO_SENDERS:
                        return {"kind": "promo", "ledger_effect": "none", "matched": p}
                    if sender not in BANK_SENDERS:
                        return {"kind": label, "ledger_effect": "review",
                                "matched": p, "note": "unrecognised sender"}
                return {"kind": label, "ledger_effect": effect, "matched": p}
    if sender in PROMO_SENDERS:
        return {"kind": "promo", "ledger_effect": "none", "matched": "sender"}
    return {"kind": "unknown", "ledger_effect": "review", "matched": None}
