"use client";

import { HooksBrowser } from "@/components/HooksBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function HooksPage() {
  useDocumentTitle("Hooks");
  return <HooksBrowser />;
}
