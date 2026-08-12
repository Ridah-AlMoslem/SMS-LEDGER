# Two-Month Simulation — Audit Report

**Run:** 25 Jun 2026 → 24 Aug 2026 (two salary cycles)
**Reproduce:** `python3 tests/simulate_two_months.py`
**Full output:** `samples/SIMULATION_OUTPUT.txt`

---

## 1. What was built

| File | Purpose |
|---|---|
| `api/ledger/normalize.py` | Bidi stripping, Arabic-Indic digits, letterform folding, currency tokens, shape hashing |
| `api/ledger/classify.py` | Message classification; non-ledger classes short-circuit first |
| `api/ledger/registry.py` | 12 templates with regexes derived **only** from raw attested text |
| `api/ledger/dates.py` | Per-template date formats + `received_at` validation |
| `api/ledger/periods.py` | Salary-cycle arithmetic (25th → 24th) |
| `api/ledger/topup.py` | Wallet top-up linking |
| `api/ledger/pipeline.py` | Ingest → dedup → classify → match → extract → date → resolve → post → link |
| `tests/scenario.py` | Message generator that emits **ground truth** beside every message |
| `tests/simulate_two_months.py` | Runs the scenario and audits output against ground truth |

The generator knows what each message *should* produce, so this is a comparison against known-correct values, not an eyeball check.

## 2. Result

**50 messages generated, plus 5 verbatim resubmissions.**

| Outcome | Count |
|---|---|
| Parsed into the ledger | 38 |
| Ignored (OTP 5, promo 2, notification 1) | 8 |
| Routed to manual review | 4 |
| Duplicates rejected at ingest | 5 |
| Failed / crashed | **0** |

Every cycle total matched the generator **exactly**:

| Cycle | Expense | Earned | Passive |
|---|---|---|---|
| July 2026 | 625.78 | 12,500.00 | 182.16 |
| August 2026 | 1,058.91 | 13,120.45 | 206.87 |

Master invariant held: `Δ net worth 24,324.79 == income 26,009.48 − expense 1,684.69`.

**The two salaries differ on purpose.** The amount is captured from the message by template
SA-04, so the parser never depends on its value — but a fixture with two identical paydays
would let something downstream start depending on it without failing. A missing-salary check
that matches on amount, or recurring-series inference that reads a changed figure as a new
series, both pass against a constant and break on real data.

Reconciliation against reported balances: AlRajhi card computed **12,144.80** vs reported **12,144.80** (debt 1,855.20); Barq computed **158.51** vs reported **158.51**. SAIB is unreconcilable by design — it reports no balances.

## 3. Unknown formats went to review, not into the ledger

Four deliberately unfamiliar messages. **None produced a transaction.**

| Message | Why it should fail | Result |
|---|---|---|
| AlRajhi purchase with restructured labels (`عملية شراء` / `القيمة` / `التاجر`) | Same bank, same event, different layout | `no template matched` |
| SAIB in English (`Dear customer, a purchase of SAR 250.00...`) | Language never seen from this sender | `classified but not actionable` |
| Truncated AlRajhi purchase — header present, amount/balance/date missing | Partial message | `no template matched` |
| `Alinma Bank` — plausible shape, unregistered institution | New bank | `unrecognised sender` |

Each is parked with its shape hash so the workbench can group and bulk-fix them (§10.7).

## 4. Six bugs the simulation found

These were all live in code that had already passed its unit tests.

**4.1 `رسوم` became `SARوم`.** The currency regex used `(?<![A-Za-z])` boundaries, so the Arabic token `رس` matched *inside* the word `رسوم`. Every foreign-purchase fee line was corrupted, and AR-04 could never match. Fixed by splitting into two rules: Latin tokens may sit flush against Arabic (`بـSR 150` → `بSAR`), Arabic tokens may not.

**4.2 The first fix broke `بـSR`.** Adding Arabic boundaries to *all* currency tokens stopped `بSR` from normalizing, silently killing two more templates. The two failures pull in opposite directions and only both pass with separate rules — a single regex cannot satisfy them.

**4.3 A new bank was silently discarded.** Any ledger-shaped message from a sender not in the known-bank list was classified `promo` and dropped. Adding a bank account would have lost every message from it with no error anywhere. Now: known junk senders are discarded, **unknown senders go to review**.

**4.4 Internal transfers debited the wrong account.** `حوالة صادرة: بين حساباتك` names both `من` and `الى`; account resolution tried `to_account` first, so a transfer *out of* current booked as a debit *against savings*. Savings ran to −9,133 before this surfaced.

**4.5 One-sided messages left the books unbalanced.** A transfer between two owned accounts produces a single SMS, but two balance movements. Same for card payments and cashback redemption. The pipeline now emits **two legs from one message** where the message describes both sides.

**4.6 Net-worth signs were wrong for liabilities.** The delta loop flipped the sign for liability accounts and then summed everything the same way. Correct rule is simpler than what was there: **credit raises net worth and debit lowers it, for assets and liabilities alike** — a credit on a card reduces debt.

Bugs 4.4–4.6 together broke the master invariant by 8,289.60 and were invisible until the whole two months ran end to end.

## 5. Behaviours confirmed working

- **Early payday snapping** — the 23 Jul salary carries `تاريخ استحقاق 07/25` and lands in the **August** cycle. On raw date alone both salaries fall in July, which would have shown one cycle with double income and the next with none.
- **Wallet top-up linking** — 2 top-ups linked to their funding purchases. Expense reads 1,684.69; unlinked it would read 2,004.69, **+320 phantom**.
- **Idempotency** — 5 verbatim resubmissions produced 0 extra transactions.
- **OTP containment** — 5 OTPs carrying real amounts, all inert.
- **FX handling** — ANTHROPIC 23 USD booked at **88.36** (total incl. fee), not the 86.37 subtotal.

## 6. Flag raised by the run

The cashback wallet finished at **−52.81**: 22.19 accrued, 75.00 redeemed. Not a parser bug — it is redemption of cashback earned *before tracking started*, exactly the cold-start case in §9.2. It needs an opening balance, and the system must **surface** it rather than silently clamp to zero.

## 7. Limits of this simulation

Stated plainly, so the result isn't over-read:

- Messages are generated from the same format understanding the parser uses. It proves internal consistency and arithmetic correctness, **not** that real future messages will match.
- 12 templates are registered; the real catalogue is ~28. Unregistered ones will route to review — correct, but the review queue will be busier at first than this run suggests.
- No LLM fallback is wired in, so unknown shapes stop at review instead of being learned. That is the intended v1 behaviour on a cold start.
- SAIB `حوالة واردة` (SA-01, SA-03), STC entirely, and Barq transfers are not yet templated.
- Merchant categorization, budgets, and the rules engine are not exercised here.
