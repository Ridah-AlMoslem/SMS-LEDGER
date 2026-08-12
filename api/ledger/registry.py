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
# Incoming from another institution. The sender name here is the account
# holder's own, at ANB — §8.2 again: the NAME decides nothing. Whether this is
# an internal move or external income depends entirely on whether the sending
# account is a registered identifier.
tpl("SA-01", "SAIB", "transfer", "MM-DD",
    rf"^حوالة واردة: محلية \(مقبوله\)\nمن:\s*(\S+)\n(.+)\nعبر:\s*(.+)\n"
    rf"مبلغ:\s*SAR\s*{A}\nالي:\s*(\S+)\nفي:\s*{DT}$",
    lambda m: dict(from_account=last_digits(m[1]),
                   counterparty_account=last_digits(m[1]),
                   counterparty=m[2].strip(), counterparty_bank=m[3].strip(),
                   amount=parse_amount(m[4]), to_account=last_digits(m[5]),
                   date_raw=m[6].strip(), direction="credit"))

# Outgoing to another institution. Same `الي` collision as STC: the recipient
# NAME and the recipient ACCOUNT both normalize to the same label, so only line
# order separates them.
tpl("SA-03", "SAIB", "transfer", "MM-DD",
    rf"^حوالة محلية\nالمصرف\s*(.+)\nالمبلغ\s*SAR\s*{A}\nمن\s*(\S+)\n"
    rf"الي:\s*(.+)\nالي\s*(\S+)\nالرسوم\s*SAR\s*{A}\nفي\s*{DT}$",
    lambda m: dict(counterparty_bank=m[1].strip(), amount=parse_amount(m[2]),
                   from_account=last_digits(m[3]), counterparty=m[4].strip(),
                   to_account=last_digits(m[5]),
                   counterparty_account=last_digits(m[5]),
                   fee_amount=parse_amount(m[6]), date_raw=m[7].strip(),
                   direction="debit"))

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

tpl("BQ-02", "barq app", "transfer", "ISO",
    rf"^حوالة واردة داخلية\n{A}\s*SAR\nحساب المرسل:\s*(\S+)\n{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), from_account=last_digits(m[2]),
                   counterparty_account=last_digits(m[2]),
                   date_raw=m[3].strip(), direction="credit"),
    account_hint="barq")

# Outgoing to another institution. The recipient here is the account holder's
# own name at SAIB — and `لحساب7001` is an owned account, which is what makes
# this internal. The NAME is not what decides that (§8.2); register
# ('barq app', 'account', '7001') and account resolution turns this into two
# legs on its own.
tpl("BQ-03", "barq app", "transfer", "ISO",
    rf"^حوالة صادرة محلية\nمبلغ\s*{A}\s*SAR\nرسوم\s*{A}\s*SAR\nالي (.+)\nبنك(.+)\n"
    rf"لحساب\s*(\S+)\n{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), fee_amount=parse_amount(m[2]),
                   counterparty=m[3].strip(), counterparty_bank=m[4].strip(),
                   to_account=last_digits(m[5]),
                   counterparty_account=last_digits(m[5]),
                   date_raw=m[6].strip(), direction="debit"),
    account_hint="barq")

tpl("BQ-04", "barq app", "transfer", "ISO",
    rf"^حوالة صادرة داخلية\nالمبلغ:\s*{A}\s*SAR\nالي\s*:\s*(\S+)\n{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), to_account=last_digits(m[2]),
                   counterparty_account=last_digits(m[2]),
                   date_raw=m[3].strip(), direction="debit"),
    account_hint="barq")

# Two formats share the header `شراء انترنت`. The mada one carries a balance
# label and a funding account; the Visa one carries a foreign amount. Both are
# anchored on line 2, which is the only place they differ.
tpl("BQ-06", "barq app", "purchase", "ISO",
    rf"^شراء انترنت\nمدي\s*{A}\s*SAR\nالرصيد\s*{A}\nب:\s*(.+)\nحساب:\s*(\S+)\n{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), balance=parse_amount(m[2]),
                   merchant=m[3].strip(), card=last_digits(m[4]),
                   date_raw=m[5].strip(), direction="debit"),
    account_hint="barq")

