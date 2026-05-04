/**
 * magpi extension — Pi-facing commands that manage the detached daemon.
 *
 * This extension does NOT run the Discord bot itself. It manages a detached
 * background process (the daemon) that handles all Discord communication.
 *
 * Architecture:
 *   Pi TUI ← /magpi commands → This extension
 *                                       ↓ spawns, signals, checks
 *                               Daemon process (daemon.ts)
 *                                       ↓ uses Pi SDK
 *                               Pi AgentSession ↔ Discord ↔ Users
 *
 * Commands (inside Pi):
 *   /magpi start   — Spawn the detached daemon process
 *   /magpi stop    — Send SIGTERM to the daemon (graceful shutdown)
 *   /magpi status  — Check if the daemon is running
 *   /magpi reset  — Send SIGUSR1 to the daemon (reset session)
 *   /magpi logs [N] — Show last N lines of daemon log output
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

const DAEMON_DIR = resolve(os.homedir(), ".magpi");
const PID_FILE = resolve(DAEMON_DIR, "daemon.pid");
const LOG_FILE = resolve(DAEMON_DIR, "daemon.log");

/**
 * Read the daemon PID from the PID file.
 * Returns null if no PID file or it's stale.
 */
function getDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;

  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;

    // Check if the process is actually running
    try {
      process.kill(pid, 0); // Signal 0 = existence check, no signal sent
      return pid;
    } catch {
      // Process doesn't exist — stale PID file
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Send a Unix signal to the daemon process.
 * Returns true if the signal was sent, false if daemon is not running.
 */
function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn the daemon as a detached background process.
 * Redirects stdout/stderr to a log file.
 *
 * Resolution strategy:
 * 1. Try the tsx binary from this project's node_modules
 * 2. Fall back to npx tsx (works if globally installed or on PATH)
 * 3. Fall back to node if the daemon was pre-compiled to JS
 */
function spawnDaemon(cwd: string): ChildProcess {
  // Ensure daemon directory exists
  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true });
  }

  // Resolve the daemon entry point — relative to this extension file
  const extensionDir = resolve(import.meta.dirname ?? ".");
  const daemonPath = resolve(extensionDir, "daemon.ts");

  // Try to find tsx in node_modules relative to this project
  // import.meta.dirname gives us src/, so go up one level for the project root
  const projectRoot = resolve(extensionDir, "..");
  const tsxBin = resolve(projectRoot, "node_modules", ".bin", "tsx");

  let command: string;
  let args: string[];

  if (daemonPath.endsWith(".ts") && existsSync(tsxBin)) {
    // Use the project's own tsx binary
    command = tsxBin;
    args = [daemonPath];
  } else if (daemonPath.endsWith(".ts")) {
    // Fall back to npx (slower but works if tsx is on PATH)
    command = "npx";
    args = ["tsx", daemonPath];
  } else {
    // Pre-compiled JS
    command = "node";
    args = [daemonPath];
  }

  const child = spawn(command, args, {
    cwd: projectRoot,      // Run from project root so node_modules resolves
    detached: true,        // Parent process can exit independently
    stdio: ["ignore", "pipe", "pipe"],  // Capture stdout/stderr
    env: {
      ...process.env,     // Inherit env (including DISCORD_* vars)
    },
  });

  // Redirect daemon output to log file
  const logFlags = existsSync(LOG_FILE) ? "a" : "w";
  const logStream = createWriteStream(LOG_FILE, { flags: logFlags });

  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  // Unref so the parent process (Pi) won't wait for the daemon
  child.unref();

  return child;
}

export default function (pi: ExtensionAPI) {
  // ─── Register commands ─────────────────────────────────

  pi.registerCommand("magpi start", {
    description: "Start the Discord bot daemon (detached background process)",
    handler: async (_args, ctx) => {
      const existingPid = getDaemonPid();
      if (existingPid !== null) {
        ctx.ui.notify(`Magpi daemon is already running (PID ${existingPid}).`, "info");
        return;
      }

      try {
        const child = spawnDaemon(ctx.cwd);
        ctx.ui.notify(`Magpi daemon started (PID ${child.pid}).`, "info");
        ctx.ui.notify(`Logs: ${LOG_FILE}`, "info");
        ctx.ui.setStatus("magpi", "🟢 Daemon online");
      } catch (err: any) {
        ctx.ui.notify(`Failed to start daemon: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("magpi stop", {
    description: "Stop the Discord bot daemon (sends SIGTERM)",
    handler: async (_args, ctx) => {
      const pid = getDaemonPid();
      if (pid === null) {
        ctx.ui.notify("Magpi daemon is not running.", "info");
        return;
      }

      const sent = sendSignal(pid, "SIGTERM");
      if (sent) {
        ctx.ui.notify(`Magpi daemon stopping (PID ${pid})...`, "info");
        ctx.ui.setStatus("magpi", "🔴 Daemon offline");
      } else {
        ctx.ui.notify("Magpi daemon is not running (stale PID file removed).", "info");
        ctx.ui.setStatus("magpi", "⚪ Not started");
      }
    },
  });

  pi.registerCommand("magpi status", {
    description: "Show Discord bot daemon status",
    handler: async (_args, ctx) => {
      const pid = getDaemonPid();

      if (pid === null) {
        ctx.ui.notify("Magpi daemon is not running.", "info");
        return;
      }

      const lines = [
        `Daemon: 🟢 Online (PID ${pid})`,
        `Logs: ${LOG_FILE}`,
        `Sessions: ${resolve(DAEMON_DIR, "sessions")}`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("magpi reset", {
    description: "Reset the Pi session (sends SIGUSR1 to daemon)",
    handler: async (_args, ctx) => {
      const pid = getDaemonPid();
      if (pid === null) {
        ctx.ui.notify("Magpi daemon is not running.", "info");
        return;
      }

      const sent = sendSignal(pid, "SIGUSR1");
      if (sent) {
        ctx.ui.notify("Session reset signal sent to daemon.", "info");
      } else {
        ctx.ui.notify("Daemon is not running (stale PID file).", "info");
      }
    },
  });

  pi.registerCommand("magpi logs", {
    description: "Show recent daemon log output (default: last 30 lines)",
    handler: async (args, ctx) => {
      if (!existsSync(LOG_FILE)) {
        ctx.ui.notify("No log file found. Has the daemon been started?", "info");
        return;
      }

      const numLines = parseInt(args?.trim() || "30", 10);
      if (isNaN(numLines) || numLines < 1 || numLines > 200) {
        ctx.ui.notify("Usage: /magpi logs [1-200]", "info");
        return;
      }

      try {
        const content = readFileSync(LOG_FILE, "utf-8");
        const lines = content.trim().split("\n");
        const tail = lines.slice(-numLines).join("\n");
        ctx.ui.notify(tail, "info");
      } catch (err: any) {
        ctx.ui.notify(`Error reading logs: ${err.message}`, "error");
      }
    },
  });

  // ─── Lifecycle events ──────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const pid = getDaemonPid();
    ctx.ui.setStatus(
      "magpi",
      pid !== null ? `🟢 Daemon (PID ${pid})` : "⚪ Not started",
    );
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // NOTE: We do NOT stop the daemon when Pi exits.
    // The daemon is detached by design — it survives Pi restarts.
    // Use /magpi stop to shut down the daemon explicitly.
  });
}