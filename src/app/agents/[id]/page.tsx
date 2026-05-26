"use client";

import { use } from "react";
import { AgentDetailView } from "@/components/AgentDetailView";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

// Next.js 16 returns dynamic route `params.id` URL-encoded — for an agent
// id like `agent:plugin:foo:bar` the `:` characters arrive as `%3A`.
// AgentDetailView calls `encodeURIComponent(id)` when building its fetch URL,
// which then double-encodes to `%253A` and produces a 404 (issue #165).
// Decode at the page boundary so the rest of the pipeline can treat `id`
// as the canonical (decoded) catalog identifier.
function safeDecode(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export default function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const raw = use(params).id;
  const id = safeDecode(raw);
  useDocumentTitle(`Agent · ${id}`);
  return (
    <div className="shell-content wide">
      <AgentDetailView id={id} />
    </div>
  );
}
