"use client";

import { ConfigBrowser } from "@/components/ConfigBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function ConfigPage() {
  useDocumentTitle("Config");
  return <ConfigBrowser />;
}
