"""Two-month message generator. Emits messages in ATTESTED formats plus the
ground truth each one should produce, so the pipeline can be audited exactly.

Cycles are salary cycles (25th -> 24th):
  July 2026   : 2026-06-25 .. 2026-07-24
  August 2026 : 2026-07-25 .. 2026-08-24
"""
from datetime import datetime, timedelta

CARD_LIMIT = 14000.0

class Scenario:
    def __init__(self):
        self.msgs = []          # (sender, body, received_at)
        self.truth = []         # dicts describing expected ledger effect
        self.avail = 12000.0    # AlRajhi available credit (debt = LIMIT - avail)
        self.barq = 0.0
        self.expected_review = []

    def _add(self, sender, body, ts, cycle_ts=None, **truth):
        self.msgs.append((sender, body, ts))
        if truth:
            self.truth.append(dict(ts=ts, cycle_ts=cycle_ts or ts, sender=sender, **truth))

    # ---------- ledger messages, attested formats ----------
    def salary(self, ts, amount, due):
        self._add("SAIB", f"قيد راتب دائن {amount:,.2f} SAR في {ts:%H:%M} {ts:%d-%m}\n"
                          f"حساب 0000xx17001 تاريخ استحقاق {due:%m/%d}", ts,
                  cycle_ts=due, kind="salary", amount=amount, account="saib_current",
                  income="earned", expense=0.0)

    def profit(self, ts, amount, month):
        self._add("SAIB", f"ايداع أرباح شهر {month} لحساب البركة الادخاري\n"
                          f"بقيمة SAR {amount:.2f}\nفي حساب XXX7002 \n"
                          f"بتاريخ {ts:%m-%d} {ts:%H:%M}", ts,
                  kind="profit", amount=amount, account="saib_savings",
                  income="passive", expense=0.0)

    def to_savings(self, ts, amount):
        self._add("SAIB", f"حوالة صادرة: بين حساباتك\nمن: XXX7001 \nمبلغ: SAR {amount:g}\n"
                          f"الى: XXX7002 \nفي: {ts:%m-%d} {ts:%H:%M}", ts,
                  kind="transfer", amount=amount, account="saib_current",
                  internal=True, expense=0.0)

    def bill(self, ts, amount, biller, invoice):
        self._add("SAIB", f"مدفوعات وزارة الداخلية\nمن: XXX7001 \nمبلغ: SAR {amount:g}\n"
                          f"الجهة: {biller} \nالخدمة: تسديد المخالفات بواسطة رقم الهوية \n"
                          f"رقم الفاتورة: {invoice} \nفي: {ts:%m-%d} {ts:%H:%M}", ts,
                  kind="bill_payment", amount=amount, account="saib_current", expense=amount)

    def card_pos(self, ts, amount, merchant, is_topup=False):
        self.avail -= amount
        self._add("AlRajhiBank", f"شراء عبر نقاط البيع \nبطاقة:0256 ;فيزا-ابل باي\n"
                                 f"لدى:{merchant}\nمبلغ:{amount:g} SAR\nرصيد:{self.avail:.2f} SAR\n"
                                 f"؜{ts:%-d/%-m/%y} {ts:%H:%M}", ts,
                  kind="purchase", amount=amount, account="alrajhi_card",
                  expense=0.0 if is_topup else amount, internal=is_topup)

    def card_online(self, ts, amount, merchant):
        self.avail -= amount
        self._add("AlRajhiBank", f"شراء إنترنت بـSR {amount:g} \nعبر0256;فيزا-ابل باي\n"
                                 f"لـ{merchant}\nرصيد:{self.avail:.2f} SR\n"
                                 f"؜{ts:%-d/%-m/%y} {ts:%H:%M}", ts,
                  kind="purchase", amount=amount, account="alrajhi_card", expense=amount)

    def card_foreign(self, ts, orig, cur, conv, fee, rate, merchant, country):
        total = round(conv + fee, 2)
        self.avail -= total
        self._add("AlRajhiBank", f"شراء انترنت \nبطاقة: 0256 ;فيزا\nمبلغ: {orig:g} {cur} ({conv:.2f} ريال) \n"
                                 f"لدى: {merchant}\nرسوم وضريبة: {fee:.2f} SAR\nسعر الصرف~ {rate}\n"
                                 f"إجمالي المبلغ المستحق: {total:.2f} SAR\nدولة: {country}\n"
                                 f"رصيد: {self.avail:.2f} SAR\n؜ {ts:%-d/%-m/%y} {ts:%H:%M}", ts,
                  kind="purchase", amount=total, account="alrajhi_card", expense=total)

    def card_payment(self, ts, amount):
        self.avail += amount
        self._add("AlRajhiBank", f"بطاقة فيزا:سداد بـSR {amount:g} \nعبر0256;فيزا\n"
                                 f"رصيد:{self.avail:.2f} SR \n؜{ts:%-d/%-m/%y} {ts:%H:%M}", ts,
                  kind="card_payment", amount=amount, account="alrajhi_card",
                  internal=True, expense=0.0)

    def cashback_accrual(self, ts, amount):
        self._add("AlRajhiBank", f"بطاقة ائتمانية استرجاع نقدي :\n"
                                 f"تم إضافة {amount:.2f} ريال إلى محفظة الاسترجاع النقدي لبطاقة كاش باك بلس", ts,
                  kind="cashback_accrual", amount=amount, account="cashback_wallet",
                  income="passive", expense=0.0)

    def cashback_redeem(self, ts, amount):
        self.avail += amount
        self._add("AlRajhiBank", f"استرداد نقدي إلى البطاقة:\n"
                                 f"تم استرداد و إضافة {amount:.2f} ريال مبلغ الاسترداد النقدي إلى رصيد بطاقتك 0256", ts,
                  kind="cashback_redeem", amount=amount, account="alrajhi_card",
                  internal=True, expense=0.0)

    def barq_topup(self, ts, amount):
        self.barq += amount
        self._add("barq app", f"إضافة اموال \n {amount:.1f} SAR\nالبطاقة: **0256 , ابل باي \n"
                              f"{ts:%Y-%m-%d %H:%M}", ts,
                  kind="wallet_topup", amount=amount, account="barq",
                  internal=True, expense=0.0)

    def barq_pos(self, ts, amount, merchant):
        self.barq -= amount
        self._add("barq app", f"شراء نقاط بيع\nمدى{amount:.2f} SAR\nرصيد{self.barq:.2f}\n"
                              f"لدى{merchant}\n{ts:%Y-%m-%d %H:%M}", ts,
                  kind="purchase", amount=amount, account="barq", expense=amount)

    # ---------- noise that must never reach the ledger ----------
    def otp(self, ts, sender, amount=None):
        if sender == "SAIB":
            b = (f"كلمة مرور لمرة واحدة\nرمز: 2938\nل: دفعة سداد\nمبلغ: SAR {amount:.2f}\n"
                 f"في: {ts:%H:%M:%S} {ts:%d-%m-%Y}\nلا تشارك الرمز")
        elif sender == "barq app":
            b = f"رمز التحقق :378242\nالخدمة: حوالة صادرة محلية\nالمبلغ: {amount:.2f} SAR"
        else:
            b = f"رمز التحقق 6071 لـ: تحويل جهة اتصال بـ: {amount:.2f} ريال"
        self._add(sender, b, ts)

    def promo(self, ts, sender, text): self._add(sender, text, ts)
    def notification(self, ts):
        self._add("barq app", "New beneficiary activated: محمد أحمد عبدالله الفلان\n"
                              "IBAN: **7001\nBank: INVESTMENT BANK\n"
                              f"{ts:%Y-%m-%d %H:%M}", ts)

    # ---------- unknown formats: MUST go to manual review ----------
    def unknown(self, ts, sender, body, why):
        self._add(sender, body, ts)
        self.expected_review.append((sender, body.split("\n")[0][:46], why))
