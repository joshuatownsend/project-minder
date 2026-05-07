import { NextRequest, NextResponse } from "next/server";
import { generateTitle, LLMError } from "@/lib/llm/autoTitle";
import { readConfig } from "@/lib/config";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const config = await readConfig();

  try {
    const { title } = await generateTitle({
      endpoint: (body?.endpoint as string | undefined) ?? config.autoTitle?.endpoint,
      model: (body?.model as string | undefined) ?? config.autoTitle?.model,
      turns: [
        { role: "user", content: "Help me build a web scraper for news articles" },
        { role: "user", content: "Add error handling for 429 rate limit responses" },
        { role: "user", content: "Write unit tests for the parser module" },
      ],
    });
    return NextResponse.json({ title });
  } catch (err) {
    if (err instanceof LLMError) {
      return NextResponse.json({ error: err.message }, { status: err.status >= 400 ? err.status : 502 });
    }
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
