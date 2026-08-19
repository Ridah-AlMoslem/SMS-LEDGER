/**
 * System health — SPEC §11.6.
 *
 * "A system health panel is the honest counterpart to a dashboard that claims
 * to know your finances… If ingestion silently dies, this is where you find out
 * — and on a pipeline that depends on an iOS automation staying enabled, that
 * will happen eventually."
 *
 * Every tile here answers a question the rest of the app cannot. Home shows what
 * was spent; it has no way of saying "and nothing has arrived since Tuesday",
 * because a pipeline that has stopped looks exactly like a quiet week. That is
 * the failure this panel exists for, and it is why the two banners below are
 * sentences rather than red dots: the reader is being told to go and check a
 * Shortcut on their phone, and a dot cannot say that.
 *
 * A server component — nothing here is interactive, and every figure comes from
 * the one statement `db/review.ts` already ran.
 */

import Link from "next/link";

import { type Reconciliation, reconciliationOf } from "@/lib/accounts";
import { dayMonthYear, timeOfDay } from "@/lib/format";
import { type InvariantCheck, explain } from "@/lib/invariant";
import {
  type Health,
  type LlmStatus,
  ingestionStale,
  parseRate,
  parsingStalled,
  templateHitRate,
} from "@/lib/review";
import type { ReviewAccount } from "@/db/review";

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-lg bg-black/[0.03] p-3 dark:bg-white/[0.06]">
      <p className="text-xs opacity-60">{label}</p>
      <p
        className={`tabular mt-0.5 text-lg font-medium ${
          tone === "warn" ? "text-amber-600 dark:text-amber-400" : ""
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] opacity-50">{hint}</p>}
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
      {children}
    </p>
  );
}

const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

/* ------------------------------------------------------- the master invariant */

/**
 * §6's identity, with pass/fail and the delta.
 *
 * Given its own card rather than a tile because a tile can only say "fail", and
 * "fail" on its own sends the reader to read §6 from the top. The two figures
 * and the difference between them are the whole diagnosis, and the reconciling
 * items are shown *only when they are non-zero* — a permanent row reading
 * "adjustments 0.00" trains the eye to skip the place where the explanation
 * appears.
 */
function InvariantCard({ check, cycleLabel }: { check: InvariantCheck; cycleLabel: string }) {
  const money = (v: number) =>
    `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const tone = check.ok
    ? "border-black/10 dark:border-white/15"
    : "border-rose-500/40 bg-rose-500/5";

  return (
    <section className={`mt-4 rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">
          Δ net worth = income − spending
          <span className="ml-2 text-xs font-normal opacity-55">{cycleLabel}</span>
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            check.ok
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "bg-rose-500/10 text-rose-700 dark:text-rose-400"
          }`}
        >
          {check.empty ? "nothing to check" : check.ok ? "holds" : "broken"}
        </span>
      </div>

      <dl className="tabular mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs opacity-55">Δ net worth</dt>
          <dd className="mt-0.5">{money(check.observed)}</dd>
        </div>
        <div>
          <dt className="text-xs opacity-55">Income − spending</dt>
          <dd className="mt-0.5">{money(check.expected)}</dd>
        </div>
        <div>
          <dt className="text-xs opacity-55">Unexplained</dt>
          <dd className={`mt-0.5 ${check.ok ? "" : "font-medium text-rose-700 dark:text-rose-400"}`}>
            {money(check.unexplained)}
          </dd>
        </div>
      </dl>

      {(check.adjustments !== 0 || check.unposted !== 0) && (
        <p className="mt-3 text-xs opacity-60">
          Accounted for separately:{" "}
          {check.adjustments !== 0 && (
            <>
              <span className="tabular">{money(check.adjustments)}</span> of balances corrected by
              hand, which move net worth without being income or spending (§3.3b)
            </>
          )}
          {check.adjustments !== 0 && check.unposted !== 0 && "; "}
          {check.unposted !== 0 && (
            <>
              <span className="tabular">{money(check.unposted)}</span> still pending — counted as
              spending the moment it arrived, and in no balance until it settles (§7.2)
            </>
          )}
          .
        </p>
      )}

      <p className="mt-3 text-xs opacity-60">
        {check.empty
          ? "No legs in this cycle yet. The check is real from the first transaction."
          : explain(check)}
      </p>

      {!check.ok && (
        <p className="mt-2 text-xs opacity-50">
          Both sides are derived from the ledger&rsquo;s own legs, so a missing message cannot
          cause this — that shows up as drift below, with the account named. This is a
          classification error: something is filed under a type §6 counts differently.{" "}
          <Link href="/ledger" className="underline underline-offset-2">
            Open the ledger for this cycle
          </Link>
          .
        </p>
      )}
    </section>
  );
}

/* --------------------------------------------------- per-account reconciliation */

