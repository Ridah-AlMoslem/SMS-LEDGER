"""Per-template date parsing with received_at validation (SPEC §10.4.1)."""
from datetime import datetime, timedelta, timezone

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

# Bank SMS print Riyadh wall-clock time, always. A fixed +03:00 rather than
# ZoneInfo("Asia/Riyadh") because Saudi Arabia has observed UTC+3 with no DST
# since 1990 — the offset cannot drift, and this needs no tzdata package on the
# deployment target.
RIYADH = timezone(timedelta(hours=3))


class DateError(ValueError): pass


def parse(fmt, raw, received, backfill=False):
    """Resolve a bank-printed timestamp against when the message arrived.

    Awareness follows `received`, deliberately:

      - naive in  → naive out. The verification suite and the in-memory
        pipeline work in bare wall-clock and never touch a database.
      - aware in  → aware out, tagged Riyadh. Postgres hands back TIMESTAMPTZ,
        and mixing that with a naive parse is a TypeError at best. At worst it
        silently shifts a transaction across a cycle boundary: 00:30 Riyadh on
        the 25th is 21:30 UTC on the 24th, which is the *previous* salary
        cycle. Comparing UTC to a Riyadh wall-clock string would file a payday
        into the wrong month.
    """
    if fmt not in FORMATS:
        raise DateError(f"unknown format {fmt}")
    try:
        d = datetime.strptime(raw.strip(), FORMATS[fmt])
    except ValueError as e:
        raise DateError(str(e))

    aware = received.tzinfo is not None
    if aware:
        d = d.replace(tzinfo=RIYADH)

    # The year-less rollover has to be decided in the same zone the bank
    # printed, or a message arriving 31 Dec 22:00 UTC picks the wrong year.
    ref = received.astimezone(RIYADH) if aware else received

    if fmt in YEARLESS:
        d = d.replace(year=ref.year)
        if d > ref:                            # most recent past occurrence
            d = d.replace(year=ref.year - 1)

    if d > received:
        raise DateError(f"{d} is after received_at {received}")
    if (received - d) > (timedelta(days=400) if backfill else LIVE_WINDOW):
        raise DateError(f"{d} too far before {received}")
    return d
