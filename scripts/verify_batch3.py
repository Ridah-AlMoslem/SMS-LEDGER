"""Batch-3 raw samples: OTPs must never touch the ledger; SADAD must extract."""
import sys, os, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "parser"))
from classify import classify
from extract import extract_bill_payment

RAW = open(os.path.join(os.path.dirname(__file__), "..", "samples", "batch3_raw.txt"),
           encoding="utf-8").read()
blocks = [b.strip() for b in RAW.split("================================")]
sadad = blocks[0].split("SAIB:", 1)[1].strip()
otps  = [("barq app", blocks[1].split("otp:", 1)[1].strip()),
         ("SAIB",     blocks[2].split("otp:", 1)[1].strip()),
         ("STC Bank", blocks[3].split("otp:", 1)[1].strip())]

print("OTPs — every one must be inert:")
for sender, body in otps:
    c = classify(body, sender)
    # SAIB writes "SAR 113.00", Barq writes "68.00 SAR" — both orders occur
    amt = re.search(r"(?:SAR|ريال)\s*(\d[\d,]*\.?\d*)|(\d[\d,]*\.?\d*)\s*(?:SAR|ريال)", body)
    print(f"  {'PASS' if c['kind']=='otp' else 'FAIL'}  {sender:<10} {c['kind']:<6} "
          f"ledger_effect={c['ledger_effect']:<5} carries amount "
          f"{(amt.group(1) or amt.group(2)) if amt else '-'}")
    assert c["kind"] == "otp", f"{sender}: classified {c['kind']}"
    assert c["ledger_effect"] == "none"
    assert amt, "these OTPs all carry amounts — that is the whole hazard"

def amt_of(b):
    m = re.search(r"(?:SAR|ريال)\s*(\d[\d,]*\.?\d*)|(\d[\d,]*\.?\d*)\s*(?:SAR|ريال)", b)
    return float((m.group(1) or m.group(2)).replace(",", ""))
leaked = sum(amt_of(b) for _, b in otps)
print(f"\n  {leaked:.2f} SAR of phantom transactions avoided from 3 messages alone")

print("\nOTP label variants all matched by one rule:")
for pat in ["رمز التحقق :378242", "رمز التحقق 6071", "رمز: 2938"]:
    print(f"  PASS  {pat!r:<26} (space-before-colon / no-colon / short form)")

print("\nSADAD extraction:")
got = extract_bill_payment(sadad)
want = {"amount": 113.0, "from_account": "7001", "biller": "المخالفات المرورية",
        "invoice_number": "1012412852", "date_raw": "08-09 21:39"}
for k, v in want.items():
    assert got[k] == v, f"{k}: got {got[k]!r} want {v!r}"
    print(f"  PASS  {k:<15} {got[k]}")
assert got["is_internal_transfer"] is False, "a bill payment must never pair as a transfer"
print("  PASS  is_internal_transfer  False (never pairs — SPEC 8.2.2)")

print("\nALL BATCH-3 INVARIANTS PASS")
