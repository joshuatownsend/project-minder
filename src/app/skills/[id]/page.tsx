"use client";

import { use } from "react";
import { SkillDetailView } from "@/components/SkillDetailView";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function SkillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  useDocumentTitle(`Skill · ${id}`);
  return (
    <div className="shell-content wide">
      <SkillDetailView id={id} />
    </div>
  );
}
