# Personal Finance Dashboard — Specification

**Owner:** Ridah
**Date:** 2026-08-11
**Status:** v1 design

---

## 1. What this is

A single-user web dashboard that builds a complete personal financial ledger from bank SMS messages, forwarded automatically from an iPhone.

**Data flow:** iPhone Shortcut → HTTPS ingest API → raw message store → parser (template-first, LLM fallback) → normalized transactions → dashboard.

**Locale:** Every message from every sender is **Arabic**. Merchant names are often Latin (`لدى: TAMIMI MARKETS`), which makes a message look bilingual but does not change how it parses. Confirmed 2026-08-12: no English-language message has been observed from any sender, and none is expected — the system is single-language by decision, not by omission. Base currency: SAR.

**Currency:** all accounting is single-currency — every transaction settles in SAR, and the bank always states the SAR total. But foreign purchases are common (USD, GBP observed in the first sample batch), so we store **FX provenance** alongside: original amount, original currency, rate, and fee. That is metadata, not multi-currency accounting.

**Institutions observed:** AlRajhi (credit card), SAIB (current, savings, salary), Barq (wallet), STC Bank (wallet/transfers). See `samples/ANALYSIS.md`.

**Tracked account types:** checking, savings, credit cards, loans, wallets, cash. **BNPL is out of scope** — no message source exists for it.

**Reporting grains:** weekly (Sunday-start) and monthly — where "monthly" is a **salary cycle running the 25th to the 24th**, not a calendar month. See §5.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js 16 (App Router)** | One deploy, no CORS. |
| Parser service | **Python 3.12 + FastAPI** | The parser is already written and verified in Python. Porting it to TypeScript means re-deriving the Arabic normalization and 12 regexes with no test net during the translation — for no gain. |
| Deploy | **Vercel Services** | Both services in one project, one repo, one deployment, routed by `vercel.json`. Keeping Python costs no extra host. |
| Database | **Supabase Postgres** | Free tier is 500 MB — SMS text is tiny, this lasts years. |
| ORM | **Drizzle** | Owns the schema and migrations. The Python service uses plain SQL against the same tables, so the model is defined once. |
| Validation | **Zod** (TS) / **Pydantic** (Py) | Shared contract at the ingest boundary. |
| AI layer | **Deferred past v1** | The 12 templates cover every attested format. Unknown shapes park in the review queue, where hand-parsing one message derives a template and reprocesses every message sharing its shape hash — what the LLM would do, minus an API key, a quota ceiling, and a schema contract. Gemini 2.5 Flash-Lite goes in when the queue becomes annoying. |
| Scheduling | **Supabase `pg_cron`** | Vercel Hobby caps cron at once daily. `pg_cron` is unrestricted and doubles as the keep-alive. |
| Queue | **`pgmq`** (or a `status` column) | Never parse inside the webhook. |
| Charts | **Recharts** | Composable, good enough for everything in §11. |
| Client data | **TanStack Query** | Cache, optimistic edits for the CRUD layer. |
| Auth | **Supabase Auth** (magic link), **RLS on** | Single user, but RLS from day one costs nothing and prevents a whole class of mistake. |

### Free-tier constraints to design around

- **Supabase pauses free projects after 7 days of inactivity.** The `pg_cron` parser tick keeps it alive. Do not remove it.
- **Vercel Hobby: 30s function timeout, cron no more than once daily, UTC only.** The ingest endpoint returns in <100 ms by design and `pg_cron` drives the parser, so neither limit binds.
- **500 MB database.** A decade of SMS + transactions is well under 100 MB.
- **Google cut free Gemini quotas 50–80% in Dec 2025.** The current 15 RPM / 1,000 req-per-day figure is post-cut. Do not design near the ceiling.

---

## 3. Three decisions that shape everything

### 3.1 Raw messages are immutable and stored forever

Two separate stores: `raw_messages` (never edited, never deleted) and `transactions` (derived, disposable).

Every parser improvement can then be replayed across full history. If you only persist the parsed result, **every parser bug becomes permanent data loss** — and early parser bugs are guaranteed.

### 3.2 Template-first, LLM-fallback

Bank SMS are templates. The same 5–10 formats repeat thousands of times.

1. Normalize the message body.
2. Compute a **shape hash**: replace every digit run with `#`, every amount with `<AMT>`, every date with `<DATE>`, then hash the skeleton.
3. Known shape → apply the stored regex. Deterministic, instant, free.
4. Unknown shape → call Gemini with a strict JSON schema → validate with Zod → **derive and persist a regex template from the result** so this shape is never sent to the LLM again.

Consequence: LLM calls scale with the number of *distinct message formats* (tens), not the number of *messages* (thousands). Parsing becomes reproducible, offline-capable, and effectively free.

### 3.3 Reconcile against the balance printed in the SMS

Many bank SMS include a balance. That is a free integrity check:

```
computed_balance = opening_balance + Σ(signed transactions)
if |computed_balance − reported_balance| > 0.01 → raise a reconciliation alert
```

A drift means a message was missed, double-counted, or misparsed. **This is the feature that makes the dashboard trustworthy rather than decorative** — without it, silent data loss is invisible.

**Two corrections forced by real samples.**

**(a) `رصيد` does not always mean what you owe.** On the AlRajhi credit card, purchases *decrease* the reported figure and payments *increase* it: it is **available credit**, not debt. Reconciliation must invert for such accounts.

```sql
accounts.balance_semantics ('balance' | 'available_credit')

-- balance:          debt_or_asset = reported_balance
-- available_credit: debt          = credit_limit − reported_balance
```

Applying the wrong one turns a 3,411 liability into a 10,588 asset — a ~14,000 error in net worth on one account.

**(b) Coverage is per-account, and one major account has none.** SAIB never reports a balance in any message, yet it holds the current account, the savings account, and the salary.

| Institution | Balance present | Reconciliation |
|---|---|---|
| AlRajhi card | Every purchase and payment | Full |
| Barq | Purchases only | Partial |
| STC | One template only | Weak |
| SAIB | **Never** | **None** |

So reconciliation is a *capability flag*, not a guarantee. For balance-less accounts three compensating controls apply, and **manual balance entry is a v1 requirement rather than a nicety**:

1. **Salary as a periodic anchor** — a missing monthly credit is immediately visible.
2. **Cross-institution leg matching** (§8.2) independently confirms transfers.
3. **One-tap manual balance entry** writing a `balance_snapshots` row, restoring the guarantee from that point forward.

The system health panel (§11.6) shows reconciliation state per account, so "unverifiable" is never mistaken for "verified".

---

## 4. Data model

### Core

```sql
accounts
  id, name, institution
  type ('checking'|'savings'|'credit_card'|'loan'|'cash'|'wallet'|'cashback_wallet')
  is_liability (derived from type)
  balance_semantics ('balance'|'available_credit')   -- §3.3(a)
  reconcilable BOOL                                  -- §3.3(b)
  opening_balance, current_balance, balance_as_of
  credit_limit, statement_day, due_day        -- cards
  is_profit_bearing BOOL, profit_payout_day INT   -- rate is variable; never stored as expected
  is_active, sort_order

raw_messages                                  -- append-only, never edited (§3.1)
  id, sender, body, received_at, device_sent_at, ingested_at
  body_hash UNIQUE                            -- dedup
  status ('pending'|'processing'|'parsed'|'ignored'|'needs_review'|'failed')
  processed_at, attempts INT, last_attempt_at, last_error   -- §10.6
  ignored_reason ('otp'|'promo'|'declined'|'balance_alert'|'statement'
                 |'notification'|'user')
  classification ('financial'|'otp'|'promo'|'unknown')
  language ('ar'|'en'|'mixed')
  template_id, parse_method ('template'|'llm'|'manual')
  llm_response jsonb

sms_templates
  id, sender, shape_hash UNIQUE, language
  pattern (regex), field_map jsonb
  kind ('purchase'|'withdrawal'|'transfer_in'|'transfer_out'|'deposit'
       |'refund'|'salary'|'profit'|'fee'|'card_payment'|'bill_payment'
       |'balance_alert'|'otp'|'notification')
  hit_count, confidence, created_by ('llm'|'manual')

transactions
  id, raw_message_id, account_id
  posted_at TIMESTAMPTZ, amount NUMERIC(14,2), direction ('debit'|'credit')
  type ('purchase'|'withdrawal'|'transfer'|'card_payment'|'loan_payment'
       |'fee'|'refund'|'income'|'profit'|'bill_payment')
  biller, biller_service, invoice_number       -- SADAD bills; §7.6
  state ('posted'|'pending'|'reversed'|'declined')     -- §7.2
  income_class ('earned'|'passive'|'other')   -- NULL unless income/profit
  cycle_override DATE                          -- see §5.6
  merchant_raw, merchant_id, category_id
  description, notes
  transfer_group_id, counterparty_account_id, counterparty_id, is_internal_transfer
  reverses_transaction_id, refunds_transaction_id, refunded_amount   -- §7.3
  original_amount, original_currency, fx_rate, fee_amount, country   -- FX provenance
  card_scheme ('mada'|'visa'|'mastercard'|'applepay'|NULL)
  origin ('parsed'|'manual'), locked_fields jsonb, matched_rule_id   -- §9.4, §9.5
  reported_balance, confidence, is_reviewed, excluded_from_analytics
  created_at, updated_at

transaction_splits
  id, transaction_id, category_id, amount   -- one row per split leg

categories        id, parent_id, name, icon, color, is_income
merchants         id, normalized_name, display_name, default_category_id
balance_snapshots id, account_id, balance, source ('sms'|'manual'|'computed'), as_of

account_identifiers  id, account_id, institution, kind, value
                     UNIQUE (institution, kind, value)   -- NOT (kind,value); §8.3
counterparties       id, name, iban_suffix, default_category_id, is_owned  -- §8.2
card_statements      id, account_id, statement_date, total_due,
                     minimum_due, due_date, paid_at                   -- §7.1
```

