"""End-to-end message pipeline (SPEC §10.3).

A single message can describe a movement between TWO owned accounts while the
bank sends only one SMS. Those produce two legs from one message, so balances
move on both sides and `d(net worth) == income - expense` still holds.
"""
import hashlib
from datetime import datetime, timedelta
from .normalize import normalize, shape_hash
from .classify import classify
from .registry import match
from .dates import parse as parse_date, DateError
from .periods import period_start, period_label
from .topup import link_topups

LEDGER_KINDS = {"purchase","transfer","transfer_in","salary","profit","card_payment",
                "bill_payment","wallet_topup","cashback_accrual","cashback_redeem","withdrawal"}

class Pipeline:
    def __init__(self, accounts, identifiers, owned_cards, funding_account=None,
                 cashback_account="cashback_wallet"):
        self.accounts, self.identifiers, self.owned_cards = accounts, identifiers, owned_cards
        self.funding_account, self.cashback_account = funding_account, cashback_account
        self.raw, self.txns, self.snapshots, self.seen = [], [], [], set()
        self.next_id = 1

    # ---------------- ingest: verbatim, dedup, never parse ----------------
    def ingest(self, sender, body, received_at):
        h = hashlib.sha256(
            f"{sender}|{normalize(body)}|{received_at:%Y-%m-%d %H:%M}".encode()).hexdigest()
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
        c = classify(r["body"], r["sender"])
        if c["ledger_effect"] == "none":
            r.update(status="ignored", ignored_reason=c["kind"]); return
        if c["ledger_effect"] == "review":
            r.update(status="needs_review",
                     error=c.get("note", "classified but not actionable")); return
        if c["kind"] not in LEDGER_KINDS and c["ledger_effect"] != "snapshot":
            r.update(status="needs_review", error=f"unhandled class {c['kind']}"); return

        tp, f = match(r["sender"], r["body"])
        if tp is None:
            r.update(status="needs_review", error="no template matched"); return

        ts = r["received_at"]
        if tp["date_format"]:
            try: ts = parse_date(tp["date_format"], f["date_raw"], r["received_at"])
            except (DateError, KeyError) as e:
                r.update(status="needs_review", template_id=tp["id"], error=f"date: {e}"); return

        acct = self._resolve(r["sender"], tp, f)
        if acct is None:
            r.update(status="needs_review", template_id=tp["id"], error="unresolved account"); return

        cycle = self._cycle(tp, f, ts)
        for account, direction, internal in self._legs(r["sender"], tp, f, acct):
            self.txns.append(dict(
                id=self.next_id, raw_id=r["id"], template=tp["id"], institution=r["sender"],
                account=account, kind=tp["kind"], amount=f["amount"], ts=ts, cycle=cycle,
                direction=direction, is_internal=internal, transfer_group_id=None,
                card_last4=f.get("card"), merchant=f.get("merchant"),
                balance=f.get("balance") if account == acct else None,
                counterparty_account=f.get("counterparty_account"),
                fee_amount=f.get("fee_amount"), original_currency=f.get("original_currency"),
                biller=f.get("biller"), due_raw=f.get("due_raw")))
            self.next_id += 1
        if f.get("balance") is not None:
            self.snapshots.append(dict(account=acct, balance=f["balance"], ts=ts))
        r.update(status="parsed", template_id=tp["id"])

    def _legs(self, sender, tp, f, acct):
        """(account, direction, is_internal) tuples. Two legs when one message
        describes a movement between two accounts you own."""
        kind = tp["kind"]
        if kind == "transfer":
            a_from = self.identifiers.get((sender, f.get("from_account")))
            a_to   = self.identifiers.get((sender, f.get("to_account")))
            if a_from and a_to and a_from != a_to:
                return [(a_from, "debit", True), (a_to, "credit", True)]
        if kind == "card_payment" and self.funding_account:
            return [(acct, "credit", True), (self.funding_account, "debit", True)]
        if kind == "cashback_redeem":
            return [(acct, "credit", True), (self.cashback_account, "debit", True)]
        return [(acct, f["direction"], False)]

    def _cycle(self, tp, f, ts):
        """Salary carries تاريخ استحقاق — the authoritative cycle anchor (SPEC §5.6)."""
        if tp["kind"] == "salary" and f.get("due_raw"):
            mm, dd = f["due_raw"].split("/")
            year = ts.year + (1 if (ts.month == 12 and mm == "01") else 0)
            return period_label(datetime(year, int(mm), int(dd)))
        return period_label(ts)

    def _resolve(self, sender, tp, f):
        if tp.get("account_hint"): return tp["account_hint"]
        for key in ("card", "from_account", "to_account"):
            v = f.get(key)
            if v and (sender, v) in self.identifiers: return self.identifiers[(sender, v)]
        return self.identifiers.get((sender, "__default__"))

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
