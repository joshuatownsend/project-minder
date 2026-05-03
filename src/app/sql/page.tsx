"use client";

import { ComingSoonPage } from "@/components/ComingSoonPage";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function SqlPage() {
  useDocumentTitle("SQL");
  return (
    <ComingSoonPage
      title="SQL query interface"
      wave={5}
      cluster="L"
      todoRefs={["#237"]}
      blurb="Power-user SELECT-only interface against the SQLite session DB. Sortable result table, CSV export, EXPLAIN-validated queries with regex pre-checks for safety."
    />
  );
}
