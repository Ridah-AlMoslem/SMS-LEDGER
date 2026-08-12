"""Template registry.

IMPORTANT: every pattern is written in POST-NORMALIZATION spelling, because
registry.match() normalizes before matching. Normalization folds ى->ي, إ->ا,
ئ->ي and strips tatweel, so the bank's `لدى` `بـ` `ائتمانية` appear here as
`لدي` `ب` `ايتمانية`. This looks wrong to a reader and is correct to the code —
consistency between normalizer and pattern is what matters.

Regexes derive from RAW attested text only (samples/batch1_raw.txt, batch3_raw.txt).
A ledger-class message matching no template goes to needs_review; it is never
extracted from guessed positions (SPEC §10.7).
"""
import re
from .normalize import normalize, parse_amount, last_digits

T = []
def tpl(tid, sender, kind, date_format, pattern, mapper, account_hint=None):
    T.append(dict(id=tid, sender=sender, kind=kind, date_format=date_format,
                  rx=re.compile(pattern, re.M), map=mapper, account_hint=account_hint))

A  = r"([\d][\d,]*(?:\.\d+)?)"     # amount
DT = r"(.+?)"                       # date blob (last line)

# ------------------------------- AlRajhi -------------------------------
tpl("AR-02", "AlRajhiBank", "purchase", "D/M/YY",
    rf"^شراء عبر نقاط البيع\nبطاقة:\s*(\S+)\s*;(.+)\nلدي:\s*(.+)\nمبلغ:\s*{A}\s*SAR\n"
    rf"رصيد:\s*{A}\s*SAR\n{DT}$",
    lambda m: dict(card=last_digits(m[1]), scheme=m[2].strip(), merchant=m[3].strip(),
                   amount=parse_amount(m[4]), balance=parse_amount(m[5]),
                   date_raw=m[6].strip(), direction="debit"))

tpl("AR-03", "AlRajhiBank", "purchase", "D/M/YY",
    rf"^شراء انترنت بSAR\s*{A}\nعبر(\S+?);(.+)\nل(.+)\nرصيد:\s*{A}\s*SAR\n{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), card=last_digits(m[2]), scheme=m[3].strip(),
                   merchant=m[4].strip(), balance=parse_amount(m[5]),
                   date_raw=m[6].strip(), direction="debit"))

tpl("AR-04", "AlRajhiBank", "purchase", "D/M/YY",
    rf"^شراء انترنت\nبطاقة:\s*(\S+)\s*;(.+)\nمبلغ:\s*{A}\s*([A-Z]{{3}})\s*\({A}\s*SAR\)\n"
    rf"لدي:\s*(.+)\nرسوم وضريبة:\s*{A}\s*SAR\nسعر الصرف~\s*([\d.]+)\n"
    rf"اجمالي المبلغ المستحق:\s*{A}\s*SAR\nدولة:\s*(\S+)\nرصيد:\s*{A}\s*SAR\n{DT}$",
    lambda m: dict(card=last_digits(m[1]), scheme=m[2].strip(),
                   original_amount=parse_amount(m[3]), original_currency=m[4],
                   converted=parse_amount(m[5]), merchant=m[6].strip(),
                   fee_amount=parse_amount(m[7]), fx_rate=float(m[8]),
                   amount=parse_amount(m[9]), country=m[10],
                   balance=parse_amount(m[11]), date_raw=m[12].strip(), direction="debit"))

tpl("AR-05", "AlRajhiBank", "card_payment", "D/M/YY",
    rf"^بطاقة فيزا:سداد بSAR\s*{A}\nعبر(\S+?);فيزا\nرصيد:\s*{A}\s*SAR\n{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), card=last_digits(m[2]),
                   balance=parse_amount(m[3]), date_raw=m[4].strip(), direction="credit"))

