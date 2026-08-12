"""Scenario construction + pipeline run.

Imported by simulate_two_months.py (assertions) and trace.py (human-readable flow).
"""
import sys, os
from datetime import datetime
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api")); sys.path.insert(0, HERE)
from ledger.pipeline import Pipeline
from scenario import Scenario, CARD_LIMIT

D = lambda m, d, h, mi: datetime(2026, m, d, h, mi)

ACCOUNTS = {"saib_current": dict(liab=False), "saib_savings": dict(liab=False),
            "alrajhi_card": dict(liab=True, limit=CARD_LIMIT, semantics="available_credit"),
            "barq": dict(liab=False), "cashback_wallet": dict(liab=False)}
IDENT = {("SAIB","7001"):"saib_current", ("SAIB","7002"):"saib_savings",
         ("AlRajhiBank","0256"):"alrajhi_card", ("barq app","0256"):"alrajhi_card"}
OPENING = {"saib_current": 0.0, "saib_savings": 0.0, "alrajhi_card": 12000.0,
           "barq": 0.0, "cashback_wallet": 0.0}

# Salary is NOT constant, and the two cycles differ on purpose.
#
# The amount is read from the message (template SA-04 captures it), so nothing
# in the parser depends on its value. These differ so that nothing downstream
# can quietly start depending on it either — a missing-salary check that
# matches on amount, or recurring-series inference that treats a changed figure
# as a new series, both pass a fixture with two identical paydays and fail on
# real data. Both values keep the thousands separator so comma parsing stays
# exercised.
SALARY_JUL = 12500.00
SALARY_AUG = 13120.45


def build():
    S = Scenario()
    # ============================ JULY CYCLE (25 Jun - 24 Jul) ============================
    S.salary(D(6,25,14,4), SALARY_JUL, D(6,25,0,0))
    S.to_savings(D(6,25,20,10), 3000)
    S.card_pos(D(6,26,13,20), 42.50, "TAMIMI MARKETS")
    S.otp(D(6,26,18,0), "STC Bank", 100.00)
    S.card_online(D(6,27,10,15), 155.22, "Zid")
    S.promo(D(6,27,12,0), "Virgin-AD", "احصل على 30 ريال رصيد مجاني عند شحن رصيدك")
    S.card_foreign(D(6,28,21,5), 12.57, "GBP", 62.89, 1.44, 5.0032, "DELIVEROO", "GBR")
    S.cashback_accrual(D(6,29,10,13), 5.85)
    S.card_pos(D(6,30,9,30), 19.55, "Innovativ")
    S.barq_topup(D(7,1,21,7), 120.00)
    S.card_pos(D(7,1,21,7), 120.00, "BARQ", is_topup=True)      # the funding leg
    S.barq_pos(D(7,2,8,51), 17.00, "FAL")
    S.otp(D(7,3,11,0), "barq app", 68.00)
    S.card_pos(D(7,5,19,40), 39.00, "MOVIE CIN")
    S.bill(D(7,8,21,39), 113.00, "المخالفات المرورية", "1012412852")
    S.otp(D(7,8,21,38), "SAIB", 113.00)
    S.barq_pos(D(7,9,13,10), 21.99, "Cloud")
    S.card_payment(D(7,10,10,13), 500.00)
    S.notification(D(7,12,9,0))
    S.card_online(D(7,15,17,3), 89.99, "Muvicinem")
    S.cashback_redeem(D(7,18,10,0), 30.00)
    S.to_savings(D(7,20,19,0), 1500)
    S.card_pos(D(7,22,12,5), 63.20, "DAWAR ALS")
    S.profit(D(7,23,22,34), 176.31, "يونيو")

    # --------- unknown formats inside the July cycle ---------
    S.unknown(D(7,24,10,0), "AlRajhiBank",
              "عملية شراء\nالبطاقة رقم 0256\nالقيمة 75.00 ريال\nالتاجر: NEW SHOP\nالرصيد الحالي 9000.00",
              "restructured AlRajhi purchase: different labels and field order")

    # ============================ AUGUST CYCLE (25 Jul - 24 Aug) ==========================
    S.salary(D(7,23,14,4), SALARY_AUG, D(7,25,0,0))             # early payday: 25 Jul was a Saturday
    S.to_savings(D(7,26,20,0), 3000)
    S.card_pos(D(7,27,13,0), 55.00, "TAMIMI MARKETS")
    S.card_foreign(D(7,29,14,33), 23.00, "USD", 86.37, 1.99, 3.755217, "ANTHROPIC", "USA")
    S.otp(D(7,29,22,7), "SAIB", 50.00)
    S.cashback_accrual(D(7,30,10,0), 16.34)
    S.promo(D(8,1,9,0), "Salla", "أصبحت حالة طلبك #277347310 [تم التنفيذ]")
    S.card_online(D(8,2,11,20), 45.00, "Zid")
    S.barq_topup(D(8,3,20,0), 200.00)
    S.card_pos(D(8,3,20,0), 200.00, "BARQ", is_topup=True)
    S.barq_pos(D(8,4,19,30), 88.40, "LAZEZ")
    S.card_pos(D(8,5,17,3), 150.00, "Muvicinem")
    S.bill(D(8,6,10,0), 300.00, "المخالفات المرورية", "1012499001")
    S.card_pos(D(8,7,8,8), 15.00, "MODAWAR S")
    S.otp(D(8,9,21,39), "SAIB", 113.00)
    S.card_payment(D(8,10,10,13), 1000.00)
    S.barq_pos(D(8,11,12,0), 34.10, "Cloud")
    S.cashback_redeem(D(8,14,10,0), 45.00)
    S.to_savings(D(8,17,21,0), 2000)
    S.card_online(D(8,19,16,0), 210.75, "Innovativ")
    S.profit(D(8,21,22,34), 190.53, "يوليو")
    S.card_pos(D(8,23,18,0), 72.30, "DAWAR ALS")

    # --------- unknown formats inside the August cycle ---------
    S.unknown(D(8,20,9,0), "SAIB",
              "Dear customer, a purchase of SAR 250.00 was made on your account XXX7001 at IKEA.",
              "English SAIB message: no template exists, language not yet seen from this sender")
    S.unknown(D(8,22,14,0), "AlRajhiBank",
              "شراء عبر نقاط البيع \nبطاقة:0256 ;فيزا-ابل باي\nلدى:HALF MESSAGE",
              "truncated: known opening but amount/balance/date missing")
    S.unknown(D(8,23,10,0), "Alinma Bank",
              "شراء عبر نقاط البيع\nبطاقة:4471\nمبلغ:60 SAR\nرصيد:900 SAR\n23/8/26 10:00",
              "unknown sender: plausible shape, but no registered institution")


    p = Pipeline(ACCOUNTS, IDENT, owned_cards={"0256"},
                 funding_account="saib_current", cashback_account="cashback_wallet")
    dupes = 0
    for sender, body, ts in S.msgs:
        if p.ingest(sender, body, ts).get("status") == "duplicate":
            dupes += 1
    for sender, body, ts in S.msgs[:5]:          # verbatim resubmission -> idempotency
        if p.ingest(sender, body, ts).get("status") == "duplicate":
            dupes += 1
    p.process_all()
    return S, p, dupes
