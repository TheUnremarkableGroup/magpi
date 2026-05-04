/**
 * Discord bot client for magpi.
 *
 * Threading and queue architecture:
 * - @mentions in the main channel create a Discord thread, then respond inside it
 * - Follow-up messages in a bot-created thread continue the conversation (no @mention needed)
 * - When Pi is busy, incoming requests are queued with time estimates
 * - Each thread gets its own Pi session for conversation isolation
 * - The request queue is persisted to disk for crash recovery
 *
 * Security considerations:
 * - Only responds in the configured channel, bot-created threads, or DMs from allowlisted users
 * - Input is sanitized: Discord markdown and mentions are stripped before sending to Pi
 * - File uploads are validated by size and MIME type before processing
 * - Rate limiting on incoming messages prevents flooding the Pi agent
 * - Output is sanitized to avoid leaking API keys, tokens, or file paths
 * - The 👀 reaction provides visible audit trail of what the bot processes
 * - Bot token is never logged or included in responses
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  MessageType,
  ThreadAutoArchiveDuration,
  type Message,
  type AnyThreadChannel,
  type MessageReaction,
  type User,
  type Attachment,
  type PartialMessageReaction,
  type PartialUser,
} from "discord.js";
import { PiSessionManager, type SessionMessage } from "./session.js";
import { SessionPool } from "./session-pool.js";
import { PersistentQueue, type PersistedQueueItem } from "./persistent-queue.js";
import { ResponseTimeTracker, formatDuration } from "./response-time-tracker.js";
import type { MagpiConfig } from "./config.js";
import { resolve } from "node:path";
import os from "node:os";

const DAEMON_DIR = resolve(os.homedir(), ".magpi");

/**
 * Rate limiter: tracks per-user message timestamps to prevent flooding.
 */
export class RateLimiter {
  private timestamps: Map<string, number[]> = new Map();
  private maxMessages: number;
  private windowMs: number;

  constructor(maxMessages = 5, windowSeconds = 30) {
    this.maxMessages = maxMessages;
    this.windowMs = windowSeconds * 1000;
  }

  /** Returns true if the user is within rate limits */
  check(userId: string): boolean {
    const now = Date.now();
    const userTimestamps = this.timestamps.get(userId) ?? [];
    const recent = userTimestamps.filter((t) => now - t < this.windowMs);

    if (recent.length >= this.maxMessages) {
      return false;
    }

    recent.push(now);
    this.timestamps.set(userId, recent);
    return true;
  }
}

/**
 * A request waiting in the queue for Pi to become available.
 * Contains live Discord objects that cannot be serialized — the
 * persistent queue stores IDs for crash recovery.
 */
export interface QueuedRequest {
  promptText: string;
  images?: Array<{ mediaType: string; data: string }>;
  thread: AnyThreadChannel;
  originalMessage: Message;
  userId: string;
  statusMessage: Message | null;
}

/**
 * Sanitize text for Discord output.
 * Prevents leaking sensitive information like API keys, tokens, and internal paths.
 * This is a pure function so it can be tested independently.
 */
export function sanitizeForDiscord(text: string): string {
  let sanitized = text;

  // Redact common API key patterns (sk-ant-, sk-, explicit key assignments)
  sanitized = sanitized.replace(
    /(sk-ant-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9_-]{20,}|API[_-]?KEY\s*[:=]\s*\S+)/gi,
    "[REDACTED]",
  );

  // Redact Discord token-like strings (three base64 segments joined by dots)
  sanitized = sanitized.replace(
    /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    (match) => {
      // Only redact if it actually looks like a token
      if (match.startsWith("sk-") || match.split(".").length === 3) {
        return "[REDACTED]";
      }
      return match;
    },
  );

  // Redact common sensitive environment variable patterns
  sanitized = sanitized.replace(
    /(ANTHROPIC_API_KEY|OPENAI_API_KEY|DISCORD_BOT_TOKEN|DISCORD_APPLICATION_ID)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  );

  // Redact absolute paths that might reveal server structure
  sanitized = sanitized.replace(/\/home\/[^\s]+/g, (match) => {
    const parts = match.split("/");
    return `/…/${parts[parts.length - 1]}`;
  });

  return sanitized;
}

/**
 * Split a long message into Discord-compatible chunks.
 */
