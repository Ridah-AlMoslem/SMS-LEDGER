"use client";

/**
 * The dashboard banner (SPEC §11.6).
 *
 * "Alerts are in-app only in v1 — a badge and a dashboard banner." So: one
 * line, above everything, and **only when there is something**. An empty
 * banner, a placeholder, or a permanently-present "all clear" strip would cost
 * the same vertical space on the good days as on the bad ones, and the entire
 * value of a banner is that its presence is the signal.
 *
 * Several alerts collapse to the most severe one plus a count, because the fold
 * is worth more than completeness here: the pace hero and the net worth strip
 * both have to be visible without scrolling, and a stack of five banners takes
 * the screen. Tapping the count expands the rest in place.
 */

import Link from "next/link";
import { useState, useTransition } from "react";

import { dismissAlert } from "@/app/actions";
import type { AlertView, Severity } from "@/lib/alerts";
import { Loader } from "@/components/ui/loader";

const TONE: Record<Severity, string> = {
  critical:
    "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:border-rose-400/30 dark:text-rose-300",
  warning:
    "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:border-amber-400/30 dark:text-amber-400",
  info: "border-black/10 bg-black/[0.02] dark:border-white/15 dark:bg-white/[0.04]",
};

/** Severity is never carried by colour alone: each one is announced, and the
 *  glyph is a second channel for a reader who cannot separate amber from rose. */
const MARK: Record<Severity, string> = { critical: "!", warning: "!", info: "i" };

function Row({
  alert,
  onDismiss,
  pending,
}: {
  alert: AlertView;
  onDismiss: (id: string) => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center rounded-full border border-current text-[10px] font-bold"
      >
        {MARK[alert.severity]}
      </span>

      <Link href={alert.href} className="min-w-0 flex-1 py-0.5 text-sm hover:underline">
        <span className="sr-only">{alert.severity}: </span>
        <span className="sms-body">{alert.title}</span>
      </Link>

      {alert.dismissible &&
        (pending ? (
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
        ))}
    </div>
  );
}

export function AlertBanner({ alerts }: { alerts: AlertView[] }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const open = alerts.filter((a) => !dismissed.includes(a.id));
  if (open.length === 0) return null;

  // Optimistic: the row leaves immediately and the write happens behind it. A
  // banner that sits there for a round trip after being dismissed reads as a
  // dismiss button that does not work, and the retry writes the same row.
  const dismiss = (id: string) => {
    setPendingId(id);
    startTransition(async () => {
      await dismissAlert(id);
      setDismissed((d) => [...d, id]);
      setPendingId(null);
    });
  };

  const [lead, ...rest] = open;

  return (
    <section
      aria-label="Alerts"
      className={`mb-4 rounded-xl border px-3 py-2.5 ${TONE[lead.severity]}`}
    >
      <Row alert={lead} onDismiss={dismiss} pending={isPending && pendingId === lead.id} />

      {rest.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="mt-1 ml-6 text-xs underline underline-offset-2 opacity-70 hover:opacity-100"
          >
            {expanded ? "hide" : `${rest.length} more`}
          </button>

          {expanded && (
            <div className="mt-2 space-y-2 border-t border-current/15 pt-2">
              {rest.map((a) => (
                <Row
                  key={a.id}
                  alert={a}
                  onDismiss={dismiss}
                  pending={isPending && pendingId === a.id}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
