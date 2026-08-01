import { NextRequest, NextResponse } from "next/server";
import { getSessionDetail } from "@/lib/data";
import { loadExportSource, toExportMeta } from "@/lib/sessions/exportReader";
import {
  EXPORT_DETAILS,
  isExportDetail,
  renderSessionMarkdown,
  resolveExportOptions,
  type ExportOptions,
} from "@/lib/sessions/markdownExport";

/**
 * `GET /api/sessions/<id>/export`
 *
 * Renders one session as a self-contained markdown document.
 *
 * Query params:
 *   `detail`     — `minimal` | `standard` (default) | `full`
 *   `thinking`   — override the preset's extended-thinking inclusion
 *   `tools`      — override tool-call inclusion
 *   `results`    — override tool-result inclusion
 *   `sidechains` — override subagent-message inclusion
 *   `download`   — `1` to send `Content-Disposition: attachment`
 *   `format`     — `md` (default, `text/markdown`) or `json` (adds stats)
 *
 * Read-only, so no demo-mode write guard: in demo mode the fixture
 * session has no JSONL behind it and the export degrades to the index
 * path, which is exactly the behaviour a pruned real session gets.
 */

/** Tri-state: absent means "leave the detail preset alone". */
function boolParam(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

/**
 * Reduce to characters that are safe in a `Content-Disposition` header.
 * `projectSlug` is scanner-derived rather than user-typed, but a filename
 * flows straight into a response header, and a CR/LF there is a response-
 * splitting bug — so this allowlists rather than escapes.
 */
function safeFilenamePart(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-{2,}/g, "-");
  const trimmed = cleaned.replace(/^[-.]+|[-.]+$/g, "");
  return trimmed.slice(0, 60) || fallback;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const search = request.nextUrl.searchParams;

  const detailParam = search.get("detail");
  if (detailParam !== null && !isExportDetail(detailParam)) {
    return NextResponse.json(
      { error: `Invalid detail. Must be one of: ${EXPORT_DETAILS.join(", ")}` },
      { status: 400 },
    );
  }

  const format = search.get("format") ?? "md";
  if (format !== "md" && format !== "json") {
    return NextResponse.json({ error: "Invalid format. Must be 'md' or 'json'." }, { status: 400 });
  }

  const { detail } = await getSessionDetail(sessionId);
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Sidechains have to be resolved BEFORE the read: modern subagent
  // transcripts live in sibling files, so whether to open them is a decision
  // for the reader, not a filter the renderer can apply after the fact.
  const resolved = resolveExportOptions({
    detail: detailParam ?? undefined,
    sidechains: boolParam(search.get("sidechains")),
  });

  const source = await loadExportSource(detail.sessionId, detail, {
    sidechains: resolved.sidechains,
  });
  const options: ExportOptions = {
    detail: detailParam ?? undefined,
    thinking: boolParam(search.get("thinking")),
    toolCalls: boolParam(search.get("tools")),
    toolResults: boolParam(search.get("results")),
    sidechains: boolParam(search.get("sidechains")),
    exportedAt: new Date().toISOString(),
    messagesUnread: source.unread,
  };

  const { markdown, stats } = renderSessionMarkdown(
    toExportMeta(detail, source.fidelity),
    source.messages,
    options,
  );

  if (format === "json") {
    return NextResponse.json({
      sessionId: detail.sessionId,
      markdown,
      stats,
      fidelity: source.fidelity,
      degradedReason: source.degradedReason ?? null,
    });
  }

  const filename = `session-${safeFilenamePart(detail.projectSlug, "export")}-${safeFilenamePart(
    detail.sessionId.slice(0, 8),
    "session",
  )}.md`;

  return new NextResponse(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `${
        boolParam(search.get("download")) ? "attachment" : "inline"
      }; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Export-Fidelity": source.fidelity,
    },
  });
}
