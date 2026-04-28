"use client";

import { SessionsBrowser } from "@/components/SessionsBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function SessionsPage() {
  useDocumentTitle("Sessions");
  return <SessionsBrowser />;
}