### Rules engine

```sql
rules
  id, priority, enabled, name
  match jsonb    -- [{field, operator, value}, ...] ANDed
  actions jsonb  -- {set_category, set_merchant, mark_internal_transfer,
                 --  exclude_from_analytics, set_account}
```

Rules run **after** parsing and **before** the transaction is finalized, and are re-runnable over history. A rule always beats the LLM — once you correct a categorization, it stays corrected.

### Budgets, goals, recurring

```sql
budgets           id, category_id, amount, rollover
                  cycle_start DATE   -- the 25th anchoring this budget's cycle
                  UNIQUE (category_id, cycle_start)
goals             id, name, target_amount, target_date, linked_account_id
recurring_series  id, merchant_id, account_id
                  kind ('subscription'|'bill'|'salary'|'profit')
                  amount_avg, amount_last, day_of_month
                  cadence ('weekly'|'biweekly'|'monthly'|'quarterly'|'yearly')
                  next_expected_at, first_seen, last_seen, occurrence_count
                  status ('active'|'paused'|'cancelled'), confidence
```

Budgets are **monthly only** — one amount per category per salary cycle, keyed by `cycle_start` (always a 25th), never by calendar month. The weekly view derives your share of the cycle budget rather than storing a separate weekly figure; see §11.2.

`transactions.recurring_series_id` links occurrences back to the series.

### Liabilities

```sql
loans
  id, name, lender, principal, apr, term_months, start_date
  payment_amount, payment_day, current_balance
```

Loan amortization is computed, not stored — derive the interest/principal split per payment from `apr` and `current_balance`.

### Reconciliation

```sql
reconciliation_alerts
  id, account_id, computed_balance, reported_balance, delta
  detected_at, resolved_at, resolution_note
```

---

## 5. Period model

Two reporting grains, neither of which is a calendar month.

### 5.1 The financial month is a salary cycle: 25th → 24th

The month runs from the **25th to the 24th** of the following month, aligned to payday. This means **`date_trunc('month')` is wrong everywhere in this codebase** — every aggregate, chart, and budget must go through the period functions below. Getting this wrong is subtle: the numbers still look plausible, they're just attributing spend to the wrong cycle.

```sql
-- day 25 is a safe anchor: every month has one (unlike 29/30/31)
CREATE FUNCTION period_start(d date) RETURNS date AS $$
  SELECT CASE WHEN EXTRACT(DAY FROM d) >= 25
              THEN date_trunc('month', d)::date + 24
              ELSE (date_trunc('month', d) - interval '1 month')::date + 24
         END;
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION period_end(d date) RETURNS date AS $$
  SELECT (period_start(d) + interval '1 month - 1 day')::date;
$$ LANGUAGE sql IMMUTABLE;
```

Index on `period_start(posted_at::date)` so cycle filtering stays fast.

**Labelling convention: name the cycle after the month it *ends* in.** `2026-07-25 → 2026-08-24` is **"August 2026"** — the salary that lands on 25 July is August's money. Verified over 5 years: 61 contiguous periods, no gaps or overlaps, all labels unique.

**Period length varies: 28, 29, 30, or 31 days.** Never hardcode 30. Pacing must use the actual length of the current cycle.

| Date | Cycle | Label | Length |
|---|---|---|---|
| 2026-08-11 | 2026-07-25 → 2026-08-24 | August 2026 | 31 (day 18) |
| 2026-03-01 | 2026-02-25 → 2026-03-24 | March 2026 | **28** |
| 2028-02-26 | 2028-02-25 → 2028-03-24 | March 2028 | **29** |
| 2026-12-31 | 2026-12-25 → 2027-01-24 | January 2027 | 31 |

### 5.2 Weeks start Sunday

Matches the Gulf work week (Sun–Thu), so Fri–Sat weekend spend lands together at the end of a week instead of being split across two.

Postgres `date_trunc('week')` is **Monday**-based. Shift it:

```sql
CREATE FUNCTION week_start(d date) RETURNS date AS $$
  SELECT (date_trunc('week', d + 1) - interval '1 day')::date;
$$ LANGUAGE sql IMMUTABLE;
```

### 5.3 Weeks don't tile the cycle — handle partial weeks explicitly

The two grains are independent, so a cycle contains **4.43 weeks on average** and starts mid-week. The August 2026 cycle splits into **six** week-buckets, two of them stubs:

```
2026-07-25 .. 2026-07-25   (1d)  ← partial
2026-07-26 .. 2026-08-01   (7d)
2026-08-02 .. 2026-08-08   (7d)
2026-08-09 .. 2026-08-15   (7d)
2026-08-16 .. 2026-08-22   (7d)
2026-08-23 .. 2026-08-24   (2d)  ← partial
```

A 1-day bar next to 7-day bars **reads as a spending collapse that never happened.** Required handling:

- Mark partial buckets in the UI (hatched fill + "2 of 7 days" tooltip).
- Offer a **normalized** toggle: daily average rather than bucket total, which makes partials comparable.
- Never compute week-over-week deltas against a partial week — suppress the comparison instead.

Weeks are **not** nested inside cycles. A week spanning the 24th/25th belongs to one week and touches two cycles; attribute each transaction to its own cycle and its own week independently, and never try to reconcile the two totals.

### 5.4 Weekly is noisy — smooth it

Raw weekly category breakdowns swing wildly on a single large purchase. Default trend charts to a **rolling 4-week average**, with raw weekly available as a toggle. Use raw weekly only for the current-week card, where the actual number is the point.

### 5.5 Settings

```sql
settings   -- single row
  cycle_anchor_day INT DEFAULT 25
  week_start_dow   INT DEFAULT 0   -- 0=Sunday
  timezone         TEXT DEFAULT 'Asia/Riyadh'
```

Both anchors are configurable but read from one place — never inline the literals.

**A third grain exists and must stay quarantined: the credit card statement cycle.** It's set by the bank (`statement_day`), doesn't align with the 25th, and differs per card. Use it **only** inside the card detail view — statement total, minimum due, days until due, utilization. Card *spending* is reported in salary cycles like everything else. Letting the statement cycle leak into global aggregates would mean two different "this month" figures on the same screen.

**Timezone matters at the boundary:** a purchase at 01:00 local on the 25th is UTC 22:00 on the 24th, and would land in the previous cycle if you bucket in UTC. Store `posted_at` as `timestamptz`; always bucket in local time.

### 5.6 Salary always funds the cycle it opens

**Rule: the salary belongs to the cycle it begins, whatever date it actually lands on.** It funds the remaining days of the current month plus the days of the next month through the 24th. Payday drift must never move which cycle the money budgets.

This matters because payday moves. When the 25th falls on a Friday or Saturday, salary is typically paid on the preceding Thursday — the **23rd or 24th**, landing in the *previous* cycle. Left alone that cycle shows two salaries and the next shows none, wrecking both savings-rate figures and every budget projection.

**Read the anchor when the bank states it.** SAIB's salary message carries the due date explicitly:

```
قيد راتب دائن 13,120.45 SAR في 14:04 23-07
حساب 0000xx17001 تاريخ استحقاق 07/25
```

