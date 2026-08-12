"""Two-cycle simulation — asserts pipeline output against generator ground truth."""
import sys, os
from datetime import datetime
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "parser")); sys.path.insert(0, HERE)
from run_scenario import build, ACCOUNTS, CARD_LIMIT
from periods import period_label
cycle_of = period_label
S, p, dupes = build()

# ================================ AUDIT ================================

print("=" * 78)
print("TWO-MONTH SIMULATION — 25 Jun 2026 to 24 Aug 2026")
print("=" * 78)

c = p.counts()
print(f"\nMESSAGES  generated {len(S.msgs)}  |  duplicate submissions rejected {dupes}")
for k in ("parsed", "ignored", "needs_review"):
    print(f"  {k:<14} {c.get(k,0)}")
assert c.get("failed", 0) == 0

# ---- 1. nothing non-financial reached the ledger ----
print("\n[1] NOISE CONTAINMENT")
ign = {}
for r in p.raw:
    if r["status"] == "ignored": ign[r["ignored_reason"]] = ign.get(r["ignored_reason"],0)+1
print("  ignored by reason:", ign)
assert not any(t for t in p.txns if t["raw_id"] in
               {r["id"] for r in p.raw if r["status"]=="ignored"}), "an ignored message reached the ledger"
print("  PASS  no ignored message produced a transaction")

# ---- 2. unknown formats went to manual review, not mis-parsed ----
print("\n[2] UNKNOWN FORMATS -> MANUAL REVIEW")
review = [r for r in p.raw if r["status"] == "needs_review"]
for r in review:
    print(f"  {r['sender']:<13} shape={r['shape']}  {r['error']}")
    print(f"      {r['body'].splitlines()[0][:60]}")
assert len(review) == len(S.expected_review), \
    f"expected {len(S.expected_review)} review items, got {len(review)}"
assert not any(t["raw_id"] == r["id"] for t in p.txns for r in review), \
    "a review message still produced a transaction"
print(f"  PASS  all {len(review)} unknown formats parked, zero transactions created from them")

# ---- 3. ledger totals vs ground truth ----
print("\n[3] LEDGER vs GROUND TRUTH  (cycle = salary cycle, 25th -> 24th)")
def gt(cycle):
    rows = [x for x in S.truth if cycle_of(x["cycle_ts"]) == cycle]
    return (sum(x.get("expense", 0.0) for x in rows),
            sum(x["amount"] for x in rows if x.get("income") == "earned"),
            sum(x["amount"] for x in rows if x.get("income") == "passive"))

print(f"  {'cycle':<14} {'expense (got/want)':>24} {'earned (got/want)':>26} {'passive':>18}")
for cyc in ("July 2026", "August 2026"):
    e, ea, pa = gt(cyc)
    ae = p.expense(cyc)
    aea = sum(t_["amount"] for t_ in p.txns if t_["kind"] == "salary" and t_["cycle"] == cyc)
    apa = sum(t_["amount"] for t_ in p.txns
              if t_["kind"] in ("profit", "cashback_accrual") and t_["cycle"] == cyc)
    print(f"  {cyc:<14} {ae:>11.2f} /{e:>11.2f} {aea:>12.2f} /{ea:>12.2f} {apa:>8.2f} /{pa:>8.2f}")
    assert abs(ae-e) < 0.01,  f"{cyc} expense {ae} != {e}"
    assert abs(aea-ea) < 0.01, f"{cyc} earned {aea} != {ea}"
    assert abs(apa-pa) < 0.01, f"{cyc} passive {apa} != {pa}"
print("  PASS  every cycle total matches the generator exactly")

# ---- 4. master invariant ----
print("\n[4] MASTER INVARIANT  d(net worth) == income - expense")
bal = {}
for t_ in p.txns:
    bal[t_["account"]] = bal.get(t_["account"], 0.0) + (
        t_["amount"] if t_["direction"] == "credit" else -t_["amount"])
for a in sorted(bal): print(f"  {a:<18} {bal[a]:>12.2f}")
dnw, inc, exp = p.net_worth_delta(), p.income(), p.expense()
print(f"  {'-'*32}\n  d(net worth) {dnw:>17.2f}   income {inc:.2f} - expense {exp:.2f} = {inc-exp:.2f}")
assert abs(dnw - (inc - exp)) < 0.01, f"invariant broken by {dnw-(inc-exp):.2f}"
print("  PASS")

