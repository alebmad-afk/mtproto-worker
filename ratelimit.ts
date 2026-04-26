/**
 * Token-bucket-ish rate limiter for MTProto requests.
 * Reads aggressiveness config from DB on every tick (so UI changes apply live).
 */
import type { Db, AggressivenessConfig } from "./db.js";

export class RateLimiter {
  private lastRequestAt = 0;
  private currentConfig: AggressivenessConfig;

  constructor(initial: AggressivenessConfig) {
    this.currentConfig = initial;
  }

  updateConfig(cfg: AggressivenessConfig) {
    this.currentConfig = cfg;
  }

  /**
   * Returns true if we are within today's quota; false if we should pause until midnight.
   */
  withinQuota(): boolean {
    const reset = new Date(this.currentConfig.requests_today_reset_at);
    const now = new Date();
    const sameDay = reset.toDateString() === now.toDateString();
    if (!sameDay) return true; // counter will reset on next increment
    return this.currentConfig.requests_today < this.currentConfig.daily_limit;
  }

  remainingToday(): number {
    const reset = new Date(this.currentConfig.requests_today_reset_at);
    const sameDay = reset.toDateString() === new Date().toDateString();
    return sameDay
      ? Math.max(0, this.currentConfig.daily_limit - this.currentConfig.requests_today)
      : this.currentConfig.daily_limit;
  }

  /**
   * Sleeps for the configured min/max delay window, with jitter.
   * Ensures we never make two requests faster than min_delay_ms apart.
   */
  async waitBeforeNext(): Promise<void> {
    const { min_delay_ms, max_delay_ms } = this.currentConfig;
    const elapsed = Date.now() - this.lastRequestAt;
    const targetGap = min_delay_ms + Math.random() * Math.max(0, max_delay_ms - min_delay_ms);
    const sleepMs = Math.max(0, targetGap - elapsed);
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    this.lastRequestAt = Date.now();
  }
}

export async function refreshConfig(db: Db, limiter: RateLimiter): Promise<AggressivenessConfig> {
  const cfg = await db.readAggressiveness();
  limiter.updateConfig(cfg);
  return cfg;
}
