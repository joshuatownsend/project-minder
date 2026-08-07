import type { Metadata } from "next";
import { WorkflowsBrowser } from "@/components/WorkflowsBrowser";

// Walks the session directories per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Workflows — Project Minder" };

export default function WorkflowsPage() {
  return (
    <div className="shell-content wide">
      <WorkflowsBrowser />
    </div>
  );
}
