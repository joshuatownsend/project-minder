import { z } from "zod";
import type { ProjectStatus } from "@/lib/types";

// Shared Zod fragments used across multiple tool definitions. Defined as
// `ZodRawShape` fragments rather than full schemas so they compose naturally
// inside `registerTool({ inputSchema: { ... } })` calls (the SDK expects the
// shape object, not a `z.object(...)` wrapper).

export const SlugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9-]+$/, "must be lowercase alphanumeric + hyphens")
  .describe("Project slug, e.g. 'project-minder' or 'crew-leader'");

export const SessionIdSchema = z
  .string()
  .min(1)
  .max(120)
  .describe("Claude Code session UUID or human-readable slug");

// Canonical period vocabulary used across the whole app (src/lib/usage/constants.ts).
// Same vocabulary for usage, OTEL, and agent/skill toggles — keeps the surface
// uniform so the model doesn't have to remember which tool uses which dialect.
// 'all' is the only choice without a default because semantics vary by tool.
export const UsagePeriodSchema = z
  .enum(["24h", "today", "7d", "30d", "all"])
  .default("7d")
  .describe("Time window: 24h (rolling), today (calendar), 7d, 30d, or all-time");

export const OtelPeriodSchema = z
  .enum(["today", "7d", "30d", "all"])
  .default("7d")
  .describe("OTEL time window: today, 7d, 30d, or all-time");

export const AgentUsagePeriodSchema = z
  .enum(["today", "7d", "30d", "all"])
  .default("all")
  .describe("Time window for agent/skill usage stats");

export const CatalogSourceSchema = z
  .enum(["user", "plugin", "project"])
  .describe("Where the agent/skill is installed: user-global, via a plugin, or project-local");

// Bound to `ProjectStatus` in @/lib/types via a `satisfies` check — if the
// canonical union ever grows or shrinks, TypeScript fails this file rather
// than silently letting the schema and the type drift apart.
export const ProjectStatusSchema = z
  .enum(["active", "paused", "archived"] as const satisfies readonly ProjectStatus[])
  .describe("Project status (matches .minder.json statuses)");