Credited Thursday 23 July for a due date of 25 July — **and 25 July 2026 was a Saturday**, a Saudi weekend day. The first batch of real samples contained this case. When `تاريخ استحقاق` is present it *is* the cycle start; use it directly. An authoritative field always beats a heuristic.

Fall back to **snapping salary to the nearest cycle boundary** when the field is absent or unparsed — one rule that handles early *and* late arrival:

```
salary_cycle = argmin over {previous 25th, next 25th} of |posted_at − boundary|
```

Lands the 23rd → next boundary is 2 days away, previous is ~29 → **next cycle**. Lands the 27th → previous boundary is 2 days away → **current cycle**, which is already correct. No window constant to tune.

Store the result in a nullable `transactions.cycle_override DATE`; all cycle aggregates read `COALESCE(cycle_override, period_start(posted_at))`. Apply it only to transactions on the detected salary series — never to ordinary spending, or a late-night purchase on the 24th would silently jump cycles.

The override doubles as the manual escape hatch: any transaction can be reassigned to a neighbouring cycle from the ledger UI. **Weekly buckets always ignore it** — a week is a literal date range, no exceptions.

---

## 6. Accounting rules (the double-counting traps)

These four rules are the difference between correct numbers and plausible-looking wrong ones.

**Credit cards.** A card is a *liability* account with a positive balance meaning debt owed.

| Event | Effect | Counts as spending? |
|---|---|---|
| Purchase on card | Card debt ↑ | **Yes** |
| Card payment from checking | Checking ↓, card debt ↓ | **No** — internal transfer |
| Card cashback / refund | Card debt ↓ | No (negative expense against original category) |

Counting both the purchase *and* the card payment inflates spending by up to 2×. The payment must be paired as an internal transfer.

**Internal transfers.** Any movement between two accounts you own is neither income nor expense. Detect by pairing opposite-sign, equal-amount transactions across two owned accounts within a ±72h window; assign both legs a shared `transfer_group_id`.

**Loan payments split.** A 2,000 payment with 300 interest is **300 of expense** and **1,700 of debt reduction**. Only the interest hits cash-flow expense; the principal moves net worth, not spending.

**Savings deposits vs. profit.** Three different events hit the *same* savings account, and they are not the same thing:

| Event | Classification | Effect on net worth |
|---|---|---|
| Deposit checking → savings | **Internal transfer** | Unchanged — unspent money moving |
| Withdrawal savings → checking | **Internal transfer** | Unchanged — money moving back |
| Variable monthly profit | **Passive income** | ↑ — new money from outside |

Profit is credited into the same account that holds the principal, so the balance is a blend of contributions and earnings that only the transaction history can separate. Keep `Σ deposits − Σ withdrawals` and `Σ profit` as independent running totals; never try to infer the split from the balance.

**Classify by message text first, pairing second.** Because transfers here follow no routine and the amounts are arbitrary, pairing alone is not a safe discriminator — a single dropped counterpart SMS would turn a deposit into phantom profit and silently inflate income.

1. **Primary signal: the SMS wording.** The bank writes profit differently from a transfer — `profit` / `ربح` / `أرباح` / `عائد` versus `transfer` / `تحويل` / `حوالة`. This is a template `kind`, and it's reliable because the bank generates the two messages from different systems.
2. **Secondary: pairing.** A savings credit with a matching checking debit inside the window corroborates "transfer."
3. **Conflict or unpaired-and-unrecognised → review queue.** Never guess.

An unpaired savings credit is **not** automatically profit — it is equally likely to be a transfer whose counterpart message was lost. Only the wording promotes it to income.

**Derived aggregates:**

```
net_worth  = Σ(asset balances) − Σ(liability balances)
expense    = Σ debits WHERE NOT is_internal_transfer
                        AND type NOT IN ('card_payment','loan_payment')
                        AND NOT excluded_from_analytics
             + Σ loan interest portions
income     = Σ credits WHERE NOT is_internal_transfer AND type = 'income'
             -- income_class: 'earned' (salary) | 'passive' (profit) | 'other'
savings_rate         = (income − expense) / income          -- headline
earned_savings_rate  = (earned − expense) / earned          -- excludes profit
passive_coverage     = passive / expense                    -- % of life the profit pays for
```

**Profit must be counted as income** — it's not optional. Exclude it and the master invariant below breaks, because net worth rose by money that never appeared in your income figure.

`loan_payment` **must** be in that exclusion list. The full payment is a debit on checking, but only the interest is an expense — omitting it silently counts the principal twice (once as expense, once as debt reduction).

### The master invariant

```
Δ net_worth over any period  ==  income − expense
```

If this identity fails, exactly one of the rules above is being applied wrongly. Assert it in tests, and surface it on the dashboard as a health check — it catches classification errors that no individual balance reconciliation would.

**Worked example** (verified — see `tests/verify_accounting.py`): salary 12,000; 800 groceries on card; card paid in full; loan payment 2,000 split 300 interest / 1,700 principal; 1,000 + 3,000 moved to savings; savings pays 45 profit.

| Measure | Correct | Naive (sum all debits) |
|---|---|---|
| Income | **12,045** (12,000 earned + 45 passive) | — |
| Expense | **1,100** | 7,600 — **6.9× overstated** |
| Net worth | −24,055 (from −35,000) | — |
| Δ net worth | +10,945 = 12,045 − 1,100 ✓ | — |
| Savings rate | 90.9% incl. profit / 90.8% earned-only | — |

Nearly **7× overstatement** from a rule as innocent-looking as "expense = sum of debits". Savings deposits and the card payment dominate the error; both are money that never left your net worth.

---

## 7. Transaction lifecycle

Not every financial SMS is a transaction, and not every transaction is final. `transactions.state` is `'posted' | 'pending' | 'reversed' | 'declined'`.

### 7.1 Messages that must NOT create a transaction

The default assumption "financial message ⇒ ledger entry" is wrong and will corrupt totals. These four kinds are recognised and routed elsewhere:

| Message | Handling |
|---|---|
| **Declined / failed / insufficient funds** | No transaction. `raw_messages.status='ignored'`, reason recorded. A declined purchase that books as spending is pure fiction. |
| **Balance-only alert** | No transaction. Writes a `balance_snapshots` row — valuable free reconciliation data. |
| **Card statement ready** | No transaction. Writes a `card_statements` row (total, minimum due, due date) feeding the liabilities view (§11.4). |
| **OTP** | Ignored — but see the warning below. **OTPs carry amounts.** |
| **Notification** | Password reset, biometric enrolment, new beneficiary activated. No amount, no ledger effect. `ignored_reason='notification'`. |
| **Promo / marketing** | Ignored at classification (§10.3). |

**OTP classification is a correctness rule, not a privacy one.** Real sample:

```
كلمة مرور لمرة واحدة
رمز: 2938
لـ: دفعة سداد
مبلغ: SAR 113.00
في: 2026-08-09 21:39:41
لا تشارك الرمز
```

An OTP authorising a payment is **structurally indistinguishable from the payment itself** — amount, currency, timestamp, service description. Any parser that reaches for the amount first will book it, and every authorised payment is counted twice.

So OTP detection must run **before field extraction**, keyed on `رمز التحقق` / `كلمة مرور لمرة واحدة` / `لا تشارك الرمز` / "verification code". At least five distinct OTP shapes exist across the four senders, including three within SAIB alone (`لـ:`, `السبب:`, `الخدمة:`).

### 7.2 Pending vs. posted

**Only create a `pending` transaction when the message explicitly says authorization or hold** — do not invent a two-phase lifecycle where the bank doesn't have one. Most messages are already final; defaulting to `pending` would leave thousands of rows waiting for a settlement that never arrives.

When a settlement message later matches a pending row — same account, same normalized merchant, amount within ±25%, inside 7 days — **update that row** to `posted` with the final amount. Never insert a second row.

Fuel pre-authorizations are the standard case: a 1.00 hold followed by the real 180.00. Tips and FX conversion produce the same pattern, which is why the amount tolerance is wide.

Pending transactions **do count** toward spending and budgets. Excluding them means your current-cycle number is permanently understated by everything not yet settled. Mark them visually instead.

### 7.3 Reversals vs. refunds

Different mechanisms, different handling — conflating them is a common source of drift.

**Reversal** — the bank undoes its own entry, usually within days (`عملية مستردة`, "reversed", "cancelled"). Link via `reverses_transaction_id`. Keep both rows for audit; analytics nets them to zero. The reversal always attaches to the original, whatever cycle that was — this is a correction, not a new event.

**Refund** — the merchant returns money, possibly months later. Match to the original by account + normalized merchant + amount within 90 days. A refund:

