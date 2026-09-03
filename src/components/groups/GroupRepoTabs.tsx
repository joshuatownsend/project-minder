"use client";

import { StatusChip, PriorityChip } from "@/components/BoardChips";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import type {
  AggregatedBoard,
  AggregatedBoardIssue,
  AggregatedInsights,
  AggregatedManualSteps,
  AggregatedOperations,
  AggregatedTodos,
} from "@/lib/groups/aggregate";
import { PresenceChips, type Labels } from "./PresenceChips";

/**
 * Read-only renderings of the repo-borne aggregates: TODOs, Insights, Board,
 * Manual Steps, Operations. Each merged item shows the primary location's
 * copy (the headline) plus its divergence chips.
 *
 * Deliberately NOT the per-project components (`TodoList`, `BoardTab`,
 * `ManualStepsList`, `OpsPanel`): those take `TodoInfo` / `BoardInfo` /
 * `ManualStepsInfo` / `ProjectData`, not the `Aggregated*` shapes, and their
 * writes (toggle a step, move an issue) target ONE checkout's file — there is
 * no correct answer for which copy a group-level toggle should edit, so the
 * group page links to the member page for edits instead.
 */

interface Common {
  memberSlugs: readonly string[];
  labels: Labels;
}

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "8px",
  padding: "6px 0",
  borderBottom: "1px solid var(--border-subtle)",
  fontSize: "0.8rem",
  fontFamily: "var(--font-body)",
  color: "var(--text-primary)",
};

const MUTED: React.CSSProperties = {
  fontSize: "0.68rem",
  fontFamily: "var(--font-mono)",
  color: "var(--text-muted)",
};

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        ...MUTED,
        color: checked ? "var(--status-active-text)" : "var(--text-muted)",
        width: "14px",
        flexShrink: 0,
        lineHeight: "1.4",
      }}
    >
      {checked ? "☑" : "☐"}
    </span>
  );
}

function Summary({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...MUTED, display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "10px" }}>{children}</div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: "0.7rem",
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        fontFamily: "var(--font-body)",
        margin: "16px 0 6px",
      }}
    >
      {children}
    </h3>
  );
}

export function GroupTodosTab({ todos, memberSlugs, labels }: { todos: AggregatedTodos } & Common) {
  return (
    <div>
      <Summary>
        <span>{todos.pending} pending</span>
        <span>{todos.completed} done</span>
        <span>{todos.total} total (deduplicated)</span>
      </Summary>
      {todos.items.map((item, i) => (
        <div key={`${item.text}#${i}`} style={{ ...ROW, opacity: item.completed ? 0.6 : 1 }}>
          <Checkbox checked={item.completed} />
          <span style={{ flex: 1, textDecoration: item.completed ? "line-through" : "none" }}>{item.text}</span>
          <PresenceChips
            presentIn={item.presentIn}
            completedIn={item.completedIn}
            memberSlugs={memberSlugs}
            labels={labels}
          />
        </div>
      ))}
    </div>
  );
}

export function GroupInsightsTab({ insights, memberSlugs, labels }: { insights: AggregatedInsights } & Common) {
  return (
    <div>
      <Summary>
        <span>{insights.total} entries (deduplicated by id)</span>
      </Summary>
      {insights.entries.map((e) => (
        <div key={e.id} style={{ ...ROW, flexDirection: "column", gap: "4px" }}>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={MUTED}>{e.date}</span>
            <span style={MUTED} title={e.sessionId}>
              {e.sessionId.slice(0, 8)}
            </span>
            <PresenceChips presentIn={e.presentIn} editedIn={e.editedIn} memberSlugs={memberSlugs} labels={labels} />
          </div>
          <div style={{ fontSize: "0.8rem" }}>
            <MarkdownRenderer content={e.content} />
          </div>
        </div>
      ))}
    </div>
  );
}

function IssueRow({ issue, memberSlugs, labels }: { issue: AggregatedBoardIssue } & Common) {
  return (
    <div style={ROW}>
      <StatusChip status={issue.status} />
      <span style={{ flex: 1 }}>
        {issue.title}
        {issue.detail && <div style={{ ...MUTED, marginTop: "2px" }}>{issue.detail}</div>}
      </span>
      <PriorityChip priority={issue.priority} />
      {issue.labels.map((l) => (
        <span key={l} style={MUTED}>
          #{l}
        </span>
      ))}
      <PresenceChips
        presentIn={issue.presentIn}
        statusIn={issue.statusIn}
        editedIn={issue.editedIn}
        memberSlugs={memberSlugs}
        labels={labels}
      />
    </div>
  );
}

