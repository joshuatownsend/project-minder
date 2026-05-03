"use client";

import { ComingSoonPage } from "@/components/ComingSoonPage";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function PlansPage() {
  useDocumentTitle("Plans");
  return (
    <ComingSoonPage
      title="Plan-mode browser"
      wave={5}
      cluster="L"
      todoRefs={["#152"]}
      blurb="Catalog of plan.md files written in Claude Code's plan-mode. Each plan will surface alongside the session it came from with the same browser pattern used by /agents and /skills."
    />
  );
}