- Inherits the original's category and books as **negative expense in that category**, never as income. Booking refunds as income inflates both income and expense and quietly distorts your savings rate.
- Supports **partial and multiple** refunds against one purchase; track `refunded_amount` on the original and never let the total exceed it without flagging review.
- Applies to **the cycle it lands in** (your decision), not the original's cycle. A closed cycle stays closed — retroactively rewriting a budget or savings rate you already reviewed is worse than imperfect attribution. Show the link to the original in the UI so the attribution is still visible.

Consequence to accept deliberately: **a category total can go negative** in a cycle with a large refund. Render it rather than clamping it.

### 7.4 Fees

ATM fees, FX fees, late fees, and account maintenance fees are ordinary expenses with their own category tree (`Fees > ATM`, `Fees > FX`, `Fees > Late`). They matter out of proportion to their size because they're the most actionable spending in the ledger — a recurring fee you didn't know about is the fastest saving available.

Where a fee is bundled into a transaction amount with no separate message, leave it bundled. Do not estimate.

### 7.5 SADAD bill payments

A whole payment rail that is neither a card purchase nor a transfer:

```
مدفوعات وزارة الداخلية
من: XXX7001          مبلغ: SAR 113
الجهة: المخالفات المرورية
الخدمة: تسديد المخالفات بواسطة رقم الهوية
رقم الفاتورة: 1012412852
```

Government fees, traffic fines, utilities, and telecom all arrive this way. They are **expenses**, categorized by `الجهة` (biller), and they **must never pair as transfers** — see §8.2.2. Store `biller`, `biller_service`, and `invoice_number`; the biller is a far better categorization key than any merchant string, and repeat billers map cleanly to categories.

### 7.6 Amount field priority — parse the total, not the subtotal

Foreign purchases state several amounts in one message, and the obvious field is the wrong one:

```
مبلغ: 23 USD (86.37 ريال)          ← subtotal, converted
رسوم وضريبة: 1.99 SAR               ← fee
إجمالي المبلغ المستحق: 88.36 SAR    ← what actually left the account
```

**Rule: `إجمالي المبلغ المستحق` / `إجمالى المبلغ المستحق` / "total due" wins over `مبلغ` / `المبلغ` / `بـ` whenever present.** Verified on real samples — `86.37 + 1.99 = 88.36` and `23.99 + 0.48 = 24.47`, both exact.

Getting this wrong understates every foreign purchase by ~2% *and* breaks reconciliation by exactly the fee each time, which then looks like a missing message rather than a parsing bug.

Because the message itemizes both parts, **auto-split** foreign purchases: merchant amount to the merchant's category, fee to `Fees > FX`. No new machinery — `transaction_splits` (§9.6) already handles it, and it makes annual FX cost visible without any manual tagging.

---

## 8. Cash, transfers, and account identity

### 8.1 Cash: the withdrawal is the expense

**An ATM withdrawal books immediately as spending** under a `Cash` category. It is not modelled as a transfer into a cash account.

This is deliberately the less "correct" of the two options. A cash-account ledger requires you to log every cash purchase forever; the day you stop, unlogged cash silently inflates a Cash balance and understates your real spending — and the error is invisible. Booking at withdrawal keeps every total right permanently, and the only thing you lose is category detail on a shrinking share of spending.

**Optional itemization**: any cash withdrawal can be split into real categories after the fact using the normal split mechanism (§11.1). Unsplit remainder stays as `Cash`. There is no nagging and no reconciliation chore — itemize when you care, ignore it when you don't.

### 8.2 Internal vs. external transfers

A transfer is **internal only when both sides are accounts you own.** Everything else moves money in or out of your net worth and must be classified accordingly.

| Direction | Counterparty | Classification |
|---|---|---|
| Out | Own account | Internal transfer — neither income nor expense |
| Out | Third party (family, landlord, friend) | **Expense** |
| In | Own account | Internal transfer |
| In | Third party | **Income**, `income_class='other'` |

The dangerous failure is pairing an *external* transfer with an unrelated debit that happens to match on amount and timing, which would erase a real expense from your books. Guard: **only pair when the counterpart account resolves to a known owned account identifier** (§8.3). Amount-and-time similarity alone is never sufficient.

Maintain a `counterparties` table (name, IBAN suffix, last-seen, default category) so repeat recipients — rent, family support, group pools — auto-classify after the first correction.

**Names are worthless for this decision.** A real sample: Barq reports an outgoing 113 to `محمد الفلان` at `INVESTMENT BANK` — that is *your own name* at SAIB, and the transfer is internal. Classifying on the recipient name would book a 113 expense that never happened. Only `لحساب7001` resolving to an owned identifier gets it right.

### 8.2.1 One event, two institutions

Both sides of a cross-bank movement send their own SMS, so a single transfer arrives as two independent messages minutes or seconds apart:

```
Barq : حوالة صادرة محلية  113.00 → لحساب 7001   2026-08-09 21:44
SAIB : حوالة واردة محلية   SAR 113 → XXXX7001    08-09 21:44
```

Pair on (amount, ±5 min, both identifiers owned) into one `transfer_group_id` with two legs. Neither leg is income or expense.

**The subtle case: a transfer disguised as a purchase.** Topping up the Barq wallet from AlRajhi card 0256 produces a Barq `إضافة اموال` *and* an AlRajhi **purchase** message for the same amount. Left alone, the AlRajhi side books as spending and the money is counted as spent and then spent again downstream when the wallet is used.

The Barq message names the funding card (`البطاقة: **0256`), which resolves to an owned account — so pairing works from that side, and the AlRajhi "purchase" is demoted to an internal transfer leg. Where only one side is present, a merchant rule on the wallet provider is the fallback.

Generalise: **a purchase whose merchant resolves to an owned account is a transfer, not spending.** Wallet top-ups are the common case, and they are invisible to any amount-based check because the amounts are legitimately arbitrary.

**Two rows always. Only the classification differs.** Each message is stored and each moves its own account balance — the AlRajhi leg reduces available credit, the Barq leg raises the wallet. Nothing is merged or suppressed. Marking both legs `is_internal_transfer` changes only whether the movement counts as *spending*.

Verified in `tests/verify_topup.py` — 12 SAR moved from card to wallet, then spent at a shop:

| Classification | Income | Expense | Master invariant |
|---|---|---|---|
| Both legs booked normally | 0 | **24** | **BROKEN by 12** |
| Card = expense, top-up = income | 12 | **24** | Holds, but both sides inflated |
| **Both legs internal** | 0 | **12** | **Holds** |

Real consumption was 12. Booking the legs independently double-counts it — once leaving the card and again leaving the wallet — and breaks `Δ net_worth == income − expense`, because the wallet gained 12 that never appeared as income.

The Barq message is **self-identifying**: `البطاقة: **0256` resolves to an owned account, so the top-up leg can be marked internal on its own, with no pairing required. The AlRajhi leg is marked internal when it pairs on amount and time; if its message never arrives, nothing is lost.

**Decision: the AlRajhi purchase that funds a Barq top-up is booked as a wallet top-up, not spending.** Implemented in `api/ledger/topup.py`, verified by `tests/verify_topup_link.py`.

Matching rule — deliberately narrow, because a false positive *hides a real expense*, which is worse than missing a link:

| Condition | Why |
|---|---|
| Purchase card == the top-up's `البطاقة` | Different card is a different event |
| Amount equal to the cent | Top-up amounts are arbitrary; near-matches are coincidence |
| Within **5 minutes** | The two messages fire seconds apart |
| One-to-one, closest timestamp wins | Repeated round amounts must not double-claim |
| Purchases only | A `bill_payment` is never absorbed |

**Order independence is required.** The AlRajhi and Barq messages can be ingested in either order, so linking runs over the working set and **amends an already-written purchase** when the top-up arrives later. Without this, whichever message lands second would silently fail to link.

**An unpaired top-up is still internal.** If AlRajhi's message never arrives, the top-up leg on its own must not read as income — the wallet gained money that was already yours.

Once AlRajhi's merchant string for wallet top-ups is known, add a merchant rule: deterministic beats heuristic, and it removes the 5-minute window entirely.

### 8.2.2 Amount and time are tiebreakers, never evidence

Real sequence from 2026-08-09: **113.00 SAR appears seven times in seven minutes** across three accounts — savings→current, a 113 traffic fine, a Barq top-up, Barq→current, current→savings.

Pairing on amount + opposite direction + 5 minutes yields **7 candidate pairs for 3 real transfers**, and cheerfully pairs the traffic fine with an unrelated transfer leg — erasing a genuine 113 expense from the books. Round amounts moving between your own accounts are not an edge case; they are your normal Sunday evening.

