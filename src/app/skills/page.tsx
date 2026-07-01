import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { SkillsBrowser } from "@/components/SkillsBrowser";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchSkills } from "@/lib/server/queries/skills";

// Reads the live skill catalog + usage per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Skills — Project Minder" };

export default async function SkillsPage() {
  const state = await maybeDehydrate([prefetchSkills]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <SkillsBrowser />
      </div>
    </HydrationBoundary>
  );
}
