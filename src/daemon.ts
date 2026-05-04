/**
 * Daemon — the detached background process that runs the Discord bot.
 *
 * This is the main entry point when the daemon is spawned (either by the
 * extension's /magpi start command, or directly via magpi-daemon).
 *
 * Architecture:
 * - Runs as a detached child process, independent of the Pi TUI
 * - Uses the Pi SDK (createAgentSession) directly — no extension API needed
 * - Survives Pi exits; managed via PID file and Unix signals
 * - Writes PID file and logs to ~/.magpi/ for the extension to query
 *
 * Signal handling:
 * - SIGTERM: Graceful shutdown
 * - SIGUSR1: Reset the Pi session (start fresh)
 * - SIGINT: Ignored (daemon is detached)
 */

import { MagpiBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

const DAEMON_DIR = resolve(os.homedir(), ".magpi");
const PID_FILE = resolve(DAEMON_DIR, "daemon.pid");

function removePidFile() {
  try {
    if (existsSync(PID_FILE)) {
      rmSync(PID_FILE);
    }
  } catch {
    // Non-critical — PID file cleanup is best-effort
  }
}

async function main() {
  // Load config from the directory containing this script, or CWD.
  // When spawned by the extension, env vars are already inherited.
  // When run directly, look for .env next to the daemon script.
  const configDir = resolve(process.cwd());
  const config = loadConfig(configDir);
  const sessionDir = resolve(DAEMON_DIR, "sessions");

  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true });
  }

  // Write PID file so the extension can track this process
  writeFileSync(PID_FILE, String(process.pid));

  const bot = new MagpiBot(config, sessionDir);

  // ─── Signal handlers ────────────────────────────────────

  process.on("SIGTERM", async () => {
    console.log("[magpi] Received SIGTERM, shutting down...");
    await bot.stop();
    removePidFile();
    process.exit(0);
  });

  process.on("SIGUSR1", async () => {
    console.log("[magpi] Received SIGUSR1, resetting session...");
    try {
      await bot.reset();
    } catch (err: any) {
      console.error("[magpi] Session reset failed:", err?.message);
    }
  });

  // Ignore SIGINT — we're a daemon, not attached to a terminal
  process.on("SIGINT", () => {
    console.log("[magpi] SIGINT ignored (daemon mode). Use SIGTERM to stop.");
  });

  // Clean up on any exit path
  process.on("exit", () => {
    removePidFile();
  });

  // ─── Start ──────────────────────────────────────────────

  try {
    await bot.start();
    console.log(`[magpi] Daemon running (PID ${process.pid})`);

    // Keep the event loop alive — the Discord.js client maintains
    // its own WebSocket, but we need to ensure the process never
    // exits naturally.
    await new Promise<void>(() => {});
  } catch (err: any) {
    console.error("[magpi] Failed to start daemon:", err?.message);
    removePidFile();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[magpi] Fatal error:", err);
  removePidFile();
  process.exit(1);
});
