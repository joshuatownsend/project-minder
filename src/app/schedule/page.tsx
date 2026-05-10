import { ComingSoon } from "@/components/ComingSoon";

export default function SchedulePage() {
  return (
    <ComingSoon
      title="Schedule"
      blurb="Cron materializer, visual schedule editor, and the dispatcher loop that turns scheduled task definitions into running sessions. Coming in Wave 9.1b. Schedules can already be created via /api/schedules and will surface on the Tasks page."
      features={[
        "Visual cron expression editor",
        "Per-schedule run history with success/failure timeline",
        "Pause / resume / one-shot run controls",
        "Conflict detection (overlapping runs, dependency cycles)",
      ]}
    />
  );
}
