import { promises as fs } from "fs";
import path from "path";
import { MinderConfig, PathMapping, ProjectData, PortConflict, ScanResult, SkippedRoot } from "../types";
import { checkWslRoot } from "../wsl";
import { mapLocalPath } from "../pathMapping";
import { normalizePathKey } from "../platform";

// Last successful per-root scan results, keyed by normalized root path.
// Lives on globalThis (mirroring the scan cache) so dev-server HMR reloads
// don't lose the carry-forward state a skipped WSL root depends on. Catalog
// walks are carried too: without them, runCatalogLint would re-walk each
// carried project path — an fs touch that defeats the never-wake guard.
interface LastGoodRootScan {
  projects: ProjectData[];
  walks: Map<string, ProjectCatalogWalk>;
}

const gScanner = globalThis as unknown as {
  __minderLastGoodRootScans?: Map<string, LastGoodRootScan>;
};

function getLastGoodRootScans(): Map<string, LastGoodRootScan> {
  gScanner.__minderLastGoodRootScans ??= new Map();
  return gScanner.__minderLastGoodRootScans;
}
import { readConfig, getDevRoots } from "../config";
import { getFlag } from "../featureFlags";
import { demoModeEnv } from "../demo/demoMode";
import { demoScanResult } from "../demo/projects";
import { scanPackageJson } from "./packageJson";
import { scanEnvFiles } from "./envFile";
import { scanDockerCompose } from "./dockerCompose";
import { scanGit } from "./git";
import { scanClaudeMd } from "./claudeMd";
import { auditClaudeMd } from "./claudeMdAudit";
import { scanTodoMd } from "./todoMd";
import { scanClaudeSessions } from "./claudeSessions";
import { encodePath, toSlug as usageToSlug } from "./claudeConversations";
import { canonicalizeDirName } from "../usage/parser";
import { resolveUsageHomeKey } from "../usage/projectMatch";
import { getClaudeHomes } from "../claudeHome";
import { scanManualStepsMd } from "./manualStepsMd";
import { scanInsightsMd } from "./insightsMd";
import { scanBoardMd } from "./boardMd";
import { scanOperationsMd } from "./operationsMd";
import { scanClaudeHooks } from "./claudeHooks";
import { scanMcpServers } from "./mcpServers";
import { scanCiCd } from "./cicd";
import { attachWorktreeOverlays } from "./worktrees";
import { countProjectCatalog } from "./projectCatalogCounts";
import { scanGsdPlanning } from "./gsdPlanning";
import { scanOutputStyles } from "./outputStyles";
import { scanLspConfig } from "./lspConfig";
import { runConfigLint } from "./configLint";
import { runCatalogLint } from "./catalogLint";
import { walkProjectAgents } from "../indexer/walkAgents";
import { walkProjectSkills } from "../indexer/walkSkills";
import { walkProjectCommands } from "../indexer/walkCommands";
import { loadProvenanceContext } from "../indexer/provenance";
import type { ProvenanceContext, SkillEntry, AgentEntry } from "../indexer/types";
import type { CommandEntry } from "../types";

/** Side-channel payload carrying the entries walkProject* already computed
 *  inside scanProject — threaded into runCatalogLint so it can skip the
 *  redundant per-project re-walks (~180 traversals on a full scan: 3 catalog subdirs × ~60 projects). */
export interface ProjectCatalogWalk {
  skills: SkillEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
}

// Neutral substitutes typed against the real scanner returns so downstream
// code reads the same shape whether the scanner ran or was gated off.
const EMPTY_CLAUDE_SESSIONS: Awaited<ReturnType<typeof scanClaudeSessions>> = {
  sessionCount: 0,
};
const EMPTY_LINT_REPORT: Awaited<ReturnType<typeof runConfigLint>> = {
  findings: [],
  countsByTarget: {},
  totalCounts: { P0: 0, P1: 0, P2: 0 },
  engineErrors: [],
  hasBlocking: false,
};
const EMPTY_DOCKER: Awaited<ReturnType<typeof scanDockerCompose>> = {
  services: [],
  ports: [],
};

/** Canonical slug derivation for project directories. Exported so the
 *  template-apply layer can synthesize matching slugs for fresh-bootstrap
 *  paths that aren't in the scan yet (otherwise the fallback could drift
 *  from the canonical form and break `?project=<slug>` filtering). */
