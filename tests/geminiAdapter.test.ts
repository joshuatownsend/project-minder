import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-adapter-test-"));
const TMP_DIR = path.join(FIXTURE_DIR, ".gemini", "tmp");

const PROJECT_NAME = "my-project";
const PROJECT_FOLDER = "/home/user/my-project";
const SESSION_ID = "session-abc123";

const SAMPLE_SESSION = {
  sessionId: SESSION_ID,
  startTime: "2025-06-01T10:00:00Z",
  lastUpdated: "2025-06-01T10:05:00Z",
  messages: [
    {
      type: "user",
      content: [{ text: "Hello from Gemini" }],
    },
    {
      type: "gemini",
      content: "Hi there from Gemini",
      model: "gemini-2.0-flash",
      tokens: { input: 20, cached: 5, output: 8 },
      toolCalls: [],
    },
    {
      type: "info",
      content: "Some informational message",
    },
  ],
};

const PROJECTS_JSON = {
  projects: {
    [PROJECT_FOLDER]: PROJECT_NAME,
  },
};

beforeAll(() => {
  const chatsDir = path.join(TMP_DIR, PROJECT_NAME, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatsDir, `${SESSION_ID}.json`),
    JSON.stringify(SAMPLE_SESSION),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(FIXTURE_DIR, ".gemini", "projects.json"),
    JSON.stringify(PROJECTS_JSON),
    "utf-8"
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("gemini adapter", () => {
  it("discover() finds session JSON files under tmp/<proj>/chats/", async () => {
    const { default: geminiAdapter } = await import("@/lib/adapters/gemini");
    vi.spyOn(os, "homedir").mockReturnValue(FIXTURE_DIR);

    const files = await geminiAdapter.discover();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].source).toBe("gemini");
    expect(files[0].filePath).toContain(`${SESSION_ID}.json`);
  });

  it("discover() resolves projectDirName from projects.json", async () => {
    const { default: geminiAdapter } = await import("@/lib/adapters/gemini");
    vi.spyOn(os, "homedir").mockReturnValue(FIXTURE_DIR);

    const files = await geminiAdapter.discover();
    expect(files.length).toBeGreaterThan(0);
    // encodeProjectPath("/home/user/my-project") → "-home-user-my-project"
    expect(files[0].projectDirName).toContain("my-project");
  });

  it("parseFile() stamps source: 'gemini' on every turn", async () => {
    const { default: geminiAdapter } = await import("@/lib/adapters/gemini");
    const filePath = path.join(TMP_DIR, PROJECT_NAME, "chats", `${SESSION_ID}.json`);
    const file = { source: "gemini", filePath, projectDirName: "home-user-my-project" };

    const turns = await geminiAdapter.parseFile(file);
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(t.source).toBe("gemini");
    }
  });

  it("parseFile() produces user and assistant turns with correct token data", async () => {
    const { default: geminiAdapter } = await import("@/lib/adapters/gemini");
    const filePath = path.join(TMP_DIR, PROJECT_NAME, "chats", `${SESSION_ID}.json`);
    const file = { source: "gemini", filePath, projectDirName: "home-user-my-project" };

    const turns = await geminiAdapter.parseFile(file);

    const user = turns.find((t) => t.role === "user");
    const assistant = turns.find((t) => t.role === "assistant");

    expect(user).toBeDefined();
    expect(user!.userMessageText).toContain("Hello from Gemini");

    expect(assistant).toBeDefined();
    expect(assistant!.model).toBe("gemini-2.0-flash");
    // cacheReadTokens = min(5, 20) = 5; inputTokens = 20 - 5 = 15
    expect(assistant!.cacheReadTokens).toBe(5);
    expect(assistant!.inputTokens).toBe(15);
    expect(assistant!.outputTokens).toBe(8);
    expect(assistant!.cacheCreateTokens).toBe(0);
  });

  it("parseFile() skips info/error/warning messages", async () => {
    const { default: geminiAdapter } = await import("@/lib/adapters/gemini");
    const filePath = path.join(TMP_DIR, PROJECT_NAME, "chats", `${SESSION_ID}.json`);
    const file = { source: "gemini", filePath, projectDirName: "home-user-my-project" };

    const turns = await geminiAdapter.parseFile(file);
    const roles = turns.map((t) => t.role);
    // Only user and assistant — no system/info turns
    expect(roles.every((r) => r === "user" || r === "assistant")).toBe(true);
    expect(turns.length).toBe(2);
  });

  it("discover() returns empty list when .gemini/tmp does not exist", async () => {
    const { default: geminiAdapter } = await import("@/lib/adapters/gemini");
    vi.spyOn(os, "homedir").mockReturnValue(
      path.join(os.tmpdir(), "nonexistent-gemini-" + Date.now())
    );

    const files = await geminiAdapter.discover();
    expect(files).toEqual([]);
  });

  it("discover() falls back to .project_root when not in projects.json", async () => {
    const { default: geminiAdapter } = await import("@/lib/adapters/gemini");
    // Create a hashed-name project dir with .project_root but no projects.json entry
    const hashedName = "abc123hash";
    const hashedChatsDir = path.join(TMP_DIR, hashedName, "chats");
    fs.mkdirSync(hashedChatsDir, { recursive: true });
    fs.writeFileSync(
      path.join(TMP_DIR, hashedName, ".project_root"),
      "/home/user/other-project",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(hashedChatsDir, "session-xyz.json"),
      JSON.stringify({ ...SAMPLE_SESSION, sessionId: "session-xyz" }),
      "utf-8"
    );

    vi.spyOn(os, "homedir").mockReturnValue(FIXTURE_DIR);

    const files = await geminiAdapter.discover();
    const hashedFile = files.find((f) => f.filePath.includes("session-xyz"));
    expect(hashedFile).toBeDefined();
    // encodeProjectPath("/home/user/other-project") → "-home-user-other-project"
    expect(hashedFile!.projectDirName).toContain("other-project");
  });
});
