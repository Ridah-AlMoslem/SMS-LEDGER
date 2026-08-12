# sms-ledger

Builds a complete personal financial ledger out of bank SMS messages.

Saudi bank SMS arrive in Arabic, with Latin merchant names embedded, inconsistent date
formats, inconsistent account masking, and bidirectional-text artifacts.
This repo parses them into a double-entry ledger and puts a dashboard on top.

Full design: [`SPEC.md`](SPEC.md). Simulation results and the six bugs it caught:
[`AUDIT.md`](AUDIT.md).

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js 16** (App Router) | One deploy, API routes are the backend, no CORS |
| Parser service | **Python 3.12 + FastAPI** | The parser is already written and verified in Python. Porting it to TypeScript would mean re-deriving Arabic normalization and 29 regexes with no test net during the translation |
| Deploy | **Vercel Services** | Both services in one project, one repo, one deploy. Routing in `vercel.json` |
| Database | **Supabase Postgres** | 500 MB free tier; a decade of SMS is well under 100 MB |
| ORM | **Drizzle** | Owns the schema and migrations. Python uses plain SQL against the same tables, so there is one source of truth |
| Validation | **Zod** (TS) / **Pydantic** (Py) | Shared contract at the ingest boundary |
| Scheduling | **Supabase `pg_cron`** | Vercel Hobby caps cron at once daily. `pg_cron` is unrestricted and doubles as the keep-alive |
| Charts | **Recharts** | |
| Client data | **TanStack Query** | Cache + optimistic edits for the CRUD layer |
| Auth | **Supabase Auth** (magic link), RLS on | Single user, but RLS from day one costs nothing |

**LLM fallback is deferred past v1.** All 29 attested formats are templated. Unknown
shapes park in the review queue, where hand-parsing one message derives a template and
reprocesses every message sharing its shape hash — which is what the LLM would do, minus an
API key, a quota ceiling, and a schema contract to keep honest. Gemini 2.5 Flash-Lite goes in
when the queue becomes annoying, not before.

### Free-tier constraints to design around

- **Supabase pauses free projects after 7 days of inactivity.** The `pg_cron` tick keeps it
  alive. Do not remove it.
- **Vercel Hobby: 30s function timeout, cron no more than once daily, UTC only.** Ingest
  returns in <100 ms by design and `pg_cron` drives the parser, so neither limit binds.
- **Google cut free Gemini quotas 50–80% in Dec 2025.** The current 1,000 req/day is
  post-cut. Don't design near the ceiling.

---

## Layout

```
api/                 Python service — deployed at /api/*
  main.py            FastAPI entrypoint: /api/ingest, /api/parse-tick, /api/health
  pyproject.toml     Deps + Vercel entrypoint
  ledger/            The parser package (pure stdlib, no I/O, no DB)
    normalize.py     Bidi stripping, Arabic-Indic digits, letterform folding,
                     currency tokens, shape hashing
    classify.py      Non-ledger classes short-circuit first
    registry.py      29 templates — every attested format, all four institutions
    extract.py       Field extraction per template
    dates.py         Per-template date formats + received_at validation
    periods.py       Salary-cycle arithmetic (25th → 24th)
    topup.py         Wallet top-up linking
    pipeline.py      ingest → dedup → classify → match → extract → date →
                     resolve → post → link

web/                 Next.js 16 — deployed at /*
  src/db/schema.ts   Drizzle schema (SPEC §4), the single source of truth
  src/db/index.ts    Postgres client
  drizzle.config.ts

tests/               Reference suite. Any change must keep these passing.
  scenario.py              Generator that emits ground truth beside every message
  simulate_two_months.py   Two salary cycles audited against that ground truth
  trace.py                 Per-message trace → samples/TRACE.md
  verify_*.py              Focused checks per spec area

tools/               Maintenance scripts
  rehash_shapes.py   Recompute stored shape hashes after a hashing change

samples/             Raw SMS batches and derived analysis (untracked)
vercel.json          Services routing
```

---

## Setup

**1. Fill in the environment.** Both files already exist and are gitignored:
`web/.env.local` and `api/.env`. `INGEST_SECRET` and `CRON_SECRET` are already generated.

Only **two values** are needed to run — both from Supabase → **Connect** → Connection string →
URI. They differ only by port, and that port is load-bearing:

