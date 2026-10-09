import { NextResponse } from "next/server";
import { generateTitle, LLMError } from "@/lib/llm/autoTitle";
import { readConfig } from "@/lib/config";

// Tests the SAVED configuration only. The request body is deliberately ignored: this route attaches
// the stored API key, so a caller-chosen endpoint (even an HTTPS one) would be a way to send the key
// to a host of their choosing (#630). The Settings UI saves first and posts with no body.
export async function POST() {
  const config = await readConfig();
  try {
    const { title } = await generateTitle({
      endpoint: config.autoTitle?.endpoint,
      model: config.autoTitle?.model,
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
