"""Field extraction. Only templates attested in RAW text are implemented;
screenshot-derived shapes are deliberately absent (see ANALYSIS.md B2.1)."""
import re
from normalize import normalize, parse_amount, last_digits

# Amount label priority: the grand total always wins over the subtotal (SPEC §7.6).
TOTAL = r"(?:اجمالي|اجمالى)\s*(?:المبلغ\s*)?(?:المستحق)?"
AMOUNT_LABELS = [TOTAL, r"المبلغ", r"مبلغ", r"بقيمة", r"بـ", r"ب"]
# SAIB/Barq write "SAR 113"; AlRajhi writes "15 SAR". Accept both, per label.
NUM = r"(?:SAR\s*)?([\d][\d,]*(?:\.\d+)?)(?:\s*SAR)?"

def field(text, label, pattern=r"(.+?)\s*$"):
    m = re.search(rf"{label}\s*[:：]?\s*{pattern}", text, re.M)
    return m.group(1).strip() if m else None

def amount(text):
    """Returns (value, label_used). Grand total beats subtotal."""
    for lab in AMOUNT_LABELS:
        m = re.search(rf"{lab}\s*[:：]?\s*{NUM}", text, re.M)
        if m: return parse_amount(m.group(1)), lab
    return None, None

def extract_bill_payment(text: str) -> dict:
    """مدفوعات وزارة الداخلية — SADAD. Attested raw, batch3."""
    t = normalize(text)
    amt, lab = amount(t)
    return {
        "kind": "bill_payment",
        "amount": amt, "amount_label": lab,
        "from_account": last_digits(field(t, r"من")),
        "biller": field(t, r"الجهة"),
        "service": field(t, r"الخدمة"),
        "invoice_number": field(t, r"رقم الفاتورة"),
        "date_raw": field(t, r"في"),
        "date_format": "MM-DD HH:MM",
        "direction": "debit", "is_internal_transfer": False,
    }

def extract_topup(text: str) -> dict:
    """اضافة اموال — Barq wallet top-up funded by a named card."""
    t = normalize(text)
    amt, lab = amount(t)
    card = last_digits(field(t, r"البطاقة"))
    return {
        "kind": "wallet_topup", "amount": amt, "amount_label": lab,
        "funding_card_last4": card, "direction": "credit",
    }
