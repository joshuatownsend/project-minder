// Re-export appendInsights from insightsMd so external callers (e.g. scripts/import-insights.ts)
// don't need to change their import path.
export { appendInsights } from "./scanner/insightsMd";
