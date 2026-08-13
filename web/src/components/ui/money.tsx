/**
 * An amount, in SAR.
 *
 * Every figure in this app goes through here so that column alignment, the
 * minus sign and the sign convention are decided once. The `.tabular` class
 * from globals.css does the real work: fixed-width digits, and an isolated
 * LTR run so an amount sitting next to an Arabic merchant name cannot be
 * reordered by the bidi algorithm.
 *
 * U+2212 MINUS SIGN, not a hyphen — it aligns with the digit width, which a
 * hyphen does not, and a column of amounts where the minus is a different
 * width is visibly ragged.
 */

const FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export type MoneyProps = {
  /** Numeric or the NUMERIC string Postgres returns. Signed. */
  value: number | string;
  /**
   * `auto` shows − on negatives only (the default: a ledger of expenses does
   * not need a plus on every row). `always` shows both, for figures where the
   * direction is the information — a net contribution that can go either way.
   * `never` prints the magnitude, for when direction is carried by a label.
   */
  sign?: "auto" | "always" | "never";
  /** Colour by sign. Off by default; a spending list is not red. */
  tone?: "auto" | "none";
  /** Append "SAR". For headline figures, not list rows — repeating the
   *  currency down a column is noise in a single-currency ledger. */
  currency?: boolean;
  className?: string;
};

export function Money({
  value,
  sign = "auto",
  tone = "none",
  currency = false,
  className = "",
}: MoneyProps) {
  const n = typeof value === "string" ? Number(value) : value;

  if (!Number.isFinite(n)) {
    return <span className={`tabular opacity-40 ${className}`}>—</span>;
  }

  const negative = n < 0;
  const prefix = sign === "never" ? "" : negative ? "−" : sign === "always" ? "+" : "";

  const toned =
    tone === "auto"
      ? negative
        ? "text-rose-600 dark:text-rose-400"
        : n > 0
          ? "text-emerald-600 dark:text-emerald-400"
          : "opacity-50"
      : "";

  return (
    <span className={`tabular ${toned} ${className}`.trim()}>
      {prefix}
      {FORMAT.format(Math.abs(n))}
      {currency && <span className="ml-1 text-[0.8em] opacity-60">SAR</span>}
    </span>
  );
}
