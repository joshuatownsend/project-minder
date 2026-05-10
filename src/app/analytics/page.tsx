import { ComingSoon } from "@/components/ComingSoon";

export default function AnalyticsPage() {
  return (
    <ComingSoon
      title="Analytics"
      blurb="Cross-project portfolio analytics — model distribution, cache efficiency, cost trends, session yield, hour-of-day activity. Today this lives split across Stats and Usage; Analytics will fold them into one storytelling-first dashboard."
      features={[
        "Model distribution donut + per-model cost stats",
        "Cache hit-rate efficiency trends over time",
        "Productive vs reverted vs abandoned yield breakdown",
        "Hour-of-day and day-of-week activity heatmaps",
      ]}
    />
  );
}
