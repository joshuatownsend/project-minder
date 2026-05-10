"use client";

import { HooksBrowser } from "@/components/HooksBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Hooks");
  return (
    <div className="shell-content wide">
      <HooksBrowser />
    </div>
  );
}
