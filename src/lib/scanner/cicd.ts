import { promises as fs } from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  CiCdInfo,
  DependabotUpdate,
  HostingTarget,
  VercelCron,
  Workflow,
  WorkflowJob,
} from "../types";
import { tryParseJsonc } from "./util/jsonc";

/**
 * Scan CI/CD-related config across the project.
 *
 * Parsing depth follows the "per-unit, semantic" rule from the design plan:
 * each row should be a unit a future template-builder could pick up and
 * drop into another project (a job, a cron, an ecosystem update block).
 */
export async function scanCiCd(
  projectPath: string
): Promise<CiCdInfo | undefined> {
  const [workflows, dependabot, vercel, hostingOthers, dockerfile] =
    await Promise.all([
      scanWorkflows(projectPath),
      scanDependabot(projectPath),
      scanVercel(projectPath),
      scanOtherHosting(projectPath),
      scanDockerfile(projectPath),
    ]);

  const hosting: HostingTarget[] = [
    ...vercel.hosting,
    ...hostingOthers,
    ...(dockerfile ? [dockerfile] : []),
  ];

  const empty =
    workflows.length === 0 &&
    dependabot.length === 0 &&
    hosting.length === 0 &&
    vercel.crons.length === 0;

  if (empty) return undefined;

  return {
    workflows,
    hosting,
    vercelCrons: vercel.crons,
    dependabot,
  };
}

// ─── GitHub Actions workflows ────────────────────────────────────────────────

async function scanWorkflows(projectPath: string): Promise<Workflow[]> {
  const dir = path.join(projectPath, ".github", "workflows");

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files = entries.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const workflows = await Promise.all(
    files.map(async (file): Promise<Workflow> => {
      const filePath = path.join(dir, file);
      const raw = await tryRead(filePath);
      if (raw === null) {
        return { file: filePath, triggers: [], cron: [], jobs: [], parseOk: false };
      }
      return parseWorkflow(raw, filePath);
    })
  );

  workflows.sort((a, b) => a.file.localeCompare(b.file));
  return workflows;
}

export function parseWorkflow(raw: string, filePath: string): Workflow {
  let doc: unknown;
  try {
    doc = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
  } catch {
    return { file: filePath, triggers: [], cron: [], jobs: [], parseOk: false };
  }
  if (!doc || typeof doc !== "object") {
    return { file: filePath, triggers: [], cron: [], jobs: [], parseOk: false };
  }

  // js-yaml parses `on:` as the boolean `true` (YAML 1.1 quirk). Look it up
  // by both the key name and that quirk.
  const docObj = doc as Record<string, unknown> & { true?: unknown };
  const onValue = docObj.on ?? docObj.true;
  const { triggers, cron } = normalizeTriggers(onValue);

  const name = typeof docObj.name === "string" ? docObj.name : undefined;
  const jobs = parseJobs(docObj.jobs);

  return { file: filePath, name, triggers, cron, jobs, parseOk: true };
}

function normalizeTriggers(on: unknown): { triggers: string[]; cron: string[] } {
  const triggers: string[] = [];
  const cron: string[] = [];

  if (typeof on === "string") {
    triggers.push(on);
  } else if (Array.isArray(on)) {
    for (const t of on) {
      if (typeof t === "string") triggers.push(t);
    }
  } else if (on && typeof on === "object") {
    for (const [key, val] of Object.entries(on as Record<string, unknown>)) {
      triggers.push(key);
      if (key === "schedule" && Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === "object") {
            const c = (item as { cron?: unknown }).cron;
            if (typeof c === "string") cron.push(c);
          }
        }
      }
    }
  }

  return { triggers: Array.from(new Set(triggers)), cron };
}

function parseJobs(value: unknown): WorkflowJob[] {
  if (!value || typeof value !== "object") return [];
  const out: WorkflowJob[] = [];

  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const job = raw as {
      name?: unknown;
      "runs-on"?: unknown;
      runs_on?: unknown;
      uses?: unknown;
      steps?: unknown;
    };

    const runsOn = pickRunsOn(job["runs-on"] ?? job.runs_on);
    const actionUses = collectActionUses(job.steps);

    out.push({
      id,
      name: typeof job.name === "string" ? job.name : undefined,
      runsOn,
      uses: typeof job.uses === "string" ? job.uses : undefined,
      actionUses,
    });
  }

  return out;
}