tpl("AR-06", "AlRajhiBank", "cashback_accrual", None,
    rf"^بطاقة ايتمانية استرجاع نقدي\s*:\ntم اضافة\s*{A}\s*SAR الي محفظة الاسترجاع النقدي".replace("tم","تم"),
    lambda m: dict(amount=parse_amount(m[1]), direction="credit"),
    account_hint="cashback_wallet")

tpl("AR-07", "AlRajhiBank", "cashback_redeem", None,
    rf"^استرداد نقدي الي البطاقة:\nتم استرداد و اضافة\s*{A}\s*SAR مبلغ الاسترداد النقدي "
    rf"الي رصيد بطاقتك\s*(\S+)",
    lambda m: dict(amount=parse_amount(m[1]), card=last_digits(m[2]), direction="credit"))

# -------------------------------- SAIB ---------------------------------
tpl("SA-02", "SAIB", "transfer", "MM-DD",
    rf"^حوالة صادرة: بين حساباتك\nمن:\s*(\S+)\nمبلغ:\s*SAR\s*{A}\nالي:\s*(\S+)\nفي:\s*{DT}$",
    lambda m: dict(from_account=last_digits(m[1]), amount=parse_amount(m[2]),
                   to_account=last_digits(m[3]), counterparty_account=last_digits(m[3]),
                   date_raw=m[4].strip(), direction="debit"))

tpl("SA-04", "SAIB", "salary", "DD-MM",
    rf"^قيد راتب داين\s*{A}\s*SAR في\s*(\d\d:\d\d)\s*(\d\d-\d\d)\n"
    rf"حساب\s*(\S+)\s*تاريخ استحقاق\s*(\d\d/\d\d)$",
    lambda m: dict(amount=parse_amount(m[1]), date_raw=f"{m[3]} {m[2]}",
                   to_account=last_digits(m[4]), due_raw=m[5], direction="credit"))

tpl("SA-05", "SAIB", "profit", "MM-DD",
    rf"^ايداع ارباح شهر\s*(\S+)\s*لحساب البركة الادخاري\nبقيمة\s*SAR\s*{A}\n"
    rf"في حساب\s*(\S+)\nبتاريخ\s*{DT}$",
    lambda m: dict(month=m[1], amount=parse_amount(m[2]), to_account=last_digits(m[3]),
                   date_raw=m[4].strip(), direction="credit"))

tpl("SA-06", "SAIB", "bill_payment", "MM-DD",
    rf"^مدفوعات\s*(.+)\nمن:\s*(\S+)\nمبلغ:\s*SAR\s*{A}\nالجهة:\s*(.+)\nالخدمة:\s*(.+)\n"
    rf"رقم الفاتورة:\s*(\d+)\nفي:\s*{DT}$",
    lambda m: dict(payer=m[1].strip(), from_account=last_digits(m[2]), amount=parse_amount(m[3]),
                   biller=m[4].strip(), service=m[5].strip(), invoice_number=m[6],
                   date_raw=m[7].strip(), direction="debit"))

# -------------------------------- Barq ---------------------------------
tpl("BQ-01", "barq app", "wallet_topup", "ISO",
    rf"^اضافة اموال\n{A}\s*SAR\nالبطاقة:\s*(\S+)\s*,\s*(.+)\n{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), card=last_digits(m[2]), scheme=m[3].strip(),
                   date_raw=m[4].strip(), direction="credit"),
    account_hint="barq")

tpl("BQ-05", "barq app", "purchase", "ISO",
    rf"^شراء نقاط بيع\nمدي\s*{A}\s*SAR\nرصيد\s*{A}\nلدي(.+)\n{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), balance=parse_amount(m[2]),
                   merchant=m[3].strip(), date_raw=m[4].strip(), direction="debit"),
    account_hint="barq")

def match(sender: str, body: str):
    t = normalize(body)
    for tp in T:
        if tp["sender"] != sender: continue
        m = tp["rx"].search(t)
        if m:
            try: return tp, tp["map"](m)
            except Exception: return None, None
    return None, None
