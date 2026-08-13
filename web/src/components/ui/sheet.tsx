"use client";

/**
 * A bottom sheet.
 *
 * This is a phone app, so detail views slide up from the bottom rather than
 * appearing as a centred modal: the top of a phone screen is the furthest
 * point from the thumb, and a dialog that puts its controls there is a dialog
 * you dismiss by reaching. The grab handle and the swipe-to-dismiss affordance
 * are what tell you this is a layer over the page rather than a new page.
 *
 * Deliberately not a component-library import. It is a fixed div, an overlay,
 * a transform and an Escape handler.
 */

import { useEffect, useRef } from "react";

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    // Without this the page behind scrolls under the sheet on iOS, which reads
    // as the sheet itself failing to scroll.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus in, so the sheet is reachable by keyboard and screen reader
    // rather than being a visual layer over a still-focused page.
    panel.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl
                    bg-[var(--background)] shadow-2xl outline-none transition-transform
                    duration-250 ease-out ${open ? "translate-y-0" : "translate-y-full"}`}
        // The sheet sits above the tab bar, so it owns the home-indicator gap.
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="sticky top-0 bg-[var(--background)] pt-2">
          <div className="mx-auto h-1 w-9 rounded-full bg-black/20 dark:bg-white/25" />
          {title && (
            <div className="flex items-baseline justify-between px-5 pt-3 pb-2">
              <h2 className="sms-body text-base font-semibold">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                className="-mr-2 px-2 py-1 text-sm opacity-60 hover:opacity-100"
              >
                Done
              </button>
            </div>
          )}
        </div>

        <div className="px-5 pb-2">{children}</div>
      </div>
    </div>
  );
}
