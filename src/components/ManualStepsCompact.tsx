import { ManualStepsInfo } from "@/lib/types";
import { ClipboardList } from "lucide-react";

export function ManualStepsCompact({ manualSteps }: { manualSteps: ManualStepsInfo }) {
  if (manualSteps.pendingSteps === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-amber-400">
      <ClipboardList className="h-3 w-3" />
      <span>
        {manualSteps.pendingSteps} step{manualSteps.pendingSteps !== 1 ? "s" : ""} pending
      </span>
    </div>
  );
}
