"use client";

import { SkillsBrowser } from "@/components/SkillsBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function SkillsPage() {
  useDocumentTitle("Skills");
  return <SkillsBrowser />;
}
