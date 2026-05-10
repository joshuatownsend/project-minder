"use client";

import { SetupGuide } from "@/components/SetupGuide";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Setup");
  return (
    <div className="shell-content wide">
      <SetupGuide />
    </div>
  );
}
