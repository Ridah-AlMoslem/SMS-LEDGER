"""Sender identity: what the phone reports → what the templates expect.

The parser addresses institutions by an exact string. `classify` gates on
`BANK_SENDERS`, all 29 templates carry `sender=`, and account identifiers are
keyed `(institution, masked_value)` — so one sender string decides whether a
message is classified, matched, and resolved, or parks in review.

That string comes from iOS, and nothing in this repo can predict it. An
alphanumeric sender ID may arrive with different spacing or case than the
samples were collected with, and if the number is saved in Contacts, iOS
reports the contact's name instead of the sender ID entirely.

So the mapping is data, in one place. A mismatch is then a line here plus a
requeue, rather than an edit across 29 templates and a seed file.

Two rules make this safe:

**Aliasing happens at PARSE time, never at ingest.** `raw_messages` stores what
the phone actually said, because it is append-only (§3.1) and is the evidence
for what the sender string really is. Changing this map and requeueing replays
correctly; rewriting the sender on the way in would destroy the only record of
the problem while hiding that it ever happened.

**An unknown sender is returned unchanged, never guessed.** It then fails the
`BANK_SENDERS` gate and parks in review with its real name visible, which is
the designed path (§8.3, and the "unknown senders go to review, never to the
bin" rule). Fuzzy-matching an unrecognised sender onto a bank would post real
money against an institution nobody confirmed.
"""

from __future__ import annotations

import re

# The names every template, `BANK_SENDERS` entry and `account_identifiers.institution`
# row is written against. Renaming one of these means editing all three.
CANONICAL = ("AlRajhiBank", "SAIB", "STC Bank", "barq app")

# Everything else that means the same institution.
#
# Case and internal spacing are already handled by the key normalization below,
# so `stc bank`, `STCBANK` and `STC  Bank` all resolve without an entry. Only
# genuinely different strings belong here — a different sender ID, a Contacts
# name, or a bank changing what it broadcasts.
#
# Add to this list only from an observed sender string. Guessing at variants a
# bank might use has the same failure mode as guessing at regexes: it looks
# harmless until the day one of the guesses collides with something real.
ALIASES: dict[str, str] = {
    # e.g. "alrajhi": "AlRajhiBank",
    # e.g. "SAIBAlAhli": "SAIB",
}


def _key(s: str) -> str:
    """Fold the differences that are never meaningful: case, and spacing.

    `casefold` rather than `lower` because it is the correct operation for
    non-ASCII, and a sender ID is not guaranteed to be ASCII.
    """
    return re.sub(r"\s+", "", s or "").casefold()


_LOOKUP = {_key(name): name for name in CANONICAL}
_LOOKUP.update({_key(k): v for k, v in ALIASES.items()})


def canonical(sender: str) -> str:
    """Map a reported sender onto its canonical name, or return it untouched."""
    return _LOOKUP.get(_key(sender), sender)


def is_known(sender: str) -> bool:
    return _key(sender) in _LOOKUP
