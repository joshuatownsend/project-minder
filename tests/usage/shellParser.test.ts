import { describe, it, expect } from "vitest";
import { extractBinary, groupByBinary } from "@/lib/usage/shellParser";

describe("extractBinary", () => {
  it("simple command: git status", () => {
    expect(extractBinary("git status")).toBe("git");
  });

  it("npx prefix: npx vitest", () => {
    expect(extractBinary("npx vitest")).toBe("vitest");
  });

  it("npx -y prefix: npx -y tsx script.ts", () => {
    expect(extractBinary("npx -y tsx script.ts")).toBe("tsx");
  });

  it("sudo prefix: sudo docker ps", () => {
    expect(extractBinary("sudo docker ps")).toBe("docker");
  });

  it("piped command: cat file.txt | grep pattern", () => {
    expect(extractBinary("cat file.txt | grep pattern")).toBe("cat");
  });

  it("chained command: npm install && npm test", () => {
    expect(extractBinary("npm install && npm test")).toBe("npm");
  });

  it("chained with ||: npm test || echo fail", () => {
    expect(extractBinary("npm test || echo fail")).toBe("npm");
  });

  it('quoted path with double quotes: "C:\\Program Files\\node.exe" script.js', () => {
    expect(extractBinary('"C:\\Program Files\\node.exe" script.js')).toBe("node");
  });

  it("quoted path with single quotes: '/usr/bin/python3' script.py", () => {
    expect(extractBinary("'/usr/bin/python3' script.py")).toBe("python3");
  });

  it("PowerShell call operator: & \"C:\\path\\to\\app.exe\" arg", () => {
    expect(extractBinary('& "C:\\path\\to\\app.exe" arg')).toBe("app");
  });

  it("path with forward slashes: /usr/bin/python3 script.py", () => {
    expect(extractBinary("/usr/bin/python3 script.py")).toBe("python3");
  });

  it("Windows path: C:\\tools\\node.exe script.js", () => {
    expect(extractBinary("C:\\tools\\node.exe script.js")).toBe("node");
  });

  it("empty string returns unknown", () => {
    expect(extractBinary("")).toBe("unknown");
  });

  it("whitespace only returns unknown", () => {
    expect(extractBinary("   ")).toBe("unknown");
  });

  it("handles leading/trailing whitespace", () => {
    expect(extractBinary("  git status  ")).toBe("git");
  });

  it("lowercase conversion", () => {
    expect(extractBinary("GIT status")).toBe("git");
  });

  it("npm with arguments", () => {
    expect(extractBinary("npm run build")).toBe("npm");
  });

  it("combined: sudo npx vitest", () => {
    expect(extractBinary("sudo npx vitest")).toBe("vitest");
  });

  it("combined: sudo with piped command", () => {
    expect(extractBinary("sudo cat /var/log/syslog | grep error")).toBe("cat");
  });

  it("quoted path without extension", () => {
    expect(extractBinary('"C:\\tools\\myapp" arg')).toBe("myapp");
  });

  it("handles multiple pipes", () => {
    expect(extractBinary("cat file | grep pattern | wc -l")).toBe("cat");
  });

  it("handles multiple && operators", () => {
    expect(extractBinary("npm install && npm build && npm test")).toBe("npm");
  });

  it("handles command with no arguments", () => {
    expect(extractBinary("git")).toBe("git");
  });

  it("npx with no next token", () => {
    expect(extractBinary("npx")).toBe("unknown");
  });

  it("quoted path with spaces", () => {
    expect(extractBinary('"C:\\Program Files\\Node.js\\node.exe" script.js')).toBe(
      "node"
    );
  });

  it("path case sensitivity", () => {
    expect(extractBinary("C:\\Tools\\MyApp.EXE")).toBe("myapp");
  });
});

describe("groupByBinary", () => {
  it("groups and sorts correctly", () => {
    const commands = [
      "git status",
      "npm run dev",
      "git add .",
      "npm test",
      "docker ps",
      "git commit",
    ];

    const result = groupByBinary(commands);

    expect(result).toEqual([
      { binary: "git", count: 3 },
      { binary: "npm", count: 2 },
      { binary: "docker", count: 1 },
    ]);
  });

  it("handles empty array", () => {
    const result = groupByBinary([]);
    expect(result).toEqual([]);
  });

  it("handles single command", () => {
    const result = groupByBinary(["git status"]);
    expect(result).toEqual([{ binary: "git", count: 1 }]);
  });

  it("groups mixed command types", () => {
    const commands = [
      "npx vitest",
      "npm run build",
      "sudo docker ps",
      "cat file | grep pattern",
      "npx vitest --watch",
    ];

    const result = groupByBinary(commands);

    expect(result).toEqual([
      { binary: "vitest", count: 2 },
      { binary: "npm", count: 1 },
      { binary: "docker", count: 1 },
      { binary: "cat", count: 1 },
    ]);
  });

  it("sorts by count descending", () => {
    const commands = [
      "cmd1",
      "cmd2",
      "cmd1",
      "cmd3",
      "cmd1",
      "cmd1",
      "cmd2",
      "cmd2",
    ];

    const result = groupByBinary(commands);

    // cmd1 appears 4 times, cmd2 appears 3 times, cmd3 appears 1 time
    expect(result[0].binary).toBe("cmd1");
    expect(result[0].count).toBe(4);
    expect(result[1].binary).toBe("cmd2");
    expect(result[1].count).toBe(3);
    expect(result[2].binary).toBe("cmd3");
    expect(result[2].count).toBe(1);
  });

  it("handles unknown commands", () => {
    const commands = ["", "   ", "git status"];

    const result = groupByBinary(commands);

    expect(result).toEqual([
      { binary: "unknown", count: 2 },
      { binary: "git", count: 1 },
    ]);
  });
});
