import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getCachedScan } from "@/lib/cache";
import { scanTodoMd } from "@/lib/scanner/todoMd";
import { scanManualStepsMd } from "@/lib/scanner/manualStepsMd";
import { scanInsightsMd, parseInsightsMd, appendInsights } from "@/lib/scanner/insightsMd";
import { appendTodosToFile } from "@/lib/todoWriter";
import { diffTodos, diffManualSteps, diffInsights } from "@/lib/worktreeSync";
import { ManualStepEntry } from "@/lib/types";

function entryToMarkdown(entry: ManualStepEntry): string {
  const steps = entry.steps
    .map((step) => {
      const checkbox = step.completed ? "- [x]" : "- [ ]";
      const details = step.details.map((d) => `  ${d}`).join("\n");
      return details ? `${checkbox} ${step.text}\n${details}` : `${checkbox} ${step.text}`;
    })
    .join("\n");
  return `## ${entry.date} | ${entry.featureSlug} | ${entry.title}\n\n${steps}\n\n---\n`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = (await req.json()) as { worktreePath: string; file: "todos" | "manual-steps" | "insights" };
  const scan = getCachedScan();
  if (!scan) return NextResponse.json({ error: "Scan cache not ready" }, { status: 503 });
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const wt = project.worktrees?.find((w) => w.worktreePath === body.worktreePath);
  if (!wt) return NextResponse.json({ error: "Worktree not found" }, { status: 404 });

  if (body.file === "todos") {
    const [parentInfo, worktreeInfo] = await Promise.all([
      scanTodoMd(project.path),
      scanTodoMd(body.worktreePath),
    ]);
    const newTexts = diffTodos(parentInfo?.items ?? [], worktreeInfo?.items ?? []);
    if (newTexts.length === 0) return NextResponse.json({ synced: 0 });
    await appendTodosToFile(project.path, newTexts);
    return NextResponse.json({ synced: newTexts.length });
  }

  if (body.file === "manual-steps") {
    const [parentInfo, worktreeInfo] = await Promise.all([
      scanManualStepsMd(project.path),
      scanManualStepsMd(body.worktreePath),
    ]);
    const newEntries = diffManualSteps(parentInfo?.entries ?? [], worktreeInfo?.entries ?? []);
    if (newEntries.length === 0) return NextResponse.json({ synced: 0 });
    const filePath = path.join(project.path, "MANUAL_STEPS.md");
    let existing = "";
    try {
      existing = await fs.readFile(filePath, "utf-8");
    } catch {
      /* new file */
    }
    const sep = existing.trimEnd() ? "\n\n" : "";
    await fs.writeFile(
      filePath,
      existing.trimEnd() + sep + newEntries.map(entryToMarkdown).join("\n"),
      "utf-8"
    );
    return NextResponse.json({ synced: newEntries.length });
  }

  if (body.file === "insights") {
    const worktreeInfo = await scanInsightsMd(body.worktreePath);
    if (!worktreeInfo || worktreeInfo.entries.length === 0) return NextResponse.json({ synced: 0 });
    let parentContent = "";
    try {
      parentContent = await fs.readFile(path.join(project.path, "INSIGHTS.md"), "utf-8");
    } catch {
      /* new file */
    }
    const { knownIds } = parseInsightsMd(parentContent);
    const newEntries = diffInsights(knownIds, worktreeInfo.entries);
    if (newEntries.length === 0) return NextResponse.json({ synced: 0 });
    await appendInsights(project.path, newEntries);
    return NextResponse.json({ synced: newEntries.length });
  }

  return NextResponse.json({ error: "Unknown file type" }, { status: 400 });
}