| Variable | Supabase option | Port | Goes in |
|---|---|---|---|
| `DATABASE_URL` | **Transaction pooler** | 6543 | both files |
| `DIRECT_URL` | **Session pooler** | 5432 | `web/.env.local` |

Replace `[YOUR-PASSWORD]` in the string with your database password. Both strings use the same
`pooler.supabase.com` host and the same `postgres.<project-ref>` username — only the port
differs.

> **Do not use the "Direct connection" option for `DIRECT_URL`.** Its host,
> `db.<ref>.supabase.co`, resolves to **IPv6 only**. On an IPv4-only network — most home wifi,
> and any phone tethering — `drizzle-kit` prints `Using 'postgres' driver` and then hangs
> silently until the OS gives up. The Session pooler answers on IPv4 and still provides
> session-mode semantics, so DDL, advisory locks and migrations all work. Both
> `drizzle.config.ts` and `run-sql.mjs` now detect that host and fail with an explanation
> rather than hanging.

The remaining keys (`NEXT_PUBLIC_SUPABASE_URL`, publishable, secret) are for Supabase Auth at
milestone 8. Nothing reads them yet — leave them blank. When you do fill them, use the new
`sb_publishable_…` / `sb_secret_…` format; the legacy `anon` and `service_role` JWTs still work
but are deprecated by end of 2026.

**2. Apply the migration and seed your accounts.**

```bash
cd web
npm run db:migrate
npm run db:seed     # runs scripts/seed.local.sql — edit your balances first
```

`db:seed` uses the `postgres` package rather than `psql`, which is not installed by default on
macOS. Re-running is safe: every statement is `ON CONFLICT DO NOTHING`.

Opening balances are not optional. Without them, reconciliation has no anchor on the SAIB
accounts — which report no balance in any message — and the cashback wallet goes negative the
first time you redeem points earned before tracking began (§9.2).

## Running it

```bash
python3 tests/run_all.py          # parser + persistence: 21 suites
python3 tests/run_all.py --fast   # pure logic only, ~1s, no Node required

cd web
npm run test:ui                   # accounts + review view logic
npm run dev                       # web only
vercel dev                        # both services, Vercel routing applied
```

The app has two screens: `/` is the ledger — net worth, accounts grouped by bank, recent
transactions — and `/review` is everything the parser could not handle, grouped by message
shape so one fix clears a whole cluster.

## Testing

Two tiers, and the split is deliberate.

**Pure logic** — no database, no network, about a second. Proves the parser computes the right
answer. The two-month simulation audits 50 generated messages against ground truth the
generator emits alongside them, so it compares against known-correct values rather than an
eyeball check.

