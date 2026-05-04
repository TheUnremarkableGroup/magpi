/**
 * Tracks Pi agent response times and estimates wait times for queued requests.
 *
 * Uses a rolling window of actual wall-clock response durations — measured
 * from session.prompt() call to completion. This is the Pi agent's time,
 * not a human's subjective estimate.
 */

export class ResponseTimeTracker {
  private samples: number[] = [];
  private maxSamples: number;

  constructor(maxSamples = 20) {
    this.maxSamples = maxSamples;
  }

  /**
   * Record a completed Pi response time.
   * @param startMs - Timestamp when prompt() was called (Date.now())
   * @param endMs - Timestamp when prompt() resolved (Date.now())
   */
  record(startMs: number, endMs: number): void {
    const duration = endMs - startMs;
    this.samples.push(duration);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * Get the rolling average response time in milliseconds.
   * Returns 0 if no data has been recorded yet.
   */
  average(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }

  /**
   * Estimate wait time for a request at the given queue position.
   *
   * Position 0 means "1 request currently being processed" → wait ≈ 1 × avg
   * Position 1 means "2 requests ahead" → wait ≈ 2 × avg
   *
   * @param queuePosition - 0-indexed position in the queue (0 = next up)
   * @returns Estimated wait time in milliseconds, or 0 if no data exists
   */
  estimateMs(queuePosition: number): number {
    const avg = this.average();
    if (avg === 0) return 0;
    // +1 because position 0 still has the currently-processing request ahead
    return Math.ceil(avg * (queuePosition + 1));
  }
}

/**
 * Format a duration in milliseconds into a human-readable string.
 *
 * Based on the Pi agent's time scale (seconds, not minutes).
 * Rounds up generously — better to under-promise and over-deliver.
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return "a few moments";

  const seconds = Math.ceil(ms / 1000);

  if (seconds <= 10) return "~10 seconds";
  if (seconds < 60) return `~${seconds} seconds`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes === 1) return "~1 minute";
  return `~${minutes} minutes`;
}