# Foreign purchases. The SAR figure in brackets is the amount that actually
# left the wallet; the foreign one is provenance (§1, FX is metadata, not
# multi-currency accounting).
tpl("BQ-07", "barq app", "purchase", "ISO",
    rf"^شراء نقاط البيع دولية\n(.+)\nالمبلغ\s*{A}\s*([A-Z]{{3}})\s*\({A}\s*SAR\)\s*"
    rf"الصرف\s*≈\s*([\d.]+)\nالرصيد\s*{A}\nلدي:\s*(.+)\n{DT}$",
    lambda m: dict(scheme=m[1].strip(), original_amount=parse_amount(m[2]),
                   original_currency=m[3], amount=parse_amount(m[4]),
                   fx_rate=float(m[5]), balance=parse_amount(m[6]),
                   merchant=m[7].strip(), date_raw=m[8].strip(), direction="debit"),
    account_hint="barq")

tpl("BQ-08", "barq app", "purchase", "ISO",
    rf"^شراء انترنت\n(\S+)\s*{A}\s*([A-Z]{{3}})\s*\({A}\s*SAR\)\nرصيد\s*{A}\n"
    rf"لدي\s*(.+)\n{DT}$",
    lambda m: dict(scheme=m[1].strip(), original_amount=parse_amount(m[2]),
                   original_currency=m[3], amount=parse_amount(m[4]),
                   balance=parse_amount(m[5]), merchant=m[6].strip(),
                   date_raw=m[7].strip(), direction="debit"),
    account_hint="barq")

# -------------------------------- STC ----------------------------------
# Eight formats, and three traps worth naming before the patterns:
#
# 1. `إلى` and `الى` both normalize to `الي`. The outgoing-transfer message
#    uses one spelling for the recipient NAME and the other for the recipient
#    ACCOUNT, so after folding it has two identical labels. Order is the only
#    thing separating them.
#
# 2. `من:` is likewise overloaded. In an incoming transfer the two `من:` lines
#    are name then account; in an Apple Pay purchase they are card then
#    merchant. Only the header line tells them apart, so every pattern is
#    anchored to it.
#
# 3. STC masks accounts to THREE digits (`318`, `713`) where every other sender
#    uses four. last_digits() keeps ≥3, so these resolve — but the collision
#    space is a thousand, not ten thousand.

tpl("ST-01", "STC Bank", "transfer", "D/M/YY",
    rf"^حوالة داخلية صادرة\nب:\s*{A}\s*SAR\nالي:\s*(.+)\nالي:\s*(\S+)\nفي:\s*{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), counterparty=m[2].strip(),
                   counterparty_account=last_digits(m[3]), date_raw=m[4].strip(),
                   direction="debit"),
    account_hint="stc")

tpl("ST-02", "STC Bank", "transfer", "D/M/YY",
    rf"^دفع قطة\nمبلغ:\s*{A}\s*SAR\nالي:\s*(.+)\nفي:\s*{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), counterparty=m[2].strip(),
                   date_raw=m[3].strip(), direction="debit"),
    account_hint="stc")

tpl("ST-03", "STC Bank", "transfer", "D/M/YY",
    rf"^حوالة داخلية واردة\nب:\s*{A}\s*SAR\nمن:\s*(.+)\nمن:\s*(\S+)\nفي:\s*{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), counterparty=m[2].strip(),
                   counterparty_account=last_digits(m[3]), date_raw=m[4].strip(),
                   direction="credit"),
    account_hint="stc")

tpl("ST-04", "STC Bank", "transfer", "D/M/YY",
    rf"^استلام قطة\nمبلغ:\s*{A}\s*SAR\nمن:\s*(.+)\nفي:\s*{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), counterparty=m[2].strip(),
                   date_raw=m[3].strip(), direction="credit"),
    account_hint="stc")