export function toSlug(dirName: string): string {
  return dirName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** The disambiguating token taken from a scan root, used when two roots hold
 *  directories of the same name (`C:\dev\bamcli` vs `…\printing-press\library\bamcli`).
 *  Returns "" for roots with no meaningful basename (a bare drive like `C:\`),
 *  which pushes the caller onto its numeric fallback. */
export function rootSlugHint(devRoot: string): string {
  const base = devRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (/^[a-z]:$/i.test(base)) return ""; // drive root — "c" is not a useful hint
  const hint = toSlug(base);
  // toSlug can reduce a punctuation-only name to all dashes; that's no hint.
  return /[a-z0-9]/.test(hint) ? hint : "";
}

/**
 * The slug a project directory should be indexed under, given the slugs already
 * claimed by earlier roots.
 *
 * Slugs are the project's identity everywhere downstream — the `/project/[slug]`
 * route, the `.minder.json` `statuses` and `portOverrides` keys, and the
 * `?project=<slug>` filter on catalog entries — so a collision cannot be allowed
 * to stand. It previously resolved by DROPPING the later project entirely
 * (silently, save for a console warning), which meant a second scan root holding
 * a same-named repo simply had no dashboard presence.
 *
 * Disambiguation is derived from the root rather than a bare counter so the
 * result is stable and legible: `bamcli` in a root ending `…\library` becomes
 * `bamcli-library`, and stays that way across rescans. The numeric tail is only
 * reached when the root hint is unavailable or itself already taken.
 *
 * Note the ordering dependency this inherits: which project keeps the
 * undecorated slug is decided by root order in `devRoots`, so reordering roots
 * in Settings can move the suffix from one project to the other. That is a
 * strict improvement on the old behaviour (where reordering decided which
 * project existed at all), but it is not order-independent.
 */
export function resolveProjectSlug(
  dirName: string,
  devRoot: string,
  taken: ReadonlySet<string>
): string {
  const base = toSlug(dirName);
  if (!taken.has(base)) return base;

  const hint = rootSlugHint(devRoot);
  // `hint !== base` avoids the stutter of a `dev` directory inside a `dev` root.
  const prefix = hint && hint !== base ? `${base}-${hint}` : base;
  if (prefix !== base && !taken.has(prefix)) return prefix;

  // Terminates: `taken` is finite, so some n is always free.
  for (let n = 2; ; n++) {
    const candidate = `${prefix}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dirPath, ".git"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function scanProject(
  dirName: string,
  devRoot: string,
  flags: MinderConfig["featureFlags"],
  ctx: ProvenanceContext,
  pathMappings: PathMapping[] = [],
  claudeHomes: string[] = [],
  // Resolved by the caller against slugs already claimed by earlier roots. It
  // must be decided BEFORE this point: the slug is stamped onto every catalog
  // entry by the walks below, so it cannot be corrected after the fact.
  slugOverride?: string,
  // Set by callers that have already established `.git` exists. The scan loop
  // must check it early (to keep non-repo directories from consuming slugs), and
  // re-statting here would double the `.git` stats on every scan — paid per
  // project, and over the network for UNC/WSL roots.
  repoAlreadyChecked = false,
): Promise<{ project: ProjectData; catalogWalk: ProjectCatalogWalk | null } | null> {
  const projectPath = path.join(devRoot, dirName);

  if (!repoAlreadyChecked && !(await isGitRepo(projectPath))) return null;

  const slug = slugOverride ?? toSlug(dirName);
  // Usage aggregates key on the encoded-conversation-dir slug, which differs
  // from the filesystem-basename route slug above. Derive it here (server-side,
  // using the same encode→canonicalize→toSlug pipeline the usage parser uses)
  // so cost/usage views can join a scanned project to its usage data. See the
  // `usageSlug` field doc on ProjectData. mapLocalPath first: a UNC-scanned WSL
  // project's sessions were recorded (and encoded) under the distro-side Linux
  // path, so the usage slug must derive from that form, not the UNC path.
  // The encoded conversation-dir name, shared by both keys below. Kept as its
  // own value so the un-slugified form is available: it is the only one of the
  // two that uniquely identifies a project (see usageDirName's doc).
  const usageDirName = encodePath(mapLocalPath(projectPath, pathMappings));
  const usageSlug = usageToSlug(canonicalizeDirName(usageDirName));
  // Home pin for the usage/cost join (#311): set only for mapped projects
  // whose owning Claude home resolves — see resolveUsageHomeKey.
  const usageHomeKey = resolveUsageHomeKey(projectPath, pathMappings, claudeHomes);

  const claudeMdPromise = scanClaudeMd(projectPath);
  // Audit reuses the buffer scanClaudeMd already read so we don't pay
  // two readFiles per project on the parallel scan path. `null` from
  // scanClaudeMd means the file doesn't exist — pass it through so the
  // audit short-circuits without its own attempt.
  const claudeMdAuditPromise = claudeMdPromise.then((md) =>
    auditClaudeMd(projectPath, md ?? null)
  );
  // Hoist mcpServers and hooks so both the main Promise.all and the
  // config-lint chain share the same promises (no double-scan).
  const mcpServersPromise = scanMcpServers(projectPath);
  const hooksPromise = scanClaudeHooks(projectPath);
  // Hoist the three project catalog walks so both configLintPromise and the
  // side-channel catalogWalk share the same promises (no double-scan in runCatalogLint).
  const catalogLintEnabled = getFlag(flags, "configLint");
  const skillsPromise = catalogLintEnabled
    ? walkProjectSkills(projectPath, slug, ctx)
    : Promise.resolve([] as SkillEntry[]);
  const agentsPromise = catalogLintEnabled
    ? walkProjectAgents(projectPath, slug, ctx)
    : Promise.resolve([] as AgentEntry[]);
  const commandsPromise = catalogLintEnabled
    ? walkProjectCommands(projectPath, slug, ctx)
    : Promise.resolve([] as CommandEntry[]);
  // Config lint chains off audit + mcpServers + hooks + project catalog.
  const configLintPromise = catalogLintEnabled
    ? Promise.all([
        claudeMdAuditPromise,
        mcpServersPromise,
        hooksPromise,
        skillsPromise,
        agentsPromise,
        commandsPromise,
      ]).then(([audit, mcp, hooksInfo, skills, agents, commands]) =>
        runConfigLint(projectPath, {
          claudeMdAudit: audit,
          mcpServers: mcp?.servers,
          hooks: hooksInfo?.entries,
          skills,
          agents,
          commands,
        })
      )
    : Promise.resolve(EMPTY_LINT_REPORT);

  const [
    pkgResult,
    envResult,
    dockerResult,
    gitResult,
    claudeMd,
    claudeMdAudit,
    todos,
    claudeSessions,
    manualSteps,
    insights,
    board,
    operations,
    hooks,
    mcpServers,
    outputStyles,
    lspConfig,
    cicd,
    catalogCounts,
    gsdPlanning,
    configLint,
    skillsResult,
    agentsResult,
    commandsResult,
  ] = await Promise.all([
    scanPackageJson(projectPath),
    scanEnvFiles(projectPath),
    getFlag(flags, "scanDockerCompose")
      ? scanDockerCompose(projectPath)
      : Promise.resolve(EMPTY_DOCKER),
    scanGit(projectPath),
    claudeMdPromise,
    claudeMdAuditPromise,
    getFlag(flags, "scanTodos")
      ? scanTodoMd(projectPath)
      : Promise.resolve(undefined),
    getFlag(flags, "scanClaudeSessions")
      ? scanClaudeSessions(projectPath)
      : Promise.resolve(EMPTY_CLAUDE_SESSIONS),
    getFlag(flags, "scanManualSteps")
      ? scanManualStepsMd(projectPath)
      : Promise.resolve(undefined),
    getFlag(flags, "scanInsights")
      ? scanInsightsMd(projectPath, slug)
      : Promise.resolve(undefined),
    getFlag(flags, "scanBoard")
      ? scanBoardMd(projectPath)
      : Promise.resolve(undefined),
    getFlag(flags, "scanOps")
      ? scanOperationsMd(projectPath)
      : Promise.resolve(undefined),
    hooksPromise,
    mcpServersPromise,
    scanOutputStyles(projectPath),
    scanLspConfig(projectPath),
    scanCiCd(projectPath),
    countProjectCatalog(projectPath),
    getFlag(flags, "gsdPlanning")
      ? scanGsdPlanning(projectPath)
      : Promise.resolve(undefined),
    configLintPromise,
    skillsPromise,
    agentsPromise,
    commandsPromise,
  ]);

  // Determine DB port from env or docker
  let dbPort: number | undefined;
  if (envResult.database) {
    dbPort = envResult.database.port;
  }
  for (const p of dockerResult.ports) {
    if ([5432, 3306, 27017, 6379].includes(p.container)) {
      dbPort = dbPort || p.host;
    }
  }

  // Determine last activity
  const dates = [
    gitResult?.lastCommitDate,
    claudeSessions.lastSessionDate,
  ].filter(Boolean) as string[];
  const lastActivity = dates.length > 0
    ? dates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
    : undefined;

  const project: ProjectData = {
    slug,
    usageSlug,
    usageDirName,
    ...(usageHomeKey !== undefined ? { usageHomeKey } : {}),
    name: pkgResult.name || dirName,
    path: projectPath,
    status: "active", // Will be overridden from config
    framework: pkgResult.framework,
    frameworkVersion: pkgResult.frameworkVersion,
    orm: pkgResult.orm,
    styling: pkgResult.styling,
    monorepoType: pkgResult.monorepoType,
    dependencies: pkgResult.dependencies,
    devPort: pkgResult.devPort,
    dbPort,
    dockerPorts: dockerResult.ports,
    database: envResult.database,
    externalServices: envResult.externalServices,
    git: gitResult,
    claude: {
      lastSessionDate: claudeSessions.lastSessionDate,
      lastPromptPreview: claudeSessions.lastPromptPreview,
      sessionCount: claudeSessions.sessionCount,
      claudeMdSummary: claudeMd,
      mostRecentSessionStatus: claudeSessions.mostRecentSessionStatus,
      mostRecentSessionId: claudeSessions.mostRecentSessionId,
    },
    claudeMdAudit,
    todos,
    manualSteps,
    insights,
    board,
    operations,
    hooks,
    mcpServers,
    outputStyles,
    lspConfig,
    cicd,
    agentCount: catalogCounts.agentCount > 0 ? catalogCounts.agentCount : undefined,
    skillCount: catalogCounts.skillCount > 0 ? catalogCounts.skillCount : undefined,
    gsdPlanning,
    configLint: (configLint.findings.length > 0 || configLint.engineErrors.length > 0) ? configLint : undefined,
    lastActivity,
    scannedAt: new Date().toISOString(),
  };
  const catalogWalk: ProjectCatalogWalk | null = catalogLintEnabled
    ? { skills: skillsResult, agents: agentsResult, commands: commandsResult }
    : null;
  return { project, catalogWalk };
}

function detectPortConflicts(projects: ProjectData[]): PortConflict[] {
  // Keyed by SLUG, not by display name. Two checkouts of one repo under
  // different scan roots share a package name, so a name-keyed set collapsed
  // them into a single entry and emitted no conflict — losing the warning for
  // precisely the duplicated-checkout case that keeping both projects enables.
  // The value carries the name so the banner can still show something human.
  const portMap = new Map<
    number,
    { projects: Map<string, string>; type: PortConflict["type"] }
  >();

  function addPort(port: number, slug: string, projectName: string, type: PortConflict["type"]) {
    const entry = portMap.get(port) || { projects: new Map<string, string>(), type };
    entry.projects.set(slug, projectName);
    portMap.set(port, entry);
  }

  for (const project of projects) {
    if (project.devPort) addPort(project.devPort, project.slug, project.name, "dev");
    if (project.dbPort) addPort(project.dbPort, project.slug, project.name, "db");
    for (const dp of project.dockerPorts) {
      addPort(dp.host, project.slug, project.name, "docker");
    }
  }

  const conflicts: PortConflict[] = [];
  for (const [port, entry] of portMap) {
    if (entry.projects.size > 1) {
      // "bamcli, bamcli" would be a useless warning, so when two members share
      // a display name, qualify each with its (unique) slug.
      const names = [...entry.projects.values()];
      const labels = [...entry.projects].map(([slug, name]) =>
        names.filter((n) => n === name).length > 1 ? `${name} (${slug})` : name
      );
      conflicts.push({ port, projects: labels, type: entry.type });
    }
  }

  return conflicts.sort((a, b) => a.port - b.port);
}

export async function scanAllProjects(): Promise<ScanResult> {
  const config = await readConfig();
  // Demo mode short-circuits the real filesystem walk with synthetic fixtures
  // (projects + board + insights + manual-steps + ops all ride on ProjectData,
  // so this one guard lights up every scan-cache-backed surface). Checked here,
  // reusing the already-loaded config, so no extra read.
  if (demoModeEnv() || getFlag(config.featureFlags, "demoMode", false)) {
    return demoScanResult(Date.now());
  }
  const flags = config.featureFlags;
  const devRoots = getDevRoots(config);
  const BATCH_SIZE = Math.max(1, Math.round(config.scanBatchSize ?? 10));
  const hiddenSet = new Set(config.hidden.map((h) => h.toLowerCase()));
  const worktreesEnabled = getFlag(flags, "scanWorktrees");

  // Load provenance context once when configLint is enabled — only the lint
  // pipeline uses it. Use an empty stub when off so callers don't change shape.
  const ctx = getFlag(flags, "configLint")
    ? await loadProvenanceContext()
    : ({} as Awaited<ReturnType<typeof loadProvenanceContext>>);

  // Resolved once per scan for the usageHomeKey derivation (pure config +
  // homedir read — no FS probing). Defensive: an unresolvable primary home
  // (mocked or minimal test envs) degrades to no home pins, never a failed scan.
  let claudeHomes: string[] = [];
  try {
    claudeHomes = getClaudeHomes(config);
  } catch {
    claudeHomes = [];
  }

  const allProjects: ProjectData[] = [];
  // Side-channel map: path → catalog walk entries already computed by scanProject.
  // Passed to runCatalogLint so it can skip redundant per-project re-walks.
  const catalogWalkByPath = new Map<string, ProjectCatalogWalk>();
  // Slugs claimed so far. A later root colliding with an earlier one keeps its
  // project and takes a root-derived suffix (see resolveProjectSlug); only the
  // undecorated slug is first-root-wins.
  const seenSlugs = new Set<string>();
  const skippedRoots: SkippedRoot[] = [];

  // Skipping a root must not DROP its projects: the fresh result overwrites the
  // scan cache, so without a carry-forward a stopped WSL distro would erase its
  // projects from the dashboard (and break their detail routes) until the next
  // successful scan. Remember each root's last successful scan and reuse it.
  const lastGood = getLastGoodRootScans();

  const carryForwardRoot = (devRoot: string): void => {
    const carried = lastGood.get(normalizePathKey(devRoot));
    if (!carried) return; // never scanned successfully (e.g. stopped since boot)
    for (const project of carried.projects) {
      // Carried projects keep the slug they were stored under rather than being
      // re-disambiguated: their catalog walks (seeded below) were tagged with
      // that slug at scan time, and renaming here would orphan them from
      // `?project=<slug>`. A collision at this point needs an earlier root to
      // have newly acquired this exact slug while this root was unreachable —
      // rare enough to accept the drop until the root is scannable again.
      if (seenSlugs.has(project.slug)) continue;
      // Honor hides made while the root is skipped — the fresh-scan path
      // filters by directory name before scanning, so carry-forward must too.
      if (hiddenSet.has(path.basename(project.path).toLowerCase())) continue;
      seenSlugs.add(project.slug);
      // Push a CLONE: the status/port-override pass below mutates projects in
      // place, and mutating the stored copy would bake overrides in — a
      // cleared override could then never revert while the root stays skipped.
      allProjects.push(structuredClone(project));
      // Seed the walk side-channel so runCatalogLint never falls back to a
      // fresh walkProject* over this (unreachable) path — the stored walk if
      // we have one, an empty walk otherwise (stale/absent lint findings for
      // a skipped root beat waking its VM).
      catalogWalkByPath.set(
        project.path,
        carried.walks.get(project.path) ?? { skills: [], agents: [], commands: [] }
      );
    }
  };

  for (const devRoot of devRoots) {
    // WSL roots must be state-checked BEFORE any fs call: reading a
    // \\wsl.localhost\ path belonging to a stopped distro auto-starts its VM.
    const wslCheck = await checkWslRoot(devRoot);
    if (wslCheck && !wslCheck.ok) {
      skippedRoots.push({ root: devRoot, reason: wslCheck.reason, distro: wslCheck.distro });
      carryForwardRoot(devRoot);
      continue;
    }

    let entries: string[];
    try {
      const dirents = await fs.readdir(devRoot, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // Root doesn't exist or isn't readable — skip it
      skippedRoots.push({ root: devRoot, reason: "unreadable", distro: wslCheck?.distro });
      carryForwardRoot(devRoot);
      continue;
    }

    // Keep full list for worktree discovery before filtering
    const allDirNames = [...entries];

    // Filter out hidden projects
    entries = entries.filter((e) => !hiddenSet.has(e.toLowerCase()));

    // Narrow to actual projects BEFORE assigning slugs. scanProject re-checks
    // this, but doing it here keeps a non-repo directory from consuming a
    // disambiguated slug that a real project in this root wants.
    const repoFlags = await Promise.all(entries.map((e) => isGitRepo(path.join(devRoot, e))));
    entries = entries.filter((_, i) => repoFlags[i]);

    // Assign each project a slug that no earlier root has claimed.
    //
    // Sorted by codepoint rather than readdir order (and NOT via localeCompare,
    // whose collation varies with process locale and ICU data) so the numeric
    // fallback lands on the same directory on every machine, every scan.
    const ordered = [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // Two passes, because a suffix must never displace a project that had a
    // unique name of its own. With an earlier `bamcli`, a root containing BOTH
    // `bamcli` and `bamcli-library`, single-pass resolution would hand
    // `bamcli-library` to the colliding `bamcli` and then push the real
    // `bamcli-library` out to `bamcli-library-library` — moving the URL and
    // saved status/port overrides of a project that never collided with
    // anything. Reserving every natural slug in this root first makes the
    // suffix route around them instead.
    const slugByDir = new Map<string, string>();
    for (const e of ordered) {
      // Tested against the LIVE set, not a snapshot: two names in this root that
      // normalize alike are not both uncontested — the first claims the slug and
      // the second must fall through to the second pass.
      const natural = toSlug(e);
      if (seenSlugs.has(natural)) continue;
      seenSlugs.add(natural);
      slugByDir.set(e, natural);
    }
    for (const e of ordered) {
      if (slugByDir.has(e)) continue;
      const slug = resolveProjectSlug(e, devRoot, seenSlugs);
      seenSlugs.add(slug);
      slugByDir.set(e, slug);
      // Says "another root" rather than "an earlier root": this also fires for
      // two names in THIS root that normalize alike (`bam_cli` / `bam-cli`),
      // and blaming an earlier root would send anyone diagnosing that down the
      // wrong path entirely.
      console.info(
        `[scanner] Slug "${toSlug(e)}" is already claimed by another root or directory; ` +
          `"${e}" in ${devRoot} is indexed as "${slug}".`
      );
    }

    // Process in batches to avoid overwhelming the system
    const rootProjects: ProjectData[] = [];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((d) => scanProject(d, devRoot, flags, ctx, config.pathMappings ?? [], claudeHomes, slugByDir.get(d), true)));
      for (const r of results) {
        if (r) {
          rootProjects.push(r.project);
          if (r.catalogWalk) catalogWalkByPath.set(r.project.path, r.catalogWalk);
        }
      }
    }

    if (worktreesEnabled) {
      await attachWorktreeOverlays(rootProjects, allDirNames, devRoot);
    }

    const rootWalks = new Map<string, ProjectCatalogWalk>();
    for (const p of rootProjects) {
      const walk = catalogWalkByPath.get(p.path);
      if (walk) rootWalks.set(p.path, walk);
    }
    // Store CLONES: the status/port-override pass below mutates the returned
    // projects in place, and the stored copy must stay pristine (pre-override)
    // so a later carry-forward re-applies whatever overrides exist THEN.
    lastGood.set(normalizePathKey(devRoot), {
      projects: structuredClone(rootProjects),
      walks: rootWalks,
    });
    allProjects.push(...rootProjects);
  }

  // Apply saved statuses and port overrides
  for (const project of allProjects) {
    if (config.statuses[project.slug]) {
      project.status = config.statuses[project.slug];
    }
    if (config.portOverrides[project.slug] !== undefined) {
      project.devPort = config.portOverrides[project.slug];
    }
  }

  // Sort by last activity descending
  allProjects.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });

  const portConflicts = detectPortConflicts(allProjects);
  const catalogLintFindings = await runCatalogLint(allProjects, flags, ctx, catalogWalkByPath);

  return {
    projects: allProjects,
    portConflicts,
    hiddenCount: config.hidden.length,
    scannedAt: new Date().toISOString(),
    catalogLintFindings,
    ...(skippedRoots.length > 0 ? { skippedRoots } : {}),
  };
}
