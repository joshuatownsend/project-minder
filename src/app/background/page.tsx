"use client";

import { BackgroundActivityBrowser } from "@/components/BackgroundActivityBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Background activity");
  return (
    <div className="shell-content wide">
      <BackgroundActivityBrowser />
    </div>
  );
}
