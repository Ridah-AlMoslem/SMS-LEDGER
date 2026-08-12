"""Text normalization. Runs before classification, shape-hashing and extraction.
Every step here corresponds to a failure observed in real samples (ANALYSIS.md §10)."""
import re, hashlib, unicodedata

BIDI = dict.fromkeys(map(ord, "‎‏؜‪‫‬‭‮"))
DIGITS = {**{ord(c): str(i) for i, c in enumerate("٠١٢٣٤٥٦٧٨٩")},
          **{ord(c): str(i) for i, c in enumerate("۰۱۲۳۴۵۶۷۸۹")}}
SEPS = {0x066B: ".", 0x066C: ",", 0x060C: ","}
LETTERS = {**dict.fromkeys(map(ord, "أإآٱ"), "ا"), ord("ى"): "ي", ord("ؤ"): "و", ord("ئ"): "ي"}
DIACRITICS = re.compile(r"[ـً-ْٰ]")
# Two separate rules. Latin tokens (SAR/SR) may sit flush against Arabic letters
# — AlRajhi writes `بـSR 150`, which normalizes to `بSR`. Arabic tokens must NOT,
# or `رس` matches inside `رسوم` and the fee line becomes `SARوم وضريبة`.
CUR_LATIN  = re.compile(r"(?<![A-Za-z])(?:SAR|SR)(?![A-Za-z])")
CUR_ARABIC = re.compile(r"(?<![\u0600-\u06FF])(?:ر\.س|ريال|رس)(?![\u0600-\u06FF])")
ARABIC = re.compile(r"[؀-ۿ]")
LATIN = re.compile(r"[A-Za-z]")

def strip_invisible(t): return t.translate(BIDI)

def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).translate(BIDI).translate(DIGITS).translate(SEPS)
    t = DIACRITICS.sub("", t).translate(LETTERS)
    t = CUR_ARABIC.sub("SAR", CUR_LATIN.sub("SAR", t))
    t = re.sub(r"[ \t]+", " ", t)
    return "\n".join(line.strip() for line in t.split("\n")).strip()

def detect_language(text: str) -> str:
    """Which parsing rules a message needs: 'ar', 'en', or 'unknown'.

    Every attested format from every sender is Arabic, and no English message
    has ever arrived. So this is not a routing decision — it is a canary. A row
    tagged 'en' means a sender started writing in English, which no template
    covers and which would otherwise only show up as an unexplained arrival in
    the review queue.

    A Latin MERCHANT NAME does not make a message English. `لدى: TAMIMI MARKETS`
    is an Arabic message about a shop with a Latin name, and an earlier version
    of this function called that 'mixed' — which fired on most normal purchases
    and made the signal useless. Presence of the Arabic block decides it.
    """
    if ARABIC.search(text):
        return "ar"
    return "en" if LATIN.search(text) else "unknown"

SCRIPT_EDGE = re.compile(
    r"(?<=[؀-ۿ])(?=[A-Za-z0-9#])|(?<=[A-Za-z0-9#])(?=[؀-ۿ])"   # Arabic <-> Latin/digit
    r"|(?<=[#0-9])(?=[A-Za-z])|(?<=[A-Za-z])(?=[#0-9])"         # digit <-> Latin
)

def split_scripts(t: str) -> str:
    """Insert a space at Arabic<->Latin/digit boundaries. Barq writes
    'مبلغ113.00SAR' with no separators at all; AlRajhi writes 'بـSR 150'."""
    return SCRIPT_EDGE.sub(" ", t)

# Free text below the header: merchant names, counterparty names, ATM names.
# `SAR` is excluded because it is structural — it marks where an amount sits,
# and collapsing it would merge a currency-bearing line with a bare one.
FREE_TEXT = re.compile(
    r"(?<![A-Za-z])(?!SAR\b)[A-Za-z][A-Za-z'&.\-]*(?:\s+[A-Za-z][A-Za-z'&.\-]*)*")


def shape_hash(text: str) -> str:
    """Collapse a message to its template skeleton so variants of one format agree.

    Numbers become `#`, masked account runs become `X`, and free text below the
    first line becomes `T`.

    That last rule is what makes the shape a FORMAT identifier rather than a
    message identifier. Without it a merchant name is structural, so one
    AlRajhi purchase format produces a distinct shape per shop — measured at 31
    shapes across 31 sample messages, i.e. no grouping at all. SPEC §3.2 rests
    on template count scaling with formats (tens) rather than messages
    (thousands); merchant-sensitive hashing quietly broke that.

    The FIRST LINE is deliberately left alone. It is the header, and headers are
    what distinguish formats — STC's `شراء Apple Pay` differs from `شراء انترنت`
    only in Latin text, and collapsing it would merge two unrelated templates.
    Fields always appear below the header in every attested format.

    Verified against every attested format in tests/verify_shapes.py: same
    format with different merchants collapses to one shape, and no two
    templates ever share one.
    """
    t = normalize(text)
    t = re.sub(r"\d+(?:[.,]\d+)*", "#", t)          # every number -> #
    t = re.sub(r"[Xx*]+", "X", t)                    # SAIB writes XXXX7001 / XXX7001 / X7001

    lines = t.split("\n")
    t = "\n".join([lines[0]] + [FREE_TEXT.sub("T", line) for line in lines[1:]])

    t = split_scripts(t)
    t = re.sub(r"\bال(?=مبلغ|رصيد|اجمالي)", "", t)   # optional definite article
    t = re.sub(r"[^\w؀-ۿ#]+", " ", t)      # punctuation is not structural
    t = re.sub(r"\s+", " ", t).strip()
    return hashlib.sha256(t.encode()).hexdigest()[:16]

def parse_amount(s: str):
    m = re.search(r"\d[\d,]*(?:\.\d+)?", s.replace(" ", ""))
    return float(m.group(0).replace(",", "")) if m else None

def last_digits(s: str, n: int = 4):
    d = re.sub(r"\D", "", s or "")
    return d[-n:] if len(d) >= 3 else None

# NOTE: currency position (`مدى10.00 SAR` vs `مدى SAR 17.00`) appeared to vary in
# Barq messages, but that reading came from a screenshot and the bidi algorithm
# reorders numeric runs for display. Only `مدى10.00 SAR` is attested in raw text.
# Shape-hashing deliberately treats the two orders as DIFFERENT templates: over-
# splitting costs one extra template, wrongly merging corrupts field extraction.
