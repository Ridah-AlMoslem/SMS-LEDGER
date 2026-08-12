# sms-ledger

Builds a complete personal financial ledger out of bank SMS messages.

Saudi bank SMS arrive in Arabic and English, often mixed inside a single message, with
inconsistent date formats, inconsistent account masking, and bidirectional-text artifacts.
This repo parses them into a double-entry ledger and puts a dashboard on top.

Full design: [`SPEC.md`](SPEC.md). Simulation results and the six bugs it caught:
[`AUDIT.md`](AUDIT.md).

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js 16** (App Router) | One deploy, API routes are the backend, no CORS |
| Parser service | **Python 3.12 + FastAPI** | The parser is already written and verified in Python. Porting it to TypeScript would mean re-deriving Arabic normalization and 12 regexes with no test net during the translation |
| Deploy | **Vercel Services** | Both services in one project, one repo, one deploy. Routing in `vercel.json` |
| Database | **Supabase Postgres** | 500 MB free tier; a decade of SMS is well under 100 MB |
| ORM | **Drizzle** | Owns the schema and migrations. Python uses plain SQL against the same tables, so there is one source of truth |
| Validation | **Zod** (TS) / **Pydantic** (Py) | Shared contract at the ingest boundary |
| Scheduling | **Supabase `pg_cron`** | Vercel Hobby caps cron at once daily. `pg_cron` is unrestricted and doubles as the keep-alive |
| Charts | **Recharts** | |
| Client data | **TanStack Query** | Cache + optimistic edits for the CRUD layer |
| Auth | **Supabase Auth** (magic link), RLS on | Single user, but RLS from day one costs nothing |

**LLM fallback is deferred past v1.** The 12 templates cover every attested format. Unknown
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
    registry.py      12 templates, regexes derived only from attested raw text
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

samples/             Raw SMS batches and derived analysis (untracked)
vercel.json          Services routing
```

---

## Running it

**Parser suite** — no install, Python 3.10+:

```bash
python3 tests/simulate_two_months.py
for f in tests/verify_*.py; do python3 "$f" || echo "FAILED: $f"; done
```

**Web:**

```bash
cd web && npm install && npm run dev
```

**Both services together**, with Vercel routing applied locally:

```bash
vercel dev
```

**Migrations:**

```bash
cd web && npx drizzle-kit generate && npx drizzle-kit migrate
```

Copy `.env.example` to `web/.env.local` and `api/.env` and fill it in first.

---

## Design rules

These are load-bearing. Breaking them has produced silent, expensive bugs before.

**Raw messages are immutable.** `raw_messages` is append-only, never edited, never deleted.
Every parser improvement replays across full history. Persist only the parsed result and every
parser bug becomes permanent data loss.

**Regexes come only from attested raw text.** If a format has not been observed in a real SMS,
it does not get a template — it goes to manual review.

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
| 0 | Period functions | **Done** — `ledger/periods.py`, verified over a multi-year range |
| 1 | Schema + migrations | Schema written, migrations not yet generated |
| 2 | Ingest endpoint | HMAC + dedup written, DB write is a TODO |
| 3 | Normalization + classification | **Done** — `ledger/normalize.py`, `ledger/classify.py` |
| 4 | Template engine | **Done in-memory** — `ledger/registry.py`; template CRUD not built |
| 5 | Gemini fallback | Deferred past v1 |
| 6 | Transaction writer | Logic done in `ledger/pipeline.py`; persistence not wired |
| 7 | Manual workbench | Not started |
