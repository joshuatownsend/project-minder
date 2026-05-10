"use client";

import { InsightsBrowser } from "@/components/InsightsBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Insights");
  return (
    <div className="shell-content wide">
      <InsightsBrowser />
    </div>
  );
}
