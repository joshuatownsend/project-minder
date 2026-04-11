import { describe, it, expect } from "vitest";
import { parseManualStepsMd } from "@/lib/scanner/manualStepsMd";

describe("parseManualStepsMd", () => {
  it("returns empty info for empty string", () => {
    const result = parseManualStepsMd("");
    expect(result.entries).toHaveLength(0);
    expect(result.totalSteps).toBe(0);
  });

  it("parses a single entry with steps", () => {
    const md = `## 2026-04-10 14:30 | auth | Set up Clerk

- [ ] Install Clerk package
  \`npm install @clerk/nextjs\`
- [ ] Add environment variables
  CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
- [x] Wrap layout with ClerkProvider

---
`;
    const result = parseManualStepsMd(md);
    expect(result.entries).toHaveLength(1);
    expect(result.totalSteps).toBe(3);
    expect(result.completedSteps).toBe(1);
    expect(result.pendingSteps).toBe(2);

    const entry = result.entries[0];
    expect(entry.date).toBe("2026-04-10 14:30");
    expect(entry.featureSlug).toBe("auth");
    expect(entry.title).toBe("Set up Clerk");
    expect(entry.steps).toHaveLength(3);
    expect(entry.steps[0].text).toBe("Install Clerk package");
    expect(entry.steps[0].completed).toBe(false);
    expect(entry.steps[0].details).toEqual(["`npm install @clerk/nextjs`"]);
    expect(entry.steps[2].completed).toBe(true);
  });

  it("parses multiple entries", () => {
    const md = `## 2026-04-10 | deploy | Deploy to Vercel

- [ ] Run vercel deploy

---

## 2026-04-09 | db | Database migration

- [x] Run drizzle push
- [ ] Seed data

---
`;
    const result = parseManualStepsMd(md);
    expect(result.entries).toHaveLength(2);
    expect(result.totalSteps).toBe(3);
    expect(result.completedSteps).toBe(1);
    expect(result.pendingSteps).toBe(2);
  });

  it("handles date-only headers (no time component)", () => {
    const md = `## 2026-04-10 | feature | Title

- [ ] Step one

---
`;
    const result = parseManualStepsMd(md);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].date).toBe("2026-04-10");
  });

  it("captures line numbers for steps", () => {
    const md = `## 2026-04-10 | test | Testing

- [ ] First step
- [ ] Second step
`;
    const result = parseManualStepsMd(md);
    // Line 1 is the header, line 3 (blank), line 2+ are steps
    expect(result.entries[0].steps[0].lineNumber).toBe(3);
    expect(result.entries[0].steps[1].lineNumber).toBe(4);
  });

  it("ignores content before any header", () => {
    const md = `# Manual Steps

Some intro text.

- [ ] Not a real step (no header above)

## 2026-04-10 | real | Real Entry

- [ ] This is real

---
`;
    const result = parseManualStepsMd(md);
    expect(result.entries).toHaveLength(1);
    expect(result.totalSteps).toBe(1);
    expect(result.entries[0].steps[0].text).toBe("This is real");
  });
});
