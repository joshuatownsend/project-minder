"use client";

import { PluginsBrowser } from "@/components/PluginsBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Plugins");
  return (
    <div className="shell-content wide">
      <PluginsBrowser />
    </div>
  );
}
