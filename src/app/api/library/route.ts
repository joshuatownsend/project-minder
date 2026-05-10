import { NextResponse } from "next/server";
import { LIBRARY, STACK_PRESETS } from "@/lib/template/library";

export type LibraryIndexItem = {
  id: string;
  kind: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  stacks: string[];
};

export type LibraryResponse = {
  items: LibraryIndexItem[];
  stackPresets: Record<string, string[]>;
};

export async function GET() {
  const items: LibraryIndexItem[] = LIBRARY.map(({ id, kind, slug, name, description, tags, stacks }) => ({
    id,
    kind,
    slug,
    name,
    description,
    tags,
    stacks,
  }));
  return NextResponse.json({ items, stackPresets: STACK_PRESETS } satisfies LibraryResponse);
}