export function GroupBoardTab({ board, memberSlugs, labels }: { board: AggregatedBoard } & Common) {
  return (
    <div>
      <Summary>
        <span>{board.total} items (deduplicated)</span>
        <span>{board.epics.length} epics</span>
        <span>{board.inbox.length} in inbox</span>
      </Summary>
      {board.inbox.length > 0 && (
        <>
          <Heading>Inbox</Heading>
          {board.inbox.map((issue) => (
            <IssueRow key={issue.id} issue={issue} memberSlugs={memberSlugs} labels={labels} />
          ))}
        </>
      )}
      {board.epics.map((epic) => (
        <div key={epic.id}>
          <Heading>
            <span style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <StatusChip status={epic.status} />
              <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-primary)", fontSize: "0.8rem" }}>
                {epic.title}
              </span>
              <PriorityChip priority={epic.priority} />
              <PresenceChips
                presentIn={epic.presentIn}
                statusIn={epic.statusIn}
                editedIn={epic.editedIn}
                memberSlugs={memberSlugs}
                labels={labels}
              />
            </span>
          </Heading>
          {epic.description && <div style={{ ...MUTED, marginBottom: "6px" }}>{epic.description}</div>}
          {epic.issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} memberSlugs={memberSlugs} labels={labels} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function GroupManualStepsTab({
  manualSteps,
  memberSlugs,
  labels,
}: { manualSteps: AggregatedManualSteps } & Common) {
  return (
    <div>
      <Summary>
        <span>{manualSteps.pendingSteps} pending</span>
        <span>{manualSteps.completedSteps} done</span>
        <span>{manualSteps.totalSteps} steps (deduplicated)</span>
      </Summary>
      {manualSteps.entries.map((entry, i) => (
        <div key={`${entry.date}|${entry.featureSlug}|${entry.title}#${i}`}>
          <Heading>
            <span style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-muted)" }}>{entry.date}</span>
              <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-primary)", fontSize: "0.8rem" }}>
                {entry.title}
              </span>
              <span>{entry.featureSlug}</span>
              <PresenceChips presentIn={entry.presentIn} memberSlugs={memberSlugs} labels={labels} />
            </span>
          </Heading>
          {entry.note && <div style={{ ...MUTED, marginBottom: "6px" }}>{entry.note}</div>}
          {entry.steps.map((step, j) => (
            <div key={`${step.text}#${j}`} style={{ ...ROW, opacity: step.completed ? 0.6 : 1 }}>
              <Checkbox checked={step.completed} />
              <span style={{ flex: 1 }}>
                <span style={{ textDecoration: step.completed ? "line-through" : "none" }}>{step.text}</span>
                {step.details.length > 0 && (
                  <pre
                    style={{
                      ...MUTED,
                      whiteSpace: "pre-wrap",
                      margin: "4px 0 0",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {step.details.join("\n")}
                  </pre>
                )}
              </span>
              <PresenceChips
                presentIn={step.presentIn}
                completedIn={step.completedIn}
                memberSlugs={memberSlugs}
                labels={labels}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function GroupOpsTab({ operations, memberSlugs, labels }: { operations: AggregatedOperations } & Common) {
  return (
    <div>
      <Summary>
        <span>{operations.pendingItems} pending</span>
        <span>{operations.totalItems} items (deduplicated)</span>
        <span>{operations.sections.length} sections</span>
      </Summary>
      {operations.sections.map((section, i) => (
        <div key={`${section.key}|${section.heading}#${i}`}>
          <Heading>
            <span style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-primary)", fontSize: "0.8rem" }}>
                {section.heading}
              </span>
              <span>{section.key}</span>
              <PresenceChips presentIn={section.presentIn} memberSlugs={memberSlugs} labels={labels} />
              {Object.keys(section.bodyIn).length > 1 && new Set(Object.values(section.bodyIn)).size > 1 && (
                <PresenceChips
                  presentIn={section.presentIn}
                  editedIn={section.presentIn.filter((s) => section.bodyIn[s] !== section.body)}
                  memberSlugs={section.presentIn}
                  labels={labels}
                />
              )}
            </span>
          </Heading>
          {section.body && (
            <div style={{ fontSize: "0.8rem", marginBottom: "6px" }}>
              <MarkdownRenderer content={section.body} />
            </div>
          )}
          {section.items.map((item, j) => (
            <div key={`${item.text}#${j}`} style={{ ...ROW, opacity: item.done ? 0.6 : 1 }}>
              <Checkbox checked={item.done} />
              <span style={{ flex: 1 }}>
                <span style={{ textDecoration: item.done ? "line-through" : "none" }}>{item.text}</span>
                {item.details.length > 0 && (
                  <pre style={{ ...MUTED, whiteSpace: "pre-wrap", margin: "4px 0 0", color: "var(--text-secondary)" }}>
                    {item.details.join("\n")}
                  </pre>
                )}
              </span>
              <PresenceChips
                presentIn={item.presentIn}
                completedIn={item.doneIn}
                memberSlugs={memberSlugs}
                labels={labels}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
