# sms-ledger

Builds a complete personal financial ledger out of bank SMS messages.

Saudi bank SMS arrive in Arabic and English, often mixed inside a single message, with
inconsistent date formats, inconsistent account masking, and bidirectional-text artifacts.
This repo holds the parsing core: normalization, classification, template matching,
extraction, date disambiguation, salary-cycle arithmetic, and double-entry posting.

The design target is a Next.js + Supabase dashboard — see [`SPEC.md`](SPEC.md). What exists
today is the parser and its verification harness, written in pure Python with **no third-party
dependencies**.

---

## Quick start

Requires Python 3.10+. Nothing to install.

```bash
# Run the full two-cycle simulation and audit
python3 scripts/simulate_two_months.py

# Emit a human-readable trace of every message processed
python3 scripts/trace.py
```

Run all verification scripts:

```bash
for f in scripts/verify_*.py; do
  echo "== $f"; python3 "$f" || echo "FAILED: $f";
done
```

---

## Layout

```
parser/
  normalize.py   Bidi stripping, Arabic-Indic digits, letterform folding,
                 currency tokens, shape hashing
  classify.py    Message classification; non-ledger classes short-circuit first
  registry.py    12 templates, regexes derived only from attested raw text
  extract.py     Field extraction per template
  dates.py       Per-template date formats + received_at validation
  periods.py     Salary-cycle arithmetic (25th → 24th)
  topup.py       Wallet top-up linking
  pipeline.py    ingest → dedup → classify → match → extract → date →
                 resolve → post → link

scripts/
  scenario.py               Message generator that emits ground truth beside
                            every message
  run_scenario.py           Scenario wiring (accounts, card limit, identities)
  simulate_two_months.py    Runs the scenario, audits output against ground truth
  trace.py                  Chronological per-message trace → samples/TRACE.md
  verify_*.py               Focused checks per spec area (dates, periods,
                            classification, pairing, top-ups, accounting,
                            lifecycle, batch-3 raw samples)

samples/       Raw SMS batches and derived analysis (untracked — see below)
SPEC.md        Full v1 specification: data model, accounting rules, lifecycle,
               ingest pipeline, features, build order
AUDIT.md       Result of the two-month simulation, including six bugs it caught
```

---

## Design rules

These are load-bearing. Breaking them has produced silent, expensive bugs before.

**Regexes come only from attested raw text.** No template is written against an imagined
message shape. If a format has not been observed in a real SMS, it does not get a template —
it goes to manual review.

**Unknown senders go to review, never to the bin.** Dropping unrecognized messages as spam
means adding a new bank account silently loses every message from it, with no error anywhere.

**Never compare masked account strings literally.** One sender writes the same account as
`XXXX7001`, `XXX7001`, `X7001`, and `0000xx17001`. Resolution is by suffix against owned
identifiers.

**Names never decide transfer direction.** A transfer to your own name at another bank is
internal; classifying on recipient name books an expense that never happened. Only an account
identifier resolving to an owned account gets it right.

**Credit raises net worth, debit lowers it — for assets and liabilities alike.** A credit on a
card reduces debt. Special-casing liability signs is where the sign errors came from.

**One message can produce two legs.** Internal transfers, card payments, and cashback
redemption each describe both sides of a movement in a single SMS.

**The month is the salary cycle, 25th → 24th**, labeled by the month it *ends* in. A salary
paid early carries `تاريخ استحقاق`, and the due date — not the received date — decides the
cycle.

---

## A note on data privacy

The verification scripts read real bank SMS. Those files are **deliberately untracked** via
`.gitignore`:

```
samples/*_raw.txt      Raw SMS batches
samples/ANALYSIS.md    Format analysis quoting real messages
samples/TRACE.md       Generated trace containing real account references
samples/COLLECTION.md  Collection notes
```

They stay on disk so everything runs locally, but they never enter git history. A fresh clone
runs the simulation and every `verify_*.py` except `verify_batch3.py`, which reads
`samples/batch3_raw.txt` directly.

Account numbers and names appearing in `SPEC.md` and `scripts/scenario.py` are **placeholders**.
The parser matches on message structure, never on these literals.

---

## Status

Parser core and verification harness: working. 50-message, two-cycle simulation passes against
generator ground truth with zero failures, and cycle totals match exactly. See
[`AUDIT.md`](AUDIT.md).

Not built yet: ingest API, database, dashboard UI, LLM fallback for unmatched templates.
Build order is in `SPEC.md` §12.
