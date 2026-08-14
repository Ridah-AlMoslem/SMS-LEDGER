/**
 * The waiting state, drawn from the app mark.
 *
 * The icon is a Riyal glyph flanked by two arrows — money out falling on the
 * left, money in rising on the right. The loader is that same mark with the
 * arrows travelling along their axis and fading at the ends, so a wait looks
 * like the thing the app actually does rather than like a generic spinner
 * borrowed from a component library.
 *
 * Deliberately not a client component. It is presentational SVG with CSS
 * keyframes and no hooks or handlers, so it costs nothing to render on the
 * server and can be imported from either side of the boundary.
 *
 * Geometry is shared with `brand/build-icons.py` — arrows spanning 134–378 at
 * x 84 and 428 of a 512 box — so the loader and the favicon are recognisably
 * the same object. The glyph paths come from `@/lib/brand`, which the
 * brand-sync test keeps in step with the icon build.
 *
 * Accessibility: always announced via role="status" and a visually hidden
 * label, and the travel is suppressed under `prefers-reduced-motion` by
 * globals.css, leaving the mark rendered but still. Motion is decoration here;
 * the announcement is what carries the meaning.
 */

import { BRAND, RIYAL_PATHS, RIYAL_VIEWBOX } from "@/lib/brand";

const HALF_WIDTH = 29; // arrowhead half-width
const SHAFT = 28;
const HEAD = 84;
const OVERLAP = 8; // shaft runs under the head so its rounded cap can't notch

function Arrow({
  cx,
  top,
  bottom,
  colour,
  up,
  className,
}: {
  cx: number;
  top: number;
  bottom: number;
  colour: string;
  up: boolean;
  className: string;
}) {
  const shaftY = up ? top + HEAD - OVERLAP : top;
  const tipY = up ? top : bottom;
  const baseY = up ? top + HEAD : bottom - HEAD;

  return (
    <g className={className} fill={colour}>
      <rect
        x={cx - SHAFT / 2}
        y={shaftY}
        width={SHAFT}
        height={bottom - top - HEAD + OVERLAP}
        rx={SHAFT / 2}
      />
      <path d={`M${cx},${tipY} L${cx + HALF_WIDTH},${baseY} L${cx - HALF_WIDTH},${baseY} Z`} />
    </g>
  );
}

export function Loader({
  size = 40,
  variant = "mark",
  label = "Loading",
  className = "",
}: {
  /** Rendered width and height in px. */
  size?: number;
  /**
   * `mark` is the full icon and needs roughly 32px to read. `arrows` drops the
   * glyph and closes the gap, for inline use inside buttons and table rows
   * where the glyph would only be a smudge.
   */
  variant?: "mark" | "arrows";
  /** Announced to screen readers. Say what is being waited on where you can. */
  label?: string;
  className?: string;
}) {
  const isMark = variant === "mark";

  // The compact box crops to the arrows and pulls them together; travel is
  // tuned per variant so the motion covers a similar fraction of each box.
  const box = isMark ? 512 : 244;
  const [leftX, rightX] = isMark ? [84, 428] : [62, 182];
  const [top, bottom] = isMark ? [134, 378] : [0, 244];
  const travel = isMark ? 22 : 11;

  const glyphScale = 270 / RIYAL_VIEWBOX.height;
  const glyphX = 256 - (RIYAL_VIEWBOX.width * glyphScale) / 2;
  const glyphY = 256 - 270 / 2;

  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center justify-center ${className}`.trim()}
      style={{ ["--ledger-travel" as string]: `${travel}px` }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${box} ${box}`}
        aria-hidden="true"
        focusable="false"
      >
        <Arrow
          cx={leftX}
          top={top}
          bottom={bottom}
          colour={BRAND.debit}
          up={false}
          className="ledger-loader-fall"
        />
        {isMark && (
          <g
            transform={`translate(${glyphX.toFixed(2)},${glyphY}) scale(${glyphScale.toFixed(5)})`}
            fill="currentColor"
          >
            {RIYAL_PATHS.map((d) => (
              <path key={d.slice(0, 24)} d={d} />
            ))}
          </g>
        )}
        <Arrow
          cx={rightX}
          top={top}
          bottom={bottom}
          colour={BRAND.credit}
          up
          className="ledger-loader-rise"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * A loader centred in the space a page's content would occupy.
 *
 * The min-height keeps the tab bar from jumping up the screen while a route
 * resolves and then dropping back once it renders — a nav bar that moves
 * between navigations is more distracting than the wait itself.
 */
export function PageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader size={52} label={label} />
    </div>
  );
}
