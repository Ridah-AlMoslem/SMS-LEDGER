/**
 * One number, with what it means and — where it matters — what it is measured
 * against.
 *
 * `hint` is not decoration. §11.2: "60% spent, 40% through the cycle" is the
 * number that changes behaviour, and neither half means much alone.
 */

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "positive" | "negative" | "warn";
  className?: string;
}) {
  const tones = {
    default: "",
    positive: "text-emerald-600 dark:text-emerald-400",
    negative: "text-rose-600 dark:text-rose-400",
    warn: "text-amber-600 dark:text-amber-400",
  };

  return (
    <div
      className={`rounded-xl bg-black/[0.03] p-3.5 dark:bg-white/[0.06] ${className}`.trim()}
    >
      <p className="text-xs tracking-wide opacity-60">{label}</p>
      <p className={`mt-1 text-xl leading-tight font-semibold ${tones[tone]}`}>{value}</p>
      {hint && <p className="mt-1 text-xs opacity-55">{hint}</p>}
    </div>
  );
}
