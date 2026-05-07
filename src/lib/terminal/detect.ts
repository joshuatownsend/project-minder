import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { isWindows } from "@/lib/platform";

export interface TerminalDef {
  binary: string;
  buildArgs: (cwd: string, command?: string) => string[];
}

async function whichExists(cmd: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    try {
      await fs.access(path.join(dir, cmd));
      return true;
    } catch {
      // Try with .exe on Windows.
      if (isWindows) {
        try {
          await fs.access(path.join(dir, `${cmd}.exe`));
          return true;
        } catch {
          // Continue.
        }
      }
    }
  }
  return false;
}

export async function detectTerminal(): Promise<TerminalDef> {
  if (isWindows) {
    const hasWt = await whichExists("wt");
    if (hasWt) {
      return {
        binary: "cmd.exe",
        buildArgs: (cwd, command) =>
          command
            ? ["/c", "start", "", "wt", "-d", cwd, "cmd.exe", "/k", command]
            : ["/c", "start", "", "wt", "-d", cwd],
      };
    }
    return {
      binary: "cmd.exe",
      buildArgs: (cwd, command) =>
        command
          ? ["/c", "start", "", "cmd.exe", "/k", `cd /d "${cwd}" && ${command}`]
          : ["/c", "start", "", "cmd.exe", "/k", `cd /d "${cwd}"`],
    };
  }

  if (process.platform === "darwin") {
    // Use osascript to open Terminal.app to a specific directory.
    return {
      binary: "osascript",
      buildArgs: (cwd, command) => {
        // Escape single quotes inside the AppleScript string literal.
        const safeCwd = cwd.replace(/'/g, "'\\''");
        const script = command
          ? `tell application "Terminal" to do script "cd '${safeCwd}' && ${command}"`
          : `tell application "Terminal" to do script "cd '${safeCwd}'"`;
        return ["-e", script];
      },
    };
  }

  // Linux: try common terminals in order.
  const linuxTerminals: Array<{ cmd: string; buildArgs: (cwd: string, command?: string) => string[] }> = [
    {
      cmd: "gnome-terminal",
      buildArgs: (cwd, command) =>
        command
          ? ["--working-directory", cwd, "--", "bash", "-c", `${command}; exec bash`]
          : ["--working-directory", cwd],
    },
    {
      cmd: "konsole",
      buildArgs: (cwd, command) =>
        command
          ? ["--workdir", cwd, "-e", "bash", "-c", `${command}; exec bash`]
          : ["--workdir", cwd],
    },
    {
      cmd: "xterm",
      buildArgs: (cwd, command) => {
        const safeCwd = cwd.replace(/'/g, "'\\''");
        return command
          ? ["-e", `bash -c "cd '${safeCwd}' && ${command}; exec bash"`]
          : ["-e", `bash -c "cd '${safeCwd}'; exec bash"`];
      },
    },
  ];
  for (const t of linuxTerminals) {
    if (await whichExists(t.cmd)) {
      return { binary: t.cmd, buildArgs: t.buildArgs };
    }
  }
  return {
    binary: "xterm",
    buildArgs: (cwd) => {
      const safeCwd = cwd.replace(/'/g, "'\\''");
      return ["-e", `bash -c "cd '${safeCwd}'; exec bash"`];
    },
  };
}
