/**
 * A trend, at the size of a word.
 *
 * Inline SVG rather than recharts: a sparkline has no axes, no legend, no
 * tooltip and no interaction, so a charting library here buys nothing and
 * costs a client boundary on what is otherwise a server-rendered row. recharts
 * earns its place on the full charts (§11.1); this is not one of them.
 *
 * Deliberately has no baseline at zero. A sparkline shows shape, not
 * magnitude, and the caller states the magnitude next to it.
 */

export function Sparkline({
  values,
  width = 72,
  height = 20,
  className = "",
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Screen-reader description. Without one this is decorative noise. */
  label?: string;
}) {
  const points = values.filter((v) => Number.isFinite(v));

  // One point is not a trend, and drawing it as a flat line implies a history
  // that does not exist.
  if (points.length < 2) {
    return <span className={`inline-block opacity-30 ${className}`} style={{ width, height }} />;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;

  const pad = 1.5;
  const x = (i: number) => (i / (points.length - 1)) * (width - pad * 2) + pad;
  // A flat series sits on the centre line rather than collapsing onto the
  // floor, which would read as "fell to zero".
  const y = (v: number) =>
    span === 0 ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2);

  const line = points.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={`overflow-visible ${className}`.trim()}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-70"
      />
      <circle cx={x(points.length - 1)} cy={y(last)} r="1.8" fill="currentColor" />
    </svg>
  );
}
