export type ModelFamily = "opus" | "sonnet" | "haiku" | "other";

export function modelFamily(model: string | undefined | null): ModelFamily {
  if (!model) return "other";
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return "other";
}

/** Strip `claude-` prefix and trailing `-YYYYMMDD` build tag. */
export function shortModelName(model: string | undefined | null): string {
  if (!model) return "unknown";
  let s = model.replace(/^claude-/i, "");
  s = s.replace(/-\d{8}$/, "");
  return s;
}
