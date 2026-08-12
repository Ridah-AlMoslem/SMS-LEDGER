"""Date disambiguation rules derived from real samples (ANALYSIS.md section 3)."""
from datetime import datetime, date, timedelta

def parse(fmt, s, received, backfill=False):
    """Per-template format + received_at validation. Returns dt or raises.
    backfill=True relaxes the freshness window for manual paste-import."""
    if fmt == "YY/M/D":    d = datetime.strptime(s, "%y/%m/%d %H:%M")
    elif fmt == "D/M/YY":  d = datetime.strptime(s, "%d/%m/%y %H:%M")
    elif fmt == "DD-MM-YYYY": d = datetime.strptime(s, "%d-%m-%Y %H:%M")
    elif fmt == "ISO":     d = datetime.strptime(s, "%Y-%m-%d %H:%M")
    elif fmt in ("MM-DD", "DD-MM"):                      # year-less
        f = "%m-%d %H:%M" if fmt == "MM-DD" else "%d-%m %H:%M"
        d = datetime.strptime(s, f).replace(year=received.year)
        if d > received:                                  # most recent past occurrence
            d = d.replace(year=received.year - 1)
    else: raise ValueError(fmt)
    if d > received: raise ValueError(f"{d} is after received_at {received}")
    window = timedelta(days=400) if backfill else timedelta(hours=72)
    if (received - d) > window: raise ValueError(f"{d} too far before {received}")
    return d

R = datetime(2026, 8, 11, 9, 0)
CASES = [
 ("AlRajhi AR-01","YY/M/D","26/8/9 22:53",       datetime(2026,8,9,22,53),  datetime(2026,8,10,1,0)),
 ("AlRajhi AR-02","D/M/YY","11/8/26 8:08",       datetime(2026,8,11,8,8),   R),
 ("AlRajhi AR-04","D/M/YY","29/7/26 14:33",      datetime(2026,7,29,14,33), datetime(2026,7,29,14,34)),
 ("SAIB SA-01",   "MM-DD", "08-09 21:44",        datetime(2026,8,9,21,44),  datetime(2026,8,9,21,45)),
 ("SAIB SA-04",   "DD-MM", "23-07 14:04",        datetime(2026,7,23,14,4),  datetime(2026,7,23,14,5)),
 ("Barq BQ-01",   "ISO",   "2026-08-07 21:07",   datetime(2026,8,7,21,7),   datetime(2026,8,7,21,8)),
 ("STC ST-05",    "DD-MM-YYYY","17-07-2026 22:54",datetime(2026,7,17,22,54),datetime(2026,7,17,22,55)),
]
print("per-template parsing:")
for name, fmt, s, want, recv in CASES:
    got = parse(fmt, s, recv)
    assert got == want, f"{name}: got {got}, want {want}"
    print(f"  PASS  {name:<14} {fmt:<11} {s!r:<22} -> {got}")

print("\nyear rollover (year-less date, live ingest across New Year):")
got = parse("MM-DD", "12-31 23:50", datetime(2027, 1, 1, 0, 5))
assert got == datetime(2026,12,31,23,50), got
print(f"  PASS  '12-31' received 2027-01-01 00:05 -> {got} (previous year)")

print("\nfreshness window: 72h live, relaxed for backfill:")
old = ("MM-DD", "12-28 10:00", datetime(2027, 1, 2, 9, 0))
try:
    parse(*old); raise SystemExit("FAIL: stale message accepted in live mode")
except ValueError:
    print("  PASS  5-day-old message rejected on live ingest")
got = parse(*old, backfill=True)
assert got == datetime(2026,12,28,10,0), got
print(f"  PASS  same message accepted in backfill mode -> {got}")

print("\nvalidation catches format errors:")
for fmt, s, why in [("D/M/YY","26/8/9 22:53","AR-01 misread as D/M/YY -> 2009"),
                    ("DD-MM","08-09 21:44","SA-01 misread as DD-MM -> wrong year"),
                    ("D/M/YY","12/8/26 10:00","tomorrow's date -> future")]:
    try:
        parse(fmt, s, datetime(2026,8,9,22,54)); raise SystemExit(f"FAIL: {why} not caught")
    except ValueError as e:
        print(f"  PASS  {why} -> rejected ({str(e)[:44]}...)")

print("\nALL DATE INVARIANTS PASS")
