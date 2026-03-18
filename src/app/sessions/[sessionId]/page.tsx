"use client";

import { use } from "react";
import { SessionDetailView } from "@/components/SessionDetailView";

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  return <SessionDetailView sessionId={sessionId} />;
}
