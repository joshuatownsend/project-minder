export const BUGGY_VERSION_RANGE = { start: "2.1.69", end: "2.1.89" } as const;

function parseSemver(v: string): [number, number, number] | null {
  const parts = v.split(".");
  if (parts.length < 2) return null;
  const nums = [
    parseInt(parts[0], 10),
    parseInt(parts[1], 10),
    parseInt(parts[2] ?? "0", 10),
  ];
  if (nums.some(isNaN)) return null;
  return nums as [number, number, number];
}

function semverLte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return true;
}

export function isBuggyVersion(v?: string): boolean {
  if (!v) return false;
  const parsed = parseSemver(v);
  if (!parsed) return false;
  const start = parseSemver(BUGGY_VERSION_RANGE.start)!;
  const end = parseSemver(BUGGY_VERSION_RANGE.end)!;
  return semverLte(start, parsed) && semverLte(parsed, end);
}
