"use client";

import { BoardBrowser } from "@/components/BoardBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function BoardPage() {
  useDocumentTitle("Board");
  return (
    <div className="shell-content wide">
      <BoardBrowser />
    </div>
  );
}