# Sarie instant transfer. The counterparty name here is the account holder's
# OWN name at another bank — which is exactly why §8.2 says names never decide
# direction. The ANB account is not an owned identifier, so this stays an
# external credit rather than an internal transfer. If that ANB account is
# yours, add it to account_identifiers and this becomes internal automatically.
tpl("ST-05", "STC Bank", "transfer", "DD-MM-YYYY",
    rf"^حوالة واردة \(سريع\)\n{A}\s*SAR\nمن (.+)\nمن بنك (.+)\nحساب (\S+)\n(.+)\nمرجع (\S+)$",
    lambda m: dict(amount=parse_amount(m[1]), counterparty=m[2].strip(),
                   counterparty_bank=m[3].strip(),
                   counterparty_account=last_digits(m[4]),
                   date_raw=m[5].strip(), reference=m[6].strip(), direction="credit"),
    account_hint="stc")

tpl("ST-06", "STC Bank", "purchase", "D/M/YY",
    rf"^عملية انترنت\nب:\s*{A}\s*SAR\nمن:\s*(.+)\nبطاقة:\s*(\S+)\nفي:\s*{DT}$",
    lambda m: dict(amount=parse_amount(m[1]), merchant=m[2].strip(),
                   card=last_digits(m[3]), date_raw=m[4].strip(), direction="debit"))

tpl("ST-07", "STC Bank", "purchase", "D/M/YY",
    rf"^شراء Apple Pay\nمن:\s*(\S+)\nب:\s*{A}\s*SAR\nمن:\s*(.+)\nفي:\s*{DT}$",
    lambda m: dict(card=last_digits(m[1]), amount=parse_amount(m[2]),
                   merchant=m[3].strip(), date_raw=m[4].strip(), direction="debit"))

# Foreign purchase. `اجمالي المبلغ المستحق` is the amount, NOT `ب:`.
# The base figure excludes the transaction fee, so taking it understates every
# foreign purchase by roughly 2% and drifts the balance reconciliation by
# exactly the fee each time (ANALYSIS §113).
tpl("ST-08", "STC Bank", "purchase", "D/M/YY",
    rf"^شراء انترنت\nعبر:\s*(\S+?),\s*(.+)\nب:\s*{A}\s*SAR\nمن:\s*(.+)\n"
    rf"رسوم تحويل العملات:\s*(.+)\nضريبة القيمة المضافة:\s*{A}\s*SAR\n"
    rf"رسوم العملية:\s*{A}\s*SAR\naجمالي المبلغ المستحق:\s*{A}\s*SAR\n"
    rf"الرصيد المتبقي:\s*{A}\s*SAR\nالدولة:\s*(\S+)\nفي:\s*{DT}$".replace("aجمالي", "اجمالي"),
    lambda m: dict(card=last_digits(m[1]), scheme=m[2].strip(),
                   converted=parse_amount(m[3]), merchant=m[4].strip(),
                   fx_fee_raw=m[5].strip(), vat=parse_amount(m[6]),
                   fee_amount=parse_amount(m[7]), amount=parse_amount(m[8]),
                   balance=parse_amount(m[9]), country=m[10],
                   date_raw=m[11].strip(), direction="debit"))


def match(sender: str, body: str, extra=None):
    """Find the first template for this sender that matches.

    `extra` carries templates derived at runtime and loaded from the database
    (§10.5, §10.7). They are tried FIRST, deliberately: a hand-derived template
    is a correction, and a correction that loses to the code template it was
    written to replace would be silently useless.

    The package itself never touches a database — the caller loads the rows and
    passes them in, which is what keeps this module pure enough to test without
    one.
    """
    t = normalize(body)
    for tp in list(extra or []) + T:
        if tp["sender"] != sender: continue
        m = tp["rx"].search(t)
        if m:
            try: return tp, tp["map"](m)
            except Exception: return None, None
    return None, None