function pickRunsOn(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string").join(", ") || undefined;
  }
  return undefined;
}

function collectActionUses(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const seen = new Set<string>();
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const uses = (s as { uses?: unknown }).uses;
    if (typeof uses === "string" && uses.length > 0) seen.add(uses);
  }
  return Array.from(seen);
}

// ─── Dependabot ──────────────────────────────────────────────────────────────

async function scanDependabot(projectPath: string): Promise<DependabotUpdate[]> {
  for (const candidate of [".github/dependabot.yml", ".github/dependabot.yaml"]) {
    const filePath = path.join(projectPath, candidate);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return parseDependabot(raw, filePath);
    } catch {
      // Try next candidate.
    }
  }
  return [];
}

export function parseDependabot(raw: string, filePath: string): DependabotUpdate[] {
  let doc: unknown;
  try {
    doc = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
  } catch {
    return [];
  }
  const updates = (doc as { updates?: unknown })?.updates;
  if (!Array.isArray(updates)) return [];

  const out: DependabotUpdate[] = [];
  for (const u of updates) {
    if (!u || typeof u !== "object") continue;
    const entry = u as {
      "package-ecosystem"?: unknown;
      directory?: unknown;
      schedule?: unknown;
    };
    const ecosystem = entry["package-ecosystem"];
    if (typeof ecosystem !== "string") continue;
    const directory = typeof entry.directory === "string" ? entry.directory : undefined;
    const interval = pickScheduleInterval(entry.schedule);
    out.push({ ecosystem, directory, schedule: interval, sourcePath: filePath });
  }
  return out;
}

function pickScheduleInterval(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = (value as { interval?: unknown }).interval;
  return typeof v === "string" ? v : undefined;
}

// ─── Vercel ──────────────────────────────────────────────────────────────────

interface VercelScanResult {
  crons: VercelCron[];
  hosting: HostingTarget[];
}

async function scanVercel(projectPath: string): Promise<VercelScanResult> {
  const jsonPath = path.join(projectPath, "vercel.json");
  const tsPath = path.join(projectPath, "vercel.ts");

  const [jsonRaw, tsRaw] = await Promise.all([tryRead(jsonPath), tryRead(tsPath)]);
  const result: VercelScanResult = { crons: [], hosting: [] };

  if (jsonRaw !== null) {
    const doc = tryParseJsonc<{
      crons?: unknown;
      framework?: unknown;
      buildCommand?: unknown;
    }>(jsonRaw);
    if (doc) {
      const crons = parseVercelCrons(doc.crons, jsonPath);
      result.crons.push(...crons);

      const detail: Record<string, string | number | boolean | string[]> = {};
      if (typeof doc.framework === "string") detail.framework = doc.framework;
      if (typeof doc.buildCommand === "string") detail.buildCommand = doc.buildCommand;
      if (crons.length > 0) detail.crons = crons.length;

      result.hosting.push({
        platform: "vercel",
        sourcePath: jsonPath,
        detail: Object.keys(detail).length > 0 ? detail : undefined,
      });
    }
  }

  if (tsRaw !== null && !result.hosting.some((h) => h.platform === "vercel")) {
    result.hosting.push({ platform: "vercel", sourcePath: tsPath });
  }

  return result;
}

function parseVercelCrons(value: unknown, sourcePath: string): VercelCron[] {
  if (!Array.isArray(value)) return [];
  const out: VercelCron[] = [];
  for (const c of value) {
    if (!c || typeof c !== "object") continue;
    const entry = c as { path?: unknown; schedule?: unknown };
    if (typeof entry.path !== "string" || typeof entry.schedule !== "string") continue;
    out.push({ path: entry.path, schedule: entry.schedule, sourcePath });
  }
  return out;
}

// ─── Other hosting targets ───────────────────────────────────────────────────

