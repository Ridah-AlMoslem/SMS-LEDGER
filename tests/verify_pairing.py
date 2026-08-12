"""Transfer pairing against the real 2026-08-09 sequence, where 113.00 SAR
appears seven times in seven minutes across three accounts (ANALYSIS.md batch 2)."""
from datetime import datetime as D

# account_identifiers: (institution, value) -> account.  Barq is funded by an
# ANB account ending 0018, which is how SAIB names it on the incoming leg.
IDENT = {("SAIB","7001"):"saib_current", ("SAIB","7002"):"saib_savings",
         ("Barq","wallet"):"barq", ("ANB","0018"):"barq",
         ("Barq","7001"):"saib_current"}
OWNED = set(IDENT.values())

# leg = (account, direction, amount, time, kind, counterparty_institution, counterparty_value)
L = [
 ("saib_savings","out",113.0,"21:38","transfer","SAIB","7001"),
 ("saib_current","in", 113.0,"21:38","transfer","SAIB","7002"),
 ("saib_current","out",113.0,"21:39","bill_payment","MOI","traffic-fine"),
 ("barq",        "out",113.0,"21:44","transfer","Barq","7001"),
 ("saib_current","in", 113.0,"21:44","transfer","ANB","0018"),
 ("saib_current","out",113.0,"21:45","transfer","SAIB","7002"),
 ("saib_savings","in", 113.0,"21:45","transfer","SAIB","7001"),
]
t = lambda s: D.strptime(s, "%H:%M")
gap = lambda a,b: abs((t(a[3])-t(b[3])).total_seconds())

def naive(a,b):
    return a[2]==b[2] and a[1]!=b[1] and gap(a,b)<=300

def strict(a,b):
    if not (a[2]==b[2] and a[1]!=b[1] and gap(a,b)<=300):        return False
    if a[4]!="transfer" or b[4]!="transfer":                      return False   # bills never pair
    if a[0]==b[0]:                                                return False   # not to itself
    ra, rb = IDENT.get((a[5],a[6])), IDENT.get((b[5],b[6]))       # resolve stated counterparties
    return ra==b[0] or rb==a[0]                                   # one side naming the other is enough

def match(pred):
    cand=[(i,j) for i in range(len(L)) for j in range(i+1,len(L)) if pred(L[i],L[j])]
    used,out=set(),[]
    for i,j in sorted(cand, key=lambda p: gap(L[p[0]],L[p[1]])):   # closest in time wins
        if i not in used and j not in used: used|={i,j}; out.append((i,j))
    return cand, out, used

print(f"{len(L)} legs of 113.00 SAR within 7 minutes\n")
cand_n,_,_ = match(naive)
cand_s, pairs, used = match(strict)
print(f"  naive  (amount + opposite direction + 5min) : {len(cand_n)} candidate pairs")
print(f"  strict (+ counterparty resolution, 1:1)     : {len(cand_s)} candidates -> {len(pairs)} pairs\n")
for i,j in pairs:
    print(f"    {L[i][0]:<13} {L[i][1]:<3} {L[i][3]}  <->  {L[j][0]:<13} {L[j][1]:<3} {L[j][3]}")
un=[L[k] for k in range(len(L)) if k not in used]
print(f"\n  correctly unpaired: {[(u[0],u[4]) for u in un]}")

assert len(pairs)==3, f"expected 3 real transfers, got {len(pairs)}"
assert all(u[4]=="bill_payment" for u in un), "only the traffic fine should be left over"
assert ("barq" in [L[i][0] for p in pairs for i in p]), "cross-institution leg must pair"
print(f"\n  naive would have produced {len(cand_n)-len(cand_s)} extra false candidates,")
print("  including pairing the traffic fine with an unrelated transfer leg.")
print("\nALL PAIRING INVARIANTS PASS")
