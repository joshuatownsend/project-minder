import { NextRequest } from "next/server";
import { loadInstructions } from "@/lib/indexer/instructions";
import { jsonWithCacheControl } from "@/lib/httpCache";

// GET /api/instructions — harness-native instruction catalog (Codex rules/
// AGENTS.md/prompts today, gated by enabledAdapters). Optional filters:
//   ?harness=codex|gemini|claude   ?source=user|plugin|project   ?q=<search>
export async function GET(request: NextRequest) {
  const harness = request.nextUrl.searchParams.get("harness");
  const source = request.nextUrl.searchParams.get("source");
  const query = request.nextUrl.searchParams.get("q")?.toLowerCase();

  let result = await loadInstructions();

  if (harness) result = result.filter((e) => e.harness === harness);
  if (source) result = result.filter((e) => e.source === source);
  if (query) {
    result = result.filter((e) =>
      [e.name, e.description, e.category, e.harness]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }

  return jsonWithCacheControl(result);
}
