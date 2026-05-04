/**
 * Persistent queue for tracking pending Discord requests across daemon restarts.
 *
 * When a user @mentions the bot while Pi is already processing a request,
 * their request is queued. This queue is file-backed so that if the daemon
 * crashes, queued requests can be recovered and fulfilled on restart.
 *
 * Queue items contain Discord message/thread IDs (strings) which are
 * serializable — the live discord.js objects are reconstructed from these
 * IDs on recovery.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface PersistedQueueItem {
  /** The Discord thread ID where the bot should respond */
  threadId: string;
  /** The Discord channel ID of the main channel (for re-fetching) */
  channelId: string;
  /** The ID of the user's original @mention message */
  originalMessageId: string;
  /** The ID of the bot's "I'll be with you..." status message */
  statusMessageId: string;
  /** The Discord user ID of the person who sent the request */
  userId: string;
  /** The extracted prompt text (mention already stripped) */
  promptText: string;
  /** Position in the queue at time of enqueue */
  queuePosition: number;
  /** Timestamp when the item was enqueued */
  enqueuedAt: number;
}

export class PersistentQueue {
  private queue: PersistedQueueItem[] = [];
  private filePath: string;

  constructor(sessionDir: string) {
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    this.filePath = resolve(sessionDir, "queue.json");
    this.load();
  }

  /** Current number of items in the queue */
  length(): number {
    return this.queue.length;
  }

  /** Peek at the front of the queue without removing it */
  peek(): PersistedQueueItem | undefined {
    return this.queue[0];
  }

  /** Add an item to the back of the queue */
  enqueue(item: PersistedQueueItem): void {
    this.queue.push(item);
    this.save();
  }

  /** Remove and return the front of the queue */
  dequeue(): PersistedQueueItem | undefined {
    const item = this.queue.shift();
    this.save();
    return item;
  }

  /** Update the queuePosition field for a specific thread */
  updatePosition(threadId: string, newPosition: number): void {
    const item = this.queue.find((i) => i.threadId === threadId);
    if (item) {
      item.queuePosition = newPosition;
      this.save();
    }
  }

  /** Remove and return ALL items from the queue, in order */
  drain(): PersistedQueueItem[] {
    const items = [...this.queue];
    this.queue = [];
    this.save();
    return items;
  }

  /** Persist the queue to disk */
  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.queue, null, 2));
  }

  /** Load the queue from disk (called on construction for crash recovery) */
  private load(): void {
    if (!existsSync(this.filePath)) {
      this.queue = [];
      return;
    }

    try {
      const data = readFileSync(this.filePath, "utf-8");
      this.queue = JSON.parse(data);
      if (!Array.isArray(this.queue)) {
        this.queue = [];
      }
    } catch {
      // Corrupt file — start fresh
      this.queue = [];
    }
  }
}