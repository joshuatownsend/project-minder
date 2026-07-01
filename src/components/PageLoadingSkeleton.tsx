import { Skeleton } from "@/components/ui/skeleton";

/**
 * Generic streaming fallback for the RSC data pages' `loading.tsx`.
 *
 * Next.js renders a route's `loading.tsx` while its async RSC awaits the
 * server-side prefetch, so the user sees this skeleton immediately instead of a
 * blank frame. Kept deliberately generic — a title, a toolbar row, and a column
 * of rows reads correctly for both the list pages (sessions, agents, …) and the
 * dashboard pages (stats, usage). Each route's `loading.tsx` is a one-liner that
 * just passes its title.
 */
export function PageLoadingSkeleton({
  title,
  rows = 8,
}: {
  title: string;
  rows?: number;
}) {
  return (
    <div className="shell-content wide">
      <div className="space-y-6">
        {/* Page heading */}
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <Skeleton className="h-4 w-64" />
        </div>

        {/* Toolbar: search + filters */}
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 flex-1 max-w-sm" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
        </div>

        {/* Content rows */}
        <div className="space-y-3">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
