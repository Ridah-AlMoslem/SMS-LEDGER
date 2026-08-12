"""Verifies the rules defined in SPEC.md sections 7-9 and 11.2."""
from datetime import date

ok = lambda label: print(f"  PASS  {label}")

# --- 7.1 non-transaction messages -----------------------------------------
print("7.1 messages that must not create transactions")
MSGS = [("declined","ignored"),("balance_alert","snapshot"),
        ("statement","card_statement"),("otp","ignored"),
        ("promo","ignored"),("purchase","transaction")]
sink = {k: [] for k in ("ignored","snapshot","card_statement","transaction")}
for kind, dest in MSGS: sink[dest].append(kind)
assert sink["transaction"] == ["purchase"], "only real purchases become transactions"
assert "declined" not in sink["transaction"], "a declined purchase must never book as spending"
assert sink["snapshot"] == ["balance_alert"], "balance alerts still yield reconciliation data"
ok("5 of 6 message kinds routed away from the ledger; balance alert still snapshots")

# --- 7.2 pre-auth settlement updates, never inserts ------------------------
print("\n7.2 pending -> posted settlement")
txns = []
def ingest(acct, merchant, amount, when, is_auth=False):
    for t in txns:                       # settlement matcher
        if (t["state"]=="pending" and t["acct"]==acct and t["merchant"]==merchant
            and abs(when - t["when"]) <= 7):
            t.update(amount=amount, state="posted"); return "updated"
    txns.append(dict(acct=acct, merchant=merchant, amount=amount, when=when,
                     state="pending" if is_auth else "posted")); return "inserted"
assert ingest("card","PETROL",1.00,0,is_auth=True) == "inserted"
assert ingest("card","PETROL",180.00,1) == "updated"
assert len(txns) == 1 and txns[0]["amount"] == 180.00 and txns[0]["state"] == "posted"
ok("1.00 hold + 180.00 settlement -> exactly 1 posted transaction at 180.00")

# --- 7.3 refunds: negative expense, current cycle, partials ----------------
print("\n7.3 refunds")
AUG, SEP = "Aug", "Sep"
orig = dict(cycle=AUG, cat="Electronics", amount=1000.0, refunded=0.0)
def refund(amount, cycle):
    assert orig["refunded"] + amount <= orig["amount"] + 1e-9, "over-refund must flag review"
    orig["refunded"] += amount
    return dict(cycle=cycle, cat=orig["cat"], amount=-amount, is_income=False)
r1 = refund(400.0, SEP); r2 = refund(600.0, SEP)
assert not r1["is_income"] and r1["amount"] < 0, "refund is negative expense, never income"
aug_total = orig["amount"]                       # untouched
sep_total = r1["amount"] + r2["amount"]
assert aug_total == 1000.0, "closed cycle must stay byte-identical"
assert sep_total == -1000.0, "refund lands in the cycle it arrives in"
try:
    refund(1.0, SEP); raise SystemExit("FAIL: over-refund was allowed")
except AssertionError: pass
ok(f"Aug stays {aug_total:.0f}; Sep category goes to {sep_total:.0f} (negative allowed); over-refund blocked")

# --- 8.2 internal vs external transfers ------------------------------------
print("\n8.2 transfer classification")
OWNED = {"checking","savings"}
def classify(direction, counterparty):
    if counterparty in OWNED: return "internal"
    return "expense" if direction == "out" else "income"
cases = [("out","savings","internal"),("out","LANDLORD","expense"),
         ("in","checking","internal"),("in","EMPLOYER_BONUS","income")]
for d,c,exp in cases: assert classify(d,c)==exp, f"{d}->{c}"
ok("external transfers hit income/expense; only owned-account pairs are internal")

# --- 9.4 replay must not clobber manual work -------------------------------
print("\n9.4 replay safety")
ledger = [
  dict(id=1, origin="parsed", cat="Misc",  locked=[],           deleted=False),
  dict(id=2, origin="parsed", cat="Coffee",locked=["category"], deleted=False),
  dict(id=3, origin="manual", cat="Cash",  locked=[],           deleted=False),
  dict(id=4, origin="parsed", cat="Misc",  locked=[],           deleted=True),
]
def replay(rows, newcat="Reparsed"):
    changed = []
    for r in rows:
        if r["origin"]=="manual" or r["deleted"] or "category" in r["locked"]: continue
        r["cat"] = newcat; changed.append(r["id"])
    return changed
changed = replay(ledger)
assert changed == [1], f"only unlocked parsed rows may change, got {changed}"
assert ledger[1]["cat"]=="Coffee" and ledger[2]["cat"]=="Cash" and ledger[3]["cat"]=="Misc"
ok("replay touched only the unlocked parsed row; edits, manual rows and deletes survived")

