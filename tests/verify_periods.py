from datetime import date, timedelta
from calendar import monthrange

ANCHOR = 25          # cycle starts on the 25th
WEEK_START = 6       # Sunday (Mon=0 .. Sun=6)

def add_month(d, n):
    m = d.month - 1 + n; y = d.year + m//12; m = m%12 + 1
    return date(y, m, min(d.day, monthrange(y, m)[1]))

def period_start(d):
    return date(d.year, d.month, ANCHOR) if d.day >= ANCHOR \
           else add_month(date(d.year, d.month, ANCHOR), -1)

def period_end(d):   return add_month(period_start(d), 1) - timedelta(days=1)
def period_label(d): return period_end(d).strftime("%B %Y")
def period_len(d):   return (period_end(d) - period_start(d)).days + 1
def week_start(d):   return d - timedelta(days=(d.weekday() - WEEK_START) % 7)

print("=== cycle math ===")
for d in [date(2026,8,11), date(2026,8,24), date(2026,8,25), date(2026,2,10),
          date(2026,3,1), date(2028,2,26), date(2026,12,31), date(2027,1,3)]:
    print(f"{d}  ->  {period_start(d)} .. {period_end(d)}  "
          f"[{period_label(d):<15}] {period_len(d)} days, day {(d-period_start(d)).days+1}")

print("\n=== invariants ===")
d = date(2025,1,1); seen = {}
while d < date(2030,1,1):
    st, en = period_start(d), period_end(d)
    assert st <= d <= en, f"{d} outside its own period"
    assert period_start(st) == st and period_start(en) == st, f"boundary unstable at {d}"
    seen.setdefault(st, en); assert seen[st] == en, f"inconsistent end for {st}"
    d += timedelta(days=1)
ps = sorted(seen)
for a, b in zip(ps, ps[1:]):
    assert seen[a] + timedelta(days=1) == b, f"gap/overlap between {a} and {b}"
lens = sorted({(seen[p]-p).days+1 for p in ps})
labels = [period_label(p) for p in ps]
assert len(labels) == len(set(labels)), "duplicate period labels"
print(f"{len(ps)} contiguous periods over 5 years, no gaps/overlaps")
print("period lengths seen:", lens, "| all labels unique:", len(labels)==len(set(labels)))

print("\n=== Sunday weeks ===")
for d in [date(2026,8,9), date(2026,8,11), date(2026,8,15), date(2026,8,16)]:
    ws = week_start(d)
    assert ws.weekday()==WEEK_START and 0 <= (d-ws).days <= 6
    print(f"{d} ({d.strftime('%a')}) -> week of {ws} ({ws.strftime('%a')})")

p = date(2026,8,11)
s,e = period_start(p), period_end(p)
weeks = []; w = week_start(s)
while w <= e:
    weeks.append((max(w,s), min(w+timedelta(days=6), e))); w += timedelta(days=7)
print(f"\ncycle {s}..{e} spans {len(weeks)} weeks (first/last partial):")
for a,b in weeks: print(f"   {a} .. {b}  ({(b-a).days+1}d)")
print("\nALL PERIOD INVARIANTS PASS")