const LEVEL_TONE: Record<Reconciliation["level"], string> = {
  full: "text-emerald-700 dark:text-emerald-400",
  partial: "text-amber-600 dark:text-amber-400",
  weak: "text-amber-600 dark:text-amber-400",
  none: "opacity-55",
};

function ReconciliationRow({ account }: { account: ReviewAccount }) {
  const r = reconciliationOf(account, account.coverage);

  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <Link href={`/accounts/${account.slug}`} className="text-sm hover:underline">
          {account.name}
        </Link>
        <p className="mt-0.5 text-xs opacity-50">{r.detail}</p>
      </div>
      <p className={`shrink-0 text-right text-xs ${LEVEL_TONE[r.level]}`}>
        {r.label}
        {r.share !== null && (
          <span className="tabular mt-0.5 block opacity-60">{pct(r.share)} of messages</span>
        )}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- the panel */

export function HealthPanel({
  health,
  accounts,
  invariant,
  llm,
  cycleLabel,
  now,
}: {
  health: Health;
  accounts: ReviewAccount[];
  invariant: InvariantCheck;
  llm: LlmStatus;
  cycleLabel: string;
  now: Date;
}) {
  const rate = parseRate(health);
  const hits = templateHitRate(health);
  const stale = ingestionStale(health.lastReceived, now);
  const stalled = parsingStalled(health.oldestQueued, now);
  const queued = health.pending + health.processing;
  const parked = health.needsReview + health.failed;

  return (
    <section aria-labelledby="health-heading">
      <h2 id="health-heading" className="sr-only">
        System health
      </h2>

      {/* "Queued" is here because it is the only place it can be: a message
          waiting to be parsed appears in no other list on this page — the queue
          below shows needs_review and failed, the ledger shows parsed — so
          without a tile of its own it is a message that arrived and vanished. */}
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Last message"
          value={health.lastReceived ? timeOfDay(health.lastReceived) : "never"}
          tone={stale ? "warn" : undefined}
          hint={health.lastReceived ? undefined : "nothing has ever been ingested"}
        />
        <Stat label="Parsed" value={String(health.parsed)} hint={`${health.ignored} ignored`} />
        <Stat
          label="Queued"
          value={String(queued)}
          tone={stalled ? "warn" : undefined}
          hint="waiting on the tick"
        />
        <Stat
          label="Waiting on you"
          value={String(parked)}
          tone={parked > 0 ? "warn" : undefined}
          hint="parked below"
        />
        <Stat
          label="Parse rate"
          value={pct(rate)}
          hint={rate === null ? "nothing attempted" : "of messages that reached a verdict"}
        />
      </div>

      {stale && (
        <Banner>
          No message in over 24 hours. iOS message automations fail silently — check the Shortcut
          is still enabled.
        </Banner>
      )}

      {stalled && (
        <Banner>
          {queued} message{queued === 1 ? "" : "s"} arrived and {queued === 1 ? "has" : "have"} not
          been parsed — the oldest since{" "}
          {health.oldestQueued ? timeOfDay(health.oldestQueued) : "—"}. The tick runs every minute,
          so this means it is not draining: check <code>net._http_response</code> for a 401
          (CRON_SECRET disagrees) or an error, and <code>cron.job</code> that the schedule is still
          active.
        </Banner>
      )}

      {/* Template hit rate and the LLM quota are one row: they are two halves of
          the same question — how much of the parsing is free, deterministic and
          replayable, and how much is not (§3.2). */}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Stat
          label="Template hit rate"
          value={pct(hits)}
          hint={
            hits === null
              ? "nothing parsed yet"
              : `${health.byMethod.template} by template, ${health.byMethod.manual} by hand${
                  health.byMethod.unattributed > 0
                    ? `, ${health.byMethod.unattributed} unattributed`
                    : ""
                } — should climb toward 100%`
          }
        />
        <Stat
          label="LLM calls this month"
          value={llm.enabled ? String(llm.calls) : "not enabled"}
          hint={llm.note}
        />
      </div>

      <InvariantCard check={invariant} cycleLabel={cycleLabel} />

      <section className="mt-6">
        <h3 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Reconciliation by account
        </h3>
        <p className="mt-1 text-xs opacity-50">
          §3.3b — a capability, not a guarantee. An account whose bank never states a balance is
          derived from message flow alone, and says so rather than looking verified.
        </p>
        <div className="mt-1 divide-y divide-black/8 dark:divide-white/10">
          {accounts.length === 0 ? (
            <p className="py-3 text-sm opacity-60">No accounts yet.</p>
          ) : (
            accounts.map((a) => <ReconciliationRow key={a.id} account={a} />)
          )}
        </div>
      </section>

      <p className="mt-3 text-xs opacity-40">
        Health as of {dayMonthYear(now)}, {timeOfDay(now)}.
      </p>
    </section>
  );
}