Required rules, verified in `tests/verify_pairing.py` (resolves to exactly 3 pairs, fine left unpaired):

1. **Both legs must be `transfer`.** A `bill_payment`, `purchase`, or `card_payment` never pairs.
2. **At least one leg's stated counterparty must resolve to the other leg's account.** Amount and time only break ties among candidates that already satisfy this.
3. **One-to-one matching**, closest timestamp first. A leg pairs at most once.

**Institutions name the same account differently.** Barq calls the destination `لحساب7001`; SAIB calls the source `XXXX0018 عبر البنك العربي الوطني` — Barq's underlying ANB account, not "Barq". One account therefore needs **multiple identities across institutions** in `account_identifiers`, and one-sided resolution must be sufficient, since the other side may name something you haven't registered yet.

### 8.3 Account identity

Bank messages identify accounts by fragments: "ending 1234", a card suffix, an IBAN tail. One account often has several, and a card and its funding account may share digits.

```sql
account_identifiers
  id, account_id, institution
  kind ('account_last4'|'card_last4'|'iban_suffix')
  value, is_primary
  UNIQUE (institution, kind, value)      -- institution scope is mandatory
```

**Identifiers must be scoped by institution.** Card `0256` appears under both AlRajhi (the card itself) and Barq (as the funding source for a top-up). A global `UNIQUE (kind, value)` would collapse two different banks' references into one account. STC additionally uses **3-digit** suffixes (`318`, `713`), so collisions are near-certain over time.

**Masking is inconsistent even within one sender** — SAIB writes the same account as `XXXX7001`, `XXX7001`, `X7001`, and `0000xx17001`. Never compare masked strings literally:

```
normalize(identifier) = last 3–4 digits of (strip all non-digits)
```

Resolution order: sender → institution → normalized suffix → disambiguate by message kind (a purchase resolves to the card, a salary credit to the account) → **unresolved goes to review as a provisional account**, never dropped and never guessed onto an existing account. Losing a transaction because its account was unrecognised is worse than a review queue item.

Supplementary cards on one account: separate identifiers on the same account, unless they carry separate credit limits, in which case separate accounts.

---

## 9. Cold start, replay, and rules

### 9.1 You are starting from zero history

iOS gives you no practical way to bulk-export past SMS, so the ledger begins the day the Shortcut starts firing. Design for it honestly rather than showing empty charts:

| Feature | Usable after |
|---|---|
| Ledger, categories, balances | Immediately |
| Weekly view, budgets | ~1 cycle |
| Rolling 4-week averages, week-over-week | ~5 weeks |
| Recurring detection (needs 3 occurrences) | ~3 cycles |
| Realized yield trend, compounding projection | ~3 cycles |

Every one of these gets an explicit empty state saying what it's waiting for and how far along it is — not a blank panel, and never a chart drawn from one data point.

### 9.2 Opening balances

Seed each account's `opening_balance` from the **first `reported_balance` observed** for it, with `balance_as_of` set to that message's timestamp. Reconciliation (§3.3) only runs forward from that point. Manual override available in account settings for accounts whose messages never carry a balance.

### 9.3 Bootstrapping salary and the savings account

Statistical detection needs 2–3 occurrences, which is 2–3 months — far too slow to be useful on day one. So detection is a convenience, not the mechanism:

- **The user can mark any transaction "this is my salary"** in one click, which creates the series immediately and activates the §5.6 cycle-snapping rule.
- Same for flagging an account as profit-bearing.
- Auto-detection still runs in the background and *suggests*; it never silently overrides a user-declared series.

### 9.4 Replay without clobbering your corrections

§3.1 promises that improving the parser lets you re-derive history. That's only safe if replay can't destroy manual work.

```sql
transactions
  origin ('parsed'|'manual')
  locked_fields jsonb   -- ['category_id','merchant_id'] — fields the user edited
```

Rules:

1. Replay **never** touches a transaction with `origin='manual'`.
2. Replay never overwrites any field listed in `locked_fields`. Editing a field in the UI adds it to that list automatically.
3. Deleting a transaction marks its raw message `ignored` with a reason, so replay doesn't resurrect it.
4. Replay is **scoped** — by template, account, or date range — and always runs **dry-run first**, showing a diff: *N transactions would change, here are the before/after values*. Apply is a second, explicit step.

Without the dry-run, the first replay over a few thousand transactions is an unreviewable mass mutation of your own financial history.

### 9.5 Rules engine semantics

**First matching rule wins**, evaluated in ascending `priority`. Not "apply all matching rules in order" — that makes outcomes depend on invisible interactions between rules and is miserable to debug at 20+ rules.

- The matched rule id is stored on the transaction and shown in the UI ("categorized by rule: *Starbucks → Coffee*"), so behaviour is always explainable.
- Rules never override `locked_fields` — an explicit manual edit beats an automatic rule.
- The review queue's primary action is **"create a rule from this correction"**. This is the core learning loop: every correction you make should reduce the number of future corrections.

### 9.6 Categorized-amount view

Transactions are categorized either on the row or across `transaction_splits`. Every aggregate must handle both, and any query that forgets will silently double-count split transactions or drop them.

Define one canonical view and forbid direct aggregation over `transactions`:

```sql
CREATE VIEW v_categorized_amounts AS
  SELECT t.id, s.category_id, s.amount, t.posted_at, t.account_id, ...
    FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id
  UNION ALL
  SELECT t.id, t.category_id, t.amount, t.posted_at, t.account_id, ...
    FROM transactions t
   WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id);
```

Enforce `Σ splits = transaction.amount` with a constraint or trigger.

---

## 10. Ingest and parsing pipeline

### 10.1 iPhone Shortcut

Personal Automation → **Message** trigger, filtered to your banks' sender IDs → Run Immediately (no confirmation) → Get Contents of URL.

```
POST https://<app>.vercel.app/api/ingest
Headers:
  X-Signature: hex(HMAC-SHA256(body, INGEST_SECRET))
  X-Timestamp: <unix seconds>
Body: { sender, body, received_at, device_id }
```

**Do not skip the HMAC.** A public unauthenticated ingest URL means anyone who guesses it can inject fabricated transactions into your ledger. Reject requests whose `X-Timestamp` is more than 5 minutes old to prevent replay.

**OTP safety:** filter OTP senders out in the Shortcut where possible. Anything classified `otp` server-side is stored with the body redacted and purged after 24 hours. Never let one-time passcodes accumulate in the database.

**Reliability:** iOS message automations fail silently — the phone was off, the automation got disabled by an iOS update, the network dropped. Mitigate with:

1. A daily **heartbeat** ping from the Shortcut. No heartbeat for 24h → dashboard banner.
2. **Balance reconciliation** (§3.3) catches gaps even when the heartbeat looks fine.
3. A manual paste-and-import screen to backfill missed messages.

### 10.2 Ingest endpoint

Verify HMAC → normalize → hash → `INSERT ... ON CONFLICT (body_hash) DO NOTHING` → return **202** immediately. No parsing, no LLM call, no blocking work.

Dedup hash = `sha256(sender + normalized_body)`. If a bank's format omits a timestamp inside the body, fold in `received_at` truncated to the minute so two genuinely separate identical purchases aren't collapsed.

### 10.3 Parser tick (`pg_cron`, every minute)

```
pending messages
  → classify: otp | promo | declined | balance_alert | statement | financial
       otp / promo / declined  → status='ignored', done            (§7.1)
       balance_alert           → balance_snapshot only, done
       statement               → card_statements row, done
  → normalize → shape_hash
  → template hit?
       yes → regex extract
       no  → Gemini structured output → Zod validate
              → confident → derive regex, persist template
              → else     → status='needs_review'
  → resolve account via account_identifiers          (§8.3)
       unresolved → needs_review (provisional account), do NOT drop
  → apply rules engine (first match wins)            (§9.5)
  → settle against pending?  → UPDATE, do not insert (§7.2)
  → pair: internal transfer | external | reversal | refund
       internal only if counterpart is an owned account
  → insert transaction + balance_snapshot
  → reconcile computed vs reported balance           (§3.3)
```

### 10.4 Arabic normalization

Run **before** hashing or regex matching. Every step here is a real failure mode, not defensive padding:

