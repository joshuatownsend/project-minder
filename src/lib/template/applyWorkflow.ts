import { promises as fs } from "fs";
import path from "path";
import { ApplyResult, ConflictPolicy } from "../types";
import {
  atomicWriteFile,
  ensureDir,
  fileExists,
  previewFileWrite,
} from "./atomicFs";

interface ApplyWorkflowArgs {
  sourceProjectPath: string;
  /** Relative path under `.github/workflows/`, e.g. "ci.yml". */
  workflowKey: string;
  targetProjectPath: string;
  conflict: ConflictPolicy;
  dryRun?: boolean;
}

/**
 * Copy a single workflow file from `<source>/.github/workflows/<key>` to
 * `<target>/.github/workflows/<key>`. Workflows are file-replace only —
 * no JSON or YAML merge — so the conflict policy is just skip / overwrite /
 * rename.
 */
export async function applyWorkflow(args: ApplyWorkflowArgs): Promise<ApplyResult> {
  const { sourceProjectPath, workflowKey, targetProjectPath, conflict, dryRun } = args;

  // Reject path-traversal in the workflow key — `..` could escape the workflows
  // dir and let an attacker write into arbitrary paths under the target.
  if (workflowKey.includes("..") || path.isAbsolute(workflowKey)) {
    return errorResult(
      "INVALID_WORKFLOW_KEY",
      `Workflow key "${workflowKey}" must be a relative path inside .github/workflows/.`
    );
  }

  const sourceFile = path.join(sourceProjectPath, ".github", "workflows", workflowKey);
  if (!(await fileExists(sourceFile))) {
    return errorResult("UNIT_NOT_FOUND", `Workflow "${workflowKey}" not found in source.`);
  }

  let targetFile = path.join(targetProjectPath, ".github", "workflows", workflowKey);
  const exists = await fileExists(targetFile);
  if (exists) {
    if (conflict === "skip") {
      return { ok: true, status: "skipped", changedFiles: [] };
    }
    if (conflict === "rename") {
      targetFile = await pickRename(targetFile);
    } else if (conflict === "merge") {
      return errorResult(
        "MERGE_NOT_SUPPORTED_FOR_WORKFLOW",
        "Workflows have no internal merge semantics; use skip, overwrite, or rename."
      );
    }
    // overwrite falls through to write.
  }

  const content = await fs.readFile(sourceFile, "utf-8");

  if (dryRun) {
    return {
      ok: true,
      status: "would-apply",
      changedFiles: [targetFile],
      diffPreview: await previewFileWrite(targetFile, content),
    };
  }

  await ensureDir(path.dirname(targetFile));
  await atomicWriteFile(targetFile, content);
  return { ok: true, status: "applied", changedFiles: [targetFile] };
}

async function pickRename(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; i < 100; i++) {
    const suffix = i === 1 ? ".copy" : `.copy${i}`;
    const candidate = path.join(dir, `${base}${suffix}${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error(`Too many existing copies for ${filePath}`);
}

function errorResult(code: string, message: string): ApplyResult {
  return { ok: false, status: "error", changedFiles: [], error: { code, message } };
}
