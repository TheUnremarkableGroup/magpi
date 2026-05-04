import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * All environment variables used by magpi, sourced from src/config.ts.
 * Required vars have no default and must be present with placeholder values in .env.example.
 * Optional vars have defaults defined in the source code.
 */
const ENV_VARS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DISCORD_CHANNEL_ID",
  "DISCORD_ADMIN_IDS",
  "DISCORD_DM_ALLOWLIST",
  "DISCORD_ALLOWED_MIME_TYPES",
  "DISCORD_AUTO_THREAD",
  "DISCORD_MAX_CONCURRENT_THREADS",
  "DISCORD_MAX_UPLOAD_SIZE",
  "DISCORD_MODEL",
  "DISCORD_THINKING_LEVEL",
  "DISCORD_THREAD_AUTO_ARCHIVE_DURATION",
  "DISCORD_VERBOSE",
] as const;

describe(".env.example", () => {
  const envExamplePath = resolve(__dirname, "../../.env.example");
  const content = readFileSync(envExamplePath, "utf-8");

  // Parse all KEY=VALUE lines from .env.example (skip comments and blanks)
  const definedVars = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    definedVars.set(key, value);
  }

  it("contains all expected environment variables", () => {
    const missing = ENV_VARS.filter((v) => !definedVars.has(v));
    expect(missing, `Missing env vars in .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no unexpected environment variables", () => {
    const extra = [...definedVars.keys()].filter(
      (k) => !ENV_VARS.includes(k as (typeof ENV_VARS)[number]),
    );
    expect(extra, `Unexpected env vars in .env.example: ${extra.join(", ")}`).toEqual([]);
  });

  it("has no commented-out env var lines (all vars should be uncommented)", () => {
    const commentedEnvLines = content
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed.startsWith("#") && trimmed.includes("DISCORD_");
      })
      .map((line) => {
        // Extract the variable name from the commented line
        const match = line.trim().match(/#\s*(DISCORD_\w+)=/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    expect(
      commentedEnvLines,
      `These env vars are commented out in .env.example: ${commentedEnvLines.join(", ")}`,
    ).toEqual([]);
  });
});