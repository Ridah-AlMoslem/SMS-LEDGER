/**
 * Alerts — SPEC §11.6.
 *
 * "Alerts are in-app only in v1 — a badge and a dashboard banner, no email or
 * push. Every alert is a row in an `alerts` table with a type, severity,
 * payload and `dismissed_at`, so adding a delivery channel later is a rendering
 * change rather than a rewrite."
 *
 * This module is that rendering: rows in, one line of text and a destination
 * out. It is pure so the mapping can be tested without a database, and so the
 * banner component stays a banner rather than a switch statement.
 *
 * **`alerts.type` is TEXT, deliberately** (see schema.ts) — a background job
 * adding a new type must not need a migration. The consequence is that this
 * table is the only contract between the writer and the reader, so an unknown
 * type renders as itself rather than being dropped. An alert that fires and is
 * silently not displayed is worse than an ugly one.
 */

export type Severity = "info" | "warning" | "critical";

export type AlertRow = {
  id: string;
  type: string;
  severity: Severity;
  payload: Record<string, unknown> | null;
  createdAt: Date;
};

export type AlertView = {
  id: string;
  type: string;
  severity: Severity;
  /** One line. This is the collapsed banner, not a detail view. */
  title: string;
  /** Where tapping it goes — the page that can actually resolve it. */
  href: string;
  /**
   * False for alerts computed at read time rather than stored.
   *
   * There is nothing to write `dismissed_at` to, and dismissing one would be a
   * lie anyway: it reappears on the next render because the condition is still
   * true. These clear themselves when the underlying state clears.
   */
  dismissible: boolean;
};

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;

const money = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.abs(n))
    : "—";
};

/**
 * The types §11.6 names, and where each one is actionable.
 *
 * The destination is the point. An alert that opens a dashboard you were
 * already looking at has told you something is wrong and then made you find it;
 * every one of these lands on the screen with the fix on it.
 */
const TYPES: Record<
  string,
  { title: (p: Record<string, unknown>) => string; href: (p: Record<string, unknown>) => string }
> = {
  reconciliation_drift: {
    title: (p) =>
      `${str(p.account, "An account")} is off by ${money(p.delta)} against the balance the bank stated`,
    href: (p) => (p.slug ? `/accounts/${str(p.slug)}` : "/accounts"),
  },
  no_heartbeat: {
    title: (p) =>
      `No message received for ${str(p.hours, "24")}h — the ingest Shortcut may be off`,
    href: () => "/review",
  },
  review_queue: {
    title: (p) =>
      `${str(p.count, "Some")} message${p.count === 1 ? "" : "s"} the parser couldn't read`,
    href: () => "/review",
  },
  budget_overspend: {
    title: (p) => `${str(p.category, "A category")} is over budget by ${money(p.over)}`,
    href: (p) => (p.categoryId ? `/categories/${str(p.categoryId)}` : "/plan"),
  },
  budget_projected_overspend: {
    title: (p) => `${str(p.category, "A category")} is on track to overspend by ${money(p.over)}`,
    href: (p) => (p.categoryId ? `/categories/${str(p.categoryId)}` : "/plan"),
  },
  missed_recurring: {
    title: (p) => `${str(p.merchant, "A recurring charge")} hasn't arrived as expected`,
    href: () => "/plan",
  },
  missed_salary: {
    title: () => "Salary hasn't landed for this cycle",
    href: () => "/ledger",
  },
  missed_profit: {
    title: () => "The monthly profit payout hasn't arrived",
    href: (p) => (p.slug ? `/accounts/${str(p.slug)}` : "/accounts"),
  },
  card_due: {
    title: (p) =>
      `${str(p.account, "A card")} is due in ${str(p.days, "3")} day${p.days === 1 ? "" : "s"}`,
    href: (p) => (p.slug ? `/accounts/${str(p.slug)}` : "/accounts"),
  },
  loan_due: {
    title: (p) => `${str(p.name, "A loan")} payment is due`,
    href: (p) => (p.slug ? `/accounts/${str(p.slug)}` : "/accounts"),
  },
  /**
   * §11.6's monthly export reminder. Raised by the nightly pass in
   * `db/backup.ts`, cleared by it once the raw store has been dumped.
   *
   * "Never" is worded as its own sentence rather than as "0 days ago": a
   * database that has never been copied anywhere is a different situation from
   * one whose copy is stale, and it is the one worth a full stop.
   */
  export_reminder: {
    title: (p) =>
      p.never
        ? "The raw messages have never been backed up — nothing outside this database can rebuild the ledger"
        : `The raw messages haven't been backed up in ${str(p.days, "30")} days`,
    href: () => "/review",
  },
};

/** An unknown type still gets a line and a destination. */
function fallbackTitle(type: string): string {
  return type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function toAlertView(row: AlertRow): AlertView {
  const payload = row.payload ?? {};
  const spec = TYPES[row.type];

  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: spec ? spec.title(payload) : str(payload.message, fallbackTitle(row.type)),
    href: spec ? spec.href(payload) : "/review",
    dismissible: true,
  };
}

/**
 * Every open alert, most severe first.
 *
 * `derived` carries conditions computed at read time — today only the parked
 * review queue, which the layout already counts for the tab badge and which
 * would otherwise need a background job to exist as a row before the parser can
 * tell you it is stuck. Ties break on recency: two warnings, the newer one
 * leads, because the banner collapses to one line and the older one is the one
 * you have already seen.
 */
export function rankAlerts(rows: AlertRow[], derived: AlertView[] = []): AlertView[] {
  const stored = [...rows]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || +b.createdAt - +a.createdAt)
    .map(toAlertView);

  return [...derived, ...stored].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** The review queue as an alert, for the count the layout already has. */
export function reviewQueueAlert(parked: number): AlertView[] {
  if (parked <= 0) return [];
  return [
    {
      id: "derived:review_queue",
      type: "review_queue",
      severity: "warning",
      title: TYPES.review_queue.title({ count: parked }),
      href: "/review",
      dismissible: false,
    },
  ];
}