- **Strip bidi control marks** (U+200E, U+200F, U+061C). Confirmed present in real samples: **U+061C sits immediately before every AlRajhi date**, exactly where the date regex anchors. Invisible, and brutal to debug.
- **Arabic-Indic → ASCII digits**: `٠١٢٣٤٥٦٧٨٩` and `۰۱۲۳۴۵۶۷۸۹` → `0-9`.
- **Arabic decimal/thousands separators**: `٫` (U+066B) → `.`, `٬` (U+066C) → `,`. Also handle ASCII thousands commas — `13,120.45` appears in salary messages.
- **Collapse whitespace**: real samples contain double spaces (`رصيد  35.34`) and trailing spaces on most lines. Barq omits spaces entirely (`مبلغ113.00SAR`), so labels must match with optional separators.
- **Remove tatweel** (`ـ`) and diacritics.
- **Unify letterforms**: `أإآ`→`ا`, `ى`→`ي`, `ة`→`ه`. Keep the original for display.
- **Strip the optional definite article** on known field labels: `المبلغ`→`مبلغ`, `الرصيد`→`رصيد`. Both spellings occur within a single sender.
- **Normalize currency tokens**: `ر.س`, `ريال`, `رس`, `SAR`, `SR` → `SAR`. (`رس`, without the dot, appears in STC messages.)
- **Tag the language** by presence of the Arabic Unicode block: `ar`, or `en` when there is no Arabic at all. A Latin merchant name does not make a message English.

**Language is a canary, not a routing decision.** All 29 templates are Arabic and no per-language template sets exist, because no English message has ever arrived. Tagging the row costs nothing and means a sender switching to English shows up as a labelled row rather than as an unexplained arrival in the review queue. If that ever happens, the template set forks then — not in advance.

**Normalize before shape-hashing, not only before merchant matching.** AlRajhi writes both `شراء إنترنت` and `شراء انترنت` for the same template; STC writes both `في:` and `فى:`. Unnormalized, each spelling hashes to a different shape and is learned as a separate template — doubling LLM cost and letting the two copies drift apart. Order: strip bidi → collapse whitespace → unify letterforms → strip article → hash.

### 10.4.1 Dates: per-template formats, validated against `received_at`

Seven distinct formats across four senders, two of them year-less, and **two senders are internally inconsistent** — AlRajhi uses `YY/M/D` in transfers but `D/M/YY` in purchases; SAIB uses `MM-DD` in transfers but `DD-MM` in salary.

| Sender | Template | Format |
|---|---|---|
| AlRajhi | transfers | `YY/M/D HH:MM` |
| AlRajhi | purchases, payments | `D/M/YY HH:MM` |
| SAIB | transfers, profit | `MM-DD HH:MM` (no year) |
| SAIB | salary | `HH:MM DD-MM` (time first, no year) |
| Barq | all | `YYYY-MM-DD HH:MM` |
| STC | most | `D/M/YY HH:MM` |
| STC | `حوالة واردة (سريع)` | `DD-MM-YYYY HH:MM` |

**A single global date parser is not viable.** Rules:

1. Every template declares its format explicitly. No runtime guessing.
2. Year-less dates take the year from `received_at`, choosing the **most recent past occurrence** — this handles the Dec→Jan rollover.
3. **Validate**: the parsed timestamp must be `≤ received_at` and within **72 hours** of it. Outside that → `needs_review`.

Rule 3 is the highest-value check in the parser: bank SMS arrive within seconds of the event, so any format misreading lands years away and is caught immediately instead of silently filing a transaction into the wrong salary cycle. Manual paste-import (§10.1) relaxes the window; live ingest never does. Verified against all seven real formats in `tests/verify_dates.py`.

### 10.5 LLM contract

Gemini runs in structured-output mode against a fixed JSON schema, returning: `kind`, `amount`, `currency`, `direction`, `merchant`, `account_last4`, `posted_at`, `reported_balance`, `confidence`, plus a `field_spans` map giving the character offsets of each extracted value.

`field_spans` is what makes automatic template derivation possible: knowing *where* each value sat in the string lets you generate the regex mechanically rather than asking the model for one.

Anything with `confidence < 0.85`, a failed Zod parse, or an unmatched account goes to the review queue. **The LLM never writes silently to the ledger.**

### 10.6 Raw message state machine

Messages land **exactly as received** and are processed separately. Ingest never parses, never validates content, and never rejects a message for being unrecognisable — its only job is to get the text safely into the table.

```
                    ┌──────────────► ignored   (terminal — §7.1, not a transaction)
                    │
pending ──► processing ──► parsed        (terminal — transaction created)
   ▲                │
   │                ├──► needs_review    (parsed but uncertain — awaits you)
   │                │
   └──── retry ◄────└──► failed          (error; parked after 3 attempts)
```

| Status | Meaning |
|---|---|
| `pending` | Landed, not yet attempted |
| `processing` | Claimed by a worker |
| `parsed` | Transaction created — `processed_at` set |
| `ignored` | Deliberately not a transaction; `ignored_reason` records why |
| `needs_review` | Low confidence, unresolved account, or conflicting classification |
| `failed` | Threw an error; retried up to 3 times, then parked for manual handling |

**Nothing is ever deleted, and no row is unrecoverable.** The single exception is OTP bodies, which are redacted after 24h (§10.1) — the row survives, the passcode doesn't.

**Concurrency: claim rows, don't just select them.** `pg_cron` fires every minute; if one tick runs long, the next starts while it's still working and both will happily parse the same message into two transactions. Dedup on `body_hash` won't save you — it's the same row processed twice, not the same message ingested twice.

```sql
UPDATE raw_messages SET status='processing', attempts = attempts + 1,
       last_attempt_at = now()
 WHERE id IN (
   SELECT id FROM raw_messages
    WHERE status IN ('pending','failed') AND attempts < 3
    ORDER BY received_at
    LIMIT 50
    FOR UPDATE SKIP LOCKED          -- the load-bearing clause
 ) RETURNING *;
```

Also reset any row stuck in `processing` for over 10 minutes back to `pending` — a crashed worker must not strand a message forever.

### 10.7 Manual processing workbench

The screen for everything the system couldn't handle: `needs_review` and `failed`, plus a filter for `ignored` in case something was wrongly discarded.

Per message you can: create the transaction by hand, correct a wrong parse, mark it as legitimately not-a-transaction, or retry it after fixing a template.

**Manual processing must feed the parser, not just the ledger.** Hand-entering a transaction and moving on means the next identical message fails identically — and bank messages repeat by nature, so a format you fix once should never cost you twice. Every manual resolution therefore offers:

1. **Derive a template from this message.** You confirm which substring is the amount, the merchant, the balance; the app generates the regex and stores it against the shape hash. Same mechanism as LLM-derived templates (§10.5), with you as the extractor.
2. **Apply to matching messages.** Once the template exists, every other message with that shape hash — including ones already parked as `failed` — is reprocessed. Dry-run diff first (§9.4).

This is what makes a new bank cheap: hand-process **one** message, and the other forty-nine resolve themselves.

**Bulk actions**, since failures arrive in format-shaped clusters rather than one at a time: group the queue by shape hash and sender, and act on a whole group at once.

---

## 11. v1 features

### 11.1 Ledger + core charts

- Transaction list: filter by account, category, merchant, date, amount range; full-text search over raw body
- **Review queue** — low-confidence parses, unmatched accounts, reconciliation alerts
- Full CRUD: edit any field, add manual cash entries, split a transaction across categories
- Rules engine UI with "apply to N matching historical transactions"
- Merchant normalization and aliasing

**A global Week / Cycle toggle** sits at the top of the dashboard and drives every chart below. It persists across navigation. Cycle labels read "August 2026 (25 Jul – 24 Aug)" so the boundary is never ambiguous; week labels read "Sun 9 – Sat 15 Aug".

**Charts, in priority order:**

| # | Chart | Week | Cycle | Notes |
|---|---|---|---|---|
| 1 | **Daily-spend calendar heatmap** | ✓ | ✓ | Grain-agnostic — it's already daily. Draw a rule on the 24/25 boundary so cycles are visible. Best information density on the page. |
| 2 | **Cash flow bars** — income vs. expense vs. net | ✓ | ✓ | Weekly: income spikes once per cycle, so most weeks show zero income. Show net only, or overlay a cycle-income reference line — otherwise 3 of every 4 bars look catastrophic. |
| 3 | **Category trends** (stacked area) | ✓ | ✓ | Weekly defaults to **rolling 4-week average** (§5.4). Raw weekly is a toggle. |
| 4 | **Net worth line** | ✓ | ✓ | From `balance_snapshots`. Weekly grain is genuinely useful here. |
| 5 | **Budget burn-down** | ✓ | ✓ | Weekly shows the cycle burn-down zoomed to the current week's segment — see §11.2. |
| 6 | **Day-of-week spending profile** | ✓ | — | **Weekly-only, and new.** Average spend by weekday over the last 8 weeks. Usually reveals a Thu–Fri weekend spike you can act on. Meaningless at cycle grain. |
| 7 | **Week-over-week comparison** | ✓ | — | This week vs. last vs. 4-week average, by category. Suppressed when either week is partial (§5.3). |
| 8 | **Sankey** — income → categories → savings | — | ✓ | Cycle-only; a week has no income to flow. Once a cycle, but it reframes the whole picture. |
| 9 | **Merchant leaderboard** | ✓ | ✓ | An unglamorous table that is consistently the most actionable thing on screen. |

