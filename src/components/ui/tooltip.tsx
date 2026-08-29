"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
 * ## Why it portals
 *
 * A transformed ancestor establishes the containing block for a
 * `position: fixed` descendant — so inside the sessions browser's virtual rows,
 * which are positioned with `translateY(...)`, the row's offset was applied a
 * SECOND time to coordinates that were already viewport-relative. The tooltip
 * landed far from its trigger, or was clipped by the scrolling container. That
 * is the primary context these chips render in, so "not a portal" was a wrong
 * call rather than a simplifying one (Codex P1, PR #519).
 *
 * It renders into `document.body` after mount, which restores the meaning of
 * the `getBoundingClientRect()` coordinates `place()` computes. `aria-describedby`
 * is unaffected: it resolves by id across the whole document, not by ancestry.
 *
 * Still no floating-ui dependency — the arithmetic is in
 * `lib/ui/tooltipPosition`, which is unit-testable in a repo whose test
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
  // THREE independent inputs, not one boolean. A single `open` let one
  // modality cancel another: in a hybrid keyboard/mouse session, tabbing to a
  // trigger opened it and then moving a pointer that happened to be resting
  // over the chip closed it again — and `onBlur` hid a tooltip the pointer was
  // still hovering. Each input owns its own flag and the tooltip is open while
  // ANY of them holds. (Codex P2, PR #519.)
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  /** Set by a tap or Enter/Space; dismissed by Escape or an outside pointer. */
  const [pinned, setPinned] = useState(false);
  const open = hovered || focused || pinned;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  // The portal target only exists in the browser. Rendering the tip inline on
  // the server keeps it in the SSR markup, so the description is present
  // before hydration rather than appearing late.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
      // Escape releases the pin AND the focus-hold: a keyboard user pressing it
      // expects the tooltip gone, not to have to move focus as well.
      if (e.key === "Escape") {
        setPinned(false);
        setFocused(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      // `pointerdown`, so a PointerEvent — and `e.target` can be null or a
      // non-Node (a shadow root retarget), which `contains` would throw on.
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (!triggerRef.current?.contains(target)) setPinned(false);
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

  const tip = (
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
  );

  return (
    <span
      ref={triggerRef}
      className={className}
      tabIndex={0}
      aria-describedby={id}
      style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onKeyDown={(e) => {
        // The trigger is focusable, so it needs the activation keys a
        // focusable thing is expected to answer — and Escape here as well as
        // on `window`, so a keyboard user can dismiss without moving focus.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setPinned(true);
        } else if (e.key === "Escape") {
          setPinned(false);
          setFocused(false);
        }
      }}
      onBlur={() => setFocused(false)}
      onClick={(e) => {
        // **Stop the event.** Every migrated chip lives inside a `<Link>` —
        // `QualityChip` and `EffortMixChip` inside `SessionRow`'s, the compact
        // Git status inside `ProjectCard`'s — so without this a tap navigates
        // away and unmounts the tooltip instead of showing it. The touch path
        // would have been unusable in exactly the contexts that ship.
        // (Codex P1, PR #519.)
        e.preventDefault();
        e.stopPropagation();
        // OPEN, never toggle. A tap fires focus and mouse-compatibility events
        // before its click on many browsers, so `open` is already true by the
        // time this runs and a toggle would close it again — a tap that ends
        // with the tooltip hidden. Dismissal is Escape or an outside tap, both
        // of which work on touch. (Codex P2.)
        setPinned(true);
      }}
    >
      {children}
      {mounted ? createPortal(tip, document.body) : tip}
    </span>
  );
}

