"use client";

import { Suspense } from "react";
import { ConfigBrowser } from "@/components/ConfigBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function ConfigPage() {
  useDocumentTitle("Config");
  // ConfigBrowser uses useSearchParams() to seed the active tab from `?type=`
  // and the project filter from `?project=` (the dashboard CI badge deep-links
  // here). useSearchParams forces a Suspense boundary in Next.js 16 prerender.
  return (
    <Suspense fallback={null}>
      <ConfigBrowser />
    </Suspense>
  );
}
