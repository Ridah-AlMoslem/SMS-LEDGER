/**
 * Nothing here — and why.
 *
 * An empty ledger is ambiguous in a way an empty inbox is not: it means either
 * "no spending" or "ingestion is broken". Every empty state in this app says
 * which, and offers the next action where there is one, because a dashboard
 * that renders a blank card when its pipeline has died is worse than one that
 * renders an error.
 */

export function EmptyState({
  title,
  body,
  action,
  className = "",
}: {
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-black/10 p-8 text-center dark:border-white/15 ${className}`.trim()}
    >
      <p className="font-medium">{title}</p>
      {body && <p className="mx-auto mt-2 max-w-sm text-sm opacity-70">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
