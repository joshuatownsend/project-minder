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

/** Locations whose indented detail lines differ from the headline copy. */
function detailsEditedIn(
  presentIn: readonly string[],
  headline: readonly string[],
  detailsIn: Record<string, readonly string[]>
): string[] {
  const head = headline.join("\n");
  return presentIn.filter((slug) => (detailsIn[slug] ?? []).join("\n") !== head);
}

/**
 * The other locations' detail lines, shown under the headline copy so an
 * alternative command or URL is never dropped (the aggregate keeps every
 * copy in `detailsIn`; this is where they become visible).
 */
function AltDetails({
  editedIn,
  detailsIn,
  labels,
}: {
  editedIn: readonly string[];
  detailsIn: Record<string, readonly string[]>;
  labels: Labels;
}) {
  if (editedIn.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
      {editedIn.map((slug) => (
        <div key={slug} style={{ display: "flex", gap: "6px", alignItems: "flex-start" }}>
          <span style={{ ...MUTED, color: "var(--accent)", flexShrink: 0 }}>{labels[slug] ?? slug}:</span>
          <pre style={{ ...MUTED, whiteSpace: "pre-wrap", margin: 0, color: "var(--text-secondary)" }}>
            {(detailsIn[slug] ?? []).join("\n") || "(no details)"}
          </pre>
        </div>
      ))}
    </div>
  );
}

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
          {board.inbox.map((issue, i) => (
            // Legacy BOARD.md rows without writer-backfilled markers have an
            // empty id; fall back to position like BoardTab does.
            <IssueRow key={issue.id || `inbox-${i}`} issue={issue} memberSlugs={memberSlugs} labels={labels} />
          ))}
        </>
      )}
      {board.epics.map((epic, ei) => (
        <div key={epic.id || `epic-${ei}`}>
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
          {epic.issues.map((issue, i) => (
            <IssueRow key={issue.id || `${epic.id || `epic-${ei}`}-${i}`} issue={issue} memberSlugs={memberSlugs} labels={labels} />
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
      {manualSteps.entries.map((entry, i) => {
        // Entry-level notes are per location too (`noteIn`); a location whose
        // note differs from the headline — including one that has a note
        // when the primary has none — is flagged and its note shown.
        const noteEditedIn = entry.presentIn.filter((slug) => (entry.noteIn[slug] ?? "") !== (entry.note ?? ""));
        return (
        <div key={`${entry.date}|${entry.featureSlug}|${entry.title}#${i}`}>
          <Heading>
            <span style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-muted)" }}>{entry.date}</span>
              <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-primary)", fontSize: "0.8rem" }}>
                {entry.title}
              </span>
              <span>{entry.featureSlug}</span>
              <PresenceChips presentIn={entry.presentIn} editedIn={noteEditedIn} memberSlugs={memberSlugs} labels={labels} />
            </span>
          </Heading>
          {entry.note && <div style={{ ...MUTED, marginBottom: "6px" }}>{entry.note}</div>}
          <AltDetails
            editedIn={noteEditedIn}
            detailsIn={Object.fromEntries(noteEditedIn.map((slug) => [slug, entry.noteIn[slug] ? [entry.noteIn[slug]] : []]))}
            labels={labels}
          />
          {entry.steps.map((step, j) => {
            const editedIn = detailsEditedIn(step.presentIn, step.details, step.detailsIn);
            return (
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
                  <AltDetails editedIn={editedIn} detailsIn={step.detailsIn} labels={labels} />
                </span>
                <PresenceChips
                  presentIn={step.presentIn}
                  completedIn={step.completedIn}
                  editedIn={editedIn}
                  memberSlugs={memberSlugs}
                  labels={labels}
                />
              </div>
            );
          })}
        </div>
        );
      })}
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
      {operations.sections.map((section, i) => {
        // Section prose is per location too (`bodyIn`); a location whose
        // prose differs from the headline is flagged and its copy shown, so
        // another checkout's operational instructions are never hidden.
        const bodyEditedIn = section.presentIn.filter((s) => (section.bodyIn[s] ?? "") !== section.body);
        return (
        <div key={`${section.key}|${section.heading}#${i}`}>
          <Heading>
            <span style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-primary)", fontSize: "0.8rem" }}>
                {section.heading}
              </span>
              <span>{section.key}</span>
              <PresenceChips presentIn={section.presentIn} editedIn={bodyEditedIn} memberSlugs={memberSlugs} labels={labels} />
            </span>
          </Heading>
          {section.body && (
            <div style={{ fontSize: "0.8rem", marginBottom: "6px" }}>
              <MarkdownRenderer content={section.body} />
            </div>
          )}
          <AltDetails
            editedIn={bodyEditedIn}
            detailsIn={Object.fromEntries(bodyEditedIn.map((s) => [s, section.bodyIn[s] ? [section.bodyIn[s]] : []]))}
            labels={labels}
          />
          {section.items.map((item, j) => {
            const editedIn = detailsEditedIn(item.presentIn, item.details, item.detailsIn);
            return (
              <div key={`${item.text}#${j}`} style={{ ...ROW, opacity: item.done ? 0.6 : 1 }}>
                <Checkbox checked={item.done} />
                <span style={{ flex: 1 }}>
                  <span style={{ textDecoration: item.done ? "line-through" : "none" }}>{item.text}</span>
                  {item.details.length > 0 && (
                    <pre style={{ ...MUTED, whiteSpace: "pre-wrap", margin: "4px 0 0", color: "var(--text-secondary)" }}>
                      {item.details.join("\n")}
                    </pre>
                  )}
                  <AltDetails editedIn={editedIn} detailsIn={item.detailsIn} labels={labels} />
                </span>
                <PresenceChips
                  presentIn={item.presentIn}
                  completedIn={item.doneIn}
                  editedIn={editedIn}
                  memberSlugs={memberSlugs}
                  labels={labels}
                />
              </div>
            );
          })}
        </div>
        );
      })}
    </div>
  );
}
