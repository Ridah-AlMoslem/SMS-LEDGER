"""Template derivation from a hand-marked message (SPEC §10.5, §10.7).

This is the mechanism that makes adding a bank cost one message instead of
forty, and it is also the one place where a user action can silently corrupt
every future parse of a format. So the checks here are mostly about what it
REFUSES to do.

The test message is a cash-withdrawal format with no template: it classifies
as a ledger event and then matches nothing, which is exactly the state a
message is in when it lands in the review queue.
"""

import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

from ledger.derive import DeriveError, derive, to_runtime_template  # noqa: E402
from ledger.pipeline import parse_message  # noqa: E402
from ledger.registry import match  # noqa: E402

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r} want {want!r}"))


def refuses(name, fn):
    try:
        fn()
    except DeriveError as exc:
        checks.append(True)
        print(f"  PASS  {name}  ({exc})")
        return
    checks.append(False)
    print(f"  FAIL  {name}  — it accepted this")


# Verified below to match no existing template.
BODY = """سحب نقدي
المبلغ 45.50 SAR
الرصيد 158.51
الصراف TAMIMI ATM
2026-08-09 14:22"""

FIELDS = {
    "amount": "45.50",
    "balance": "158.51",
    "merchant": "TAMIMI ATM",
    "date_raw": "2026-08-09 14:22",
}

print("\n[0] THE MESSAGE GENUINELY HAS NO TEMPLATE")
check("no code template matches it", match("barq app", BODY)[0], None)

print("\n[1] DERIVES A WORKING TEMPLATE")
tpl = derive(BODY, FIELDS, kind="withdrawal", direction="debit",
             date_format="ISO", sender="barq app", account_hint="barq")
check("pattern is anchored", tpl["pattern"].startswith("^") and tpl["pattern"].endswith("$"), True)
check("captures are in span order, not typing order",
      tpl["field_order"], ["amount", "balance", "merchant", "date_raw"])

print("\n[2] THE DERIVED TEMPLATE PARSES ITS OWN MESSAGE")
rt = to_runtime_template({**tpl, "id": "BQ-DERIVED"})
tp, f = match("barq app", BODY, [rt])
check("matches", tp["id"] if tp else None, "BQ-DERIVED")
check("amount", f["amount"], 45.50)
check("balance", f["balance"], 158.51)
check("merchant", f["merchant"], "TAMIMI ATM")
check("direction is injected, not captured", f["direction"], "debit")

print("\n[3] IT GENERALISES TO OTHER MESSAGES OF THE SAME FORMAT")
OTHER = """سحب نقدي
المبلغ 210.75 SAR
الرصيد 947.76
الصراف Innovativ ATM
2026-08-11 09:03"""
tp, f = match("barq app", OTHER, [rt])
check("a different message of the same shape matches", tp is not None, True)
check("its own amount", f["amount"], 210.75)
check("its own merchant", f["merchant"], "Innovativ ATM")

print("\n[4] SPACING VARIANTS STILL MATCH")
# Senders are inconsistent about spacing inside one format.
TIGHT = """سحب نقدي
المبلغ 12.00 SAR
الرصيد 900.00
الصراف LAZEZ ATM
2026-08-11 10:00"""
tp, f = match("barq app", TIGHT, [rt])
check("tolerated", f["amount"] if tp else None, 12.00)

print("\n[5] IT REFUSES WHAT IT CANNOT VERIFY")
H = dict(account_hint="barq")
refuses("a value that isn't in the message",
        lambda: derive(BODY, {**FIELDS, "amount": "999.99"}, "withdrawal", "debit", **H))
refuses("an ambiguous value appearing twice",
        lambda: derive("A 5.00 SAR\nB 5.00 SAR", {"amount": "5.00"}, "withdrawal", "debit", **H))
refuses("no amount at all",
        lambda: derive(BODY, {"merchant": "TAMIMI ATM"}, "withdrawal", "debit", **H))
refuses("no fields marked",
        lambda: derive(BODY, {}, "withdrawal", "debit", **H))
refuses("a bad direction",
        lambda: derive(BODY, FIELDS, "withdrawal", "sideways", **H))
refuses("an unknown field name",
        lambda: derive(BODY, {**FIELDS, "vibes": "high"}, "withdrawal", "debit", **H))
refuses("a date format with no date marked",
        lambda: derive(BODY, {"amount": "45.50"}, "withdrawal", "debit", date_format="ISO", **H))
refuses("a message naming no account, with no account chosen",
        lambda: derive(BODY, FIELDS, "withdrawal", "debit"))

print("\n[6] DERIVED TEMPLATES BEAT CODE TEMPLATES")
# A correction must win over the template it was written to replace, or it is
# silently useless.
SAIB = """حوالة صادرة: بين حساباتك
من: XXX7001
مبلغ: SAR 3000
الى: XXX7002
في: 06-25 20:10"""
override = to_runtime_template({
    "id": "OVERRIDE", "sender": "SAIB", "kind": "transfer", "direction": "debit",
    "date_format": None,
    "pattern": r"^حوالة صادرة: بين حساباتك\nمن:\s*(\S+)\nمبلغ:\s*SAR\s*([\d.]+)\n"
               r"الي:\s*(\S+)\nفي:\s*(.+)$",
    "field_order": ["from_account", "amount", "to_account", "date_raw"],
})
tp, _ = match("SAIB", SAIB, [override])
check("the runtime template wins", tp["id"], "OVERRIDE")
tp, _ = match("SAIB", SAIB, [])
check("without it, the code template still works", tp["id"], "SA-02")

print("\n[7] IT REACHES THE PIPELINE")
r = parse_message("barq app", BODY, datetime(2026, 8, 9, 14, 25),
                  {}, templates=[rt])
check("parses end to end", r.status, "parsed")
check("posts one leg", len(r.legs), 1)
check("with the derived amount", r.legs[0]["amount"], 45.50)
check("posted to the chosen account", r.legs[0]["account"], "barq")

print("\n[8] AN UNPARSEABLE MESSAGE IS STILL REFUSED AFTERWARDS")
UNRELATED = "تم تفعيل خدمة الدخول"
tp, _ = match("barq app", UNRELATED, [rt])
check("an unrelated message does not match the new template", tp, None)

print()
if all(checks):
    print("=" * 70)
    print(f"ALL {len(checks)} DERIVATION CHECKS PASS")
    print("=" * 70)
    sys.exit(0)
print(f"{checks.count(False)} of {len(checks)} FAILED")
sys.exit(1)
