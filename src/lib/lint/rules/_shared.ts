/** Groups an array of entries by a string key derived from each entry. */
export function groupByKey<T>(entries: T[], getKey: (e: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const e of entries) {
    const k = getKey(e);
    const bucket = map.get(k) ?? [];
    bucket.push(e);
    map.set(k, bucket);
  }
  return map;
}
