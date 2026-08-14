"""One movement, described twice (SPEC §8.2.1).

A transfer between two institutions produces a message from *each* of them:

    Barq : حوالة صادرة محلية  113.00 → لحساب 7001      2026-08-09 21:44
    SAIB : حوالة واردة محلية   SAR 113 من XXXX0018      2026-08-09 21:44

Both are real, both are stored forever (§3.1), and both are correctly parsed.
The problem is what they resolve to: `pipeline._legs_for` books BOTH sides of a
transfer whenever both accounts resolve to ones you own — which is right, and
which each of these messages independently does. Barq names `لحساب7001`
(= saib_current) and knows its own wallet; SAIB names `XXXX0018` (= the Barq
account at ANB) and knows the destination. So each message books
`barq −113` and `saib_current +113`, and the single movement lands **four
times**: both balances move twice.

Expense is unaffected — every leg is internal, so §6 spending is still right —
which is exactly why this is worth catching here. The damage is to balances,
and it surfaces as a reconciliation alert (§3.3) pointing at an account that
looks like it dropped a message when in fact it processed one twice.

The rule is deliberately narrow, for the reason §8.2.1 gives about top-up
matching: a false positive **erases a real movement**, which is worse than
missing a link. Two descriptions collapse only when all of these hold:

  - both are two-leg internal transfers — a message that booked both sides;
  - they name exactly the same legs: same accounts, same directions, same
    amount to the cent;
  - they post within `WINDOW` of each other;
  - they come from **different institutions**.

That last condition is the safety catch. Two genuine transfers of the same
amount between the same two accounts minutes apart — which is an ordinary
Sunday evening here, see the seven 113.00 legs in §8.2.2 — always arrive from
the same sender, and are never merged. Only the cross-institution echo is.
"""
from datetime import timedelta

# §8.2.1: "the two messages fire seconds apart". Five minutes is already
# generous; widening it buys nothing and costs safety.
WINDOW = timedelta(minutes=5)


def _signature(legs):
    """What a message says happened, independent of who said it.

    A frozenset of (account, direction, amount-in-cents). Cents rather than
    floats because two descriptions of one movement must compare equal exactly,
    and 113.00 parsed from two different formats must not miss by 1e-13.
    """
    return frozenset(
        (leg["account"], leg["direction"], int(round(leg["amount"] * 100)))
        for leg in legs
    )


def find_duplicate_descriptions(descriptions, window=WINDOW):
    """Pick the legs to supersede when two institutions describe one movement.

    `descriptions` is one entry per raw message that booked a transfer:
        {id, institution, ts, legs: [{id, account, direction, amount}, ...]}

    Returns [(kept_message_id, superseded_message_id), ...].

    The keeper is the earliest by (ts, id) — an arbitrary but *stable* choice,
    which is what matters: this runs on every parse tick, and a keeper that
    changed between runs would move balances back and forth forever.
    """
    # Only a message that booked both sides can be an echo of another. A
    # one-leg description is a transfer whose counterparty did not resolve, and
    # merging those would be guessing.
    candidates = [d for d in descriptions if len(d["legs"]) == 2]

    by_signature = {}
    for d in candidates:
        by_signature.setdefault(_signature(d["legs"]), []).append(d)

    pairs = []
    for group in by_signature.values():
        if len(group) < 2:
            continue

        group = sorted(group, key=lambda d: (d["ts"], str(d["id"])))
        kept = []
        for d in group:
            echo_of = next(
                (
                    k
                    for k in kept
                    # Different institutions only — the safety catch.
                    if k["institution"] != d["institution"]
                    and abs(d["ts"] - k["ts"]) <= window
                ),
                None,
            )
            if echo_of is None:
                kept.append(d)
            else:
                pairs.append((echo_of["id"], d["id"]))

    return pairs
