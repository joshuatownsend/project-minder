"use client";

import React from "react";

import { formatCost } from "@/lib/format";
import { MIN_TASKS_FOR_RATE } from "@/lib/usage/effort";
import { ATTRIBUTION_TAIL_SHARE } from "@/lib/usage/attribution";
import type { AttributionMethod } from "@/lib/usage/attribution";
import { SampleBadge } from "@/components/stats/SampleBadge";
import type { SkillCost, McpServerCost, McpToolCost } from "@/lib/usage/types";

/**
 * Where spend actually comes from: which skills and MCP servers caused it (A4).
 *
 * This is **not** the same as how often each was called, and the difference is
 * not marginal. Measured on the index, Claude Code's own attribution accounts
 * for 11x more MCP spend than call-site inference ($2,052 vs $187) and 373x
 * more skill spend ($2,442 vs $6.54). The structural reason: the turn that
 * *issues* a tool call is tiny — often a lone `tool_use` block — while the
 * expensive turn is the next one, which pulls a large result into context and
 * reasons over it. Counting call sites finds the cheap turn and misses the
 * costly one it caused.
 *
 * A `method` badge appears whenever a list falls back to inference, because
 * the two scales are not comparable and a reader must never take one for the
 * other.
 */
export function AttributionPanel({ skills, servers, currency, fxRate }: {
  skills: SkillCost[];
  servers: McpServerCost[];
  currency: string;
  fxRate: number;
}) {
  if (skills.length === 0 && servers.length === 0) {
    return (
      <EmptyNote>
        No skill or MCP attribution in this period. Claude Code began recording
        it in ~2.1.212; sessions indexed before Minder learned to read the field
        are refreshed on the next re-index.
      </EmptyNote>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {skills.length > 0 && (
        <Section
          title="By skill"
          method={skills[0].method}
          rows={foldTail(skills, (r) => r.cost, (n, cost, turns, tokens) => ({
            skill: `${n} more skills`, cost, turns, tokens,
            verifiedTasks: 0, oneShotTasks: 0, method: skills[0].method,
          }))}
          currency={currency}
          fxRate={fxRate}
          label={(r) => r.skill}
          extra={(r) => <OneShotCell row={r} />}
        />
      )}
      {servers.length > 0 && (
        <Section
          title="By MCP server"
          method={servers[0].method}
          rows={foldTail(servers, (r) => r.cost, (n, cost, turns, tokens) => ({
            server: `${n} more servers`, key: "__other__", cost, turns, tokens,
            method: servers[0].method,
          }))}
          currency={currency}
          fxRate={fxRate}
          label={(r) => r.server}
          detail={(r) => <TopTools tools={r.tools} currency={currency} fxRate={fxRate} />}
        />
      )}
    </div>
  );
}

/**
 * Fold everything under {@link ATTRIBUTION_TAIL_SHARE} into one row.
 *
 * Attribution has a long thin tail — 26 skills and 18 servers on the reference
 * corpus, most of them fractions of a percent. Listing all of them turns a
 * chart meant to answer "what is expensive?" into an inventory that answers
 * nothing, and the tail entries are exactly the ones whose individual figures
 * are least worth trusting. The fold is shown, never silently dropped: the row
 * says how many it covers and carries their summed cost.
 */
function foldTail<T extends { cost: number; turns: number; tokens: number }>(
  rows: T[],
  cost: (r: T) => number,
  makeOther: (n: number, cost: number, turns: number, tokens: number) => T
): T[] {
  const total = rows.reduce((s, r) => s + cost(r), 0);
  if (total <= 0) return rows;
  const head = rows.filter((r) => cost(r) / total >= ATTRIBUTION_TAIL_SHARE);
  const tail = rows.filter((r) => cost(r) / total < ATTRIBUTION_TAIL_SHARE);
  if (tail.length <= 1) return rows;
  return [
    ...head,
    makeOther(
      tail.length,
      tail.reduce((s, r) => s + r.cost, 0),
      tail.reduce((s, r) => s + r.turns, 0),
      tail.reduce((s, r) => s + r.tokens, 0)
    ),
  ];
}

function Section<T extends { cost: number; turns: number }>({
  title, method, rows, currency, fxRate, label, extra, detail,
}: {
  title: string;
  method: AttributionMethod;
  rows: T[];
  currency: string;
  fxRate: number;
  label: (r: T) => string;
  extra?: (r: T) => React.ReactNode;
  /** Optional second line under a row — used for the per-tool split. */
  detail?: (r: T) => React.ReactNode;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.cost), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: "0.68rem",
          color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em",
        }}>
          {title}
        </span>
        <MethodBadge method={method} />
      </div>
      {rows.map((r, i) => (
        // Fragment per row so the optional detail line sits directly beneath
        // ITS bar. Rendering all bars and then all details — which an earlier
        // draft of this did — detaches every tool split from the server it
        // describes and silently mis-labels the whole section.
        <React.Fragment key={`${label(r)}-${i}`}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            title={label(r)}
            style={{
              fontFamily: "var(--font-mono)", fontSize: "0.7rem",
              color: "var(--text-secondary)", width: "168px", flexShrink: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {label(r)}
          </span>
          <div aria-hidden="true" style={{
            flex: 1, background: "var(--bg-elevated)",
            borderRadius: "2px", height: "10px", overflow: "hidden",
          }}>
            <div style={{
              width: "100%",
              transform: `scaleX(${max > 0 ? r.cost / max : 0})`,
              transformOrigin: "left", height: "100%",
              background: "var(--accent)", borderRadius: "2px",
              transition: "transform 0.3s ease",
            }} />
          </div>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: "0.7rem",
            color: "var(--text-primary)", width: "68px", textAlign: "right", flexShrink: 0,
          }}>
            {formatCost(r.cost, currency, fxRate)}
          </span>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: "0.62rem",
            color: "var(--text-muted)", width: "58px", textAlign: "right", flexShrink: 0,
          }}>
            {r.turns.toLocaleString()}t
          </span>
          {extra?.(r)}
        </div>
        {/* Its own row rather than nested inside the bar row, so the bar stays
            a single flex line and the tool split can wrap freely when narrow. */}
        {detail?.(r)}
        </React.Fragment>
      ))}
    </div>
  );
}

