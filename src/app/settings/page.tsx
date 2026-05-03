"use client";

import { SettingsPage } from "@/components/SettingsPage";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Settings() {
  useDocumentTitle("Settings");
  return <SettingsPage />;
}
