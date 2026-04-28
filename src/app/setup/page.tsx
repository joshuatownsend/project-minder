"use client";

import { SetupGuide } from "@/components/SetupGuide";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function SetupPage() {
  useDocumentTitle("Setup");
  return <SetupGuide />;
}
