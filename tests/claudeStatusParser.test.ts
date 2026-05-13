import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { parseSummary } from "@/lib/claudeStatus/parser";

function fixture(name: string): unknown {
  const p = path.resolve(__dirname, "fixtures", "claudeStatus", `${name}.json`);
  return JSON.parse(readFileSync(p, "utf-8"));
}

describe("parseSummary", () => {
  it("treats an all-operational payload as overall=operational with no incidents", () => {
    const snap = parseSummary(fixture("summary-clear"));
    expect(snap.overall).toBe("operational");
    expect(snap.incidents).toHaveLength(0);
    expect(snap.components).toHaveLength(6);
    expect(snap.components.every((c) => c.status === "operational")).toBe(true);
  });

  it("treats a single degraded_performance component (no incident) as overall=degraded", () => {
    const snap = parseSummary(fixture("summary-degraded"));
    expect(snap.overall).toBe("degraded");
    expect(snap.incidents).toHaveLength(0);
    const claudeApi = snap.components.find((c) => c.name === "Claude API");
    expect(claudeApi?.status).toBe("degraded_performance");
  });

  it("treats an active major incident with a major_outage component as overall=incident", () => {
    const snap = parseSummary(fixture("summary-incident"));
    expect(snap.overall).toBe("incident");
    expect(snap.incidents).toHaveLength(1);
    const inc = snap.incidents[0];
    expect(inc.status).toBe("investigating");
    expect(inc.impact).toBe("major");
    expect(inc.resolvedAt).toBeNull();
  });

  it("picks the most-recent incident update for latestUpdateBody and truncates if needed", () => {
    const snap = parseSummary(fixture("summary-incident"));
    const inc = snap.incidents[0];
    // Statuspage orders newest-first; first update mentions "elevated error rates affecting"
    expect(inc.latestUpdateBody).toContain("elevated error rates");
    expect(inc.latestUpdateBody).toContain("API and Claude Code");
    expect((inc.latestUpdateBody ?? "").length).toBeLessThanOrEqual(280);
  });

  it("collects affectedComponentIds from incident_updates, deduped and preserving first-seen order", () => {
    const snap = parseSummary(fixture("summary-incident"));
    const inc = snap.incidents[0];
    // Most-recent update lists API then Code; earlier update only lists API.
    // Dedup must keep first-seen order.
    expect(inc.affectedComponentIds).toEqual(["cmpapi00001", "cmpcode0001"]);
  });

  it("filters resolved incidents out of incidents[] and falls back to operational when components are clean", () => {
    const snap = parseSummary(fixture("summary-resolved"));
    expect(snap.incidents).toHaveLength(0);
    expect(snap.overall).toBe("operational");
  });

  it("returns a safe empty result for malformed input (not an object)", () => {
    const snap = parseSummary("not-an-object");
    expect(snap.components).toEqual([]);
    expect(snap.incidents).toEqual([]);
    expect(snap.overall).toBe("operational");
  });

  it("returns a safe empty result when payload is null", () => {
    const snap = parseSummary(null);
    expect(snap.components).toEqual([]);
    expect(snap.incidents).toEqual([]);
    expect(snap.overall).toBe("operational");
  });

  it("tolerates missing components/incidents arrays", () => {
    const snap = parseSummary({ page: { url: "x", updated_at: "y" } });
    expect(snap.components).toEqual([]);
    expect(snap.incidents).toEqual([]);
    expect(snap.page.url).toBe("x");
  });

  it("tolerates an incident with no incident_updates array (latestUpdateBody is null)", () => {
    const payload = {
      page: { url: "u", updated_at: "t" },
      components: [],
      incidents: [
        {
          id: "i1",
          name: "n",
          status: "investigating",
          impact: "minor",
          shortlink: "s",
          started_at: "a",
          updated_at: "b",
          resolved_at: null,
        },
      ],
    };
    const snap = parseSummary(payload);
    expect(snap.incidents).toHaveLength(1);
    expect(snap.incidents[0].latestUpdateBody).toBeNull();
    expect(snap.incidents[0].affectedComponentIds).toEqual([]);
  });

  it("strips nested/malformed HTML from latestUpdateBody (defense against partial-sanitization escapes)", () => {
    const payload = {
      page: { url: "u", updated_at: "t" },
      components: [],
      incidents: [
        {
          id: "i1",
          name: "n",
          status: "investigating",
          impact: "minor",
          shortlink: "s",
          started_at: "a",
          updated_at: "b",
          resolved_at: null,
          incident_updates: [
            {
              id: "u1",
              status: "investigating",
              // Classic single-pass-strip bypass: removing `<script>` leaves
              // the outer `<scr` + `ipt>` which look like a tag again.
              body: "<scr<script>ipt>alert(1)</scr</script>ipt>fine",
              display_at: "z",
            },
          ],
        },
      ],
    };
    const snap = parseSummary(payload);
    const body = snap.incidents[0].latestUpdateBody ?? "";
    expect(body).not.toContain("<");
    expect(body).not.toContain(">");
    expect(body).not.toContain("script");
  });

  it("strips HTML from latestUpdateBody", () => {
    const payload = {
      page: { url: "u", updated_at: "t" },
      components: [],
      incidents: [
        {
          id: "i1",
          name: "n",
          status: "investigating",
          impact: "minor",
          shortlink: "s",
          started_at: "a",
          updated_at: "b",
          resolved_at: null,
          incident_updates: [
            {
              id: "u1",
              status: "investigating",
              body: "<p><strong>Update</strong> - things are <em>broken</em></p>",
              display_at: "z",
            },
          ],
        },
      ],
    };
    const snap = parseSummary(payload);
    expect(snap.incidents[0].latestUpdateBody).toBe("Update - things are broken");
  });

  it("treats components with unknown status verbatim (forward-compat)", () => {
    const payload = {
      page: { url: "u", updated_at: "t" },
      components: [
        { id: "c1", name: "Future", status: "under_review", updated_at: "z" },
      ],
      incidents: [],
    };
    const snap = parseSummary(payload);
    expect(snap.components[0].status).toBe("under_review");
    // Unknown status counts as non-operational → degraded.
    expect(snap.overall).toBe("degraded");
  });

  it("treats a minor active incident as overall=degraded even with all components operational", () => {
    const payload = {
      page: { url: "u", updated_at: "t" },
      components: [
        { id: "c1", name: "Service", status: "operational", updated_at: "z" },
      ],
      incidents: [
        {
          id: "i1",
          name: "Minor issue",
          status: "monitoring",
          impact: "minor",
          shortlink: "s",
          started_at: "a",
          updated_at: "b",
          resolved_at: null,
        },
      ],
    };
    const snap = parseSummary(payload);
    expect(snap.overall).toBe("degraded");
  });

  it("treats a critical active incident as overall=incident", () => {
    const payload = {
      page: { url: "u", updated_at: "t" },
      components: [
        { id: "c1", name: "Service", status: "operational", updated_at: "z" },
      ],
      incidents: [
        {
          id: "i1",
          name: "Total outage",
          status: "investigating",
          impact: "critical",
          shortlink: "s",
          started_at: "a",
          updated_at: "b",
          resolved_at: null,
        },
      ],
    };
    const snap = parseSummary(payload);
    expect(snap.overall).toBe("incident");
  });

  it("skips components missing an id", () => {
    const payload = {
      page: { url: "u", updated_at: "t" },
      components: [
        { name: "no-id", status: "operational", updated_at: "z" },
        { id: "c1", name: "ok", status: "operational", updated_at: "z" },
      ],
      incidents: [],
    };
    const snap = parseSummary(payload);
    expect(snap.components.map((c) => c.id)).toEqual(["c1"]);
  });
});
