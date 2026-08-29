"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tooltipLeft, tooltipTop } from "@/lib/ui/tooltipPosition";

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

  /**
   * Escape means gone — so it clears ALL THREE holds, `hovered` included.
   *
   * Splitting one boolean into three (Codex P2, round 4) made Escape a partial
   * dismissal: it released the pin and the focus but not the hover, so a
   * mouse-and-keyboard user resting the pointer on a trigger pressed Escape and
   * the tooltip stayed exactly where it was. The documented dismissal silently
   * required moving the pointer as well. (Codex P2, round 5.)
   *
   * Clearing `hovered` under a stationary pointer is safe rather than sticky:
   * no `mouseenter` is owed until the pointer leaves and returns, which is
   * precisely the gesture that should bring the tooltip back.
   */
  /**
   * How long the hover hold survives the pointer leaving the trigger.
   *
   * Placement leaves an 8px gap, and the tooltip is PORTALED, so moving toward
   * it fires `mouseleave` on the trigger while the pointer is still in the gap.
   * With the hold released immediately the tooltip hides and flips to
   * `pointerEvents: "none"` before the pointer can arrive — so its own
   * `onMouseEnter` never fires and its scrollbar is unreachable by ordinary
   * slow movement (Codex P2, PR #519).
   *
   * A delay rather than a wider hit area or a zero gap: the gap exists so the
   * tooltip does not sit under the pointer that summoned it, and 120ms is long
   * enough to cross 8px while still reading as immediate when the pointer is
   * genuinely leaving.
   */
  const HOVER_EXIT_MS = 120;
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * A pointer is currently down INSIDE the tooltip.
   *
   * Blur releases the pin (a keyboard user tabbing away expects the tooltip
   * gone) — but a touch that lands on the portaled tooltip also blurs the
   * trigger, and on touch the pin is the ONLY hold. So the gesture meant to
   * scroll the tooltip dismissed it instead, which is the same defect the
   * outside-pointerdown check just fixed, arriving through the other handler
   * (Codex P2, PR #519).
   *
   * A ref rather than state: it is read inside an event handler and must never
   * schedule a render of its own — a re-render between the pointerdown and the
   * blur is exactly the race this exists to avoid.
   */
  const pointerInsideTip = useRef(false);

  const cancelHoverExit = useCallback(() => {
    if (exitTimer.current !== null) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
  }, []);

  const enterHover = useCallback(() => {
    cancelHoverExit();
    setHovered(true);
  }, [cancelHoverExit]);

  const beginHoverExit = useCallback(() => {
    cancelHoverExit();
    exitTimer.current = setTimeout(() => setHovered(false), HOVER_EXIT_MS);
  }, [cancelHoverExit]);

  const dismiss = useCallback(() => {
    cancelHoverExit();
    setHovered(false);
    setFocused(false);
    setPinned(false);
  }, [cancelHoverExit]);

  // A pending exit must not outlive the component, or it fires setState on an
  // unmounted tree — and worse, keeps a stale closure alive for as long as the
  // timer runs.
  useEffect(() => cancelHoverExit, [cancelHoverExit]);
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
    setPos({
      left: tooltipLeft(trigger, tip.width, window.innerWidth),
      // Both axes clamped by the pure module. The vertical side-choice AND its
      // clamp live in `tooltipTop` rather than being spelled out here, because
      // spelling it out here is how the below case shipped unclamped.
      top: tooltipTop(trigger, tip.height, window.innerHeight),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // Escape closes, and so does a click anywhere else — the two dismissals a
    // tap-opened tooltip needs, since there is no "leave" on touch.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const onDown = (e: PointerEvent) => {
      // `pointerdown`, so a PointerEvent — and `e.target` can be null or a
      // non-Node (a shadow root retarget), which `contains` would throw on.
      const target = e.target;
      if (!(target instanceof Node)) return;
      // The TOOLTIP counts as inside, not just the trigger. It is portaled into
      // `document.body`, so a touch drag started on its scrollbar fails a
      // trigger-only containment test and clears the pin — dismissing the
      // tooltip on the very gesture meant to scroll it, and on touch there is
      // no hover hold left to keep it open (Codex P2, PR #519).
      const insideTrigger = triggerRef.current?.contains(target) ?? false;
      const insideTip = tipRef.current?.contains(target) ?? false;
      pointerInsideTip.current = insideTip;
      if (!insideTrigger && !insideTip) setPinned(false);
    };
    // Reposition rather than close: a tooltip that vanishes when the page
    // scrolls under a stationary pointer reads as a glitch.
    // Released on pointerUP wherever it happens, including outside the
    // tooltip — a drag that starts on the tip and ends elsewhere must not leave
    // the flag stuck true, or the next blur would silently keep the pin.
    const onUp = () => {
      pointerInsideTip.current = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place, dismiss]);

  const tip = (
  <span
    ref={tipRef}
    // Hovering the TOOLTIP counts as hovering, so moving the pointer onto it to
    // scroll or read does not dismiss it. Without this the portal makes the
    // trigger fire `mouseleave` the moment the pointer crosses onto the tip,
    // and a scrollable tooltip could never actually be scrolled.
    onMouseEnter={enterHover}
    onMouseLeave={beginHoverExit}
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
      // Bounded on BOTH axes, and scrollable when it hits the bound. Clamping
      // the position alone is not enough: a tooltip taller than the viewport
      // pins to the top margin and the remainder simply runs off the bottom,
      // unreadable by exactly the keyboard and touch users this primitive
      // exists for (Codex P2, PR #519). Under browser zoom or a short landscape
      // viewport that is an ordinary case, not a pathological one.
      maxHeight: "calc(100vh - 16px)",
      overflowY: "auto",
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
      // Interactive WHILE OPEN, inert otherwise. A bounded, scrollable tooltip
      // that cannot be pointed at is not readable — `pointerEvents: "none"`
      // would leave the overflow above unreachable by mouse and by touch, which
      // is the half of the fix that matters. Inert when closed so an invisible
      // element never swallows a click on the row beneath it.
      pointerEvents: open ? "auto" : "none",
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
      onMouseEnter={enterHover}
      onMouseLeave={beginHoverExit}
      onFocus={() => setFocused(true)}
      onKeyDown={(e) => {
        // The trigger is focusable, so it needs the activation keys a
        // focusable thing is expected to answer — and Escape here as well as
        // on `window`, so a keyboard user can dismiss without moving focus.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setPinned(true);
          return;
        }
        if (e.key === "Escape") {
          dismiss();
          return;
        }
        // SCROLL THE TOOLTIP, without moving focus into it.
        //
        // On a zoomed or short viewport the tooltip hits its height bound and
        // scrolls — which a mouse can reach and a keyboard could not: arrow and
        // PageDown scrolled the PAGE, and the clipped remainder of the
        // explanation was unreachable for exactly the audience this component
        // exists for (Codex P2, PR #519).
        //
        // Scrolling from the trigger rather than making the tip focusable. A
        // focusable portaled tip means focus leaving the trigger, which fires
        // `blur` and releases the focus hold before the tip's own focus
        // arrives — a race that closes the tooltip around the keystroke meant
        // to read it. Keeping focus put has no such gap.
        const tipEl = tipRef.current;
        if (!open || !tipEl) return;
        // Only when it ACTUALLY overflows. Otherwise a focused chip would
        // swallow the page's own scroll keys, which is a regression for every
        // tooltip that fits — the common case.
        if (tipEl.scrollHeight <= tipEl.clientHeight) return;
        const step =
          e.key === "ArrowDown" ? 40
          : e.key === "ArrowUp" ? -40
          : e.key === "PageDown" ? tipEl.clientHeight - 16
          : e.key === "PageUp" ? -(tipEl.clientHeight - 16)
          : e.key === "Home" ? -tipEl.scrollHeight
          : e.key === "End" ? tipEl.scrollHeight
          : 0;
        if (step === 0) return;
        e.preventDefault();
        tipEl.scrollTop += step;
      }}
      // Blur clears the PIN as well as the focus-hold. Enter/Space pins on top
      // of the focus that is already holding the tooltip open, so releasing
      // only `focused` here left the tooltip visible indefinitely after the
      // user tabbed away — and activating several chips in turn left a trail of
      // them overlapping on screen. (Codex P2, round 6.)
      //
      // Safe for touch, which is what the pin exists for: a tap focuses the
      // trigger, so tapping elsewhere blurs it, and the outside-pointerdown
      // handler clears the pin independently for any browser where it does not.
      onBlur={(e) => {
        setFocused(false);
        // Keep the pin when focus is leaving BECAUSE of the tooltip. Two ways
        // to tell, because neither covers both input modes: `relatedTarget` is
        // the element receiving focus and is reliable for a click, but is
        // frequently null on touch — where the pointer flag is what knows.
        const to = e.relatedTarget as Node | null;
        const focusMovedIntoTip = to !== null && (tipRef.current?.contains(to) ?? false);
        if (!focusMovedIntoTip && !pointerInsideTip.current) setPinned(false);
      }}
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

