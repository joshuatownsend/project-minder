import { describe, it, expect } from "vitest";
import { parseDependabot, parseWorkflow } from "@/lib/scanner/cicd";

describe("parseWorkflow", () => {
  it("normalizes string-form `on:` to a single trigger", () => {
    const yaml = `
name: simple
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const wf = parseWorkflow(yaml, "/repo/.github/workflows/simple.yml");
    expect(wf.parseOk).toBe(true);
    expect(wf.name).toBe("simple");
    expect(wf.triggers).toEqual(["push"]);
    expect(wf.jobs).toHaveLength(1);
    expect(wf.jobs[0].id).toBe("build");
    expect(wf.jobs[0].runsOn).toBe("ubuntu-latest");
    expect(wf.jobs[0].actionUses).toEqual(["actions/checkout@v4"]);
  });

  it("normalizes array-form `on:` to multiple triggers", () => {
    const yaml = `
name: arr
on: [push, pull_request]
jobs:
  x:
    runs-on: ubuntu-latest
    steps: []
`;
    const wf = parseWorkflow(yaml, "/x.yml");
    expect(wf.triggers.sort()).toEqual(["pull_request", "push"]);
  });

  it("normalizes object-form `on:` and extracts cron schedules", () => {
    const yaml = `
name: scheduled
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 0 * * *"
    - cron: "*/15 * * * *"
  workflow_dispatch:
jobs:
  noop:
    runs-on: ubuntu-latest
    steps: []
`;
    const wf = parseWorkflow(yaml, "/x.yml");
    expect(wf.triggers.sort()).toEqual(["push", "schedule", "workflow_dispatch"]);
    expect(wf.cron).toEqual(["0 0 * * *", "*/15 * * * *"]);
  });

  it("dedupes action `uses:` references and skips run: scripts", () => {
    const yaml = `
name: dedup
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - uses: actions/setup-node@v4
      - uses: actions/checkout@v4
      - run: npm test
`;
    const wf = parseWorkflow(yaml, "/x.yml");
    expect(wf.jobs[0].actionUses).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
    ]);
  });

  it("preserves reusable-workflow references on jobs.<id>.uses", () => {
    const yaml = `
name: reuse
on: push
jobs:
  call:
    uses: org/repo/.github/workflows/shared.yml@main
`;
    const wf = parseWorkflow(yaml, "/x.yml");
    expect(wf.jobs[0].uses).toBe("org/repo/.github/workflows/shared.yml@main");
  });

  it("returns parseOk:false on malformed YAML without throwing", () => {
    const yaml = "::: not yaml :::";
    const wf = parseWorkflow(yaml, "/broken.yml");
    expect(wf.parseOk).toBe(false);
    expect(wf.file).toBe("/broken.yml");
    expect(wf.jobs).toEqual([]);
  });

  it("handles multi-runner runs-on as comma-joined string", () => {
    const yaml = `
name: arr-runs-on
on: push
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps: []
`;
    const wf = parseWorkflow(yaml, "/x.yml");
    expect(wf.jobs[0].runsOn).toBe("self-hosted, linux");
  });
});

describe("parseDependabot", () => {
  it("emits one entry per `updates[]` block", () => {
    const yaml = `
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
`;
    const result = parseDependabot(yaml, "/repo/.github/dependabot.yml");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      ecosystem: "npm",
      directory: "/",
      schedule: "weekly",
      sourcePath: "/repo/.github/dependabot.yml",
    });
    expect(result[1].ecosystem).toBe("github-actions");
    expect(result[1].schedule).toBe("monthly");
  });

  it("returns empty array when updates is missing", () => {
    expect(parseDependabot("version: 2\n", "/x")).toEqual([]);
  });

  it("ignores entries without a string ecosystem", () => {
    const yaml = `
version: 2
updates:
  - directory: "/"
  - package-ecosystem: "npm"
    directory: "/"
`;
    const result = parseDependabot(yaml, "/x");
    expect(result).toHaveLength(1);
    expect(result[0].ecosystem).toBe("npm");
  });

  it("returns empty when YAML is malformed", () => {
    expect(parseDependabot("::: not yaml :::", "/x")).toEqual([]);
  });
});
