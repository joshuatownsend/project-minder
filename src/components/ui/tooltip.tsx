"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  tooltipAbove,
  tooltipLeft,
  VIEWPORT_MARGIN,
} from "@/lib/ui/tooltipPosition";

/**
 * A tooltip that three audiences can actually reach (#391).
 *
 * `title` is a mouse-only affordance. #380 established that, and #390 answered
 * it with `.sr-only` + `aria-hidden`, which reaches SCREEN READERS and leaves
 * the other two audiences #380 named exactly where they were:
 *
 *  - **sighted keyboard users** — `.sr-only` is visually clipped, and `title`
 *    still does not appear on focus in any major browser;
 *  - **touch users** — no hover, and nothing to tap.
 *
 * So the explanation stayed unreachable for anyone sighted and not using a
 * mouse. The case that made this worth fixing is `GitStatus`'s **"status
 * unavailable"** chip: it sits exactly where `N uncommitted` would, so a reader
 * who cannot reach the tooltip sees no dirty count and concludes the repo is
 * clean. The failure state is indistinguishable from success.
 *
 * ## What this does differently
 *
 * The explanation lives in ONE element, always in the DOM, referenced by
 * `aria-describedby`. Hiding it with `visibility`/`opacity` rather than
 * unmounting it is what lets a single element serve all three audiences — a
 * screen reader reads it through the association whether or not it is visible,
 * so the `.sr-only` duplicate is no longer needed and cannot drift from the
 * `title` it was copied from.
 *
 * Opens on **hover, focus and tap**. Closes on leave, blur, Escape, and a click
 * elsewhere. The trigger is focusable, which is what makes the keyboard path
 * exist at all.
 *
 * ## What it deliberately is not
 *
 * Not a portal, and not a floating-ui dependency. It positions itself with a
 * `position: fixed` layer and the arithmetic in `lib/ui/tooltipPosition` —
 * enough for a chip in a dense row, and unit-testable in a repo whose test
 * environment is `node` with no DOM.
 */
export function Tooltip({
  content,
  children,
  className,
}: {
  /** The explanation. This is the accessible description — keep it a sentence. */
  content: React.ReactNode;
  /** The visible trigger. */
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!trigger || !tip) return;
    const above = tooltipAbove(trigger, tip.height);
    setPos({
      left: tooltipLeft(trigger, tip.width, window.innerWidth),
      top: above
        ? trigger.top - tip.height - VIEWPORT_MARGIN
        : trigger.bottom + VIEWPORT_MARGIN,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // Escape closes, and so does a click anywhere else — the two dismissals a
    // tap-opened tooltip needs, since there is no "leave" on touch.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!triggerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Reposition rather than close: a tooltip that vanishes when the page
    // scrolls under a stationary pointer reads as a glitch.
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  return (
    <span
      ref={triggerRef}
      className={className}
      tabIndex={0}
      aria-describedby={id}
      style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen((v) => !v)}
    >
      {children}
      <span
        ref={tipRef}
        id={id}
        role="tooltip"
        // Always rendered. `aria-describedby` reaches it whether or not it is
        // visible, which is what removes the need for a second `.sr-only` copy
        // of the same sentence.
        style={{
          position: "fixed",
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          zIndex: 60,
          maxWidth: "min(320px, calc(100vw - 16px))",
          padding: "6px 8px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border-subtle)",
          background: "var(--bg-elevated, var(--bg-surface))",
          color: "var(--text-primary)",
          fontSize: "0.72rem",
          lineHeight: 1.5,
          fontWeight: 400,
          textAlign: "left",
          whiteSpace: "normal",
          pointerEvents: "none",
          boxShadow: "0 4px 16px rgba(0,0,0,.35)",
          visibility: open && pos ? "visible" : "hidden",
          opacity: open && pos ? 1 : 0,
          transition: "opacity .12s ease",
        }}
      >
        {content}
      </span>
    </span>
  );
}
