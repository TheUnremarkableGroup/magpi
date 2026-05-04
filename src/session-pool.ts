/**
 * Manages multiple Pi sessions — one per Discord thread.
 *
 * Each thread gets its own AgentSession so conversations are isolated.
 * Sessions are lazily created on first message in a thread and file-backed
 * so they survive daemon restarts and crashes.
 *
 * Thread sessions are stored in ~/.magpi/sessions/<threadId>/
 * as JSONL files managed by the Pi SDK's SessionManager.
 * On restart, continueRecent() reopens the last session so the agent
 * retains full context of what happened before the crash.
 */

import { PiSessionManager, type SessionMessage } from "./session.js";
import type { MagpiConfig } from "./config.js";

export type SessionEventCallback = (msg: SessionMessage) => void;

export class SessionPool {
  private sessions: Map<string, PiSessionManager> = new Map();
  private eventHandlers: Map<string, (msg: SessionMessage) => void> = new Map();
  private config: MagpiConfig;
  private sessionDir: string;

  constructor(config: MagpiConfig, sessionDir: string) {
    this.config = config;
    this.sessionDir = sessionDir;
  }

  /**
   * Get an existing session for a thread, or undefined if none exists.
   */
  get(threadId: string): PiSessionManager | undefined {
    return this.sessions.get(threadId);
  }

  /**
   * Get or create a session for a thread.
   * Lazily initializes a new PiSessionManager if one doesn't exist.
   * If the pool has reached maxConcurrentThreads, the least-recently-used
   * session is evicted.
   */
  async getOrCreate(threadId: string): Promise<PiSessionManager> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;

    // Evict least-recently-used if at capacity
    if (this.sessions.size >= this.config.maxConcurrentThreads) {
      const firstKey = this.sessions.keys().next().value;
      if (firstKey) {
        const evicted = this.sessions.get(firstKey)!;
        evicted.stop();
        this.sessions.delete(firstKey);
        console.log(`[magpi] Evicted session for thread ${firstKey} (capacity reached)`);
      }
    }

    const threadSessionDir = `${this.sessionDir}/${threadId}`;
    const manager = new PiSessionManager(this.config, threadSessionDir, (msg: SessionMessage) => {
      // Forward streaming events to any registered handler (for live progress updates)
      const handler = this.eventHandlers.get(threadId);
      if (handler) handler(msg);

      // Log errors as before
      if (msg.type === "error") {
        console.error(`[magpi] Session error (thread ${threadId}):`, msg.content);
      }
    });

    await manager.start();
    this.sessions.set(threadId, manager);
    console.log(`[magpi] Created session for thread ${threadId} (${this.sessions.size}/${this.config.maxConcurrentThreads})`);

    return manager;
  }

  /**
   * Remove and dispose a session for a thread.
   * Used when a thread is deleted or archived.
   */
  remove(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.stop();
      this.sessions.delete(threadId);
      console.log(`[magpi] Removed session for thread ${threadId}`);
    }
  }

  /**
   * Register a streaming event handler for a thread.
   * Events from the Pi agent (tool_start, tool_end, etc.) are forwarded here
   * so the bot can provide live progress updates to Discord.
   */
  onEvent(threadId: string, handler: (msg: SessionMessage) => void): void {
    this.eventHandlers.set(threadId, handler);
  }

  /**
   * Remove the streaming event handler for a thread.
   * Call this after request processing completes to prevent leaks.
   */
  offEvent(threadId: string): void {
    this.eventHandlers.delete(threadId);
  }

  /**
   * Check if a session exists for a thread.
   */
  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /**
   * Get all managed thread IDs.
   */
  threadIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Check if any session is currently streaming.
   */
  isAnyStreaming(): boolean {
    for (const session of this.sessions.values()) {
      if (session.isStreaming()) return true;
    }
    return false;
  }

  /**
   * Check if a specific session is streaming.
   */
  isStreaming(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    return session?.isStreaming() ?? false;
  }

  /**
   * Stop all sessions (for daemon shutdown).
   */
  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
  }
}