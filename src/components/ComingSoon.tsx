"use client";

import { PageHeader } from "@/components/ui/design";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

interface ComingSoonProps {
  title: string;
  blurb: string;
  /** Optional bullet list of features the page will include when shipped. */
  features?: string[];
}

export function ComingSoon({ title, blurb, features }: ComingSoonProps) {
  useDocumentTitle(title);
  return (
    <div className="shell-content wide">
      <PageHeader title={title} sub="Coming soon" />
      <div className="scaffold-note" style={{ padding: 40, textAlign: "left", maxWidth: 720 }}>
        <p style={{ color: "var(--text-2)", marginTop: 0, fontSize: 14, lineHeight: 1.65 }}>{blurb}</p>
        {features && features.length > 0 && (
          <ul style={{ color: "var(--text-3)", fontSize: 13, lineHeight: 1.8, marginTop: 16, paddingLeft: 18 }}>
            {features.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
