/**
 * Pi session management for magpi.
 *
 * Security considerations:
 * - Sessions are file-backed for persistence, stored in a known directory
 * - Compaction is enabled to prevent unbounded context growth
 * - The session is scoped to a single channel — no cross-channel data leakage
 * - Session state is never logged or exposed outside the Pi process
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { MagpiConfig } from "./config.js";

export interface SessionMessage {
  type: "text_delta" | "thinking_delta" | "tool_start" | "tool_end" | "agent_end" | "error";
  content: string;
  toolName?: string;
}

/**
 * Manages a persistent Pi agent session for the Discord channel.
 *
 * Lifecycle:
 * - Created on bot start, resumes previous session if one exists
 * - Persists to disk so it survives restarts and crashes
 * - Compaction runs automatically when context gets large
 * - Can be reset (new session) via admin command
 *
 * Session data (conversation history, tool calls, etc.) is stored as
 * append-only JSONL files in the session directory, managed by the Pi SDK's
 * SessionManager. On restart, continueRecent() reopens the last session
 * so the agent retains full context of what happened before.
 */
export class PiSessionManager {
  private session: AgentSession | null = null;
  private sessionDir: string;
  private config: MagpiConfig;
  private onEvent: (msg: SessionMessage) => void;

  constructor(
    config: MagpiConfig,
    sessionDir: string,
    onEvent: (msg: SessionMessage) => void,
  ) {
    this.config = config;
    this.sessionDir = sessionDir;
    this.onEvent = onEvent;

    // Ensure session directory exists
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
  }

  /**
   * Initialize or resume the Pi session.
   * Uses continueRecent() to pick up where we left off after a restart/crash.
   */
  async start(): Promise<void> {
    if (this.session) {
      return; // Already running
    }

    await this._initSession(/* resume */ true);
  }

  /**
   * Internal: create or resume a session.
   * @param resume If true, continue the most recent session (crash/restart recovery).
   *              If false, create a fresh session (used by reset()).
   */
  private async _initSession(resume: boolean): Promise<void> {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    // Resolve model from config or fall back to first available
    let model;
    if (this.config.model) {
      const slashIndex = this.config.model.indexOf("/");
      if (slashIndex !== -1) {
        const provider = this.config.model.slice(0, slashIndex);
        const modelId = this.config.model.slice(slashIndex + 1);
        model = modelRegistry.find(provider, modelId);
        console.log(`[magpi] Resolved model from config: provider=${provider}, modelId=${modelId}, found=${!!model}`);
      } else {
        console.warn(`[magpi] MAGPI_MODEL "${this.config.model}" is missing provider prefix (expected format: provider/model-id), falling back to first available`);
      }
    }

    if (!model) {
      const available = await modelRegistry.getAvailable();
      if (available.length === 0) {
        throw new Error(
          "No Pi models available. Configure an API key (e.g., ANTHROPIC_API_KEY) or run `pi /login`.",
        );
      }
      model = available[0];
      console.log(`[magpi] Using fallback model: ${model.provider}/${model.id}`);
    } else {
      console.log(`[magpi] Using model: ${model.provider}/${model.id}`);
    }

    // Thinking level
    const thinkingLevel = this.config.thinkingLevel as
      | "off"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | undefined;

    // File-backed session manager for persistence.
    // Pass sessionDir explicitly so data lives in our directory (~/.magpi/sessions/<threadId>/)
    // instead of the Pi SDK's default location (~/.pi/agent/sessions/).
    const dir = resolve(this.sessionDir);
    const sessionManager = resume
      ? SessionManager.continueRecent(dir, dir)  // Resume last session after restart/crash
      : SessionManager.create(dir, dir);           // Fresh session for reset

    const result: CreateAgentSessionResult = await createAgentSession({
      sessionManager,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel,
      cwd: this.sessionDir,
    });

    this.session = result.session;

    // Subscribe to streaming events
    this.session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const amd = event.assistantMessageEvent;
          if (amd.type === "text_delta") {
            this.onEvent({ type: "text_delta", content: amd.delta });
          } else if (amd.type === "thinking_delta") {
            this.onEvent({ type: "thinking_delta", content: amd.delta });
          }
          break;
        }
        case "tool_execution_start": {
          this.onEvent({ type: "tool_start", content: "", toolName: event.toolName });
          break;
        }
        case "tool_execution_end": {
          this.onEvent({ type: "tool_end", content: "", toolName: event.toolName });
          break;
        }
        case "agent_end": {
          this.onEvent({ type: "agent_end", content: "" });
          break;
        }
      }
    });

    if (resume && this.session.sessionFile) {
      console.log(`[magpi] Resumed session: ${this.session.sessionId} (${this.session.sessionFile})`);
    }
  }

  /**
   * Send a prompt to the Pi session.
   * Returns a promise that resolves when the agent finishes responding.
   */
  async prompt(text: string, images?: Array<{ mediaType: string; data: string }>): Promise<void> {
    if (!this.session) {
      throw new Error("Session not started. Call start() first.");
    }

    if (images && images.length > 0) {
      const imageContent = images.map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mediaType,
      }));
      await this.session.prompt(text, { images: imageContent });
    } else {
      await this.session.prompt(text);
    }
  }

  /**
   * Get the full last assistant response text.
   */
  getLastResponseText(): string {
    if (!this.session) return "";
    const messages = this.session.messages;
    // Walk backwards to find last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        // Extract text from content blocks
        if (typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
          return (msg.content as any[])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("");
        }
      }
    }
    return "";
  }

  /**
   * Reset the session — start fresh (new conversation, no history).
   */
  async reset(): Promise<void> {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    await this._initSession(/* resume */ false);
  }

  /**
   * Stop the session and clean up.
   */
  stop(): void {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }

  /**
   * Get session ID for status reporting.
   */
  getSessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /**
   * Check if session is currently streaming (agent is working).
   */
  isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }
}