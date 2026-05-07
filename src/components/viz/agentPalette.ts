// Shared 8-color agent palette and depth-color stops for all D3 viz.
// Colors are CSS variable references so they respond to theme changes.

export const AGENT_COLORS = [
  "var(--accent)",
  "var(--info)",
  "var(--status-active-text)",
  "var(--status-error-text)",
  "var(--accent-strong)",
  "var(--info-strong)",
  "var(--status-warn-text)",
  "var(--text-secondary)",
];

export function agentColor(agentName: string | undefined, index: number): string {
  if (!agentName) return "var(--text-secondary)";
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

// Red → purple gradient stops for hierarchy depth (depth 0 = red, depth 6 = purple)
export const DEPTH_COLORS = [
  "var(--status-error-text)",   // depth 0
  "#e05a44",                    // depth 1
  "#c45a9e",                    // depth 2
  "#a455c4",                    // depth 3
  "#844dd4",                    // depth 4
  "#6644e0",                    // depth 5
  "var(--info)",                // depth 6+
];

export function depthColor(depth: number): string {
  const idx = Math.min(depth, DEPTH_COLORS.length - 1);
  return DEPTH_COLORS[idx];
}

// Family colors for model delegation flow
export const MODEL_FAMILY_COLORS: Record<string, string> = {
  opus:   "var(--info-strong)",
  sonnet: "var(--accent)",
  haiku:  "var(--status-active-text)",
  other:  "var(--text-muted)",
};
