"use client";

import { PluginsBrowser } from "@/components/PluginsBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function PluginsPage() {
  useDocumentTitle("Plugins");
  return <PluginsBrowser />;
}
