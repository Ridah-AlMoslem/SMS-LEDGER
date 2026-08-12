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
    ar, la = bool(ARABIC.search(text)), bool(LATIN.search(text))
    # Latin merchant names inside an Arabic body are not "mixed" — require a Latin *word*
    if ar and re.search(r"[A-Za-z]{3,}\s+[A-Za-z]{3,}", text): return "mixed"
    return "ar" if ar else ("en" if la else "unknown")

SCRIPT_EDGE = re.compile(
    r"(?<=[؀-ۿ])(?=[A-Za-z0-9#])|(?<=[A-Za-z0-9#])(?=[؀-ۿ])"   # Arabic <-> Latin/digit
    r"|(?<=[#0-9])(?=[A-Za-z])|(?<=[A-Za-z])(?=[#0-9])"         # digit <-> Latin
)

def split_scripts(t: str) -> str:
    """Insert a space at Arabic<->Latin/digit boundaries. Barq writes
    'مبلغ113.00SAR' with no separators at all; AlRajhi writes 'بـSR 150'."""
    return SCRIPT_EDGE.sub(" ", t)

def shape_hash(text: str) -> str:
    """Collapse a message to its template skeleton so variants of one format agree."""
    t = normalize(text)
    t = re.sub(r"\d+(?:[.,]\d+)*", "#", t)          # every number -> #
    t = re.sub(r"[Xx*]+", "X", t)                    # SAIB writes XXXX7001 / XXX7001 / X7001
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
