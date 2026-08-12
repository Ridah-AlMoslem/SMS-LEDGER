"""The phone's signature must verify on the server. Prove it, don't assume it.

`tools/shortcut-signer.js` reimplements HMAC-SHA256 and UTF-8 encoding by hand,
because JavaScriptCore inside the Shortcuts app has neither. Two independent
implementations of the same primitive is exactly the arrangement that produces
a signature which is *almost* right, and the symptom on the phone is a bare
401 with nothing to inspect — no logs, no response body, no way to tell a
wrong key from a wrong encoding.

So this runs the real file — not a copy, not a port — through Node.

The fixtures are chosen for the encoder, not the parser. Arabic exercises the
3-byte UTF-8 path on nearly every character; the RTL marks are invisible bytes
that a naive `length` would miscount; the emoji is a surrogate pair, the only
4-byte path and the one a `charCodeAt` loop gets wrong; the long body crosses
SHA-256's 64-byte block boundary and its padding case.

TIERING: this belongs to the pure tier, so the assertions that matter use only
the standard library — `hmac` is the reference implementation, and agreeing
with it is the whole claim. Importing the FastAPI app would drag `psycopg` and
`fastapi` into a tier whose contract is that it runs on a fresh clone with
nothing installed. When those packages ARE present the checks below also run
the server's own `verify_signature` over the same bytes, which additionally
covers the timestamp window and the constant-time compare.

Run: python3 tests/verify_shortcut_signer.py
"""

import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

SIGNER = os.path.join(HERE, "..", "tools", "shortcut-signer.js")
SECRET = "test-ingest-secret-مفتاح"  # non-ASCII key too

os.environ["INGEST_SECRET"] = SECRET

# Optional, and never required. The stdlib checks are the proof; this adds the
# server's own wiring on top when the API dependencies happen to be installed.
try:
    import main as server
except ImportError:
    server = None

checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}"
          + ("" if ok else f"\n          got  {got!r}\n          want {want!r}"))


DRIVER = """
const s = require(process.argv[1]);
const text = require('fs').readFileSync(0, 'utf8');
process.stdout.write(s.buildRequest(text, process.argv[2], 'iphone', process.argv[3]));
"""

FIXTURES = [
    ("plain ASCII",
     "SAIB", "2026-08-12T14:04:00+03:00", "test"),

    ("Arabic with newlines",
     "SAIB",
     "2026-08-12T14:04:00+03:00",
     "شراء\nمبلغ: SAR 113.00\n"
     "لدى: TAMIMI MARKETS\nبطاقة:*5842"),

    ("bidi control characters",
     "STC Bank",
     "2026-08-12T00:30:00+03:00",
     "‏حوالة صادرة‎\n"
     "الى: محمد\nالى: 318"),

    ("surrogate pair",
     "barq app", "2026-08-12T14:04:00+03:00", "\U0001f4b0 cashback"),

    ("quotes and backslashes",
     "AlRajhiBank", "2026-08-12T14:04:00+03:00",
     'merchant "ACME\\CO" ريال'),

    ("crosses the SHA-256 block boundary",
     "SAIB", "2026-08-12T14:04:00+03:00",
     "راتب " * 60),

    ("body ending in a newline",
     "SAIB", "2026-08-12T14:04:00+03:00", "شراء\n"),
]


def sign(sender, received_at, body, ts):
    text = f"{sender}\n{received_at}\n{body}"
    proc = subprocess.run(
        ["node", "-e", DRIVER, SIGNER, SECRET, ts],
        input=text.encode(), capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode())
    return proc.stdout.decode()


def main_test():
    if shutil.which("node") is None:
        print("  SKIP  node is not installed; cannot exercise the signer")
        return 0

    print("  reference: hmac (stdlib)"
          + ("  +  main.verify_signature" if server
             else "\n  note: api deps not installed, so the server's own"
                  " verify_signature is not exercised here."
                  "\n        verify_endpoints.py covers it in the"
                  " persistence tier."))

    ts = str(int(time.time()))

    print("\n[1] THE JS SIGNATURE MATCHES PYTHON'S, BYTE FOR BYTE")
    for name, sender, received_at, body in FIXTURES:
        out = sign(sender, received_at, body, ts)
        lines = out.split("\n")
        check(f"{name}: output is exactly three lines", len(lines), 3)

        sig, got_ts, payload = lines[0], lines[1], lines[2]
        raw = payload.encode()

        check(f"{name}: digest matches",
              sig, hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest())

        # The body the phone built has to survive being read back. Checked
        # with stdlib json rather than the Pydantic model so this holds on a
        # bare clone; verify_endpoints.py proves the model accepts it.
        parsed = json.loads(raw)
        check(f"{name}: body survives the round trip", parsed["body"], body)
        check(f"{name}: sender survives the round trip", parsed["sender"], sender)
        check(f"{name}: received_at survives the round trip",
              parsed["received_at"], received_at)

        if server is not None:
            try:
                server.verify_signature(raw, sig, got_ts)
                verified = True
            except Exception as exc:  # noqa: BLE001
                verified = f"{type(exc).__name__}: {exc}"
            check(f"{name}: the server accepts it", verified, True)

    print("\n[2] A TAMPERED BODY IS REJECTED")
    out = sign("SAIB", "2026-08-12T14:04:00+03:00", "شراء 100", ts)
    sig, got_ts, payload = out.split("\n")
    tampered = json.loads(payload)
    tampered["body"] = tampered["body"].replace("100", "900")
    raw = json.dumps(tampered, ensure_ascii=False, separators=(",", ":")).encode()

    check("editing the amount invalidates the signature",
          hmac.compare_digest(
              sig, hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()),
          False)

    print()
    if all(checks):
        print("=" * 70)
        print(f"ALL {len(checks)} SIGNER CHECKS PASS")
        print("=" * 70)
        return 0
    print(f"{checks.count(False)} of {len(checks)} FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main_test())
