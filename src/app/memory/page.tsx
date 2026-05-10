import { ComingSoon } from "@/components/ComingSoon";

export default function MemoryPage() {
  return (
    <ComingSoon
      title="Memory"
      blurb="A cross-project view of every memory file Claude is reading and writing — your CLAUDE.md hierarchy, .memory/ entries, and per-session memory state. Designed to make it obvious when context is missing or when an update never propagated to the project files Claude actually loads."
      features={[
        "All CLAUDE.md files across project, user, and plugin scopes",
        "Stale-memory detection: entries that contradict current code",
        "Quick edits without leaving the dashboard",
        "Diff view for memory changes between sessions",
      ]}
    />
  );
}
