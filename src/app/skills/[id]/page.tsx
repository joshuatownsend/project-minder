"use client";

import { use } from "react";
import { SkillDetailView } from "@/components/SkillDetailView";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

// See `src/app/agents/[id]/page.tsx` for the rationale — same Next.js 16
// dynamic-param encoding issue (#165). Decode at the page boundary so
// `SkillDetailView` receives the canonical catalog id with literal colons.
function safeDecode(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export default function SkillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const raw = use(params).id;
  const id = safeDecode(raw);
  useDocumentTitle(`Skill · ${id}`);
  return (
    <div className="shell-content wide">
      <SkillDetailView id={id} />
    </div>
  );
}
