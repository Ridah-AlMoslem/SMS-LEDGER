"""Sender aliasing (ledger/senders.py).

One string decides classification, template matching and account resolution.
It comes from iOS, and the two failure modes pull in opposite directions:
too strict and every message parks because of a space; too loose and a
stranger's SMS resolves onto a real account. Both directions are checked.

Run: python3 tests/verify_senders.py
"""

import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

from ledger import senders  # noqa: E402
from ledger.pipeline import parse_message  # noqa: E402

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r}"))


# ST-01 verbatim from the sample batch, copied rather than invented: a fixture
# written to fit this test would only prove the alias matched the fixture. Kept
# pre-normalization, with the original إلى/الى spellings, for the same reason
# verify_stc.py does — the patterns are written in post-normalization spelling.
#
# Copied rather than imported because verify_stc.py runs its checks at module
# level and exits.
MESSAGE = """حوالة داخلية صادرة
بـ:23ر.س
إلى:A ALMARHOON
الى:318
في:08/08/26 11:44"""

# A minute after the timestamp in the body: live ingest, inside the 72-hour
# freshness window (§10.4.1).
WHEN = datetime(2026, 8, 8, 11, 45)

IDENT = {("STC Bank", "5842"): "stc", ("STC Bank", "1152"): "stc",
         ("STC Bank", "692"): "barq"}


def main_test():
    print("\n[1] CANONICAL NAMES PASS THROUGH UNCHANGED")
    for name in senders.CANONICAL:
        check(f"{name!r} is its own canonical form", senders.canonical(name), name)

    print("\n[2] CASE AND SPACING ARE NEVER MEANINGFUL")
    check("lowercased", senders.canonical("stc bank"), "STC Bank")
    check("uppercased", senders.canonical("STC BANK"), "STC Bank")
    check("no space", senders.canonical("STCBank"), "STC Bank")
    check("doubled space", senders.canonical("STC  Bank"), "STC Bank")
    check("leading/trailing space", senders.canonical("  SAIB "), "SAIB")
    check("barq's lowercase name still resolves",
          senders.canonical("BARQ APP"), "barq app")

    print("\n[3] AN UNKNOWN SENDER IS RETURNED UNTOUCHED, NOT GUESSED")
    # The design rule: unknown senders go to review, never to the bin and never
    # onto a bank that nobody confirmed. `canonical` must not reach for the
    # nearest match — "Al Rajhi Capital" is a different institution.
    for unknown in ["Al Rajhi Capital", "SAIBA", "STC", "Anb", "+966500000000"]:
        check(f"{unknown!r} unchanged", senders.canonical(unknown), unknown)
        check(f"{unknown!r} reported unknown", senders.is_known(unknown), False)

    print("\n[4] AN ALIAS SURVIVES THE WHOLE PIPELINE")
    # The reason the map exists: a sender iOS reports differently must parse
    # identically, all the way to a posted leg.
    good = parse_message("STC Bank", MESSAGE, WHEN, IDENT)
    odd = parse_message("stcbank", MESSAGE, WHEN, IDENT)
    check("the canonical sender parses", good.status, "parsed")
    check("a spacing variant parses the same way", odd.status, good.status)
    check("and produces the same legs",
          [leg["account"] for leg in odd.legs],
          [leg["account"] for leg in good.legs])

    print("\n[5] AN UNRECOGNISED SENDER STILL PARKS")
    parked = parse_message("Al Rajhi Capital", MESSAGE, WHEN, IDENT)
    check("parks rather than posting", parked.status, "needs_review")
    check("and posts nothing", parked.legs, [])

    print()
    if all(checks):
        print("=" * 70)
        print(f"ALL {len(checks)} SENDER CHECKS PASS")
        print("=" * 70)
        return 0
    print(f"{checks.count(False)} of {len(checks)} FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main_test())
