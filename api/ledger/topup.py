"""Wallet top-up linking (SPEC §8.2.1).

A Barq `اضافة اموال` names the funding card. The matching AlRajhi purchase is the
SAME money leaving the card, so both legs are marked internal and neither counts
as spending. Both rows are kept; only the classification changes.

Arrival order is not guaranteed, so this runs over the working set and amends
already-written rows when the second leg turns up.
"""
from datetime import timedelta

WINDOW = timedelta(minutes=5)

def link_topups(txns, owned_cards, window=WINDOW):
    """Mutates txns in place. Returns the list of (topup_id, purchase_id) pairs.

    txns entries need: id, institution, account, card_last4, amount, ts, kind,
    is_internal (bool), transfer_group_id (None).

    Safe to run repeatedly over a set that grows between runs, which is what
    the database path does — it re-scans on every parse tick, and the two legs
    routinely arrive on different ticks because they come from two different
    senders. `transfer_group_id`, not `is_internal`, is what marks a top-up as
    already handled: an unpaired top-up is set internal on sight (it is still
    a movement between two accounts you own, counterpart or not), so keying
    off `is_internal` would retire it on the first pass and leave its AlRajhi
    leg counted as spending forever if that message landed one tick later.
    """
    topups = [t for t in txns
              if t["kind"] == "wallet_topup" and t.get("card_last4") in owned_cards
              and t.get("transfer_group_id") is None]
    pairs, claimed = [], set()

    for tu in sorted(topups, key=lambda t: t["ts"]):
        cands = [p for p in txns
                 if p["kind"] == "purchase"
                 and p["id"] not in claimed
                 and not p["is_internal"]
                 and p.get("card_last4") == tu["card_last4"]      # same funding card
                 and abs(p["amount"] - tu["amount"]) < 0.005      # exact amount
                 and abs(p["ts"] - tu["ts"]) <= window]           # tight window
        if not cands:
            # Self-identifying: the top-up leg is internal even with no counterpart.
            tu["is_internal"] = True
            continue
        best = min(cands, key=lambda p: abs(p["ts"] - tu["ts"]))
        gid = f"tg-{tu['id']}"
        for leg in (tu, best):
            leg["is_internal"] = True
            leg["transfer_group_id"] = gid
        claimed.add(best["id"])
        pairs.append((tu["id"], best["id"]))
    return pairs

def expense_total(txns):
    """Spending excludes anything flagged internal (SPEC §6)."""
    return sum(t["amount"] for t in txns
               if t["kind"] in ("purchase", "bill_payment") and not t["is_internal"])
