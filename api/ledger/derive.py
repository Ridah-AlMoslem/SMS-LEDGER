"""Derive a template from one hand-marked message (SPEC §10.5, §10.7).

The mechanism the spec describes for LLM-extracted fields, with you as the
extractor: you say which substring is the amount, the merchant, the balance,
and this turns the message into a regex keyed on its shape hash. Every other
message sharing that shape then parses without further help — which is what
makes adding a bank cost one message instead of forty.

Two rules make this safe to expose in a UI:

  1. Fields are located by VALUE, not by coordinates. You give the amount as it
     appears; the span is found. Nothing depends on a click landing precisely.

  2. A derived pattern is validated by re-parsing the message it came from and
     comparing against the values you supplied. A template that cannot
     reproduce its own source message is rejected, never stored. Storing one
     would mis-parse every future message of that shape, silently.
"""

import re

from .normalize import normalize, parse_amount, last_digits

# What each field is allowed to look like once generalised. Deliberately
# narrow: a capture that matches too much will happily swallow a neighbouring
# field on the next message and produce a plausible wrong answer.
CAPTURE = {
    "amount":       r"([\d][\d,]*(?:\.\d+)?)",
    "balance":      r"([\d][\d,]*(?:\.\d+)?)",
    "fee_amount":   r"([\d][\d,]*(?:\.\d+)?)",
    "date_raw":     r"(.+?)",
    "merchant":     r"(.+)",
    "counterparty": r"(.+)",
    "card":         r"(\S+)",
    "from_account": r"(\S+)",
    "to_account":   r"(\S+)",
    "biller":       r"(.+)",
}

NUMERIC_FIELDS = {"amount", "balance", "fee_amount"}
ACCOUNT_FIELDS = {"card", "from_account", "to_account"}

FIELD_ORDER = list(CAPTURE)


class DeriveError(ValueError):
    """Raised when a template cannot be derived, or cannot reproduce itself."""


def _spans(text: str, fields: dict) -> list:
    """Locate each supplied value in the message. Returns [(start, end, name)].

    Ambiguity is an error rather than a guess. If the amount 113.00 appears
    twice — once as the amount and once inside a reference number — picking the
    first occurrence would be right roughly half the time, and wrong silently
    the rest.
    """
    found = []
    for name, value in fields.items():
        if name not in CAPTURE:
            raise DeriveError(f"unknown field {name!r}")
        value = (value or "").strip()
        if not value:
            continue

        occurrences = [m.start() for m in re.finditer(re.escape(value), text)]
        if not occurrences:
            raise DeriveError(f"{name}: {value!r} does not appear in the message")
        if len(occurrences) > 1:
            raise DeriveError(
                f"{name}: {value!r} appears {len(occurrences)} times — "
                "include more surrounding text so it is unambiguous")

        found.append((occurrences[0], occurrences[0] + len(value), name))

    if not found:
        raise DeriveError("mark at least one field")

    found.sort()
    for (_, end, a), (start, _, b) in zip(found, found[1:]):
        if start < end:
            raise DeriveError(f"{a} and {b} overlap")
    return found


def _literal(segment: str) -> str:
    r"""Escape a fixed segment, but let whitespace flex.

    Real senders are inconsistent about spacing within one format — `ب:23SAR`
    and `ب: 5.5 SAR` are the same template. Normalization collapses runs, but
    zero-versus-one space survives it, so a literal ` ` becomes `\s*`.
    """
    escaped = re.escape(segment)
    return re.sub(r"(?:\\?\s)+", r"\\s*", escaped)


def derive_pattern(body: str, fields: dict) -> str:
    """Build an anchored regex that captures the marked fields.

    Works on the NORMALIZED body, because that is what registry.match() sees.
    """
    text = normalize(body)
    spans = _spans(text, fields)

    out, cursor = [], 0
    for start, end, name in spans:
        out.append(_literal(text[cursor:start]))
        out.append(CAPTURE[name])
        cursor = end
    out.append(_literal(text[cursor:]))

    return "^" + "".join(out) + "$"


