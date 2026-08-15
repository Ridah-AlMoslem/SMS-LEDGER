# UI build prompts

Seven prompts for Claude Code, to be run **in order**. Prompt 0 is a hard prerequisite for
every other one — it creates the SQL the pages query and the shell they mount into.

Run each in its own session, from `sms-ledger/`. Paste the prompt verbatim; the preamble in
each is deliberate.

**Decisions already made** (don't re-litigate them in the sessions):

- Phone-first. Bottom tab bar, single column, ~390px design target. Desktop is the same
  layout widened, not a different one.
- Four fixed tabs: Home · Ledger · Plan · Accounts. Review is a conditional fifth, appearing
  only when the parked queue is non-empty (see Prompt 0 §4).
- **Position 5 is never reassigned.** When Review hides, the bar shows four tabs and the slot
  stays empty. Nothing gets promoted into it — not Savings, not anything. A tab bar works
  through muscle memory: a slot that is *absent* costs nothing because positions 1–4 don't
  move, but a slot that *changes meaning* means reaching for one screen and landing on
  another, on precisely the days the pipeline is healthy.
- Savings & profit (SPEC §11.5) is therefore not a tab. It's promoted onto Home instead: the
  net worth strip is the tappable entry point and carries the passive-coverage line itself, so
  "am I getting richer" is answered on Home and drilled into in one tap.
- Home leads with cycle pacing, then net worth. Charts scroll below the fold.
- No lock screen in v1.
- The Sankey (SPEC §11.1 chart 8) is built as a three-column flow list, not a Sankey diagram.
- Rules are *created* contextually from a transaction; *managed* in Settings.
- Every displayed number drills through to the transactions that produce it.
- **The waiting state already exists. Use it; do not build another.**
  `web/src/components/ui/loader.tsx` is the app mark in motion — the Riyal glyph flanked by
  the two in/out arrows, arrows travelling in opposite directions. `<PageLoader>` for route
  `loading.tsx` files, `<Loader size={16} variant="arrows">` inline in buttons and rows.
  Keyframes are in `globals.css` and already handle `prefers-reduced-motion`. Do not add a
  CSS spinner, an `animate-spin` border, a skeleton shimmer, or a component-library loader —
  one waiting state used everywhere is what makes a wait read as *this* app waiting. Full
  rules in `web/CLAUDE.md`; rationale in SPEC §11.7.
- **Every new route gets a `loading.tsx`.** Every page is `force-dynamic` and hits Postgres,
  so a route without one shows nothing between the tap and the answer. Follow the six that
  exist: static `<h1>` first so the tab announces itself, then `<PageLoader>`.
- Brand colours come from `BRAND` in `web/src/lib/brand.ts` — `#34D399` credit, `#FB7185`
  debit, the same values amounts are already printed in. Don't retype the hex, and don't
  introduce a third accent colour. `npm run test:brand` asserts these stay in step with the
  icon build.

---

## Prompt 0 — foundation

```
You're working in sms-ledger/. Read SPEC.md sections 4, 5, 6 and 11 in full before writing
anything, and read web/AGENTS.md — this is Next.js 16 and the conventions differ from what
you know; consult node_modules/next/dist/docs/ rather than assuming.

CONTEXT — what already exists:
- Python parser at api/ledger/ (29 templates, all four institutions), verified by tests/verify_*.py.
- Drizzle schema at web/src/db/schema.ts with: accounts, account_identifiers, raw_messages,
  sms_templates, categories, merchants, counterparties, transactions, transaction_splits,
  balance_snapshots, card_statements, reconciliation_alerts.
- Two routes: web/src/app/page.tsx (accounts + last 50 transactions) and
  web/src/app/review/page.tsx (parked messages grouped by shape hash).
- Presentation logic in web/src/lib/accounts.ts and web/src/lib/review.ts.
- Test harness pattern: web/scripts/verify-*.mjs running against pglite, wired into
  package.json as test:accounts / test:review / test:ui.
- recharts and @tanstack/react-query are installed but not yet used anywhere.

WHAT'S MISSING, and what this task is:

1. PERIOD FUNCTIONS IN SQL. SPEC §12 calls these milestone 0 and they were never built on the
   Postgres side — period_start/period_end exist only in api/ledger/periods.py, and week_start
   exists nowhere. Every aggregate in every page depends on them. Create a Drizzle migration
   defining, exactly as specified in SPEC §5.1 and §5.2:
     period_start(date) -> date      -- 25th-anchored, IMMUTABLE
     period_end(date) -> date
     period_label(date) -> text      -- names the cycle after the month it ENDS in
     week_start(date) -> date        -- Sunday-based, not Postgres's Monday
   Add the index on period_start(posted_at::date) that §5.1 requires.
   These read their anchors from the settings table (item 2) — do NOT inline 25 or 0 in
   application code. The SQL functions may hardcode for immutability, but there must be exactly
   one place in TypeScript that knows the anchor values.

2. MISSING TABLES. Add to schema.ts, with a migration, per SPEC §4:
     settings (single row: cycle_anchor_day=25, week_start_dow=0, timezone='Asia/Riyadh')
     budgets, goals, recurring_series, loans, rules, alerts
   Match SPEC §4's column lists exactly, including budgets.cycle_start being a DATE that is
   always a 25th with UNIQUE (category_id, cycle_start). Seed the settings row.

3. v_categorized_amounts VIEW. SPEC §11 and §13 both depend on it. A transaction is either
   split across categories (transaction_splits rows) or not (its own category_id). The view
   emits one row per (transaction, category, amount) so aggregation is uniform. The invariant
   to preserve: summing this view over a mix of split and unsplit transactions must equal
   total spend exactly. Write the test that asserts this.

4. APP SHELL. Create web/src/app/layout.tsx changes plus web/src/components/tab-bar.tsx:
   - Bottom tab bar. FOUR FIXED ITEMS in this order, which never changes: Home (/),
     Ledger (/ledger), Plan (/plan), Accounts (/accounts). Icons + labels, safe-area inset
     padding at the bottom, active state.
   - THE REVIEW TAB IS A CONDITIONAL FIFTH. Render it only when the parked count (raw_messages
     with status in needs_review/failed) is > 0, with a count badge. When the queue is empty
     the bar shows four tabs and /review remains reachable by URL and from a link in Settings —
     the route always exists, only the tab is conditional.
   - POSITION 5 IS NEVER REASSIGNED TO ANOTHER DESTINATION. When Review hides, the slot is
     empty. Do not promote Savings, Trends, or anything else into it, and do not add a fifth
     item "so the bar looks balanced". The four fixed positions must mean the same thing on
     every load; a slot whose identity depends on parser health defeats the muscle memory that
     makes a tab bar worth having. Layout the four tabs as equal flex children so their
     positions are identical whether or not the fifth is present — the fifth appearing must
     not shift the first four sideways.
   - Compute the parked count once in the layout, not per page, so navigation doesn't flicker.
   - Do not build a hamburger or "More" menu. If something doesn't fit, it's a drill-down
     route, not a nav item.

5. GLOBAL WEEK/CYCLE TOGGLE. SPEC §11.1: one control, drives every chart on every page,
   persists across navigation. Build it as:
   - URL search param `grain=week|cycle` and `period=<ISO date>` as the source of truth, so
     any view is linkable and the back button works.
   - localStorage remembers the last grain and restores it when the param is absent.
   - A `web/src/lib/periods.ts` module exporting: currentPeriod(), periodBounds(grain, anchor),
     periodLabel(), stepPeriod(±1), daysElapsed(), daysInPeriod(), isPartialWeek().
     Labels read exactly as §11.1 specifies: "August 2026 (25 Jul – 24 Aug)" for cycles,
     "Sun 9 – Sat 15 Aug" for weeks.
   - A <PeriodHeader> component: label, prev/next steppers, grain segmented control.

6. SHARED PRIMITIVES in web/src/components/ui/: Money (tabular, SAR, sign-aware, uses the
   existing .tabular class), Sheet (bottom sheet for detail views — this is a phone app, modals
   slide up from the bottom), Chip (filter pills), StatCard, EmptyState, Sparkline.
   Reuse the .sms-body and .tabular classes already in globals.css. Do not introduce a
   component library.

TRAPS, all of which this codebase has already been bitten by or explicitly warns about:
- date_trunc('month') is WRONG everywhere in this repo. If you type it, you have a bug.
- Postgres date_trunc('week') is Monday-based. Weeks here start Sunday.
- Bucket in Asia/Riyadh, never UTC. A 01:00 purchase on the 25th is UTC 22:00 on the 24th and
  lands in the wrong cycle if you bucket in UTC.
- Weeks do NOT tile cycles. Never write code that assumes summing weeks gives the cycle total.

TESTS — follow the existing web/scripts/verify-*.mjs pglite pattern, add npm scripts:
- verify-periods.mjs: port the assertions from tests/verify_periods.py to the SQL functions and
  assert the SQL agrees with api/ledger/periods.py over a 5-year range. Every date in exactly
  one cycle; contiguous, no gaps or overlaps; labels unique; lengths exactly {28,29,30,31}.
- verify-categorized-view.mjs: the split-integrity invariant from §13.
- Both wired into test:ui.

DONE WHEN: npm run test:ui passes, npm run build succeeds, and the five (or four) tabs render
on every route with the period header state surviving navigation between them.
```

---

## Prompt 1 — Home

```
Read SPEC.md §5, §6, §11.1 and §11.2. Also read web/CLAUDE.md — the UI conventions
there are binding, in particular the single shared loader and the requirement that every
route carry a loading.tsx. Prompt 0's foundation is in place: period SQL functions,
web/src/lib/periods.ts, the tab bar, the global grain toggle, and web/src/components/ui/
primitives. Use them — do not recompute period math locally.

Build web/src/app/page.tsx as the Home tab, replacing what's there now (move the existing
accounts overview to /accounts in Prompt 4 — for now leave web/src/components/accounts-overview.tsx
untouched, Home does not render it).

Home answers exactly two questions, in this order: "am I on pace?" and "am I getting richer?"
Everything else scrolls below.

ABOVE THE FOLD, in order:

1. PeriodHeader from Prompt 0. Plus a gear icon linking to /settings.

2. Alert banner — only when there is something. Reads from the alerts table, most severe first,
   collapsed to one line with a count if there are several. Alert types per §11.6: reconciliation
   drift, no heartbeat 24h, review queue non-empty, budget overspend, on-track-to-overspend,
   missed recurring, missed salary, missed profit payout, card due within 3 days, loan due.
   Tapping goes to the relevant page. Dismissing writes dismissed_at.

3. PACE HERO. The headline number is percent of effective budget spent, against percent of the
   cycle elapsed, with a one-word verdict (On pace / Ahead / Over). Below it, in smaller text,
   remaining_pace = (cycle_budget − spent_so_far) / weeks_left, expressed as "SAR X/week for Y
   weeks left". §11.2 is explicit that remaining_pace is the number that changes behavior — it
   leads over fair_share.
   - Pace against the ACTUAL cycle length, 28-31 days. Never 30, never 4 weeks.
   - At week grain the hero shows this week's spend against remaining_pace instead.
   - When the current week is partial, say so and suppress any week-over-week comparison (§5.3).

4. NET WORTH STRIP — and the app's only entry point to the savings view.
   Current net worth, delta this cycle, and a sparkline from balance_snapshots. Assets and
   liabilities split underneath in small text. Credit cards contribute limit − available as
   debt, never their reported balance — use the existing toView() in web/src/lib/accounts.ts,
   do not reimplement the rule.
   Add one more line to this strip: PASSIVE COVERAGE from SPEC §11.5, phrased as "your savings
   pays for N% of your life". It's a single computed percentage (cycle profit ÷ cycle expenses)
   and it belongs on Home rather than buried in an account detail — §11.5 calls it the number
   that makes long-horizon saving feel concrete, which only works if it's seen daily.
   THE WHOLE STRIP IS TAPPABLE, going to the savings account detail (/accounts/[slug] for the
   is_profit_bearing account, built in Prompt 4). Savings deliberately has no tab of its own;
   this strip is how it's reached, so treat the tap target as a primary affordance — full-width,
   with a chevron — not an easter egg.

5. CATEGORY PACE LIST. Top 5 categories by share of budget consumed. Each row: name, bar,
   spent / effective budget, and a projected end-of-cycle figure from current run rate. Red when
   over or projected over. base and carry shown as separate numbers, per §11.2 — a large negative
   carry must never read as a small budget. Tapping a row goes to /categories/[id].

6. UNCATEGORIZED CHIP. Count of uncategorized transactions this period, always visible, tapping
   it opens /ledger?uncategorized=1. §11.2: hiding this makes every other number quietly wrong.

BELOW THE FOLD, scroll order (all driven by the global grain):

7. Daily-spend calendar heatmap. Grain-agnostic. Draw a visible rule on the 24/25 boundary.
   Tapping a day opens /ledger filtered to that date.
8. Cash flow bars — income vs expense vs net. At WEEK grain income spikes once per cycle, so
   most weeks show zero income: show net only, or overlay a cycle-income reference line.
   Three of four bars looking catastrophic is a presentation bug, not a finding.
9. Category trends, stacked area. At week grain default to a rolling 4-week average with raw
   weekly as a toggle (§5.4).
10. Merchant leaderboard — a plain table. §11.1 calls it the most actionable thing on the page.
11. Day-of-week spending profile — WEEK GRAIN ONLY, hidden at cycle grain. Average by weekday
    over the last 8 weeks.
12. Week-over-week comparison — WEEK GRAIN ONLY. Suppressed entirely when either week is partial.
13. Cycle flow — CYCLE GRAIN ONLY. This replaces §11.1's Sankey: a three-column list (income
    sources → category totals → what was saved) with amounts and share percentages, columns
    stacked vertically on phone. Do not render a Sankey diagram; it does not survive 390px.
14. Weekly digest card, shown on Sundays: total spend, vs 4-week average, top 3 categories,
    biggest single transaction, budget pacing, anything unusual.

INTERACTIONS: swipe left/right on the header steps the period. Tapping any chart opens it
full-screen with its own filters. Pull to refresh. Every figure drills through to the
transactions behind it — that is the trust mechanism for a ledger built from parsed SMS.

TRAPS:
- Partial weeks get a hatched fill and a "2 of 7 days" tooltip. A 1-day bar next to 7-day bars
  reads as a spending collapse that never happened (§5.3).
- expense excludes internal transfers, card_payment and loan_payment, and excluded_from_analytics
  rows; it adds loan interest portions. Get this from a shared helper, not per-chart SQL (§6).
- income includes profit as income_class='passive'. Excluding it breaks the master invariant.
- Aggregate from v_categorized_amounts so split transactions count once.
- Cycle aggregates read COALESCE(cycle_override, period_start(posted_at)). Weekly buckets
  IGNORE cycle_override — a week is a literal date range (§5.6).
- A negative savings rate is a valid result. Show it in red, never clamp to zero (§11.5).

Charts are Recharts, already installed. Every chart needs a mobile-legible version at 390px:
rotate or drop axis labels rather than shrinking below 11px.

TESTS: web/scripts/verify-home-aggregates.mjs against pglite, asserting the SPEC §6 worked
example — salary 12,000; 800 groceries on card; card paid in full; loan payment 2,000 split
300/1,700; 1,000 + 3,000 to savings; 45 profit — yields income 12,045 and expense 1,100, NOT
7,600. Assert the master invariant Δnet_worth == income − expense over the fixture period.
Assert pacing uses actual cycle length by running the same fixture in a 28-day and a 31-day cycle.

DONE WHEN: tests pass, build succeeds, and the page is usable at 390px with the pace hero and
net worth both visible without scrolling.
```

---

## Prompt 2 — Ledger

```
Read SPEC.md §7, §9 and §11.1. Also read web/CLAUDE.md — the UI conventions
there are binding, in particular the single shared loader and the requirement that every
route carry a loading.tsx. Prompt 0's foundation is in place.

Build web/src/app/ledger/page.tsx and the transaction detail sheet. This is the CRUD surface —
milestone 8 in SPEC §12 — and the page you'll use most after Home.

LIST VIEW:
- Search input: full-text over raw_messages.body AND transactions.merchant_raw/biller/description.
  Searching the raw body is the point — it's how you find a transaction you can only half remember.
- Filter chips, horizontally scrollable: account, category, merchant, date range, amount range,
  type, direction, internal on/off, uncategorized only, needs-review only, manual only.
  Filters live in URL params so a filtered view is linkable and back works.
- Grouped by day with a day header and a day subtotal on the right. Subtotals exclude internal
  transfers and say so on tap.
- Row: label (merchant_raw ?? biller ?? type), account name, time, signed amount. Badges for
  internal / pending / reversed / refunded / manual / fx. Keep the existing .sms-body isolation —
  Arabic biller names must not reorder the row (globals.css already handles this).
- Infinite scroll or paginated at 100; never load the whole ledger.
- Bulk select mode: categorize N, exclude N from analytics, mark N internal.

DETAIL SHEET (bottom sheet, not a route push — it must be dismissible with a swipe):
- The raw SMS body verbatim at the top, in .sms-body. Everything below is derived from it, and
  showing the source is what makes an edit decision possible.
- All parsed fields, each editable: account, posted_at, amount, direction, type, category,
  merchant, biller, description, notes.
- FX provenance shown read-only when present: original_amount, original_currency, fx_rate,
  fee_amount, country.
- Actions: split across categories; mark internal transfer; exclude from analytics; reassign to
  the neighbouring cycle (writes cycle_override — §5.6 says this is the manual escape hatch);
  delete; convert to manual.
- Split editor: rows of (category, amount), live remainder, cannot save unless Σ splits ==
  transaction.amount exactly. Enforce in SQL too, not just the UI.
- EDITED FIELDS LOCK. Writing a field by hand adds it to locked_fields so a future replay leaves
  it alone (§9.4). Show a small lock marker on locked fields with a tap to unlock. This is the
  highest-consequence behavior on this page — a replay that silently reverts your manual
  categorizations destroys trust in the whole app.

RULES, CREATED HERE:
- From a transaction's category picker: "Always categorize <merchant> as <category>".
- This writes a rules row, then shows a DRY-RUN PREVIEW: "matches 34 historical transactions",
  with the list, before you apply. Applying is a separate confirm.
- §11.1: "apply to N matching historical transactions". Never apply silently.
- Managing/reordering rules is Settings' job, not this page's.

MANUAL ENTRY: a floating action button for cash transactions. origin='manual'. §9 requires these
to survive replay untouched.

EXPORT: a button exporting the CURRENT FILTERED VIEW to CSV and JSON. §11.6 makes export a v1
requirement, and the filtered-view scoping is what makes it actually useful.

TRAPS:
- Internal transfers are shown in the list but excluded from every total. Both facts must be
  visible or the numbers look wrong.
- Editing an amount must invalidate any reconciliation state for that account, not silently
  leave a stale computed balance.
- Deleting a transaction must not resurrect on replay (§13).
- Optimistic edits via TanStack Query, already installed. Roll back visibly on failure — a
  finance app that silently drops an edit is worse than one that's slow.

TESTS: web/scripts/verify-ledger-mutations.mjs — Σ splits == amount enforced; a hand-edited
category survives a full replay; a manual transaction survives replay unchanged; a deleted
transaction is not resurrected; a rule dry-run count matches what applying it actually changes;
cycle_override moves a transaction between cycles but leaves its week bucket alone.

DONE WHEN: tests pass, and you can find, edit, split, categorize and rule-ify a transaction
entirely with one thumb.
```

---

## Prompt 3 — Plan

```
Read SPEC.md §11.2 and §11.3. Also read web/CLAUDE.md — the UI conventions
there are binding, in particular the single shared loader and the requirement that every
route carry a loading.tsx. Prompt 0's foundation is in place, including the budgets, goals
and recurring_series tables.

Build web/src/app/plan/page.tsx with three in-page segments: Budgets | Goals | Recurring.
These are content segments, not navigation — one route, state in a URL param.

BUDGETS:
- One row per category for the current cycle. Budgets are set MONTHLY only; there is no weekly
  budget stored anywhere.
- Each row shows: base, carry, effective (base + carry), spent, remaining, pace bar, and
  projected end-of-cycle from run rate.
- base and carry are SEPARATE displayed numbers. §11.2: a large negative carry must never be
  mistaken for a small budget.
- Rollover carries BOTH directions: carry(c) = effective_budget(c−1) − spent(c−1), signed.
  Underspend raises next cycle's allowance; overspend lowers it. Carry is STORED when a cycle
  closes, never recomputed from the beginning of time — a corrected old transaction must not
  cascade through years of budgets.
- A one-click "reset carry" per category, for when it has drifted so far negative it stops
  being informative. Cap displayed carry history at 6 cycles.
- AT WEEK GRAIN the same rows show two derived numbers, never stored:
    fair_share     = cycle_budget × (days_in_week / days_in_cycle)
    remaining_pace = (cycle_budget − spent_so_far) / weeks_left
  Show both, lead with remaining_pace. NEVER cycle_budget ÷ 4 — a cycle averages 4.43 weeks and
  a flat quarter-split understates the allowance ~10%, making you look permanently over budget.
  Weight by days, and use real partial-week day counts at cycle edges.
- Uncategorized is excluded from pacing but shown as its own prominent row with a count.
- Edit amount inline; toggle rollover per category.

GOALS:
- A goal is a virtual bucket over a REAL account. Progress reads the linked account's actual
  balance — never a separate counter — so a withdrawal reduces progress automatically and the
  number cannot drift from reality.
- Multiple goals may share one account. The sum of buckets must not exceed the balance; the
  unallocated remainder is always displayed. Reject or warn on over-allocation.
- Show required contribution per cycle to hit target_date, and whether the current run rate
  makes it.

RECURRING:
- Upcoming bills list: next expected date, expected amount, account, days away. Group by week.
- Detected series with confidence. Actions per series: confirm, dismiss as noise, pause, mark
  cancelled, exclude from detection.
- Price-increase flags — §11.3 says silent annual price bumps are the main thing this catches.
- Dormant-series prompts: "no charge from X in 3 months — cancelled?"
- Detect weekly and biweekly cadences, not just monthly.

EXCLUSIONS the detector must respect (§11.3):
- Savings transfers are NEVER fed to the detector. They follow no routine, so any series found
  in them is noise, and a false prediction would pollute the bills calendar with money that was
  never leaving.
- Profit payouts are detected on CADENCE ONLY, never amount. The amount varies every cycle.
  Suppress amount-drift warnings on any series with kind='profit' — otherwise it fires a
  spurious price-change alert monthly.

If the detection logic doesn't exist yet, write it in this task as a server-side module in
web/src/lib/recurring.ts with its own unit tests, and drive it from the pg_cron tick.

TESTS: web/scripts/verify-budgets.mjs — overspend produces a negative carry into the next
cycle; a corrected transaction two cycles back does not cascade into the current budget;
fair_share over a full cycle's weeks sums to the cycle budget within rounding; a 28-day and a
31-day cycle produce different fair_share for the same weekly window; goal progress falls when
the linked account is debited; sum of goal buckets cannot exceed the account balance.

DONE WHEN: tests pass, and switching the global grain to week changes the budget rows to
fair_share/remaining_pace without a page reload.
```

---

## Prompt 4 — Accounts

```
Read SPEC.md §3.3, §6, §11.4 and §11.5. Also read web/CLAUDE.md — the UI conventions
there are binding, in particular the single shared loader and the requirement that every
route carry a loading.tsx. Prompt 0's foundation is in place.

Build web/src/app/accounts/page.tsx and web/src/app/accounts/[slug]/page.tsx. Move the existing
web/src/components/accounts-overview.tsx here from the old home page and extend it — do not
rewrite toView() in web/src/lib/accounts.ts, it already encodes the credit-card rule correctly
and has tests.

LIST (/accounts):
- Net worth at the top, split into assets and liabilities as separate figures.
- Accounts grouped by institution, as now.
- RECONCILIATION STATE STATED PER ACCOUNT, not implied by the absence of a badge. §3.3b: full
  (AlRajhi), partial (Barq), weak (STC), none (SAIB). "Unverifiable" must never look like
  "verified" — this is already the stated intent of AccountMeta in accounts-overview.tsx.
- One-tap "Enter balance now" on every account, writing a balance_snapshots row with
  source='manual'. §3.3b makes this a v1 REQUIREMENT, not a nicety: SAIB never reports a balance
  in any message and holds the current account, the savings account and the salary.

DETAIL (/accounts/[slug]) — the body varies by account type:

checking / wallet / cash:
  Balance history line from balance_snapshots, this-period transactions, manual balance entry,
  reconciliation status with any open alert and a resolve action that writes resolution_note.

credit_card:
  THE ONLY PLACE THE STATEMENT CYCLE IS ALLOWED TO EXIST (§5.5). Statement total, minimum due,
  days until due, utilization ring, paid/unpaid state, from card_statements.
  Card SPENDING on this page is still reported in salary cycles like everywhere else. Two
  different "this month" figures on one screen is the failure mode being avoided here.
  Headline is what you OWE (limit − available), reported balance demoted to a subtitle.
  Minimum-vs-full payment comparison with the interest consequence.

savings (is_profit_bearing):
  This is SPEC §11.5 in full, and it's the most rewarding screen in the app.
  IT IS ALSO REACHED DIRECTLY FROM HOME, by tapping the net worth strip — savings has no tab of
  its own by design. So this view must stand alone rather than reading as a sub-page of the
  account list: give it its own title and a back affordance that returns to wherever you came
  from, and don't assume the user arrived via /accounts. Home already shows passive coverage;
  show it here too, in its fuller form with the trend, rather than omitting it as a duplicate.
  - Contributions vs growth: stacked area splitting the balance into net principal
    (Σ deposits − Σ withdrawals) and cumulative profit. Keep these as two independent running
    totals — never infer the split from the balance, since profit compounds into the same account.
  - Net contribution per cycle as BARS, not a progress ring. It can be negative, and with no
    routine the interesting signal is variability; a ring implies a target that doesn't exist.
  - Realized yield: (profit_this_cycle / average_daily_balance) × 12. Average DAILY balance, not
    closing — an irregular mid-cycle deposit distorts closing-balance rates badly. Plot the
    per-cycle series with a trailing 3-cycle average.
  - Passive coverage: profit as a percentage of cycle expenses, phrased as "your savings pays
    for N% of your life".
  - Compounding projection from trailing-average yield and net contribution, with a
    "+500 per cycle" slider. Render as a RANGE, not a line — the variable rate makes a single
    projected number false precision.
  - Profit payout tracking: alert on a late or missing payout, never on a smaller-than-usual one.

loan:
  Amortization table computed from apr and current_balance, never stored. Payoff date, total
  interest remaining, extra-payment simulator. A payment splits into interest (expense) and
  principal (debt reduction) — only the interest is spending.

cashback_wallet:
  Accrual is passive income crediting the wallet; redemption is an internal transfer
  wallet → card. Show both legs distinctly. Booking both as income double-counts; booking only
  the redemption understates income and delays it (§11.5).

TRAPS:
- balance_semantics='available_credit' means the stored figure is what you can still SPEND.
  Applying the wrong reading turns a 3,411 liability into a 10,588 asset — a ~14,000 net worth
  error on one account (§3.3a).
- A deposit into savings is an internal transfer, not income. Profit is income. They land in the
  same account and only the message wording separates them (§6).
- Loan principal is not expense. Only interest is.

TESTS: web/scripts/verify-account-detail.mjs — extend the existing verify-accounts-view.mjs
fixtures; assert available_credit vs balance semantics produce net worth figures differing by
the full limit; assert realized yield computed on average daily balance differs from the
closing-balance figure for a fixture with a large mid-cycle deposit, and that the average-daily
one is used; assert contributions and cumulative profit sum to the account balance.

DONE WHEN: tests pass, and the savings detail view renders contributions-vs-growth legibly at
390px.
```

---

## Prompt 5 — Review

```
Read SPEC.md §10 and §11.6. Also read web/CLAUDE.md — the UI conventions
there are binding, in particular the single shared loader and the requirement that every
route carry a loading.tsx. Prompt 0's foundation is in place.

Extend web/src/app/review/page.tsx — it already groups parked messages by shape hash and has
derive/retry/dismiss/restore actions in web/src/app/review/actions.ts and derive-form.tsx.
Keep all of that. Add the health and alerts layers around it, and adjust for the conditional tab.

ADD, in this order down the page:

1. SYSTEM HEALTH PANEL (§11.6). This is the honest counterpart to a dashboard claiming to know
   your finances. On a pipeline that depends on an iOS Shortcut staying enabled, ingestion WILL
   silently die eventually, and this is where you find out.
   - Last message received, with a warning past 24h.
   - Messages pending, parse success rate, template hit rate (should climb toward ~100%).
   - LLM calls this month against the free-tier cap — show as not-yet-enabled while the Gemini
     fallback is deferred, rather than omitting the row.
   - Per-account reconciliation status.
   - MASTER INVARIANT CHECK: assert Δnet_worth == income − expense over the current cycle and
     show pass/fail with the delta. §6 says this catches classification errors no individual
     balance reconciliation would. It belongs on screen, not only in tests.
   Some of this already exists as Stat components and lib/review.ts helpers — extend rather
   than duplicate.

2. ALERTS LIST from the alerts table: type, severity, payload, dismiss. Grouped by severity.
   Dismissing writes dismissed_at. §11.6 keeps alerts in-app only in v1 — no email, no push —
   but each is a row so adding a channel later is a rendering change.

3. RECONCILIATION ALERTS with computed vs reported vs delta per account, and a resolve action
   that writes resolution_note. Link through to the account and to the transactions in the
   drifting window.

4. The existing parked-message queue, unchanged in behavior.

5. EXPORT / BACKUP section: one click to CSV and JSON for transactions, and a full dump of
   raw_messages. §11.6: the raw store is the irreplaceable asset since everything else can be
   re-derived from it, and you're on a free tier that pauses on inactivity with no restore
   guarantee. Treat your own export as the backup. Add a monthly export reminder as an alert row.

CONDITIONAL TAB BEHAVIOR: Prompt 0 made the Review tab appear only when the queue is non-empty.
Consequences to handle here:
- The route must render correctly when reached by URL with an empty queue — the health panel and
  export are still useful, so the page is never empty.
- Settings must contain a permanent link to /review so it's reachable when the tab is hidden.
- When the queue empties while you're on the page, don't yank the tab out from under the current
  navigation. Recompute on the next navigation, not mid-render.

TRAPS:
- Deriving a template from one hand-parsed message must reprocess every parked message sharing
  its shape hash and leave unrelated shapes untouched (§13). This already works — don't break it.
- Health figures must be cheap. This page is polled; don't table-scan raw_messages on every load.

TESTS: extend web/scripts/verify-review-view.mjs — the master invariant check reports fail on a
deliberately misclassified fixture (a card payment counted as spending) and pass once corrected;
the page renders with an empty queue; template hit rate is computed over parsed messages only.

DONE WHEN: tests pass, and the health panel tells you the truth about a pipeline you've
deliberately broken by pausing ingestion.
```

---

## Prompt 6 — Settings

```
Read SPEC.md §4, §5.5, §9 and §11.6. Also read web/CLAUDE.md — the UI conventions
there are binding, in particular the single shared loader and the requirement that every
route carry a loading.tsx. Prompt 0's foundation is in place.

Build web/src/app/settings/page.tsx, reached by the gear icon on Home. Not a tab. Sections, each
collapsible, each its own component:

1. ACCOUNTS ADMIN — add, rename, deactivate, reorder. Set type, is_liability, balance_semantics,
   reconcilable, credit_limit, statement_day, due_day, is_profit_bearing, opening_balance.
   Changing balance_semantics is the single most consequential setting in the app: warn, show the
   net worth figure before and after, and require a confirm (§3.3a).
   Account identifiers management: the UNIQUE key is (institution, kind, value), NOT (kind,
   value) — two banks can mask to the same last-four digits (§8.3).

2. CATEGORIES — tree with parent_id, icon, colour, is_income. Merge two categories (moves
   transactions, keeps history). Cannot delete a category with transactions; offer merge instead.

3. MERCHANTS — normalized name, display name, default category, aliases. Merge merchants.
   This is where "TAMIMI MARKETS 4471" and "TAMIMI MARKETS" become one thing.

4. RULES — the management surface for rules created in the Ledger. List ordered by priority,
   drag to reorder, enable/disable, edit match conditions and actions, delete.
   "Re-run over history" with a DRY-RUN PREVIEW showing what would change before applying (§9.5).
   A rule always beats the parser: once you correct a categorization, it stays corrected.
   Never re-run rules over locked_fields.

5. PERIOD SETTINGS — cycle_anchor_day, week_start_dow, timezone, from the settings table.
   Editable, with a loud warning that changing the anchor re-buckets all history. Show a preview
   of the current period under the proposed anchor before saving. Everything reads from here;
   nothing inlines 25 or 0 (§5.5).

6. DATA — export CSV/JSON, raw_messages dump, a permanent link to /review (needed because the
   Review tab hides when the queue is empty), parse-tick status, and the monthly export reminder
   toggle.

TESTS: web/scripts/verify-settings.mjs — changing balance_semantics on a fixture card changes
net worth by exactly the credit limit; merging two categories preserves the transaction count and
total; a rule re-run does not touch locked_fields; account_identifiers accepts the same last-four
under two different institutions and rejects a duplicate within one.

DONE WHEN: tests pass, and every literal 25 / 0 / 'Asia/Riyadh' in web/src/ has been replaced by
a read from settings.
```

---

## Notes on running these

- **Order matters.** 0 → 1 → 2 → 3 → 4 → 5 → 6. Prompts 1–5 all assume Prompt 0's
  `web/src/lib/periods.ts` and the grain toggle exist.
- **One session each.** These are large; a fresh context per prompt keeps the SPEC sections
  relevant to that page in view.
- **After each**, run `npm run test:ui && npm run build` before starting the next.
- **If a prompt's session proposes `date_trunc('month')`, a hardcoded 30-day cycle, or
  `cycle_budget ÷ 4`**, stop it — those are the three failure modes this SPEC was written to
  prevent, and they produce numbers that look plausible while being wrong.
- **If a session proposes adding a fifth permanent tab**, stop it too. The four-tab bar is a
  decision, not an oversight. Anything that feels like it needs a tab is either a drill-down
  from Home (the savings view, reached from the net worth strip) or a segment inside Plan.
