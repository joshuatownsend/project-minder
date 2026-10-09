/**
 * Escape a single value per RFC-4180, and defuse spreadsheet formulas (#641): a TEXT value that begins
 * with `=`, `+`, `-`, `@`, TAB or CR is evaluated by Excel/Sheets/LibreOffice when the file is opened,
 * and these values come from repositories, sessions, tools and providers. Such text gets a leading
 * apostrophe. Real numbers (a negative one starts with `-`) are not text and are left alone.
 */
export function escapeCell(val: unknown): string {
  let str = val === null || val === undefined ? "" : String(val);
  if (typeof val === "string" && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
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
