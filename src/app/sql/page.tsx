"use client";

import { SqlBrowser } from "@/components/SqlBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function SqlPage() {
  useDocumentTitle("SQL");
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <SqlBrowser />
    </div>
  );
}
