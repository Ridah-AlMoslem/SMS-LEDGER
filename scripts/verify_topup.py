"""Barq top-up funded by AlRajhi card 0256.

Both messages are kept as separate rows, each hitting its own account balance.
The only question is how each is CLASSIFIED. Three options compared.
"""
LIMIT = 14000.0
def run(label, alrajhi_kind, barq_kind):
    # start: card debt 4000 (available 10000), Barq empty
    avail, barq = 10000.0, 0.0
    income = expense = 0.0
    # 1. top-up 12 from card 0256 -> Barq
    avail -= 12;  barq += 12
    if alrajhi_kind == "expense": expense += 12
    if barq_kind   == "income":   income  += 12
    # 2. spend the 12 at LAZEZ from Barq
    barq -= 12; expense += 12
    nw0 = -(LIMIT - 10000.0) + 0.0
    nw1 = -(LIMIT - avail) + barq
    return dict(label=label, avail=avail, barq=barq, income=income, expense=expense,
                dnw=nw1 - nw0, ok=abs((nw1 - nw0) - (income - expense)) < 0.01)

rows = [
 run("A1  separate, top-up = expense + nothing", "expense",  "none"),
 run("A2  separate, top-up = expense + income",  "expense",  "income"),
 run("B   both legs marked internal",            "internal", "internal"),
]
print(f"  {'option':<40} {'avail':>8} {'barq':>6} {'income':>7} {'expense':>8} {'dNW':>6}  invariant")
for r in rows:
    print(f"  {r['label']:<40} {r['avail']:>8.0f} {r['barq']:>6.0f} {r['income']:>7.0f} "
          f"{r['expense']:>8.0f} {r['dnw']:>6.0f}  {'HOLDS' if r['ok'] else 'BROKEN'}")

a1, a2, b = rows
print(f"\n  Real consumption was 12 SAR (one coffee at LAZEZ).")
print(f"    A1 reports {a1['expense']:.0f} expense and BREAKS the master invariant by "
      f"{abs(a1['dnw']-(a1['income']-a1['expense'])):.0f}")
print(f"    A2 reports {a2['expense']:.0f} expense and {a2['income']:.0f} income — invariant holds,")
print(f"       but both sides are inflated by 12, so the savings rate is wrong")
print(f"    B  reports {b['expense']:.0f} expense, {b['income']:.0f} income — correct")

print(f"\n  All three keep TWO separate rows; each still moves its own account balance:")
print(f"    AlRajhi available credit 10000 -> {b['avail']:.0f}   (debt 4000 -> "
      f"{LIMIT-b['avail']:.0f})")
print(f"    Barq balance 0 -> 12 -> {b['barq']:.0f}")
print(f"  Only the classification flag differs. Nothing is merged or suppressed.")

assert not a1["ok"], "A1 should break the invariant"
assert a2["ok"] and a2["expense"] == 24, "A2 holds but inflates both sides"
assert b["ok"] and b["expense"] == 12 and b["income"] == 0, "B is the correct one"
print("\nALL TOPUP INVARIANTS PASS")
