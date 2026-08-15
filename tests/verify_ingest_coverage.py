"""The phone's filter must be able to see every message the parser can read.

This is the only failure in the pipeline that leaves NO evidence. Everything
downstream of ingest is recoverable because `raw_messages` is append-only: a
misclassification is a status, a bad regex is a `needs_review` row, a crash is
a `last_error`. All of them can be corrected and requeued, because the message
is there.

A message the phone never forwarded is not there. No row, no status, no error —
and the review screen, whose whole job is to tell you when the pipeline is
lying, cannot report the absence of something it never heard about. It looks
exactly like a quiet week.

The trigger is `Message Contains` (DEPLOY §4 — the Sender field cannot be used,
because a bank's alphanumeric sender ID cannot be made into a contact). So the
question this file answers is narrow and load-bearing: does every message
format the parser handles contain at least one phrase an automation matches?

It did not. `ledger.normalize` folds five currency spellings to `SAR`, DEPLOY
listed four, and the missing one — `رس` — is the ONLY currency token in two
attested STC formats. Those parse perfectly in the suite and could never
arrive.

The corpus is read out of the per-institution verify_*.py files rather than
copied here, by parsing the `M = {...}` literal with `ast` and never executing
them (they call sys.exit at import). One copy of each attested message, in the
file that already asserts what it should parse to.
"""

import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

from ledger.normalize import TRIGGER_PHRASES, normalize  # noqa: E402

# Every file that holds a dict of attested raw message bodies keyed by template
# id. Adding an institution means adding it here, which is the same edit as
# adding its verify file to run_all.py.
CORPUS_FILES = ("verify_alrajhi.py", "verify_saib.py", "verify_stc.py",
                "verify_barq.py")

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   {detail}"))


def corpus():
    """{template_id: raw body} across every institution's verify file.

    Parsed, not imported: these modules run their assertions at import time and
    exit. `ast.literal_eval` on the `M` assignment gets the data with none of
    the behaviour.
    """
    out = {}
    for filename in CORPUS_FILES:
        path = os.path.join(HERE, filename)
        tree = ast.parse(open(path, encoding="utf-8").read(), filename)
        found = False
        for node in tree.body:
            if (isinstance(node, ast.Assign)
                    and any(getattr(t, "id", None) == "M" for t in node.targets)):
                for tid, body in ast.literal_eval(node.value).items():
                    out[f"{filename[7:-3]}/{tid}"] = body
                found = True
        if not found:
            raise SystemExit(f"{filename} has no `M = {{...}}` corpus to read")
    return out


MESSAGES = corpus()

print(f"\n[1] THE CORPUS IS THE ONE THE PARSER IS TESTED AGAINST  ({len(MESSAGES)} formats)")
check("every institution contributed", len(MESSAGES) >= 25, f"got {len(MESSAGES)}")

print("\n[2] EVERY ATTESTED MESSAGE TRIPS AT LEAST ONE AUTOMATION")
# Matched against the RAW body, deliberately. The phone filters what the bank
# actually sent; normalization happens on the server, hours of debugging later.
uncovered = [tid for tid, body in MESSAGES.items()
             if not any(p in body for p in TRIGGER_PHRASES)]
for tid in sorted(MESSAGES):
    if tid in uncovered:
        first = MESSAGES[tid].splitlines()[0]
        check(f"{tid} reaches the server", False, f"no trigger phrase in {first!r}")
check(f"all {len(MESSAGES)} formats covered", not uncovered,
      f"{len(uncovered)} unreachable: {uncovered}")

print("\n[3] THE PHRASE LIST AND THE NORMALIZER AGREE")
# The phrases exist because the normalizer folds them; a spelling the parser
# understands but the phone cannot see is exactly the gap this file exists for.
for phrase in TRIGGER_PHRASES:
    check(f"normalizer folds {phrase!r} to SAR",
          normalize(f"مبلغ 12.34 {phrase}") == "مبلغ 12.34 SAR",
          f"got {normalize(f'مبلغ 12.34 {phrase}')!r}")

print("\n[4] رس SPECIFICALLY — the spelling that was missing")
# Regression pin. These two are the reason this file exists: STC's incoming
# transfer and its Sarie transfer carry no other currency token.
STC_RIYAL_ONLY = [tid for tid, body in MESSAGES.items()
                  if "رس" in body and not any(p in body for p in ("SAR", "SR", "ريال", "ر.س"))]
check("at least one attested format depends on رس alone",
      len(STC_RIYAL_ONLY) >= 2, f"found {STC_RIYAL_ONLY}")
check("رس is in the trigger list", "رس" in TRIGGER_PHRASES)

print()
if all(checks):
    print("=" * 70)
    print(f"ALL {len(checks)} INGEST-COVERAGE CHECKS PASS")
    print("=" * 70)
    sys.exit(0)
print(f"{checks.count(False)} of {len(checks)} FAILED")
sys.exit(1)
