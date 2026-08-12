"""Run every check in the project.

Two tiers, and the distinction matters:

  pure logic   — no database, no network, runs anywhere in about a second.
                 Proves the parser computes the right answer.
  persistence  — real Postgres (PGlite over the wire protocol), migrations
                 applied. Proves the answer survives being stored, and catches
                 what the pure tier structurally cannot: timezone awareness,
                 NUMERIC rounding, row claiming, idempotency at the DB level.

Both tiers found real bugs. Neither replaces the other.

Usage: python3 tests/run_all.py [--fast]
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

PURE = [
    "verify_periods.py", "verify_dates.py", "verify_classification.py",
    "verify_batch3.py", "verify_accounting.py", "verify_lifecycle.py",
    "verify_pairing.py", "verify_topup.py", "verify_topup_link.py", "verify_stc.py",
    "verify_derive.py",
    "simulate_two_months.py",
]

DB = ["verify_persistence.py", "verify_balances.py", "verify_template_store.py",
      "verify_endpoints.py"]


def run(script, args=()):
    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, script), *args],
        capture_output=True, text=True)
    ok = proc.returncode == 0
    print(f"  {'ok  ' if ok else 'FAIL'}  {script}")
    if not ok:
        tail = (proc.stdout + proc.stderr).strip().splitlines()[-15:]
        print("\n".join(f"          {line}" for line in tail))
    return ok


def main():
    fast = "--fast" in sys.argv
    results = []

    print("\nPURE LOGIC")
    results += [run(s) for s in PURE]

    if fast:
        print("\nPERSISTENCE  (skipped: --fast)")
    else:
        print("\nPERSISTENCE  (real Postgres)")
        results += [run(s, ["--serve"]) for s in DB]

    passed, total = sum(results), len(results)
    print()
    print("=" * 70)
    print(f"{passed}/{total} suites pass" if passed == total
          else f"{total - passed} of {total} SUITES FAILED")
    print("=" * 70)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
