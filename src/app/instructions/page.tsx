"use client";

import { InstructionsBrowser } from "@/components/InstructionsBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function InstructionsPage() {
  useDocumentTitle("Instructions");
  return (
    <div className="shell-content wide">
      <InstructionsBrowser />
    </div>
  );
}
