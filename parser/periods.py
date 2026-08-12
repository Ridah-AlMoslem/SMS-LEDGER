"""Salary-cycle periods (SPEC §5.1). Cycle runs anchor_day -> anchor_day-1."""
from calendar import monthrange
from datetime import date, timedelta
ANCHOR = 25

def _add_month(d, n):
    m = d.month - 1 + n; y = d.year + m // 12; m = m % 12 + 1
    return date(y, m, min(d.day, monthrange(y, m)[1]))

def period_start(d):
    d = d.date() if hasattr(d, "date") else d
    s = date(d.year, d.month, ANCHOR)
    return s if d.day >= ANCHOR else _add_month(s, -1)

def period_end(d):   return _add_month(period_start(d), 1) - timedelta(days=1)
def period_label(d): return period_end(d).strftime("%B %Y")
