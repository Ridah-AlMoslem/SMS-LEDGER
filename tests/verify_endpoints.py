"""End-to-end through the HTTP layer, against real Postgres.

verify_persistence.py calls the storage functions directly. This one goes
through the actual FastAPI app — signature verification, Pydantic coercion,
status codes — because that is the layer the iPhone Shortcut talks to, and a
signed request that the phone can't form is a ledger that never fills up.

Run: python3 tests/verify_endpoints.py --serve
"""

import hashlib
import hmac
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

PORT = int(os.environ.get("TEST_PG_PORT", "5435"))
DSN = f"postgresql://postgres@127.0.0.1:{PORT}/postgres"
INGEST_SECRET = "test-ingest-secret"
CRON_SECRET = "test-cron-secret"

os.environ["DATABASE_URL"] = DSN
os.environ["INGEST_SECRET"] = INGEST_SECRET
os.environ["CRON_SECRET"] = CRON_SECRET

from fastapi.testclient import TestClient  # noqa: E402

import db as store       # noqa: E402
import main              # noqa: E402
from verify_persistence import ACCOUNTS, IDENTIFIERS, SALARY, OTP  # noqa: E402

UTC = timezone.utc
checks = []


def check(name, got, want):
    ok = got == want
    checks.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r}, want {want!r}"))


def signed(client, sender, body, received_at, secret=INGEST_SECRET, skew=0):
    payload = main.IngestPayload(sender=sender, body=body, received_at=received_at)
    raw = payload.model_dump_json().encode()
    ts = str(int(time.time()) - skew)
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return client.post(
        "/api/ingest",
        json={"sender": sender, "body": body, "received_at": received_at.isoformat()},
        headers={"X-Signature": sig, "X-Timestamp": ts},
    )


def main_test():
    client = TestClient(main.app)

    with store.connect(DSN) as conn:
        for slug, name, inst, typ, liab, sem in ACCOUNTS:
            conn.execute(
                """INSERT INTO accounts (slug, name, institution, type, is_liability,
                                         balance_semantics, reconcilable)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (slug, name, inst, typ, liab, sem, inst != "SAIB"))
        for inst, kind, value, slug in IDENTIFIERS:
            conn.execute(
                """INSERT INTO account_identifiers (account_id, institution, kind, value)
                   SELECT id, %s, %s, %s FROM accounts WHERE slug = %s""",
                (inst, kind, value, slug))
        conn.commit()

    when = datetime(2026, 6, 25, 14, 4, tzinfo=UTC)

    print("\n[1] INGEST AUTHENTICATION  (§10.1)")
    check("health is open", client.get("/api/health").status_code, 200)
    r = client.post("/api/ingest", json={"sender": "SAIB", "body": "x",
                                         "received_at": when.isoformat()})
    check("unsigned request rejected", r.status_code, 401)
    r = signed(client, *SALARY, when, secret="wrong-secret")
    check("mis-signed request rejected", r.status_code, 401)
    r = signed(client, *SALARY, when, skew=600)
    check("replayed request rejected", r.status_code, 401)
    check("no rows written by rejected requests", _count("raw_messages"), 0)

    print("\n[2] INGEST ACCEPTS AND DEDUPS  (§10.2)")
    r = signed(client, *SALARY, when)
    check("signed request accepted", r.status_code, 202)
    check("reported as accepted", r.json()["status"], "accepted")
    r2 = signed(client, *SALARY, when)
    check("redelivery still returns 202", r2.status_code, 202)
    check("redelivery reported as duplicate", r2.json()["status"], "duplicate")
    check("only one raw row", _count("raw_messages"), 1)
    check("ingest never parses", _count("transactions"), 0)

    print("\n[3] PARSE TICK  (§10.3)")
    check("tick without secret rejected",
          client.post("/api/parse-tick").status_code, 401)
    r = client.post("/api/parse-tick", headers={"X-Cron-Secret": CRON_SECRET})
    check("authorised tick runs", r.status_code, 200)
    body = r.json()
    check("claimed the pending message", body["claimed"], 1)
    check("parsed it", body["parsed"], 1)
    check("posted one leg", body["legs"], 1)
    check("transaction exists", _count("transactions"), 1)

    print("\n[4] TICK IS IDEMPOTENT")
    r = client.post("/api/parse-tick", headers={"X-Cron-Secret": CRON_SECRET})
    check("nothing left to claim", r.json()["claimed"], 0)
    check("still exactly one transaction", _count("transactions"), 1)

    print("\n[5] OTP THROUGH THE FULL STACK  (§7.1)")
    signed(client, *OTP, datetime(2026, 7, 8, 21, 38, tzinfo=UTC))
    r = client.post("/api/parse-tick", headers={"X-Cron-Secret": CRON_SECRET})
    check("OTP was ignored, not parsed", r.json()["ignored"], 1)
    check("OTP added no transaction", _count("transactions"), 1)

    print()
    if all(checks):
        print("=" * 70)
        print(f"ALL {len(checks)} ENDPOINT CHECKS PASS")
        print("=" * 70)
        return 0
    print(f"{checks.count(False)} of {len(checks)} FAILED")
    return 1


def _count(table):
    with store.connect(DSN) as conn:
        return conn.execute(f"SELECT count(*) c FROM {table}").fetchone()["c"]


def serve_and_run():
    server = os.path.join(HERE, "..", "web", "scripts", "pgserver.mjs")
    proc = subprocess.Popen(["node", server, str(PORT)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        deadline = time.time() + 60
        while time.time() < deadline:
            line = proc.stdout.readline()
            if line.startswith("READY"):
                break
            if proc.poll() is not None:
                print(line, proc.stdout.read())
                return 1
        else:
            print("pgserver did not become ready")
            return 1
        return main_test()
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    sys.exit(serve_and_run() if "--serve" in sys.argv else main_test())
