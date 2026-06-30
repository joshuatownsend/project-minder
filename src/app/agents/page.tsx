import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { AgentsBrowser } from "@/components/AgentsBrowser";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchAgents } from "@/lib/server/queries/agents";

// Reads the live agent catalog + usage per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agents — Project Minder" };

export default async function AgentsPage() {
  const state = await maybeDehydrate([prefetchAgents]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <AgentsBrowser />
      </div>
    </HydrationBoundary>
  );
}
