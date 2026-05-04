/**
 * Configuration loader and validator for magpi.
 *
 * Security considerations:
 * - All secrets come from environment variables or .env file — never hardcoded
 * - Channel ID scoping prevents the bot from responding outside its designated channel
 * - DM allowlisting restricts who can use the bot in private messages
 * - Admin IDs gate destructive operations (stop, reset)
 * - File upload validation (size, MIME type) prevents abuse
 * - Input is validated at load time — fail fast on misconfiguration
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface MagpiConfig {
  botToken: string;
  applicationId: string;
  channelId: string;
  dmAllowlist: Set<string>;
  adminIds: Set<string>;
  model?: string;
  thinkingLevel?: string;
  verbose: boolean;
  maxUploadSize: number;
  allowedMimeTypes: Set<string>;
  autoThread: boolean;
  threadAutoArchiveDuration: number;
  maxConcurrentThreads: number;
}

// Default allowed MIME types for file uploads
const DEFAULT_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
];

const DEFAULT_MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Parse a comma-separated string into a Set, trimming whitespace.
 * Returns empty set for empty/undefined input.
 */
function parseIdList(value: string | undefined): Set<string> {
  if (!value || value.trim() === "") return new Set();
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Load .env file into process.env (simple parser, no external deps).
 * Does NOT override existing env vars. Only reads KEY=VALUE lines.
 */
function loadDotEnv(dir: string): void {
  const envPath = resolve(dir, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Don't override existing env vars
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/**
 * Load and validate configuration from environment variables.
 * @param cwd - Working directory to search for .env file
 * @throws on missing required config
 */
export function loadConfig(cwd: string): MagpiConfig {
  loadDotEnv(cwd);

  const botToken = process.env.DISCORD_BOT_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  const missing: string[] = [];
  if (!botToken) missing.push("DISCORD_BOT_TOKEN");
  if (!applicationId) missing.push("DISCORD_APPLICATION_ID");
  if (!channelId) missing.push("DISCORD_CHANNEL_ID");

  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(", ")}. ` +
        `Set them in .env or environment variables. See .env.example for reference.`,
    );
  }

  // Validate Discord snowflake IDs (17-20 digit numbers)
  const snowflakeRegex = /^\d{17,20}$/;
  if (!snowflakeRegex.test(channelId!)) {
    throw new Error(
      `DISCORD_CHANNEL_ID must be a valid Discord snowflake (17-20 digits). Got: "${channelId}"`,
    );
  }
  if (!snowflakeRegex.test(applicationId!)) {
    throw new Error(
      `DISCORD_APPLICATION_ID must be a valid Discord snowflake (17-20 digits). Got: "${applicationId}"`,
    );
  }

  // Token format: base64-encoded three-part structure
  if (botToken!.split(".").length !== 3) {
    throw new Error(
      `DISCORD_BOT_TOKEN does not appear to be a valid Discord bot token. ` +
        `Expected format: base64.base64.base64`,
    );
  }

  const dmAllowlist = parseIdList(process.env.DISCORD_DM_ALLOWLIST);
  const adminIds = parseIdList(process.env.DISCORD_ADMIN_IDS);

  const maxUploadSize = parseInt(
    process.env.DISCORD_MAX_UPLOAD_SIZE ?? String(DEFAULT_MAX_UPLOAD_SIZE),
    10,
  );
  if (isNaN(maxUploadSize) || maxUploadSize < 0 || maxUploadSize > 25 * 1024 * 1024) {
    throw new Error(
      `DISCORD_MAX_UPLOAD_SIZE must be between 0 and 25MB. Got: "${process.env.DISCORD_MAX_UPLOAD_SIZE}"`,
    );
  }

  const mimeTypesStr = process.env.DISCORD_ALLOWED_MIME_TYPES;
  const allowedMimeTypes = mimeTypesStr
    ? new Set(
        mimeTypesStr
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0),
      )
    : new Set(DEFAULT_ALLOWED_MIME_TYPES);

  const autoThread = process.env.DISCORD_AUTO_THREAD !== "false"; // default true
  const threadAutoArchiveDuration = parseInt(
    process.env.DISCORD_THREAD_AUTO_ARCHIVE_DURATION ?? "1440",
    10,
  );
  const validArchiveDurations = [60, 1440, 4320, 10080];
  if (!validArchiveDurations.includes(threadAutoArchiveDuration)) {
    throw new Error(
      `DISCORD_THREAD_AUTO_ARCHIVE_DURATION must be one of ${validArchiveDurations.join(", ")}. Got: "${process.env.DISCORD_THREAD_AUTO_ARCHIVE_DURATION}"`,
    );
  }
  const maxConcurrentThreads = parseInt(
    process.env.DISCORD_MAX_CONCURRENT_THREADS ?? "10",
    10,
  );
  if (isNaN(maxConcurrentThreads) || maxConcurrentThreads < 1 || maxConcurrentThreads > 50) {
    throw new Error(
      `DISCORD_MAX_CONCURRENT_THREADS must be between 1 and 50. Got: "${process.env.DISCORD_MAX_CONCURRENT_THREADS}"`,
    );
  }

  return {
    botToken: botToken!,
    applicationId: applicationId!,
    channelId: channelId!,
    dmAllowlist,
    adminIds,
    model: process.env.DISCORD_MODEL,
    thinkingLevel: process.env.DISCORD_THINKING_LEVEL,
    verbose: process.env.DISCORD_VERBOSE === "1" || process.env.DISCORD_VERBOSE === "true",
    maxUploadSize,
    allowedMimeTypes,
    autoThread,
    threadAutoArchiveDuration,
    maxConcurrentThreads,
  };
}