# ---- 5. reconciliation against reported balances ----
print("\n[5] RECONCILIATION (accounts that report a balance)")
for acct in ("alrajhi_card", "barq"):
    snaps = [s for s in p.snapshots if s["account"] == acct]
    if not snaps: continue
    last = max(snaps, key=lambda s: s["ts"])
    running = 12000.0 if acct == "alrajhi_card" else 0.0
    for t_ in sorted([x for x in p.txns if x["account"]==acct], key=lambda x: x["ts"]):
        running += (t_["amount"] if t_["direction"]=="credit" else -t_["amount"])
    ok = abs(running - last["balance"]) < 0.01
    extra = f"  (debt = {CARD_LIMIT-last['balance']:.2f})" if acct=="alrajhi_card" else ""
    print(f"  {'PASS' if ok else 'FAIL'}  {acct:<14} computed {running:>10.2f}  reported {last['balance']:>10.2f}{extra}")
    assert ok, f"{acct} drift {running-last['balance']:.2f}"
print("  SAIB accounts report no balance -> unreconcilable by design (SPEC 3.3b)")

# ---- 6. wallet top-up linking ----
print("\n[6] WALLET TOP-UP LINKING")
links = [t for t in p.txns if t["kind"]=="wallet_topup" and t["transfer_group_id"]]
paired = [t for t in p.txns if t["kind"]=="purchase" and t["merchant"]=="BARQ"]
print(f"  top-ups linked: {len(links)}   funding purchases: {len(paired)}   "
      f"all internal: {all(t['is_internal'] for t in paired)}")
assert len(links)==2 and all(t["is_internal"] for t in paired), "top-up legs must be internal"
naive = p.expense() + sum(t["amount"] for t in paired)
print(f"  PASS  expense {p.expense():.2f}; without linking it would read {naive:.2f} "
      f"(+{naive-p.expense():.0f} phantom)")

# ---- 7. early payday snapped to the right cycle ----
print("\n[7] EARLY PAYDAY")
sal = sorted([t for t in p.txns if t["kind"]=="salary"], key=lambda t: t["ts"])
for s in sal:
    print(f"  paid {s['ts']:%Y-%m-%d}  due {s['due_raw']}  -> cycle {s['cycle']}  "
          f"(raw date alone would say {cycle_of(s['ts'])})")
assert sal[1]["cycle"] == "August 2026", "early payday must snap to the August cycle"
assert sal[1]["ts"].date().isoformat() == "2026-07-23" and sal[1]["due_raw"] == "07/25"
print("  PASS  23 Jul payment carries due date 07/25 (a Saturday) — SPEC 5.6 applies")

# ---- 8. cold-start anomaly the run surfaced ----
print("\n[8] DATA-QUALITY FLAGS RAISED BY THE RUN")
cb_in  = sum(t["amount"] for t in p.txns if t["kind"] == "cashback_accrual")
cb_out = sum(t["amount"] for t in p.txns
             if t["kind"] == "cashback_redeem" and t["account"] == "cashback_wallet")
print(f"  cashback wallet: accrued {cb_in:.2f}, redeemed {cb_out:.2f} -> "
      f"balance {cb_in-cb_out:+.2f}")
assert cb_in - cb_out < 0, "this run deliberately redeems more than it accrued"
print("  FLAG  wallet is negative — redemption of cashback earned BEFORE tracking began.")
print("        Correct behaviour under cold start (SPEC 9.2): needs an opening balance,")
print("        not a parser fix. A real system must surface this rather than hide it.")

# ---- 9. per-cycle summary as the dashboard would show it ----
print("\n[9] DASHBOARD VIEW")
for cyc in ("July 2026", "August 2026"):
    inc, exp = p.income(cyc), p.expense(cyc)
    print(f"\n  {cyc}   income {inc:>10.2f}   expense {exp:>9.2f}   "
          f"net {inc-exp:>10.2f}   savings rate {100*(inc-exp)/inc:5.1f}%")
    cat = {}
    for t_ in p.txns:
        if t_["cycle"] == cyc and t_["kind"] in ("purchase","bill_payment") and not t_["is_internal"]:
            k = t_["biller"] or t_["merchant"] or "?"
            cat[k] = cat.get(k, 0.0) + t_["amount"]
    for k, v in sorted(cat.items(), key=lambda kv: -kv[1])[:6]:
        print(f"      {k:<28} {v:>9.2f}")

print("\n" + "=" * 78)
print("ALL SIMULATION ASSERTIONS PASS")
print("=" * 78)