A category pie chart is fine to include, but treat it as decoration — it answers a question you already know the answer to.

**Weekly digest** — a "week in review" card each Sunday: total spend, vs. 4-week average, top 3 categories, biggest single transaction, budget pacing, anything unusual. This is the piece you'll actually read week to week.

### 11.2 Budgets & goals

Budgets are **set monthly** (one amount per category per salary cycle) and **viewed at both grains**.

- Per-category cycle budgets with optional rollover
- **Pacing, not just totals**: "60% spent, 40% through the cycle" is the number that changes behavior. Pace against the *actual* cycle length — 28 to 31 days (§5.1), never a hardcoded 30
- Projected end-of-cycle spend per category from current run rate
- Savings goals with progress and required contribution per cycle
- Overspend and on-track-to-overspend alerts

**Weekly budget view — derived, never stored.** Two numbers, and the distinction matters:

```
fair_share  = cycle_budget × (days_in_week / days_in_cycle)   -- static target
remaining_pace = (cycle_budget − spent_so_far) / weeks_left   -- adaptive
```

`fair_share` answers "what should this week cost?" `remaining_pace` answers "what can I still spend per week without blowing the cycle?" — and it's the one that actually changes behavior, because it absorbs the overspend you already committed. Show both; lead with `remaining_pace`.

Using `cycle_budget ÷ 4` is wrong: a cycle averages **4.43 weeks**, so a flat quarter-split understates the weekly allowance by ~10% and makes you look permanently over budget. Always weight by days, and always use partial-week day counts at cycle edges.

**Rollover carries both directions.**

```
effective_budget(c) = base_budget(c) + carry(c)
carry(c)            = effective_budget(c−1) − spent(c−1)     -- signed
```

Underspend increases next cycle's allowance; **overspend reduces it**. That's the honest version — overspending has a consequence, and saving across cycles for a large purchase works without any special feature. Carry is stored per cycle when the cycle closes, not recomputed from the beginning of time, so a single corrected old transaction can't cascade through years of budgets.

Guards worth having: show `base` and `carry` as separate numbers so a large negative carry is never mistaken for a small budget; offer a one-click **"reset carry"** for when a category has drifted so far negative it's no longer informative; and cap displayed carry history at the last 6 cycles.

**Uncategorized is a first-class category**, excluded from budget pacing but shown prominently on the dashboard with a count. Hiding it makes every other number quietly wrong.

**Goals are virtual buckets over a real account.** Progress reads from the linked account's actual balance, not a separate counter, so a withdrawal reduces goal progress automatically and the number can never drift from reality. Multiple goals may share one account; the sum of buckets must not exceed the balance, and the unallocated remainder is always displayed.

### 11.3 Recurring & subscriptions

- Auto-detect recurring series from (merchant, amount, interval) periodicity — typically the highest-ROI insight in a personal finance app
- Detect **weekly and biweekly** cadences, not just monthly — these only become visible once the weekly grain exists
- Salary detection → anchors savings rate and the cycle. See the early-payday rule in §5.6
- Upcoming bills calendar with next expected date and amount
- **Price-increase flags** on subscriptions — silent annual price bumps are the main thing this catches
- Dormant-series detection ("you haven't been charged for X in 3 months — cancelled?")

**Exclusions — do not feed these to the detector:**

- **Savings transfers.** They follow no routine, so any "series" the detector finds in them is noise, and a false recurring prediction on an internal transfer would pollute the upcoming-bills calendar with money that was never leaving.
- **Profit payouts** are detected on **cadence only, never amount**. The amount varies every month, so amount-based matching would either fail to group them or fire a spurious price-change alert each cycle. Suppress amount-drift warnings on any series whose `kind = 'profit'`.

### 11.4 Liabilities

- Credit cards: utilization, statement/due dates, minimum vs. full payment, days-until-due
- Loans: amortization table, payoff date, total interest remaining, extra-payment simulator
- **Total debt** widget with payoff projection at current rate

### 11.5 Savings & profit

The profit-bearing savings account is the only thing in the ledger that *makes* money, so it gets its own view rather than sitting as one more row in the account list.

Two facts shape this section: **profit varies month to month**, and **transfers in and out follow no routine**. So nothing here may assume a fixed expected amount or a regular contribution schedule — everything is measured after the fact from the messages.

- **Contributions vs. growth** — stacked area splitting the balance into net principal (`Σ deposits − Σ withdrawals`) and cumulative profit. Since profit compounds into the same account, this derived split is the *only* way to see what your money actually earned. The moment the growth band becomes visibly thick is the most motivating chart in the app
- **Net contribution per cycle** — deposits minus withdrawals, **which can be negative**. Shown as a bar chart, not a progress ring: with no routine, the interesting signal is variability, and a ring implies a target you don't have
- **Realized yield** — the only meaningful rate measure when profit is variable: `(profit_this_cycle / average_daily_balance) × 12`. Use average *daily* balance, not closing balance — an irregular mid-cycle deposit would otherwise distort the rate badly. Plot the per-cycle series with a trailing 3-cycle average, since a single month tells you nothing
- **Profit payout tracking** — detect the monthly *cadence* but never the amount. A late or missing payout is worth an alert; a smaller-than-usual one is not
- **Passive coverage** — profit as a percentage of cycle expenses: "your savings currently pays for 2% of your life." Small now, compounds visibly, and it's the single number that makes long-horizon saving feel concrete
- **Compounding projection** — forecast from trailing-average yield and trailing-average net contribution, with a "what if I add 500 more per cycle" slider. Show it as a range, not a line — the variable rate means a single projected number would be false precision

**Do not** classify profit payouts as `transfer`. They are external income (§6) and the master invariant depends on it.

**Cashback is a two-stage flow and must not be counted twice.** AlRajhi sends two unrelated-looking messages:

```
استرجاع نقدي            7.59  → cashback wallet   (NOT yet on the card)
استرداد نقدي إلى البطاقة 215.00 → card balance      (redeemed from the wallet)
```

Model the wallet as a real account of type `cashback_wallet`:

- **Accrual** → credit to the wallet, `income_class='passive'`. Net worth rises; this is the moment the money is earned.
- **Redemption** → internal transfer wallet → card. Net worth unchanged.

Booking both as income double-counts. Booking only the redemption understates income and delays it by however long the balance sits unredeemed.

Neither message carries a date or (for the accrual) a card number, so `posted_at` falls back to `received_at`, the dedup hash must fold in `received_at` (§10.2), and the account resolves by template rather than by identifier.

**A negative savings rate is a valid result, not a bug.** Withdrawing from savings to cover overspending means expense exceeds income for that cycle. Verified (`tests/verify_accounting.py`, scenario B): salary 12,000, spend 14,000, 3,000 drawn from savings, 50 profit → savings rate −16.2%, net contribution −3,000, and the master invariant still holds. Display it in red; do not clamp it to zero.

### 11.6 Alerts, health, and data ownership

**Alerts are in-app only in v1** — a badge and a dashboard banner, no email or push. Nothing to configure, nothing to deliver, nothing to break. Every alert is a row in an `alerts` table with a type, severity, payload, and `dismissed_at`, so adding a delivery channel later is a rendering change rather than a rewrite.

Alert types: reconciliation drift, no heartbeat for 24h, review queue non-empty, budget overspend, on-track-to-overspend, missed recurring payment, missed salary, missed profit payout, card due within 3 days, loan payment due.

**A system health panel** is the honest counterpart to a dashboard that claims to know your finances: last message received, messages pending, parse success rate, template hit rate (should climb toward ~100%), LLM calls this month against the free-tier cap, and per-account reconciliation status. If ingestion silently dies, this is where you find out — and on a pipeline that depends on an iOS automation staying enabled, that will happen eventually.

**Export is a v1 feature, not a nicety.** One click to CSV and JSON for transactions, and a full dump of `raw_messages` — the raw store is the irreplaceable asset, since everything else can be re-derived from it (§3.1). You're on a free tier that pauses on inactivity and offers no restore guarantees; treat your own export as the backup. A scheduled monthly export reminder is worth the two lines it costs.

### 11.7 Deferred to v2