def build_mapper(field_names: list):
    """Turn capture groups back into the field dict the pipeline expects.

    Mirrors what the hand-written templates in registry.py do: amounts through
    parse_amount, account references through last_digits, everything else
    stripped.
    """
    order = list(field_names)

    def mapper(m):
        out = {}
        for index, name in enumerate(order, start=1):
            raw = m[index]
            if name in NUMERIC_FIELDS:
                out[name] = parse_amount(raw)
            elif name in ACCOUNT_FIELDS:
                out[name] = last_digits(raw)
            else:
                out[name] = raw.strip()
        return out

    return mapper


def derive(body: str, fields: dict, kind: str, direction: str,
           date_format: str | None = None, sender: str = "",
           account_hint: str | None = None) -> dict:
    """Derive, then prove it works. Returns a template dict ready to register.

    The validation step is the whole safety argument: a pattern is only stored
    if re-parsing its own source message reproduces the values that were
    entered. Without it, a subtly wrong capture — one that grabs a trailing
    space, or swallows the currency token — would be saved and then applied to
    every future message of that shape.
    """
    if direction not in ("debit", "credit"):
        raise DeriveError("direction must be debit or credit")
    if not kind:
        raise DeriveError("kind is required")

    supplied = {k: v for k, v in fields.items() if (v or "").strip()}
    if date_format and "date_raw" not in supplied:
        raise DeriveError("a date format was chosen but no date value was marked")
    if "amount" not in supplied:
        raise DeriveError("amount is required — a transaction without one is not a transaction")

    # A message that names no card or account number has nothing to resolve
    # against, so it needs to be told which account it belongs to. Barq and
    # cashback messages are both like this. Without the hint the template would
    # derive cleanly and then park every message as "unresolved account".
    if not account_hint and not (supplied.keys() & ACCOUNT_FIELDS):
        raise DeriveError(
            "this message names no card or account number, so an account must be chosen")

    pattern = derive_pattern(body, supplied)

    # Capture groups appear in positional order, which is span order, not the
    # order the fields were typed in.
    ordered = [name for _, _, name in _spans(normalize(body), supplied)]

    try:
        rx = re.compile(pattern, re.M)
    except re.error as exc:
        raise DeriveError(f"generated an invalid regex: {exc}")

    m = rx.search(normalize(body))
    if not m:
        raise DeriveError("the generated pattern does not match its own message")

    extracted = build_mapper(ordered)(m)

    for name, value in supplied.items():
        want = (parse_amount(value) if name in NUMERIC_FIELDS
                else last_digits(value) if name in ACCOUNT_FIELDS
                else value.strip())
        if extracted.get(name) != want:
            raise DeriveError(
                f"validation failed for {name}: pattern extracted "
                f"{extracted.get(name)!r} but you marked {want!r}")

    return {
        "sender": sender,
        "kind": kind,
        "direction": direction,
        "date_format": date_format or None,
        "pattern": pattern,
        "field_order": ordered,
        "account_hint": account_hint or None,
    }


def to_runtime_template(row: dict) -> dict:
    """Turn a stored template into the shape registry.match() iterates over.

    `direction` is injected by the mapper rather than captured, because no bank
    prints the word 'debit' — it is implied by the message format, which is
    exactly what the template encodes.
    """
    order = list(row["field_order"])
    base = build_mapper(order)
    direction = row["direction"]

    def mapper(m):
        out = base(m)
        out.setdefault("direction", direction)
        return out

    return dict(
        id=row.get("id", "derived"),
        sender=row["sender"],
        kind=row["kind"],
        date_format=row.get("date_format"),
        rx=re.compile(row["pattern"], re.M),
        map=mapper,
        account_hint=row.get("account_hint"),
    )
