"use client";

import { SettingsPage } from "@/components/SettingsPage";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Settings");
  return (
    <div className="shell-content wide">
      <SettingsPage />
    </div>
  );
}
