import { ComingSoon } from "@/components/ComingSoon";

export default function HealthPage() {
  return (
    <ComingSoon
      title="Health"
      blurb="Configuration health audits across all your projects: secret leaks, runaway sessions, malformed YAML frontmatter, stale dependencies, security warnings — surfaced as a prioritized worklist with one-click jumps to the offending file."
      features={[
        "Composite health score with category breakdown",
        "Severity-tiered issues: errors → warnings → info",
        "Cross-project deduplication so the same issue isn't surfaced 12 times",
        "Auto-fix for common issues (rotate keys, normalize frontmatter, etc.)",
      ]}
    />
  );
}