export function splitMessage(text: string, maxLen = 1900): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) {
      // No good newline — split at a space
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.5) {
      // No good space — hard split
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}

/**
 * The Discord bot that bridges Discord to Pi.
 */
export class MagpiBot {
  private client: Client;
  private sessions: SessionPool;
  private persistentQueue: PersistentQueue;
  private responseTracker = new ResponseTimeTracker();
  private config: MagpiConfig;
  private rateLimiter = new RateLimiter(5, 30);
  private isActive = false;

  /** Queue of requests waiting for Pi. First in, first out. */
  private requestQueue: QueuedRequest[] = [];

  /** Whether the bot is currently processing a request. */
  private isProcessing = false;

  /** Set of thread IDs that this bot created. Messages in these threads are
   *  answered without requiring @mention. */
  private managedThreads: Set<string> = new Set();

  // Collect reactions as passive context for the next Pi turn
  private pendingReactions: Array<{ userId: string; emoji: string; messageId: string }> = [];

  // Buffer for thinking deltas — flushed on agent_end or tool_start
  private thinkingBuffer = "";

  constructor(config: MagpiConfig, sessionDir: string) {
    this.config = config;

    const fullSessionDir = resolve(sessionDir);
    this.sessions = new SessionPool(config, fullSessionDir);
    this.persistentQueue = new PersistentQueue(fullSessionDir);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.registerEventHandlers();
  }

  /**
   * Start the Discord bot and Pi session pool.
   */
  async start(): Promise<void> {
    await this.client.login(this.config.botToken);
    this.isActive = true;

    // Recover any queued requests from a previous crash
    await this.recoverQueue();
  }

  /**
   * Stop the bot and clean up.
   */
  async stop(): Promise<void> {
    this.isActive = false;
    this.sessions.stopAll();

    // Set presence to invisible so Discord immediately marks the bot offline
    if (this.client.isReady()) {
      try {
        await this.client.user?.setPresence({ status: "invisible" });
      } catch {
        // Best-effort
      }
    }

    this.client.destroy();

    // Give the OS a moment to flush the TCP send buffer
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  /**
   * Check if the bot is running.
   */
  get active(): boolean {
    return this.isActive && this.client.isReady();
  }

  /**
   * Get session status info.
   */
  getStatus(): { active: boolean; threadCount: number; queueDepth: number } {
    return {
      active: this.active,
      threadCount: this.sessions.threadIds().length,
      queueDepth: this.requestQueue.length,
    };
  }

  /**
   * Reset all Pi sessions (admin command).
   */
  async reset(): Promise<void> {
    this.sessions.stopAll();
  }

  // ─── Event Handlers ────────────────────────────────────

  private registerEventHandlers(): void {
    this.client.once(Events.ClientReady, (client) => {
      console.log(`[magpi] Bot online as ${client.user.tag}`);
      console.log(`[magpi] Listening in channel: ${this.config.channelId}`);
      console.log(`[magpi] Auto-thread: ${this.config.autoThread ? "enabled" : "disabled"}`);
    });

    this.client.on(Events.MessageCreate, async (msg) => {
      await this.handleMessage(msg);
    });

    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      await this.handleReactionAdd(reaction, user);
    });

