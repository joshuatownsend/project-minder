import { cn } from "@/lib/utils";
import { LOADING_ATTR } from "./loading";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // `data-loading` before the spread, so a caller can still override it —
      // a skeleton used as a static placeholder rather than a loading state
      // should be able to say so. See `LOADING_ATTR` for why the marker is an
      // attribute and not this component's class (#445).
      {...LOADING_ATTR}
      className={cn("animate-pulse rounded-md bg-[var(--muted)]", className)}
      {...props}
    />
  );
}

export { Skeleton };
