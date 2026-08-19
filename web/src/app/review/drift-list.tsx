/**
 * Reconciliation drift, per account (SPEC §3.3).
 *
 * "Drift means a message was missed, double-counted, or misparsed. This is the
 * feature that makes the dashboard trustworthy rather than decorative."
 *
 * The account detail page already shows one account's alerts. This is the same
 * rows across every account, which is a different job: drift is how you find
 * out ingestion lost something, and the question there is "which account", not
 * "how is this account doing".
 *
 * Three figures, always together and always labelled: **computed** is what the
 * ledger derives from its legs, **reported** is what the bank last printed, and
 * **delta** is the difference. Showing only the delta would hide which side is
 * larger, and the sign is the first thing that narrows the cause — the ledger
 * ahead of the bank means a leg was booked twice, behind it means one never
 * arrived.
 *
 * Every row links two ways: to the account, and to the transactions inside the
 * window the drift appeared in. The second link is the one that does the work —
 * a drift is explained by finding the leg that is wrong, and the window is the
 * only thing narrowing that from the whole history to a handful of rows.
 */

import Link from "next/link";

import { ResolveDrift } from "@/components/accounts/resolve-drift";
import type { DriftRow } from "@/db/review";
import { driftPersists } from "@/db/reconciliation";
import { PARAM } from "@/lib/ledger-filters";
import { dayMonthYear } from "@/lib/format";

/**
 * Signed, always. A computed balance of −31.85 printed as 31.85 is the ledger
 * stating the opposite of what it holds, on the one screen whose job is to say
 * whether the ledger can be believed — and an overdrawn account read as a
 * positive one is a §3.3a-shaped error on a smaller scale. The minus is U+2212
 * so it lines up with the digits rather than sitting half a stroke high.
 */
const money = (v: number) => {
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `−${abs}` : abs;
};

/**
 * The transactions that could explain the drift.
 *
 * `window_from` is the last balance the bank stated *before* the one that
 * disagreed, so everything between it and the detection is a candidate. When
 * the bank has only ever stated one balance there is no earlier anchor, and the
 * honest window is the account's whole history — `all=1` rather than a range
 * invented to look precise.
 */
function windowHref(row: DriftRow): string {
  const params = new URLSearchParams({ [PARAM.account]: row.accountId });

  if (row.windowFrom) {
    params.set(PARAM.from, row.windowFrom);
    params.set(PARAM.to, row.windowTo);
  } else {
    params.set(PARAM.allTime, "1");
  }

  return `/ledger?${params.toString()}`;
}

function Row({ row }: { row: DriftRow }) {
  const open = row.resolvedAt === null;
  const stillOff = driftPersists(row.computedBalance, row.reportedBalance);

  return (
    <article
      className={`rounded-xl border px-4 py-3 ${
        open ? "border-amber-500/40 bg-amber-500/5" : "border-black/10 dark:border-white/15"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={`/accounts/${row.slug}`} className="font-medium hover:underline">
          {row.name}
        </Link>
        <p className="text-xs opacity-50">
          {open ? "Detected" : "Closed"} {dayMonthYear(row.resolvedAt ?? row.detectedAt)}
        </p>
      </div>

      <dl className="tabular mt-2.5 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs opacity-55">Computed</dt>
          <dd className="mt-0.5">{money(row.computedBalance)}</dd>
        </div>
        <div>
          <dt className="text-xs opacity-55">Bank reported</dt>
          <dd className="mt-0.5">{money(row.reportedBalance)}</dd>
        </div>
        <div>
          <dt className="text-xs opacity-55">Difference</dt>
          <dd
            className={`mt-0.5 font-medium ${
              open ? "text-amber-700 dark:text-amber-400" : ""
            }`}
          >
            {/* The one figure that carries an explicit "+": a difference is a
                direction, and a bare 1,000.00 reads as a magnitude. */}
            {row.delta > 0 && "+"}
            {money(row.delta)}
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-xs opacity-55">
        {row.delta > 0
          ? "The ledger is ahead of the bank — a leg booked that the bank does not have, most often one movement described by two messages (§8.2.1)."
          : "The ledger is behind the bank — money moved without a message arriving, which is what a paused Shortcut looks like from here."}
      </p>

      {!open && row.resolutionNote && (
        <p className="sms-body mt-2 rounded-lg bg-black/[0.03] px-3 py-2 text-xs dark:bg-white/[0.06]">
          {row.resolutionNote}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          href={windowHref(row)}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {row.windowFrom
            ? `Transactions ${row.windowFrom} → ${row.windowTo}`
            : "All transactions on this account"}
        </Link>
        <Link
          href={`/accounts/${row.slug}`}
          className="rounded-lg px-3 py-1.5 text-xs opacity-70 hover:bg-black/5 dark:hover:bg-white/10"
        >
          Open the account
        </Link>
        {open && (
          <div className="ml-auto">
            <ResolveDrift
              alertId={row.id}
              slug={row.slug}
              delta={row.delta}
              stillOff={stillOff}
            />
          </div>
        )}
      </div>
    </article>
  );
}

export function DriftList({ rows }: { rows: DriftRow[] }) {
  const open = rows.filter((r) => r.resolvedAt === null);
  const closed = rows.filter((r) => r.resolvedAt !== null);

  return (
    <section className="mt-10" aria-labelledby="drift-heading">
      <h2 id="drift-heading" className="text-sm font-semibold tracking-wide uppercase opacity-70">
        Reconciliation
      </h2>
      <p className="mt-1 text-xs opacity-50">
        What the ledger computes against what the bank last printed (§3.3). Closing one records
        that you know why they differ — it does not change a balance, and the next pass raises it
        again if they still disagree.
      </p>

      {open.length === 0 ? (
        <p className="mt-3 rounded-xl border border-black/10 px-4 py-3 text-sm opacity-60 dark:border-white/15">
          Every reconcilable account agrees with the last balance its bank stated. Accounts that
          state no balance are listed above as unchecked rather than counted here as clean.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {open.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs opacity-55 hover:opacity-100">
            {closed.length} closed recently
          </summary>
          <p className="mt-2 text-xs opacity-45">
            Kept because &ldquo;this account drifted three times last month and was closed by hand
            each time&rdquo; is the story a single open alert cannot tell.
          </p>
          <div className="mt-2 space-y-3">
            {closed.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
