import sys, os
from datetime import datetime, timedelta
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "parser"))
from topup import link_topups, expense_total

T0 = datetime(2026, 8, 7, 21, 7)
OWNED_CARDS = {"0256"}
def tx(i, kind, amount, mins, card="0256", inst="AlRajhi"):
    return dict(id=i, institution=inst, account="card" if kind == "purchase" else "barq",
                card_last4=card, amount=amount, ts=T0 + timedelta(minutes=mins),
                kind=kind, is_internal=False, transfer_group_id=None)

def case(name, txns, want_pairs, want_expense):
    pairs = link_topups(txns, OWNED_CARDS)
    exp = expense_total(txns)
    ok = len(pairs) == want_pairs and abs(exp - want_expense) < 0.005
    print(f"  {'PASS' if ok else 'FAIL'}  {name:<52} pairs={len(pairs)} expense={exp:.2f}")
    assert ok, f"{name}: pairs={len(pairs)} (want {want_pairs}), expense={exp} (want {want_expense})"
    return txns

print("wallet top-up linking:")

# 1. the real case: card purchase + Barq top-up, then the money is spent
t = case("top-up 12 + card purchase 12, then 12 spent at LAZEZ", [
    tx(1, "purchase", 12.0, 0),
    tx(2, "wallet_topup", 12.0, 0),
    dict(id=3, institution="Barq", account="barq", card_last4=None, amount=12.0,
         ts=T0+timedelta(minutes=1), kind="purchase", is_internal=False, transfer_group_id=None),
], want_pairs=1, want_expense=12.0)
assert t[0]["transfer_group_id"] == t[1]["transfer_group_id"], "legs must share a group"

# 2. order independence — top-up ingested before the card message
case("card message arrives AFTER the top-up (retro-amend)", [
    tx(2, "wallet_topup", 12.0, 0),
    tx(1, "purchase", 12.0, 2),
], want_pairs=1, want_expense=0.0)

# 3. false-positive guard: a real shop purchase of the same amount, far apart
case("unrelated 12.00 shop purchase 40 min later is NOT swallowed", [
    tx(1, "wallet_topup", 12.0, 0),
    tx(2, "purchase", 12.0, 40),
], want_pairs=0, want_expense=12.0)

# 4. different card -> not a top-up source
case("same amount on a different card is NOT linked", [
    tx(1, "wallet_topup", 12.0, 0),
    tx(2, "purchase", 12.0, 1, card="9999"),
], want_pairs=0, want_expense=12.0)

# 5. one-to-one: two top-ups, two purchases, no double-claim
t = case("two 12.00 top-ups + two 12.00 purchases pair 1:1", [
    tx(1, "wallet_topup", 12.0, 0), tx(2, "purchase", 12.0, 0),
    tx(3, "wallet_topup", 12.0, 3), tx(4, "purchase", 12.0, 3),
], want_pairs=2, want_expense=0.0)
assert len({x["transfer_group_id"] for x in t}) == 2, "must be two distinct groups"

# 6. self-identifying: top-up with no AlRajhi message still must not look like income
t = case("top-up alone (AlRajhi message never arrives) is still internal", [
    tx(1, "wallet_topup", 103.0, 0),
], want_pairs=0, want_expense=0.0)
assert t[0]["is_internal"], "an unpaired top-up from an owned card is still internal"

# 7. bill payments never absorbed
case("a 12.00 bill payment is never linked or hidden", [
    tx(1, "wallet_topup", 12.0, 0),
    dict(id=2, institution="SAIB", account="7001", card_last4=None, amount=12.0,
         ts=T0, kind="bill_payment", is_internal=False, transfer_group_id=None),
], want_pairs=0, want_expense=12.0)

print("\nALL TOP-UP LINKING INVARIANTS PASS")
