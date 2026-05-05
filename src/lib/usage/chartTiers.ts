export function computeActivityTiers(flatValues: number[]): number[] {
  const nonZero = flatValues.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return [0, 0, 0, 0, 0];
  const q = (p: number) => nonZero[Math.floor(p * (nonZero.length - 1))];
  return [q(0.2), q(0.4), q(0.6), q(0.8), nonZero[nonZero.length - 1]];
}

export function tierColor(turns: number, tiers: number[]): string {
  if (turns === 0) return "var(--bg-elevated)";
  if (turns <= tiers[0]) return "color-mix(in oklch, var(--accent) 30%, transparent)";
  if (turns <= tiers[1]) return "color-mix(in oklch, var(--accent) 50%, transparent)";
  if (turns <= tiers[2]) return "color-mix(in oklch, var(--accent) 65%, transparent)";
  if (turns <= tiers[3]) return "color-mix(in oklch, var(--accent) 80%, transparent)";
  return "var(--accent)";
}
