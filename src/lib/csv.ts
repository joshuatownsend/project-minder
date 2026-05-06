/** Escape a single value per RFC-4180. */
export function escapeCell(val: unknown): string {
  const str = val === null || val === undefined ? "" : String(val);
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Build an RFC-4180 CSV string (CRLF line endings, header row first). */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines: string[] = [columns.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(row[col])).join(","));
  }
  return lines.join("\r\n");
}
