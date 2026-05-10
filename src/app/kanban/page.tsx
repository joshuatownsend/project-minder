"use client";

import { KanbanBoard } from "@/components/KanbanBoard";
import { PageHeader } from "@/components/ui/design";

export default function KanbanPage() {
  return (
    <div className="shell-content wide">
      <PageHeader title="Mission Control" sub="Kanban view of in-flight tasks across all projects" />
      <KanbanBoard />
    </div>
  );
}
