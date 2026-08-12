"""Emits a chronological, human-auditable trace of every message processed."""
import sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api")); sys.path.insert(0, HERE)
from run_scenario import build, ACCOUNTS, OPENING, CARD_LIMIT
from ledger.classify import classify
from ledger.registry import match

S, p, dupes = build()
legs_by_raw = {}
for t in p.txns: legs_by_raw.setdefault(t["raw_id"], []).append(t)

ICON = {"parsed": "OK  ", "ignored": "SKIP", "needs_review": "HOLD"}
bal = dict(OPENING)
out = []
w = out.append

w("# Processing Trace — Two-Month Scenario\n")
w(f"Every message in arrival order, with the decision path and the resulting ledger effect.\n")
w(f"**{len(S.raw) if hasattr(S,'raw') else len(S.msgs)} messages · "
  f"{p.counts().get('parsed',0)} parsed · {p.counts().get('ignored',0)} ignored · "
  f"{p.counts().get('needs_review',0)} held for review · {dupes} duplicates rejected**\n")
w("Legend — `OK` posted to the ledger · `SKIP` deliberately not a transaction · "
  "`HOLD` unknown format, parked for manual processing\n")
w("---\n")

cycle_now = None
for r in p.raw:
    legs = legs_by_raw.get(r["id"], [])
    cyc = legs[0]["cycle"] if legs else None
    if cyc and cyc != cycle_now:
        cycle_now = cyc
        w(f"\n## Cycle: {cyc}\n")

    c = classify(r["body"], r["sender"])
    w(f"### `{ICON[r['status']]}`  #{r['id']:02d} · {r['received_at']:%Y-%m-%d %H:%M} · **{r['sender']}**\n")
    w("```")
    for line in r["body"].strip().split("\n"): w(line.rstrip())
    w("```")
    w("")
    steps = [f"**classify** → `{c['kind']}` ({c['ledger_effect']})"]
    if r["status"] == "ignored":
        steps.append(f"**stop** → ignored, reason `{r['ignored_reason']}`, no transaction")
    elif r["status"] == "needs_review":
        steps.append(f"**template** → none (shape `{r['shape']}`)")
        steps.append(f"**stop** → `needs_review`: {r['error']} — *no fields guessed*")
    else:
        tp, f = match(r["sender"], r["body"])
        steps.append(f"**template** → `{tp['id']}`" +
                     (f", date `{tp['date_format']}`" if tp["date_format"] else ", no date field"))
        shown = {k: v for k, v in f.items() if k not in ("date_raw",) and v is not None}
        steps.append("**extract** → " + " · ".join(f"`{k}`={v}" for k, v in list(shown.items())[:7]))
        if tp["date_format"]:
            steps.append(f"**date** → `{f['date_raw']}` ({tp['date_format']}) → "
                         f"{legs[0]['ts']:%Y-%m-%d %H:%M}")
        for lg in legs:
            sign = "+" if lg["direction"] == "credit" else "−"
            bal[lg["account"]] += lg["amount"] if lg["direction"] == "credit" else -lg["amount"]
            tag = " *(internal — not spending)*" if lg["is_internal"] else ""
            steps.append(f"**post** → `{lg['account']}` {sign}{lg['amount']:,.2f}{tag} "
                         f"→ balance {bal[lg['account']]:,.2f}")
        if legs and legs[0].get("balance") is not None:
            acct = legs[0]["account"]
            rep = legs[0]["balance"]
            ok = "matches" if abs(bal[acct] - rep) < 0.01 else f"DRIFT {bal[acct]-rep:+.2f}"
            steps.append(f"**reconcile** → bank says {rep:,.2f}, we computed {bal[acct]:,.2f} — {ok}")
        if legs and legs[0]["kind"] == "salary":
            steps.append(f"**cycle** → due `{legs[0]['due_raw']}` → **{legs[0]['cycle']}** "
                         f"(raw date alone would say {__import__('ledger.periods', fromlist=['periods']).period_label(legs[0]['ts'])})")
    for s_ in steps: w(f"- {s_}")
    w("")

w("\n---\n\n## Closing position\n")
w("| Account | Balance | Meaning |")
w("|---|---:|---|")
for a in ("saib_current","saib_savings","barq","cashback_wallet"):
    w(f"| {a} | {bal[a]:,.2f} | asset (opening 0.00) |")
w(f"| alrajhi_card | {bal['alrajhi_card']:,.2f} | available credit → **debt "
  f"{CARD_LIMIT-bal['alrajhi_card']:,.2f}** |")
w("")
for cyc in ("July 2026", "August 2026"):
    inc, exp = p.income(cyc), p.expense(cyc)
    w(f"**{cyc}** — income {inc:,.2f} · expense {exp:,.2f} · net {inc-exp:,.2f} "
      f"· savings rate {100*(inc-exp)/inc:.1f}%\n")
w(f"Master invariant: Δ net worth {p.net_worth_delta():,.2f} == income {p.income():,.2f} − "
  f"expense {p.expense():,.2f} = {p.income()-p.expense():,.2f}\n")

open(os.path.join(HERE, "..", "samples", "TRACE.md"), "w").write("\n".join(out))
print(f"wrote samples/TRACE.md — {len(out)} lines")
