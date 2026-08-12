"""End-to-end message pipeline (SPEC §10.3).

A single message can describe a movement between TWO owned accounts while the
bank sends only one SMS. Those produce two legs from one message, so balances
move on both sides and `d(net worth) == income - expense` still holds.
"""
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from .normalize import normalize, shape_hash
from .classify import classify
from .registry import match
from .dates import parse as parse_date, DateError
from .periods import period_start, period_label
from .topup import link_topups

LEDGER_KINDS = {"purchase","transfer","transfer_in","salary","profit","card_payment",
                "bill_payment","wallet_topup","cashback_accrual","cashback_redeem","withdrawal"}


def body_hash(sender, body, received_at):
    """Dedup key (SPEC §10.2). received_at is folded in at minute precision
    because some senders omit any timestamp inside the body — without it, two
    genuinely separate identical purchases collapse into one."""
    return hashlib.sha256(
        f"{sender}|{normalize(body)}|{received_at:%Y-%m-%d %H:%M}".encode()).hexdigest()


@dataclass
class ParseResult:
    """What one message produced. No ids, no storage — the caller assigns those.

    This is the seam between the parser and persistence. The parser stays pure
    and stdlib-only so the verification suite can exercise it without a
    database, and the service writes the result wherever it likes.
    """
    status: str                       # 'parsed' | 'ignored' | 'needs_review'
    shape: str
    kind: str | None = None
    template_id: str | None = None
    ignored_reason: str | None = None
    error: str | None = None
    cycle: str | None = None
    posted_at: datetime | None = None
    legs: list = field(default_factory=list)
    snapshot: dict | None = None


def parse_message(sender, body, received_at, identifiers,
                  funding_account=None, cashback_account="cashback_wallet",
                  templates=None):
    """Classify → match → extract → date → resolve → build legs.

    Returns a ParseResult and touches nothing else. Every early return is a
    message that must NOT become a transaction: SPEC §7.1 is emphatic that
    non-transactions reaching the ledger is the most expensive class of bug
    here, because an OTP carrying an amount silently doubles a real payment.
    """
    shape = shape_hash(body)
    c = classify(body, sender)

    if c["ledger_effect"] == "none":
        return ParseResult(status="ignored", shape=shape, kind=c["kind"],
                           ignored_reason=c["kind"])
    if c["ledger_effect"] == "review":
        return ParseResult(status="needs_review", shape=shape, kind=c["kind"],
                           error=c.get("note", "classified but not actionable"))
    if c["kind"] not in LEDGER_KINDS and c["ledger_effect"] != "snapshot":
        return ParseResult(status="needs_review", shape=shape, kind=c["kind"],
                           error=f"unhandled class {c['kind']}")

    tp, f = match(sender, body, templates)
    if tp is None:
        return ParseResult(status="needs_review", shape=shape, kind=c["kind"],
                           error="no template matched")

    ts = received_at
    if tp["date_format"]:
        try:
            ts = parse_date(tp["date_format"], f["date_raw"], received_at)
        except (DateError, KeyError) as e:
            return ParseResult(status="needs_review", shape=shape, kind=tp["kind"],
                               template_id=tp["id"], error=f"date: {e}")

    acct = _resolve_account(sender, tp, f, identifiers)
    if acct is None:
        # Never dropped. An unresolved account means a provisional account in
        # the workbench, because the alternative is silently losing every
        # message from a newly opened account (SPEC §8.3).
        return ParseResult(status="needs_review", shape=shape, kind=tp["kind"],
                           template_id=tp["id"], error="unresolved account")

    cycle = _cycle_for(tp, f, ts)
    legs = [
        dict(account=account, direction=direction, is_internal=internal,
             amount=f["amount"], kind=tp["kind"], ts=ts, cycle=cycle,
             card_last4=f.get("card"), merchant=f.get("merchant"),
             balance=f.get("balance") if account == acct else None,
             counterparty_account=f.get("counterparty_account"),
             fee_amount=f.get("fee_amount"),
             original_currency=f.get("original_currency"),
             biller=f.get("biller"), due_raw=f.get("due_raw"))
        for account, direction, internal in _legs_for(
            sender, tp, f, acct, identifiers, funding_account, cashback_account)
    ]

    return ParseResult(
        status="parsed", shape=shape, kind=tp["kind"], template_id=tp["id"],
        cycle=cycle, posted_at=ts, legs=legs,
        snapshot=(dict(account=acct, balance=f["balance"], ts=ts)
                  if f.get("balance") is not None else None))