    this.client.on(Events.ThreadDelete, async (thread) => {
      // Clean up the session when a thread is deleted
      if (this.managedThreads.has(thread.id)) {
        this.managedThreads.delete(thread.id);
        this.sessions.remove(thread.id);
        console.log(`[magpi] Thread ${thread.id} deleted — session removed`);
      }
    });
  }

  /**
   * Handle incoming Discord messages.
   * Routes to one of three flows:
   *   1. Thread message (conversation continuation)
   *   2. Channel @mention (new thread creation)
   *   3. DM (private conversation)
   */
  private async handleMessage(msg: Message): Promise<void> {
    // Ignore bot messages
    if (msg.author.bot) return;

    // Ignore system messages
    if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return;

    // ── Route 1: Message in a bot-managed thread ──
    if (msg.channel.isThread() && this.managedThreads.has(msg.channelId)) {
      await this.handleThreadMessage(msg);
      return;
    }

    // Determine context
    const isChannel = msg.guildId && msg.channelId === this.config.channelId;
    const isDM = !msg.guildId;
    const isDMAllowed = isDM && this.isDMAllowed(msg.author.id);

    // ── Route 2: @mention in the configured channel ──
    if (isChannel && this.isMentioned(msg)) {
      if (this.config.autoThread) {
        await this.handleChannelMention(msg);
      } else {
        await this.handleDirectReply(msg);
      }
      return;
    }

    // ── Route 3: DM from an allowed user ──
    if (isDMAllowed) {
      await this.handleDM(msg);
      return;
    }

    // Ignore everything else
  }

  // ─── Flow 1: Channel @mention → create a thread ──────────

  /**
   * Called when a user @mentions the bot in the main channel.
   * Creates a thread on their message and responds inside it.
   * If Pi is currently busy, the request is queued with a time estimate.
   */
  private async handleChannelMention(msg: Message): Promise<void> {
    // Rate limit check
    if (!this.rateLimiter.check(msg.author.id)) {
      await msg.reply("⏳ Slow down — please wait a moment before sending another message.");
      return;
    }

    // React 👀 on the original message to show received
    try {
      await msg.react("👀");
    } catch {
      // Non-critical
    }

    // Create a thread from the user's message
    let thread: AnyThreadChannel;
    try {
      thread = await msg.startThread({
        name: `💬 ${msg.author.username}'s conversation`,
        autoArchiveDuration:
          this.config.threadAutoArchiveDuration as number as ThreadAutoArchiveDuration,
      });
    } catch (err: any) {
      console.error("[magpi] Failed to create thread:", err?.message);
      try {
        await msg.reactions.removeAll();
        await msg.react("❌");
      } catch {}
      await msg.reply("❌ Failed to create a thread. Please try again.");
      return;
    }

    // Track this thread as one we manage
    this.managedThreads.add(thread.id);

    // Extract prompt (strip bot mention)
    const promptText = this.extractPromptText(msg);
    const images = await this.processAttachments(msg.attachments);

    // Collect reaction context
    const reactionContext = this.flushPendingReactions();
    const fullPrompt = reactionContext ? `${reactionContext}\n\n${promptText}` : promptText;

    // If Pi is busy, queue the request
    if (this.isProcessing) {
      await this.enqueueRequest(msg, thread, fullPrompt, images);
      return;
    }

    // Process immediately
    await this.processRequest(msg, thread, fullPrompt, images);
  }

  // ─── Flow 2: Message in a bot-managed thread ──────────────

  /**
   * Called when a user sends a message inside a thread the bot created.
   * No @mention is required — the thread context implies intent.
   */
  private async handleThreadMessage(msg: Message): Promise<void> {
    // Rate limit check (still applies inside threads)
    if (!this.rateLimiter.check(msg.author.id)) {
      await msg.reply("⏳ Slow down — please wait a moment before sending another message.");
      return;
    }

    const threadId = msg.channelId;

    // Check if Pi is busy with this thread's session
    if (this.sessions.isStreaming(threadId)) {
      await msg.reply("⏳ I'm still working on your previous request in this thread.");
      return;
    }

    // React 👀
    try {
      await msg.react("👀");
    } catch {}

    // Extract prompt — strip mention if present, but it's optional in threads
    const promptText = this.extractPromptText(msg);
    const images = await this.processAttachments(msg.attachments);

    // Get or create the session for this thread
    let session: PiSessionManager;
    try {
      session = await this.sessions.getOrCreate(threadId);
    } catch (err: any) {
      console.error(`[magpi] Failed to create session for thread ${threadId}:`, err?.message);
      try {
        await msg.reactions.removeAll();
        await msg.react("❌");
      } catch {}
      await msg.reply("❌ Failed to initialize session. Please try starting a new thread.");
      return;
    }

    const startTime = Date.now();

    // Send status message with time estimate
    const avgEstimate = this.responseTracker.average();
    const estimateText = avgEstimate > 0
      ? `👀 Thinking... (typically ~${formatDuration(avgEstimate)})`
      : "👀 Thinking...";
    let statusMsg: Message | null = null;
    try {
      statusMsg = await msg.reply(estimateText);
    } catch {}

    // Register streaming event handler for tool progress updates
    let lastEditTime = 0;
    this.sessions.onEvent(threadId, (event: SessionMessage) => {
      if (event.type === "tool_start" && event.toolName && statusMsg) {
        const now = Date.now();
        if (now - lastEditTime > 3000) {
          lastEditTime = now;
          statusMsg.edit(`🔧 Using ${event.toolName}...`).catch(() => {});
        }
      }
    });

    // Send typing indicator while processing
    const typingInterval = setInterval(() => { this.sendTypingIndicator(msg.channel); }, 8000);
    this.sendTypingIndicator(msg.channel); // Initial indicator

    try {
      await session.prompt(promptText, images.length > 0 ? images : undefined);
      this.responseTracker.record(startTime, Date.now());

      const responseText = session.getLastResponseText();
      const sanitized = sanitizeForDiscord(responseText || "(no response)");

      // Delete status message before sending the real response
      if (statusMsg) {
        try { await statusMsg.delete(); } catch {}
      }

      if (sanitized.length > 1900) {
        const chunks = splitMessage(sanitized);
        for (const chunk of chunks) {
          await msg.reply(chunk);
        }
      } else {
        await msg.reply(sanitized);
      }

      try {
        await msg.reactions.removeAll();
        await msg.react("✅");
      } catch {}
    } catch (err: any) {
      const errorMsg = err?.message ?? "Unknown error processing prompt";
      console.error(`[magpi] Prompt error in thread ${threadId}:`, sanitizeForDiscord(errorMsg));
      this.responseTracker.record(startTime, Date.now());

      // Delete status message before sending the error
      if (statusMsg) {
        try { await statusMsg.delete(); } catch {}
      }

      await msg.reply(`❌ Error: ${sanitizeForDiscord(errorMsg)}`).catch(() => {});
      try {
        await msg.reactions.removeAll();
        await msg.react("❌");
      } catch {}
    } finally {
      clearInterval(typingInterval);
      this.sessions.offEvent(threadId);
    }
  }

  // ─── Flow 3: DM ──────────────────────────────────────────

  /**
   * Called when an allowlisted user sends a DM.
   * Falls back to the original reply-in-channel behavior (no threads).
   */
  private async handleDM(msg: Message): Promise<void> {
    // Rate limit check
    if (!this.rateLimiter.check(msg.author.id)) {
      await msg.reply("⏳ Slow down — please wait a moment before sending another message.");
      return;
    }

    // Use a special DM session key
    const dmSessionKey = `dm_${msg.author.id}`;
    const session = await this.sessions.getOrCreate(dmSessionKey);

    if (session.isStreaming()) {
      await msg.reply("⏳ I'm still working on your previous request.");
      return;
    }

    try {
      await msg.react("👀");
    } catch {}

    const promptText = msg.content;
    const images = await this.processAttachments(msg.attachments);

    const startTime = Date.now();

    // Send status message with time estimate
    const avgEstimate = this.responseTracker.average();
    const estimateText = avgEstimate > 0
      ? `👀 Thinking... (typically ~${formatDuration(avgEstimate)})`
      : "👀 Thinking...";
    let statusMsg: Message | null = null;
    try {
      statusMsg = await msg.reply(estimateText);
    } catch {}

    // Register streaming event handler for tool progress updates
    const dmSessionKey2 = `dm_${msg.author.id}`;
    let lastEditTime = 0;
    this.sessions.onEvent(dmSessionKey2, (event: SessionMessage) => {
      if (event.type === "tool_start" && event.toolName && statusMsg) {
        const now = Date.now();
        if (now - lastEditTime > 3000) {
          lastEditTime = now;
          statusMsg.edit(`🔧 Using ${event.toolName}...`).catch(() => {});
        }
      }
    });

    // Send typing indicator while processing
    // Send typing indicator while processing
    const typingInterval = setInterval(() => { this.sendTypingIndicator(msg.channel); }, 8000);
    this.sendTypingIndicator(msg.channel); // Initial indicator

    try {
      await session.prompt(promptText, images.length > 0 ? images : undefined);
      this.responseTracker.record(startTime, Date.now());

      const responseText = session.getLastResponseText();
      const sanitized = sanitizeForDiscord(responseText || "(no response)");

      // Delete status message before sending the real response
      if (statusMsg) {
        try { await statusMsg.delete(); } catch {}
      }

      if (sanitized.length > 1900) {
        const chunks = splitMessage(sanitized);
        for (const chunk of chunks) {
          await msg.reply(chunk);
        }
      } else {
        await msg.reply(sanitized);
      }

      try {
        await msg.reactions.removeAll();
        await msg.react("✅");
      } catch {}
    } catch (err: any) {
      const errorMsg = err?.message ?? "Unknown error";
      console.error("[magpi] DM prompt error:", sanitizeForDiscord(errorMsg));
      this.responseTracker.record(startTime, Date.now());

      // Delete status message before sending the error
      if (statusMsg) {
        try { await statusMsg.delete(); } catch {}
      }

      await msg.reply(`❌ Error: ${sanitizeForDiscord(errorMsg)}`).catch(() => {});
      try {
        await msg.reactions.removeAll();
        await msg.react("❌");
      } catch {}
    } finally {
      clearInterval(typingInterval);
      this.sessions.offEvent(dmSessionKey2);
    }
  }

  // ─── Fallback: @mention without threading (autoThread disabled) ──

  /**
   * Fallback behavior when autoThread is disabled.
   * Replies directly in the channel, same as the original behavior.
   */
  private async handleDirectReply(msg: Message): Promise<void> {
    if (!this.rateLimiter.check(msg.author.id)) {
      await msg.reply("⏳ Slow down — please wait a moment before sending another message.");
      return;
    }

    // Use a single channel-wide session
    const session = await this.sessions.getOrCreate(this.config.channelId);

    if (session.isStreaming()) {
      await msg.reply("⏳ I'm still working on a previous request. Please wait.");
      return;
    }

    try {
      await msg.react("👀");
    } catch {}

    const promptText = this.extractPromptText(msg);
    const images = await this.processAttachments(msg.attachments);

    const reactionContext = this.flushPendingReactions();
    const fullPrompt = reactionContext ? `${reactionContext}\n\n${promptText}` : promptText;

    const startTime = Date.now();

    // Send status message with time estimate
    const avgEstimate = this.responseTracker.average();
    const estimateText = avgEstimate > 0
      ? `👀 Thinking... (typically ~${formatDuration(avgEstimate)})`
      : "👀 Thinking...";
    let statusMsg: Message | null = null;
    try {
      statusMsg = await msg.reply(estimateText);
    } catch {}

    // Register streaming event handler for tool progress updates
    const directSessionKey = this.config.channelId;
    let lastEditTime = 0;
    this.sessions.onEvent(directSessionKey, (event: SessionMessage) => {
      if (event.type === "tool_start" && event.toolName && statusMsg) {
        const now = Date.now();
        if (now - lastEditTime > 3000) {
          lastEditTime = now;
          statusMsg.edit(`🔧 Using ${event.toolName}...`).catch(() => {});
        }
      }
    });

    // Send typing indicator while processing
    // Send typing indicator while processing
    const typingInterval = setInterval(() => { this.sendTypingIndicator(msg.channel); }, 8000);
    this.sendTypingIndicator(msg.channel); // Initial indicator

    try {
      await session.prompt(fullPrompt, images.length > 0 ? images : undefined);
      this.responseTracker.record(startTime, Date.now());

      const responseText = session.getLastResponseText();
      const sanitized = sanitizeForDiscord(responseText || "(no response)");

      // Delete status message before sending the real response
      if (statusMsg) {
        try { await statusMsg.delete(); } catch {}
      }

      if (sanitized.length > 1900) {
        const chunks = splitMessage(sanitized);
        for (const chunk of chunks) {
          await msg.reply(chunk);
        }
      } else {
        await msg.reply(sanitized);
      }

      try {
        await msg.reactions.removeAll();
        await msg.react("✅");
      } catch {}
    } catch (err: any) {
      const errorMsg = err?.message ?? "Unknown error";
      console.error("[magpi] Prompt error:", sanitizeForDiscord(errorMsg));
      this.responseTracker.record(startTime, Date.now());

      // Delete status message before sending the error
      if (statusMsg) {
        try { await statusMsg.delete(); } catch {}
      }

      await msg.reply(`❌ Error: ${sanitizeForDiscord(errorMsg)}`).catch(() => {});
      try {
        await msg.reactions.removeAll();
        await msg.react("❌");
      } catch {}
    } finally {
      clearInterval(typingInterval);
      this.sessions.offEvent(directSessionKey);
    }
  }

  // ─── Request Processing (threaded) ───────────────────────

  /**
   * Process a request immediately in a thread.
   * Called when Pi is not busy and the request can be handled right away.
   */
  private async processRequest(
    originalMessage: Message,
    thread: AnyThreadChannel,
    promptText: string,
    images?: Array<{ mediaType: string; data: string }> ,
    existingStatusMessage?: Message,
  ): Promise<void> {
    this.isProcessing = true;
    const startTime = Date.now();

    // Send typing indicator while processing
    const typingInterval = setInterval(() => { this.sendTypingIndicator(thread); }, 8000);
    this.sendTypingIndicator(thread); // Initial indicator

    try {
      const session = await this.sessions.getOrCreate(thread.id);

      // Create or reuse status message with time estimate
      const avgEstimate = this.responseTracker.average();
      const estimateText = avgEstimate > 0
        ? `👀 Working on your request... (typically ~${formatDuration(avgEstimate)})`
        : "👀 Working on your request...";
      let statusMsg: Message;
      if (existingStatusMessage) {
        try {
          await existingStatusMessage.edit(estimateText);
          statusMsg = existingStatusMessage;
        } catch {
          statusMsg = await thread.send(estimateText);
        }
      } else {
        statusMsg = await thread.send(estimateText);
      }

      // Register streaming event handler for tool progress updates
      let lastEditTime = 0;
      this.sessions.onEvent(thread.id, (event: SessionMessage) => {
        if (event.type === "tool_start" && event.toolName) {
          const now = Date.now();
          if (now - lastEditTime > 3000) {
            lastEditTime = now;
            statusMsg.edit(`🔧 Using ${event.toolName}...`).catch(() => {});
          }
        }
      });

      await session.prompt(promptText, images);
      this.responseTracker.record(startTime, Date.now());

      const responseText = session.getLastResponseText();
      const sanitized = sanitizeForDiscord(responseText || "(no response)");

      // Delete the status message and send the actual response
      try {
        await statusMsg.delete();
      } catch {}

      if (sanitized.length > 1900) {
        const chunks = splitMessage(sanitized);
        for (const chunk of chunks) {
          await thread.send(chunk);
        }
      } else {
        await thread.send(sanitized);
      }

      // Replace 👀 with ✅ on the original message
      try {
        await originalMessage.reactions.removeAll();
        await originalMessage.react("✅");
      } catch {}
    } catch (err: any) {
      const errorMsg = err?.message ?? "Unknown error processing prompt";
      console.error("[magpi] Prompt error:", sanitizeForDiscord(errorMsg));
      this.responseTracker.record(startTime, Date.now());

      await thread.send(`❌ Error: ${sanitizeForDiscord(errorMsg)}`).catch(() => {});

      // Replace 👀 with ❌ on the original message
      try {
        await originalMessage.reactions.removeAll();
        await originalMessage.react("❌");
      } catch {}
    } finally {
      clearInterval(typingInterval);
      this.sessions.offEvent(thread.id);
      this.isProcessing = false;
      // Process next queued request if any
      await this.processQueue();
    }
  }

  // ─── Queue Management ────────────────────────────────────

  /**
   * Enqueue a request when Pi is busy.
   * Creates the thread, posts a time estimate, and persists the queue state.
   */
  private async enqueueRequest(
    msg: Message,
    thread: AnyThreadChannel,
    promptText: string,
    images?: Array<{ mediaType: string; data: string }>,
  ): Promise<void> {
    const queuePosition = this.requestQueue.length;

    // Calculate estimated wait time based on Pi's actual response history
    const waitEstimate = this.responseTracker.estimateMs(queuePosition);
    let statusText: string;

    if (waitEstimate > 0) {
      const ahead = queuePosition + 1; // +1 for the currently-processing request
      statusText =
        ahead === 1
          ? `👀 There is 1 request ahead of yours. Estimated wait: ${formatDuration(waitEstimate)}.`
          : `👀 There are ${ahead} requests ahead of yours. Estimated wait: ${formatDuration(waitEstimate)}.`;
    } else {
      statusText = "👀 I'm currently working on another request — I'll be with you as soon as I finish.";
    }

    let statusMessage: Message | null = null;
    try {
      statusMessage = await thread.send(statusText);
    } catch {}

    const queued: QueuedRequest = {
      promptText,
      images,
      thread,
      originalMessage: msg,
      userId: msg.author.id,
      statusMessage,
    };

    this.requestQueue.push(queued);

    // Persist to disk for crash recovery
    this.persistentQueue.enqueue({
      threadId: thread.id,
      channelId: msg.channelId,
      originalMessageId: msg.id,
      statusMessageId: statusMessage?.id ?? "",
      userId: msg.author.id,
      promptText,
      queuePosition,
      enqueuedAt: Date.now(),
    });

    console.log(
      `[magpi] Queued request from ${msg.author.tag} (queue depth: ${this.requestQueue.length})`,
    );
  }

  /**
   * Process the next request in the queue.
   * Called after each request completes (success or error).
   */
  private async processQueue(): Promise<void> {
    if (this.requestQueue.length === 0) return;
    if (this.isProcessing) return;

    const next = this.requestQueue.shift()!;

    // Remove from persistent queue
    this.persistentQueue.dequeue();

    // Update queue positions and time estimates for remaining items
    await this.updateQueueEstimates();

    // Process the queued request, reusing the existing status message for live updates
    await this.processRequest(
      next.originalMessage,
      next.thread,
      next.promptText,
      next.images,
      next.statusMessage ?? undefined,
    );
  }

  /**
   * Update time estimates for all remaining queued items.
   * Called after each request completes so users see their updated wait time.
   */
  private async updateQueueEstimates(): Promise<void> {
    for (let i = 0; i < this.requestQueue.length; i++) {
      const item = this.requestQueue[i];
      const waitEstimate = this.responseTracker.estimateMs(i);

      if (item.statusMessage && waitEstimate > 0) {
        try {
          const ahead = i + 1;
          const newText =
            ahead === 1
              ? `👀 Updated wait: ${formatDuration(waitEstimate)} (you're next!)`
              : `👀 Updated wait: ${formatDuration(waitEstimate)} (${ahead} ahead of you)`;
          await item.statusMessage.edit(newText);
        } catch {}
      }

      // Update persistent queue position
      this.persistentQueue.updatePosition(item.thread.id, i);
    }
  }

  /**
   * Recover queued requests from a previous daemon crash.
   * Re-fetches Discord objects and re-queues the requests.
   */
  private async recoverQueue(): Promise<void> {
    const items = this.persistentQueue.drain();
    if (items.length === 0) return;

    console.log(`[magpi] Recovering ${items.length} queued requests from previous session`);

    for (const item of items) {
      try {
        // Re-fetch the thread from Discord
        const channel = await this.client.channels.fetch(item.threadId).catch(() => null);
        if (!channel || !channel.isThread()) {
          console.warn(`[magpi] Skipping orphaned queue item: thread ${item.threadId} not found`);
          continue;
        }

        // Try to fetch the status message and edit it
        let statusMessage: Message | null = null;
        if (item.statusMessageId) {
          try {
            statusMessage = await channel.messages.fetch(item.statusMessageId);
            await statusMessage.edit(
              "🔄 Recovering from a restart — I'm back and will process your request now.",
            );
          } catch {
            // Status message was deleted — non-critical
          }
        }

        // Try to fetch the original message
        let originalMessage: Message | null = null;
        try {
          originalMessage = await channel.messages.fetch(item.originalMessageId);
        } catch {
          // Original message was deleted — we can still continue without it
        }

        // Track this thread
        this.managedThreads.add(item.threadId);

        // Re-queue as a live request
        this.requestQueue.push({
          promptText: item.promptText,
          thread: channel,
          originalMessage: originalMessage ?? ({} as Message), // best-effort
          userId: item.userId,
          statusMessage,
        });
      } catch (err: any) {
        console.error(`[magpi] Failed to recover queue item for thread ${item.threadId}:`, err?.message);
      }
    }

    console.log(`[magpi] Recovered ${this.requestQueue.length} requests`);

    // Start processing the queue
    if (this.requestQueue.length > 0) {
      await this.processQueue();
    }
  }

  // ─── Reactions ───────────────────────────────────────────

  /**
   * Handle emoji reactions on messages.
   * Reactions on the bot's messages become passive context for the Pi session.
   */
  private async handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot) return;

    // Only care about reactions on the bot's messages
    if (reaction.message.author?.id !== this.client.user?.id) return;

    // In the main channel or bot threads only
    if (
      reaction.message.channelId !== this.config.channelId &&
      !this.managedThreads.has(reaction.message.channelId)
    ) {
      return;
    }

    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }

    this.pendingReactions.push({
      userId: user.id,
      emoji: reaction.emoji.name ?? "❓",
      messageId: reaction.message.id,
    });
  }

  /**
   * Flush queued reactions into a context string for Pi.
   */
  private flushPendingReactions(): string {
    if (this.pendingReactions.length === 0) return "";

    const lines = this.pendingReactions.map(
      (r) => `User ${r.userId} reacted with ${r.emoji} to message ${r.messageId}`,
    );
    this.pendingReactions = [];
    return `[Reaction context]\n${lines.join("\n")}`;
  }

  // ─── Helpers ─────────────────────────────────────────────

  /**
   * Check if the bot is mentioned in the message.
   */
  private isMentioned(msg: Message): boolean {
    return msg.mentions.has(this.client.user!.id, {
      ignoreEveryone: true,
      ignoreRoles: true,
    });
  }

  /**
   * Check if a user ID is in the DM allowlist.
   */
  private isDMAllowed(userId: string): boolean {
    if (this.config.dmAllowlist.size === 0) return true;
    return this.config.dmAllowlist.has(userId);
  }

  /**
   * Send a typing indicator to a channel.
   * Safe to call on any channel type — silently skips channels that don't support typing.
   * The routing logic guarantees we only reach text-based channels (threads, DMs, guild text),
   * but TypeScript can't verify this from channel union types.
   */
  private sendTypingIndicator(channel: Message["channel"] | AnyThreadChannel): void {
    if ("sendTyping" in channel && typeof (channel as any).sendTyping === "function") {
      (channel as any).sendTyping().catch(() => {});
    }
  }

  /**
   * Extract the prompt text from a Discord message.
   * Strips the bot mention prefix and cleans up formatting.
   */
  private extractPromptText(msg: Message): string {
    let text = msg.content;

    // Remove bot mention (<@123456789> or <@!123456789>)
    const mentionPattern = new RegExp(`<@!?${this.client.user?.id}>`, "g");
    text = text.replace(mentionPattern, "").trim();

    return text;
  }

  /**
   * Process message attachments, validating size and MIME type.
   */
  private async processAttachments(
    attachments: Map<string, Attachment>,
  ): Promise<Array<{ mediaType: string; data: string }>> {
    const images: Array<{ mediaType: string; data: string }> = [];

    for (const [, attachment] of attachments) {
      if (attachment.size > this.config.maxUploadSize) {
        console.warn(
          `[magpi] Skipping attachment ${attachment.name}: ${attachment.size} bytes exceeds limit`,
        );
        continue;
      }

      const contentType = (attachment.contentType ?? "").toLowerCase();
      if (!this.config.allowedMimeTypes.has(contentType)) {
        console.warn(
          `[magpi] Skipping attachment ${attachment.name}: disallowed MIME type ${contentType}`,
        );
        continue;
      }

      if (!contentType.startsWith("image/")) {
        continue;
      }

      try {
        const response = await fetch(attachment.url, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          console.warn(
            `[magpi] Failed to fetch attachment ${attachment.name}: HTTP ${response.status}`,
          );
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const base64 = buffer.toString("base64");

        images.push({
          mediaType: contentType,
          data: base64,
        });
      } catch (err: any) {
        console.warn(
          `[magpi] Error downloading attachment ${attachment.name}: ${err.message}`,
        );
      }
    }

    return images;
  }

  /**
   * Get the Set of managed thread IDs (for testing/recovery).
   */
  getManagedThreadIds(): Set<string> {
    return new Set(this.managedThreads);
  }

  /**
   * Get the current queue depth (for status reporting).
   */
  getQueueDepth(): number {
    return this.requestQueue.length;
  }

  /**
   * Check if the bot is currently processing a request.
   */
  getIsProcessing(): boolean {
    return this.isProcessing;
  }
}