async function scanOtherHosting(projectPath: string): Promise<HostingTarget[]> {
  const railwayTomlPath = path.join(projectPath, "railway.toml");
  const railwayJsonPath = path.join(projectPath, "railway.json");
  const flyPath         = path.join(projectPath, "fly.toml");
  const renderPath      = path.join(projectPath, "render.yaml");
  const netlifyPath     = path.join(projectPath, "netlify.toml");
  const procfilePath    = path.join(projectPath, "Procfile");
  const appJsonPath     = path.join(projectPath, "app.json");

  const [railwayToml, railwayJson, fly, render, netlify, procfile, appJson] = await Promise.all([
    tryRead(railwayTomlPath),
    tryRead(railwayJsonPath),
    tryRead(flyPath),
    tryRead(renderPath),
    tryRead(netlifyPath),
    tryRead(procfilePath),
    tryRead(appJsonPath),
  ]);

  const out: HostingTarget[] = [];

  if (railwayToml !== null) {
    out.push({
      platform: "railway",
      sourcePath: railwayTomlPath,
      detail: parseTomlScalars(railwayToml, ["app", "name"]),
    });
  } else if (railwayJson !== null) {
    out.push({
      platform: "railway",
      sourcePath: railwayJsonPath,
      detail: parseJsonScalars(railwayJson, ["name", "build", "deploy"]),
    });
  }

  if (fly !== null) {
    out.push({
      platform: "fly",
      sourcePath: flyPath,
      detail: parseTomlScalars(fly, ["app", "primary_region"]),
    });
  }

  if (render !== null) {
    out.push({
      platform: "render",
      sourcePath: renderPath,
      detail: parseRenderDetail(render),
    });
  }

  if (netlify !== null) {
    out.push({
      platform: "netlify",
      sourcePath: netlifyPath,
      detail: parseNetlifyDetail(netlify),
    });
  }

  if (procfile !== null || appJson !== null) {
    const detail: Record<string, string | number | boolean | string[]> = {};
    if (procfile !== null) {
      detail.processes = parseProcfile(procfile);
    }
    if (appJson !== null) {
      const doc = tryParseJsonc<{ name?: unknown; description?: unknown }>(appJson);
      if (typeof doc?.name === "string") detail.name = doc.name;
      if (typeof doc?.description === "string") detail.description = doc.description;
    }
    out.push({
      platform: "heroku",
      sourcePath: procfile !== null ? procfilePath : appJsonPath,
      detail: Object.keys(detail).length > 0 ? detail : undefined,
    });
  }

  return out;
}

function parseTomlScalars(
  raw: string,
  keys: string[]
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[.+\]\s*$/.test(line)) break;
    for (const k of keys) {
      const matched = line.match(new RegExp(`^\\s*${escapeRegex(k)}\\s*=\\s*"([^"]*)"`));
      if (matched) out[k] = matched[1];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseJsonScalars(
  raw: string,
  keys: string[]
): Record<string, string | number | boolean | string[]> | undefined {
  const doc = tryParseJsonc<Record<string, unknown>>(raw);
  if (!doc) return undefined;
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const k of keys) {
    const v = doc[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseRenderDetail(
  raw: string
): Record<string, string | number | boolean | string[]> | undefined {
  let doc: { services?: Array<{ name?: unknown }> };
  try {
    doc = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA }) as typeof doc;
  } catch {
    return undefined;
  }
  const services = Array.isArray(doc?.services) ? doc.services : [];
  const names: string[] = [];
  for (const s of services) {
    if (s && typeof s.name === "string") names.push(s.name);
  }
  return names.length > 0 ? { services: names } : undefined;
}

function parseNetlifyDetail(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let inBuild = false;

  for (const line of raw.split(/\r?\n/)) {
    const sect = line.match(/^\s*\[(.+)\]\s*$/);
    if (sect) {
      inBuild = sect[1].trim() === "build";
      continue;
    }
    if (!inBuild) continue;

    const cmd = line.match(/^\s*command\s*=\s*"([^"]*)"/);
    const pub = line.match(/^\s*publish\s*=\s*"([^"]*)"/);
    if (cmd) out.command = cmd[1];
    if (pub) out.publish = pub[1];
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseProcfile(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*\S/);
    if (m) out.push(m[1]);
  }
  return out;
}

// ─── Dockerfile ──────────────────────────────────────────────────────────────

async function scanDockerfile(projectPath: string): Promise<HostingTarget | null> {
  const filePath = path.join(projectPath, "Dockerfile");
  const raw = await tryRead(filePath);
  if (raw === null) return null;
  const baseImage = parseFirstFrom(raw);
  return {
    platform: "docker",
    sourcePath: filePath,
    detail: baseImage ? { baseImage } : undefined,
  };
}

function parseFirstFrom(raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^FROM\s+(\S+)/i);
    if (m) return m[1];
  }
  return undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read a file as utf-8, returning `null` on any error (ENOENT, permissions, etc). */
async function tryRead(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
