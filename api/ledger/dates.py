"""Per-template date parsing with received_at validation (SPEC §10.4.1)."""
from datetime import datetime, timedelta

FORMATS = {
    "YY/M/D":      "%y/%m/%d %H:%M",
    "D/M/YY":      "%d/%m/%y %H:%M",
    "DD-MM-YYYY":  "%d-%m-%Y %H:%M",
    "ISO":         "%Y-%m-%d %H:%M",
    "MM-DD":       "%m-%d %H:%M",     # year-less
    "DD-MM":       "%d-%m %H:%M",     # year-less
}
YEARLESS = {"MM-DD", "DD-MM"}
LIVE_WINDOW = timedelta(hours=72)

class DateError(ValueError): pass

def parse(fmt, raw, received, backfill=False):
    if fmt not in FORMATS: raise DateError(f"unknown format {fmt}")
    try:
        d = datetime.strptime(raw.strip(), FORMATS[fmt])
    except ValueError as e:
        raise DateError(str(e))
    if fmt in YEARLESS:
        d = d.replace(year=received.year)
        if d > received:                       # most recent past occurrence
            d = d.replace(year=received.year - 1)
    if d > received:
        raise DateError(f"{d} is after received_at {received}")
    if (received - d) > (timedelta(days=400) if backfill else LIVE_WINDOW):
        raise DateError(f"{d} too far before {received}")
    return d