/**
 * Names the signal behind the numbers.
 *
 * Only shown for `inferred`, and that asymmetry is the point: explicit
 * attribution is the normal, correct case and needs no apology, while an
 * inferred list is an order of magnitude smaller for reasons that have nothing
 * to do with the user's actual spend. Badging the normal case too would make
 * the warning invisible by making it ubiquitous.
 */
function MethodBadge({ method }: { method: AttributionMethod }) {
  if (method === "explicit") return null;
  const title =
    "Estimated from tool call sites, not Claude Code's own attribution — " +
    "these sessions predate it. Call-site figures run far lower than true " +
    "attributed cost, so treat them as a floor, not a total.";
  return (
    <span
      title={title}
      style={{
        fontFamily: "var(--font-mono)", fontSize: "0.58rem",
        color: "var(--attention, #d97706)",
        border: "1px solid var(--attention, #d97706)",
        borderRadius: "3px", padding: "0 4px",
      }}
    >
      <span className="sr-only">{title}</span>
      <span aria-hidden="true">estimated</span>
    </span>
  );
}

/**
 * First-pass success for one skill — the A2 `task_outcome` column crossed with
 * A4 attribution, which is why that column was made turn-level rather than an
 * effort-shaped rollup.
 *
 * Reuses {@link MIN_TASKS_FOR_RATE} and the shared {@link SampleBadge} rather
 * than inventing a second threshold: on the reference corpus only `pr-resolve`
 * clears it (n=156), while `improve` shows 100% off **two** tasks. A rule that
 * suppressed thin samples on the effort panel but not here would be the same
 * mistake twice.
 */
function OneShotCell({ row }: { row: SkillCost }) {
  const measured = row.oneShotRate !== undefined;
  const tooThin = measured && row.verifiedTasks < MIN_TASKS_FOR_RATE;
  const showRate = measured && !tooThin;

  const title = !measured
    ? "No verified tasks attributed to this skill — nothing to measure, not a 0% success rate."
    : tooThin
      ? `Only ${row.verifiedTasks} verified task${row.verifiedTasks === 1 ? "" : "s"} for this skill — too few for a rate to mean anything (needs ${MIN_TASKS_FOR_RATE}). ${row.oneShotTasks} passed first time.`
      : `${row.oneShotTasks} of ${row.verifiedTasks} tasks started under this skill passed verification without a follow-up edit.`;

  return (
    <span
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "flex-end",
        gap: "5px", width: "148px", flexShrink: 0,
        fontFamily: "var(--font-mono)", fontSize: "0.66rem",
        color: showRate ? "var(--text-secondary)" : "var(--text-muted)",
      }}
    >
      <span className="sr-only">{title}</span>
      <span aria-hidden="true">
        {showRate ? `${Math.round(row.oneShotRate! * 100)}% 1-shot` : "—"}
      </span>
      {measured && (
        <span aria-hidden="true">
          <SampleBadge n={row.verifiedTasks} threshold={MIN_TASKS_FOR_RATE} />
        </span>
      )}
    </span>
  );
}

/**
 * The costliest calls inside one server.
 *
 * A server total says "Playwright cost $634"; it does not say what to do about
 * it. The split does: `browser_take_screenshot` returning an image is far more
 * expensive per call than `browser_click` returning nothing, so naming the top
 * few turns a number into a decision. Capped at three — a pointer to the
 * expensive call, not an inventory.
 */
function TopTools({ tools, currency, fxRate }: {
  tools?: McpToolCost[];
  currency: string;
  fxRate: number;
}) {
  if (!tools || tools.length === 0) return null;
  const top = tools.slice(0, 3);
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: "10px",
      padding: "0 0 2px 178px",
      fontFamily: "var(--font-mono)", fontSize: "0.58rem", color: "var(--text-muted)",
    }}>
      {top.map((t) => (
        <span key={t.tool} title={`${t.tool}: ${t.turns} turns`}>
          {t.tool} {formatCost(t.cost, currency, fxRate)}
        </span>
      ))}
      {tools.length > top.length && <span>+{tools.length - top.length} more</span>}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: "0.7rem", color: "var(--text-muted)",
      fontFamily: "var(--font-body)", lineHeight: 1.5, maxWidth: "62ch",
    }}>
      {children}
    </div>
  );
}