def _legs_for(sender, tp, f, acct, identifiers, funding_account, cashback_account):
    """(account, direction, is_internal) tuples.

    Two legs when one message describes a movement between two accounts you
    own. Booking only one side leaves the books unbalanced and breaks
    `d(net worth) == income - expense` (AUDIT §4.5).
    """
    kind = tp["kind"]
    if kind == "transfer":
        a_from = identifiers.get((sender, f.get("from_account")))
        a_to = identifiers.get((sender, f.get("to_account")))

        # A wallet transfer names only the OTHER side — the wallet itself is
        # implied by the sender. Without filling it in from the template's
        # account hint, a transfer from the wallet to an account you own books
        # one leg instead of two: money leaves and never arrives, and net worth
        # drops by an amount that never left your control (AUDIT §4.5).
        hint = tp.get("account_hint")
        if hint:
            if a_from is None and f.get("direction") == "debit":
                a_from = hint
            elif a_to is None and f.get("direction") == "credit":
                a_to = hint

        if a_from and a_to and a_from != a_to:
            return [(a_from, "debit", True), (a_to, "credit", True)]
    if kind == "card_payment" and funding_account:
        return [(acct, "credit", True), (funding_account, "debit", True)]
    if kind == "cashback_redeem":
        return [(acct, "credit", True), (cashback_account, "debit", True)]
    return [(acct, f["direction"], False)]


def _cycle_for(tp, f, ts):
    """Salary carries تاريخ استحقاق — the authoritative cycle anchor (SPEC §5.6).
    On the raw date alone an early payday lands in the previous cycle, showing
    one month with double income and the next with none."""
    if tp["kind"] == "salary" and f.get("due_raw"):
        mm, dd = f["due_raw"].split("/")
        year = ts.year + (1 if (ts.month == 12 and mm == "01") else 0)
        return period_label(datetime(year, int(mm), int(dd)))
    return period_label(ts)


def _resolve_account(sender, tp, f, identifiers):
    if tp.get("account_hint"):
        return tp["account_hint"]
    for key in ("card", "from_account", "to_account"):
        v = f.get(key)
        if v and (sender, v) in identifiers:
            return identifiers[(sender, v)]
    return identifiers.get((sender, "__default__"))

class Pipeline:
    def __init__(self, accounts, identifiers, owned_cards, funding_account=None,
                 cashback_account="cashback_wallet"):
        self.accounts, self.identifiers, self.owned_cards = accounts, identifiers, owned_cards
        self.funding_account, self.cashback_account = funding_account, cashback_account
        self.raw, self.txns, self.snapshots, self.seen = [], [], [], set()
        self.next_id = 1

    # ---------------- ingest: verbatim, dedup, never parse ----------------
    def ingest(self, sender, body, received_at):
        h = body_hash(sender, body, received_at)
        if h in self.seen: return {"status": "duplicate"}
        self.seen.add(h)
        rec = dict(id=len(self.raw)+1, sender=sender, body=body, received_at=received_at,
                   hash=h, status="pending", ignored_reason=None, template_id=None,
                   shape=shape_hash(body), error=None)
        self.raw.append(rec); return rec

    # ---------------- parse tick ----------------
    def process_all(self):
        for r in self.raw:
            if r["status"] == "pending": self._process(r)
        link_topups(self.txns, self.owned_cards)
        return self

    def _process(self, r):
        """In-memory bookkeeping around parse_message().

        Deliberately thin: the service and this class must go through the same
        parsing code, or the verification suite stops describing what actually
        runs in production.
        """
        res = parse_message(r["sender"], r["body"], r["received_at"], self.identifiers,
                            self.funding_account, self.cashback_account)

        if res.status != "parsed":
            r.update(status=res.status, ignored_reason=res.ignored_reason,
                     template_id=res.template_id, error=res.error)
            return

        for leg in res.legs:
            self.txns.append(dict(
                id=self.next_id, raw_id=r["id"], template=res.template_id,
                institution=r["sender"], transfer_group_id=None, **leg))
            self.next_id += 1

        if res.snapshot is not None:
            self.snapshots.append(res.snapshot)
        r.update(status="parsed", template_id=res.template_id)

    # ---------------- reporting ----------------
    def counts(self):
        out = {}
        for r in self.raw: out[r["status"]] = out.get(r["status"], 0) + 1
        return out

    def net_worth_delta(self):
        """Credit raises net worth, debit lowers it — for assets AND liabilities.
        A credit on a card reduces debt, which is a net-worth increase."""
        return sum(t["amount"] if t["direction"] == "credit" else -t["amount"]
                   for t in self.txns)

    def income(self, cycle=None):
        return sum(t["amount"] for t in self.txns
                   if t["kind"] in ("salary","profit","cashback_accrual")
                   and (cycle is None or t["cycle"] == cycle))

    def expense(self, cycle=None):
        return sum(t["amount"] for t in self.txns
                   if t["kind"] in ("purchase","bill_payment") and not t["is_internal"]
                   and (cycle is None or t["cycle"] == cycle))