**Persistence** — real Postgres via [PGlite](https://pglite.dev) over the actual wire
protocol, with the current migrations applied, so `psycopg` connects exactly as it will to
Supabase. This tier exists because the expensive bugs live in the gap between parsing and
storage, and a mock would simply agree with whatever the code did.

It has already earned its keep. It caught a `TypeError` on every dated message — the parser
built naive datetimes and Postgres returns `TIMESTAMPTZ` — which the pure suite could not see,
because in-memory fixtures are naive on both sides. The underlying issue was worse than the
crash: bank SMS print Riyadh wall-clock, and comparing that against UTC files a 00:30
transaction into the previous day, which for a payday means the previous *salary cycle*.

---

## Design rules

These are load-bearing. Breaking them has produced silent, expensive bugs before.

**Raw messages are immutable.** `raw_messages` is append-only, never edited, never deleted.
Every parser improvement replays across full history. Persist only the parsed result and every
parser bug becomes permanent data loss.

**Regexes come only from attested raw text.** If a format has not been observed in a real SMS,
it does not get a template — it goes to manual review. Patterns are written in POST-normalization
spelling: the normalizer folds `إ`→`ا` and `ى`→`ي`, so the bank's `إلى` and `الى` both reach the
regex as `الي`. That fold is why STC's outgoing transfer has two identical labels and order is
the only thing separating name from account.

**Unknown senders go to review, never to the bin.** Dropping unrecognized messages as spam
means adding a new bank account silently loses every message from it, with no error anywhere.

**Never compare masked account strings literally.** One sender writes the same account as
`XXXX7001`, `XXX7001`, `X7001`, and `0000xx17001`. Resolution is by suffix, scoped to the
institution.

**Names never decide transfer direction.** A transfer to your own name at another bank is
internal; classifying on recipient name books an expense that never happened.

**Credit raises net worth, debit lowers it — for assets and liabilities alike.** A credit on a
card reduces debt. Special-casing liability signs is where the sign errors came from.

**One message can produce two legs.** Internal transfers, card payments, and cashback
redemption each describe both sides of a movement in a single SMS.

**The system is single-language by decision.** Every attested format from every sender is
Arabic, and English is out of scope (confirmed 2026-08-12) — not a gap waiting to be filled.
A Latin merchant name does not make a message English. But classification still recognises
English OTPs and declines, deliberately: those patterns are not there to parse English, they
are there so an English OTP is DISCARDED rather than booked. §7.1 calls an OTP reaching the
ledger the most expensive misclassification in the system. Every row is tagged `ar` or `en`, so
a sender switching language shows up as a labelled row rather than an unexplained arrival in
the review queue.

**The shape hash identifies a FORMAT, not a message.** Numbers become `#`, masked accounts
become `X`, and free text below the first line becomes `T`. That last rule is what stops a
merchant name being structural — without it one purchase format produces a shape per shop,
measured at 31 shapes across 31 messages, meaning no grouping at all. The first line is left
alone because headers are what distinguish formats: STC's `شراء Apple Pay` differs from
`شراء انترنت` only in Latin text. Change the rules and run `tools/rehash_shapes.py`.

**The month is the salary cycle, 25th → 24th**, labeled by the month it *ends* in. An early
salary carries `تاريخ استحقاق`, and the due date decides the cycle.

**Reconcile against the balance printed in the SMS.** Drift means a message was missed,
double-counted, or misparsed. This is what makes the dashboard trustworthy rather than
decorative — and on a credit card, `رصيد` is available credit, not debt.

---

## Data privacy

The verification scripts read real bank SMS. Those files are deliberately untracked:
`samples/*_raw.txt`, `samples/ANALYSIS.md`, `samples/TRACE.md`, `samples/COLLECTION.md`.

They stay on disk so everything runs locally, but never enter git history. A fresh clone runs
the simulation and every `verify_*.py` except `verify_batch3.py`, which reads
`samples/batch3_raw.txt` directly.

Account numbers and names in tracked files are **placeholders**. The parser matches on message
structure, never on these literals.

---

## Build order

Milestones 1–7 are the product. Everything after is presentation over data you already trust.
Full table in `SPEC.md` §12.

| # | Milestone | State |
|---|---|---|
| 0 | Period functions | **Done** — verified over a multi-year range |
| 1 | Schema + migrations | **Done** — 12 tables, applied and tested against real Postgres |
| 2 | Ingest endpoint | **Done** — HMAC, replay window, dedup, 202 on redelivery |
| 3 | Normalization + classification | **Done** |
| 4 | Template engine | **Done** — 28 templates, plus derivation and persistence |
| 5 | Gemini fallback | Deferred past v1 |
| 6 | Transaction writer | **Mostly done** — claim, parse, post, balances, reconciliation |
| 7 | Manual workbench | **Done** — queue, retry/dismiss, and template derivation |

A signed message goes in one end and comes out as a transaction on the page, account balances
move, and drift against the bank's own figures raises a visible alert.

Balances are **recomputed** from `opening_balance` + posted legs on every tick, never
incremented. Incrementing is cheaper and wrong: messages arrive out of order, replay is a design
requirement (§3.1), and a tick that committed a transaction but not its balance update would
leave a permanent invisible skew.

What this does *not* yet do, in rough priority order:

- **Top-up linking does not run on the DB path.** `link_topups` is a cross-transaction pass
  that exists only in the in-memory pipeline, so a wallet top-up and the spend it funds both
  count. The simulation measures this at +320 phantom expense over two months.
- **`template_id` is written as NULL** on every parse, so there is no record of which template
  matched and `hit_count` never climbs.
- **Code templates cannot be edited from the UI.** Derived templates live in `sms_templates`
  and are tried first, so a correction wins — but the 20 built-in ones still change only in
  `registry.py`.
- **No transfer pairing, no rules engine, no categories.** Transactions land uncategorized.
