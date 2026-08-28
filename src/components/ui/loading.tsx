import { cn } from "@/lib/utils";

/**
 * The marker every loading state carries, whatever it looks like (#445).
 *
 * The app had three unrelated loading idioms and no shared marker between
 * them: `<Skeleton>` (detectable via `.animate-pulse`), a plain "Loading…"
 * sentence, and bespoke inline-styled placeholder boxes. Nothing outside a
 * component could answer "is this view still loading?".
 *
 * That is not only an inconsistency. The screenshot pipeline gates on
 * `.animate-pulse` before shooting, so it was blind to the other two — and
 * published `status.png` as four empty grey bars, `config.png` with every tab
 * count reading `0`, and four more shots mid-load, all live on the public
 * landing page until someone noticed by eye.
 *
 * `data-loading` is the answer to that question. Query `[data-loading]`, not a
 * class name, not a string: a class is an implementation detail of one idiom
 * and the string varies (`Loading…` vs `Loading...`).
 */
export const LOADING_ATTR = { "data-loading": "true" } as const;

/**
 * A loading sentence — the second idiom, given the marker and one spelling.
 *
 * Prefer `<Skeleton>` where the shape of the eventual content is known: it
 * says something about what is coming, and it animates, so a stalled fetch is
 * distinguishable from a slow one. Use this where it is not.
 */
export function Loading({
  label = "Loading…",
  className,
  style,
}: {
  /** Override only when the wait has a specific subject worth naming. */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      {...LOADING_ATTR}
      role="status"
      aria-live="polite"
      className={cn("text-sm text-[var(--text-muted)]", className)}
      style={style}
    >
      {label}
    </div>
  );
}
