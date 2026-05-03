"use client";

import { ComingSoonPage } from "@/components/ComingSoonPage";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function PluginsPage() {
  useDocumentTitle("Plugins");
  return (
    <ComingSoonPage
      title="Plugins browser"
      wave={5}
      cluster="L"
      todoRefs={["#156"]}
      blurb="Every installed plugin with per-capability invocation counts and per-plugin detail pages. Walks ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ for full attribution."
    />
  );
}
