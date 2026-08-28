/**
 * Where a tooltip sits relative to its trigger.
 *
 * Pure, and separate from the component, because this repo has no
 * component-render harness — no jsdom, no testing-library, `environment: node`.
 * The interaction wiring is therefore asserted at source level (as
 * `a11yTooltips` already does), and the arithmetic that can actually be wrong
 * is unit-tested here instead of being trusted.
 */

/** Minimum gap between the tooltip and the viewport edge. */
export const VIEWPORT_MARGIN = 8;

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

/**
 * The tooltip's `left`, in viewport coordinates: centred on the trigger, then
 * clamped so it cannot hang off either edge.
 *
 * Clamping rather than flipping. A tooltip that jumps to the other side of its
 * trigger near an edge moves under the pointer that summoned it, which is the
 * one thing a hover-triggered element must not do; sliding along the axis keeps
 * it adjacent and stable.
 *
 * A tooltip WIDER than the viewport pins to the left margin instead of going
 * negative — the text then wraps, which is the readable failure.
 */
export function tooltipLeft(
  trigger: Rect,
  tooltipWidth: number,
  viewportWidth: number,
  margin: number = VIEWPORT_MARGIN
): number {
  const centred = trigger.left + trigger.width / 2 - tooltipWidth / 2;
  const max = viewportWidth - tooltipWidth - margin;
  if (max < margin) return margin;
  return Math.min(Math.max(centred, margin), max);
}

/**
 * Whether the tooltip should render ABOVE its trigger.
 *
 * Above by default — it is where a reader looks, and it does not cover the row
 * beneath. Below only when there is genuinely no room above, which is the case
 * a fixed choice gets wrong for anything near the top of the page.
 */
export function tooltipAbove(
  trigger: Rect,
  tooltipHeight: number,
  margin: number = VIEWPORT_MARGIN
): boolean {
  return trigger.top - tooltipHeight - margin >= 0;
}
