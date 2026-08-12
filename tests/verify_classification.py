"""Classification must keep non-transactions out of the ledger (SPEC §7.1)."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
from ledger.classify import classify

CASES = [
 # --- the trap: OTPs that look exactly like payments ---
 ("SAIB", "كلمة مرور لمرة واحدة\nرمز: 2938\nل: دفعة سداد\nمبلغ: SAR 113.00\nفي: 2026-08-09 21:39:41\nلا تشارك الرمز", "otp"),
 ("SAIB", "رمز التحقق: 0137\nل: الدخول الى النظام\nفي: 07-29 22:07", "otp"),
 ("SAIB", "رمز التحقق: 0821\nالسبب: تفعيل خدمة تسجيل الدخول", "otp"),
 ("barq app", "رمز التحقق: 656230\nالخدمة: حوالة صادرة محلية\nالمبلغ: SAR 113.00", "otp"),
 ("STC Bank", "رمز التحقق 9798 ل: تحويل جهة اتصال بـ: 14.00 ريال\n*لا تشارك الرمز", "otp"),
 ("Apple", "Your Apple Account Code is: 910752. Don't share it with anyone.", "otp"),
 # --- notifications ---
 ("barq app", "New beneficiary activated: محمد أحمد عبدالله الفلان\nIBAN: **7001\nBank: INVESTMENT BANK", "notification"),
 ("SAIB", "تم اعادة تعيين كلمة المرور بنجاح.\nفي: 07-29 22:06", "notification"),
 # --- bills ---
 ("SAIB", "مدفوعات وزارة الداخلية\nمن: XXX7001\nمبلغ: SAR 113\nالجهة: المخالفات المرورية\nرقم الفاتورة: 1012412852", "bill_payment"),
 # --- real ledger messages must still classify correctly ---
 ("SAIB", "ايداع أرباح شهر يوليو لحساب البركة الادخاري\nبقيمة SAR 190.53\nفي حساب XXX7002", "profit"),
 ("SAIB", "قيد راتب دائن 13,120.45 SAR في 14:04 23-07\nحساب 0000xx17001 تاريخ استحقاق 07/25", "salary"),
 ("AlRajhiBank", "بطاقة فيزا:سداد بـSR 1000\nعبر0256;فيزا\nرصيد:10720.52 SR", "card_payment"),
 ("AlRajhiBank", "شراء عبر نقاط البيع\nبطاقة:0256 ;فيزا-ابل باي\nلدى:MODAWAR S\nمبلغ:15 SAR", "purchase"),
 ("SAIB", "حوالة صادرة: بين حساباتك\nمن: XXX7001\nمبلغ: SAR 113\nالى: XXX7002", "transfer"),
 ("barq app", "إضافة اموال\n12.0 SAR\nالبطاقة: **0256 , ابل باي", "transfer"),
 ("AlRajhiBank", "بطاقة ائتمانية استرجاع نقدي :\nتم إضافة 7.59 ريال إلى محفظة الاسترجاع النقدي", "cashback_accrual"),
 # --- junk senders ---
 ("Salla", "أصبحت حالة طلبك #277347310 [تم التنفيذ]", "promo"),
 ("Virgin-AD", "احصل على 30 ريال رصيد مجاني عند شحن رصيدك بـ 15 ريال أو أكثر!", "promo"),
]

fails = 0
for sender, body, want in CASES:
    got = classify(body, sender)
    ok = got["kind"] == want
    fails += not ok
    print(f"  {'PASS' if ok else 'FAIL'}  {sender:<12} -> {got['kind']:<17} (want {want})")
    if not ok: print(f"        matched: {got['matched']}")

led = [(s,b) for s,b,w in CASES if w in ("otp","notification","promo","declined")]
assert all(classify(b,s)["ledger_effect"] == "none" for s,b in led), \
    "an OTP/notification/promo reached the ledger"
print(f"\n  {len(led)} non-ledger messages, all with ledger_effect='none'")
assert fails == 0, f"{fails} classification failures"
print("\nALL CLASSIFICATION INVARIANTS PASS")
