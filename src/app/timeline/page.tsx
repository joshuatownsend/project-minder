import { ComingSoon } from "@/components/ComingSoon";

export default function TimelinePage() {
  return (
    <ComingSoon
      title="Timeline"
      blurb="A unified, time-based view of everything that happened across all your projects today — sessions, commits, manual steps completed, plans executed, insights logged. The shape of your day at a glance."
      features={[
        "Chronological feed across every project",
        "Filter by event type (session, commit, plan, manual step)",
        "Jump to the source artifact for any entry",
        "Daily / weekly / monthly aggregations",
      ]}
    />
  );
}