Natural-language query, anomaly detection, spend forecasting beyond simple run-rate. All of these depend on having clean, trusted data first — build them once the ledger has a few months of verified history.

---

## 12. Build order

| # | Milestone | Deliverable |
|---|---|---|
| 0 | **Period functions** | `period_start`, `period_end`, `week_start` + full test suite. Everything downstream depends on these; build them first and never bypass them. |
| 1 | Schema + migrations | Drizzle schema, seed categories, settings row, RLS policies |
| 2 | Ingest endpoint | HMAC verify, dedup, 202 response, Shortcut configured and firing |
| 3 | Normalization + classification | AR/EN normalizer with unit tests, OTP/promo filter |
| 4 | Template engine | Shape hashing, regex match, template CRUD |
| 5 | Gemini fallback | Structured output, Zod validation, template derivation |
| 6 | Transaction writer | Non-transaction routing (§7.1), account resolution, rules engine, transfer/refund pairing, reconciliation |
| 7 | Manual workbench | Review/failed queue grouped by shape, hand-parse, derive template from a message, bulk reprocess, resolve provisional accounts |
| 8 | Ledger UI + CRUD | List, filters, edit, splits, manual entry, `v_categorized_amounts`, replay dry-run |
| 9 | Core charts | Heatmap, cash flow, category trends, net worth |
| 10 | Budgets & goals | Pacing, projections, alerts |
| 11 | Recurring detection | Series inference, upcoming bills, price flags |
| 12 | Liabilities | Cards, loans, amortization |
| 13 | Savings & profit | Contributions vs. growth, realized yield, passive coverage |
| 14 | Health & export | Alerts table, system health panel, CSV/JSON export |

Milestones 1–7 are the actual product. Everything after is presentation over data you already trust.

---

## 13. Testing priorities

- **Normalizer unit tests** with real samples from each bank — the highest-value tests in the project. There is one deliberate English fixture, and its job is to prove an English message PARKS rather than parses.
- **Golden-file parser tests**: fixture SMS → expected transaction JSON. Every parser change replays them.
- **Accounting invariants** as property tests: internal transfers net to zero; expense excludes card payments and loan principal; `Δ net_worth == income − expense`; `computed_balance == reported_balance` for every fixture stream.
- **Period math**, run over a multi-year date range (`tests/verify_periods.py` already does this): every date falls inside exactly one cycle; cycles are contiguous with no gaps or overlaps; boundaries are stable under re-application; labels are unique; observed lengths are exactly {28, 29, 30, 31}.
- **Period edge cases** as explicit fixtures: the 24th and 25th of a month, February in leap and non-leap years, the December→January rollover, DST-free but timezone-sensitive midnight transactions, and an early-payday salary landing on the 23rd.
- **Grain independence**: summing all weekly buckets that touch a cycle must *not* equal the cycle total — assert they differ where partial weeks exist, so nobody later "fixes" this into a bug.
- **Savings credit disambiguation**, the highest-risk classification in the system. Cover: profit wording with no counterpart → income; transfer wording with a counterpart → internal; **transfer wording whose counterpart SMS was dropped → review queue, never income**; profit wording that happens to coincide with an unrelated checking debit → still income. Also assert net contribution can go negative and that a negative savings rate is never clamped.
- **Salary snapping**: fixtures for payday on the 23rd, 24th, 25th, and 27th all resolve to the intended cycle, and no non-salary transaction ever gets a `cycle_override`.
- **Idempotency**: posting the same message twice creates exactly one transaction.
- **Concurrent ticks**: two overlapping parser runs never claim the same row, a message failing repeatedly parks at 3 attempts, and a row stuck in `processing` beyond 10 minutes returns to `pending`. This is the invariant protecting "one message, one transaction" — dedup on `body_hash` does *not* cover it.
- **Manual resolution propagates**: deriving a template from one hand-parsed message reprocesses every parked message sharing its shape hash, and leaves unrelated shapes untouched.
- **Non-transactions never reach the ledger**: declined, balance-alert, statement, OTP, notification, and promo fixtures each produce zero `transactions` rows — and the balance-alert still produces a snapshot.
- **OTPs carrying amounts** (`كلمة مرور لمرة واحدة ... مبلغ: SAR 113.00`) classify as OTP before any amount is extracted. Fixture every OTP shape found per sender — this is the single most expensive misclassification in the system, because it silently doubles authorised payments.
- **Pairing under amount collision**: the real 2026-08-09 sequence of seven 113.00 legs resolves to exactly three transfers with the bill payment left unpaired (`tests/verify_pairing.py`).
- **Settlement updates, never inserts**: a 1.00 fuel pre-auth followed by a 180.00 settlement yields exactly one transaction at 180.00.
- **Refund direction**: a refund reduces expense in the original category and never appears as income; a partial refund cannot exceed the original; a cross-cycle refund lands in the *current* cycle and leaves the original cycle's totals byte-identical.
- **Replay safety**, the highest-consequence test in the suite: after editing a category by hand, a full replay leaves that field untouched; a `manual` transaction survives replay unchanged; a deleted transaction is not resurrected.
- **Split integrity**: `Σ splits = transaction.amount`, and aggregating `v_categorized_amounts` over a mix of split and unsplit transactions equals total spend exactly — the assertion that catches double-counting.
- **Rollover arithmetic**: overspend produces a negative carry into the next cycle, and a corrected transaction two cycles back does not cascade into the current budget.

---

## 14. Resolved questions

All answered 2026-08-12. Kept here with their consequences, because several of them are the
reason a feature is *absent* — and an absent feature with no recorded reason gets rebuilt.

**1. Which banks?** `AlRajhiBank`, `SAIB`, `STC Bank`, `barq app`. OTPs arrive from separate
sender IDs (`SAIB otp`, `STC Bank otp`, `barq app otp`), which is a free first-pass filter —
but never the only one, since OTPs also arrive on the main sender.

> A `barg app` (with a g) in the first sample batch was a collection typo, not a sender
> variant. Corrected. Had it been real, half the wallet messages would have diverted to
> review.

**2. Income shape.** A **single monthly deposit whose amount varies.** Consequences:

- Missing-salary detection keys on *a salary-classified credit landing in the cycle*, never on
  an amount match. This matters more than it looks: salary is the periodic anchor for the SAIB
  accounts, which report no balance and are otherwise unreconcilable (§3.3b).
- Recurring-series inference needs a tolerance band. Exact-amount matching would register
  every payday as a new series.
- The two simulated cycles use deliberately different salaries so neither assumption can creep
  back in unnoticed.

**3. Savings profit wording.** `ايداع أرباح شهر <month> لحساب البركة الادخاري`. Shares no
vocabulary with `حوالة`, so the profit-vs-transfer discriminator (§6) rests on solid ground.
Template SA-05. No English variant observed.

**4. Transfer legs.** Checking↔savings produces **one SMS naming both sides**
(`حوالة صادرة: بين حساباتك`, with both `من` and `الى`). Template SA-02. Pairing can never
corroborate from a counterpart message, so the wording plus account resolution carries the
classification alone — and the pipeline emits **two legs from that one message**.

**5. Authorization holds.** **Not sent.** One message per purchase, stating the real amount.
**§7.2 is dormant**: the `pending` transaction state is never entered and settlement-matching
is not built in v1. The `state` enum keeps `reversed` and `declined`, which are real.

**6. Loans.** **None.** The `loans` table, amortization, and interest/principal derivation are
not built. BNPL was already out of scope (§1). `loan_payment` stays in the transaction-type
enum so adding one later is a seed row rather than a migration.

**7. Cold start.** Opening balances **entered manually**, per account, as of a start date.
This is what makes reconciliation work from day one on the balance-less SAIB accounts, and it
is the fix for the negative-wallet flag the simulation raises — cashback redeemed that was
earned before tracking began (§9.2).

### Still genuinely unknown

Not blockers; the review queue is the designed response to each.

- **English is out of scope by decision** (confirmed 2026-08-12), not an untested gap. An
  English message still classifies safely — an English OTP or decline is ignored, anything
  else parks — and is tagged `language='en'` so a sender switching would be visible
  immediately rather than silently swelling the review queue.
- **Never yet seen:** declined transactions, card statement notices, BNPL. Each will arrive as
  an unknown shape and park in review rather than being dropped (§10.5).
- **The AlRajhi side of a Barq top-up** — the funding purchase message. Attested only through
  the simulation's reconstruction, not a captured sample.

**Logic is closed.** Every flow in §§3–11 has a defined behaviour, and §§6, 7, 9, 11.2 are
covered by executable checks in `tests/`.