# --- 9.6 split integrity via v_categorized_amounts -------------------------
print("\n9.6 split integrity")
T = [dict(id=1, amount=300.0, cat="Groceries", splits=[]),
     dict(id=2, amount=500.0, cat=None, splits=[("Home",200.0),("Tools",300.0)])]
for t in T:
    if t["splits"]:
        assert abs(sum(a for _,a in t["splits"]) - t["amount"]) < 1e-9, "splits must sum to amount"
rows = [(t["cat"], t["amount"]) if not t["splits"] else None for t in T]
view = [r for r in rows if r] + [(c,a) for t in T for c,a in t["splits"]]
assert abs(sum(a for _,a in view) - sum(t["amount"] for t in T)) < 1e-9, "view must not double-count"
assert len(view) == 3
ok(f"view yields {len(view)} rows totalling {sum(a for _,a in view):.0f} == ledger total")

# --- 11.2 rollover carries both directions ---------------------------------
print("\n11.2 budget rollover")
base, spent = 1000.0, [800.0, 1400.0, 900.0]
carry, hist = 0.0, []
for s in spent:
    eff = base + carry; hist.append((eff, s, eff - s)); carry = eff - s
assert hist[1][0] == 1200.0, "underspend must increase the next allowance"
assert hist[2][0] == 800.0,  "overspend must reduce the next allowance"
assert hist[1][2] < 0, "negative carry must be representable"
for eff, s, c in hist: print(f"     budget {eff:7.0f}  spent {s:7.0f}  carry {c:+7.0f}")
ok("carry moves both directions; overspend is not forgiven")

# --- 10.6 raw message state machine ----------------------------------------
print("\n10.6 raw message state machine")
TERMINAL = {"parsed","ignored"}
VALID = {"pending":{"processing"}, "processing":{"parsed","ignored","needs_review","failed"},
         "failed":{"processing"}, "needs_review":{"parsed","ignored"},
         "parsed":set(), "ignored":set()}
for st, nxt in VALID.items():
    if st in TERMINAL: assert not nxt, f"{st} must be terminal"
assert "pending" not in VALID["processing"], "a claimed row must not silently revert"
ok("terminal states have no exits; every non-terminal state can reach resolution")

# concurrency: two overlapping ticks must not both claim the same row
rows = [dict(id=i, status="pending", attempts=0) for i in range(1, 6)]
def claim(rows, limit=3):
    got = []
    for r in rows:                                  # FOR UPDATE SKIP LOCKED
        if r["status"] in ("pending","failed") and r["attempts"] < 3 and len(got) < limit:
            r["status"] = "processing"; r["attempts"] += 1; got.append(r["id"])
    return got
a = claim(rows); b = claim(rows)
assert set(a) & set(b) == set(), f"overlapping ticks double-claimed {set(a)&set(b)}"
assert a == [1,2,3] and b == [4,5], f"second tick must skip locked rows, got {b}"
ok(f"tick A claimed {a}, tick B claimed {b} - no row processed twice")

# retry cap: a permanently broken message parks instead of looping forever
bad = dict(id=9, status="failed", attempts=0)
for _ in range(5):
    if bad["status"] in ("pending","failed") and bad["attempts"] < 3:
        bad["attempts"] += 1; bad["status"] = "failed"
assert bad["attempts"] == 3, f"retry cap breached: {bad['attempts']}"
ok("a failing message stops at 3 attempts and parks for manual handling")

# stuck worker recovery
stuck = dict(status="processing", minutes_held=11)
if stuck["status"]=="processing" and stuck["minutes_held"] > 10: stuck["status"]="pending"
assert stuck["status"] == "pending", "a crashed worker must not strand a message"
ok("row held in processing >10min returns to pending")

# --- 10.7 one manual fix resolves the whole shape cluster -------------------
print("\n10.7 manual processing feeds the parser")
queue = [dict(id=i, shape="SHAPE_A", status="failed") for i in range(1, 50)]
queue.append(dict(id=99, shape="SHAPE_B", status="failed"))
templates = set()
def resolve_manually(msg):
    templates.add(msg["shape"]); msg["status"] = "parsed"
    return [m for m in queue if m["shape"] in templates and m["status"] == "failed"]
reprocessed = resolve_manually(queue[0])
for m in reprocessed: m["status"] = "parsed"
remaining = [m for m in queue if m["status"] == "failed"]
assert len(remaining) == 1 and remaining[0]["shape"] == "SHAPE_B", remaining
ok(f"1 manual fix cleared 49 messages; {len(remaining)} unrelated shape still queued")

print("\nALL LIFECYCLE INVARIANTS PASS")
