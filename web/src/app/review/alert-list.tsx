"use client";

/**
 * Every open alert, grouped by severity (SPEC §11.6).
 *
 * The counterpart to Home's banner, not a duplicate of it. The banner collapses
 * to one line because Home has to fit a pace hero and a net-worth strip above
 * the fold; this is the list you come to when you want to work through them,
 * so it shows all of them and does not fold.
 *
 * §11.6 keeps alerts in-app only in v1 — "a badge and a dashboard banner, no
 * email or push. Nothing to configure, nothing to deliver, nothing to break" —
 * "but every alert is a row in an `alerts` table with a type, severity, payload
 * and `dismissed_at`, so adding a delivery channel later is a rendering change
 * rather than a rewrite". This file is that rendering, and it is the only thing
 * that would need to know about a channel.
 *
 * Grouped by severity rather than sorted by it, because the grouping is the
 * triage: two criticals under a heading are a different morning from eleven
 * infos, and a flat list ordered by severity makes those look like the same
 * list of thirteen.
 */

import Link from "next/link";
import { useState, useTransition } from "react";

import { dismissAlert } from "@/app/actions";
import { Loader } from "@/components/ui/loader";
import type { AlertView, Severity } from "@/lib/alerts";

const ORDER: Severity[] = ["critical", "warning", "info"];

const HEADING: Record<Severity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "For information",
};

const TONE: Record<Severity, string> = {
  critical: "border-rose-500/40 bg-rose-500/5",
  warning: "border-amber-500/40 bg-amber-500/5",
  info: "border-black/10 dark:border-white/15",
};

const INK: Record<Severity, string> = {
  critical: "text-rose-700 dark:text-rose-300",
  warning: "text-amber-700 dark:text-amber-400",
  info: "",
};

/** Severity is never carried by colour alone: each one is announced to a screen
 *  reader and the glyph is a second channel for a reader who cannot separate
 *  amber from rose. Same two channels as the banner, deliberately. */
const MARK: Record<Severity, string> = { critical: "!", warning: "!", info: "i" };

function Row({
  alert,
  dismissing,
  onDismiss,
}: {
  alert: AlertView;
  dismissing: boolean;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className={`flex items-center gap-2.5 py-2 ${INK[alert.severity]}`}>
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center rounded-full border border-current text-[10px] font-bold"
      >
        {MARK[alert.severity]}
      </span>

      <Link href={alert.href} className="min-w-0 flex-1 text-sm hover:underline">
        <span className="sr-only">{alert.severity}: </span>
        <span className="sms-body">{alert.title}</span>
      </Link>

      <code className="hidden shrink-0 text-[11px] opacity-40 sm:block">{alert.type}</code>

      {alert.dismissible ? (
        dismissing ? (
          <Loader size={16} variant="arrows" label={`Dismissing ${alert.title}`} />
        ) : (
          <button
            type="button"
            onClick={() => onDismiss(alert.id)}
            aria-label={`Dismiss: ${alert.title}`}
            className="-mr-1 shrink-0 rounded-lg px-2 py-1 text-lg leading-none opacity-50 hover:opacity-100"
          >
            ×
          </button>
        )
      ) : (
        /* Computed at read time, so there is nothing to write `dismissed_at`
           to — and dismissing it would be a lie: it reappears on the next
           render because the condition is still true. */
        <span className="shrink-0 pr-1 text-[11px] opacity-40">clears itself</span>
      )}
    </div>
  );
}

export function AlertList({ alerts }: { alerts: AlertView[] }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const open = alerts.filter((a) => !dismissed.includes(a.id));

  // Optimistic, and the row leaves immediately: a row that sits there for a
  // round trip after being dismissed reads as a button that does not work, and
  // the retry writes the same row. `dismissAlert` is guarded on
  // `dismissed_at IS NULL`, so a double tap cannot overwrite the moment it was
  // first dismissed.
  const dismiss = (id: string) => {
    setPendingId(id);
    startTransition(async () => {
      await dismissAlert(id);
      setDismissed((d) => [...d, id]);
      setPendingId(null);
    });
  };

  return (
    <section className="mt-10" aria-labelledby="alerts-heading">
      <h2 id="alerts-heading" className="text-sm font-semibold tracking-wide uppercase opacity-70">
        Alerts
      </h2>
      <p className="mt-1 text-xs opacity-50">
        In-app only in v1 — no email, no push. Each one is a row, so a delivery channel later is a
        rendering change rather than a rewrite (§11.6).
      </p>

      {open.length === 0 ? (
        <p className="mt-3 rounded-xl border border-black/10 px-4 py-3 text-sm opacity-60 dark:border-white/15">
          Nothing open. Dismissed alerts are kept, not deleted — the record of what fired and when
          is what says whether the rule that raised it is any good.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {ORDER.map((severity) => {
            const rows = open.filter((a) => a.severity === severity);
            if (rows.length === 0) return null;

            return (
              <div key={severity} className={`rounded-xl border px-3.5 py-2 ${TONE[severity]}`}>
                <p className="mt-1 text-[11px] font-medium tracking-wide uppercase opacity-60">
                  {HEADING[severity]}
                  <span className="tabular ml-1.5 opacity-70">{rows.length}</span>
                </p>
                <div className="divide-y divide-current/10">
                  {rows.map((a) => (
                    <Row
                      key={a.id}
                      alert={a}
                      dismissing={isPending && pendingId === a.id}
                      onDismiss={dismiss}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
