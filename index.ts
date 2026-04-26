import { loadEnv, WORKER_VERSION } from "./env.js";
import { Db } from "./db.js";
import { TelegramSearchClient, FloodWaitError } from "./telegram.js";
import { RateLimiter, refreshConfig } from "./ratelimit.js";

const env = loadEnv();
const db = new Db(env);
const tg = new TelegramSearchClient(env);

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function heartbeat() {
  await db.updateWorkerState({
    is_online: true,
    last_heartbeat_at: new Date().toISOString(),
    worker_version: WORKER_VERSION,
    worker_id: env.WORKER_ID,
  });
}

async function processOneJob(rateLimiter: RateLimiter): Promise<"processed" | "idle" | "quota_exceeded"> {
  if (!rateLimiter.withinQuota()) {
    console.log(`[loop] daily quota exhausted (${rateLimiter.remainingToday()} left). Sleeping 5min.`);
    return "quota_exceeded";
  }

  const job = await db.claimNextJob();
  if (!job) return "idle";

  console.log(`[job ${job.id}] claimed: ${job.job_type} "${job.query_text}"`);
  const t0 = Date.now();

  try {
    await rateLimiter.waitBeforeNext();
    let candidates: Awaited<ReturnType<typeof tg.searchContacts>> = [];

    switch (job.job_type) {
      case "search_contacts":
        candidates = await tg.searchContacts(job.query_text, 50);
        break;
      case "search_global":
        candidates = await tg.searchMessagesGlobal(job.query_text, 30);
        break;
      case "resolve_username": {
        const one = await tg.resolveUsername(job.query_text);
        candidates = one ? [one] : [];
        break;
      }
      default:
        throw new Error(`Unsupported job_type: ${job.job_type}`);
    }

    await db.incrementRequestCounter();

    let inserted = 0;
    if (job.discovery_query_id && candidates.length > 0) {
      inserted = await db.insertDiscoveryCandidates(job.discovery_query_id, candidates);
    }

    await db.completeJob(job.id, { found: candidates.length, inserted } as never, inserted);
    await db.writeAudit(
      job.job_type,
      { query: job.query_text },
      Date.now() - t0,
      true,
      undefined,
      undefined,
      job.id,
    );
    console.log(`[job ${job.id}] done: ${candidates.length} found, ${inserted} inserted, ${Date.now() - t0}ms`);
    return "processed";
  } catch (err) {
    const latency = Date.now() - t0;
    if (err instanceof FloodWaitError) {
      const waitSec = err.seconds ?? 60;
      console.warn(`[job ${job.id}] FloodWait ${waitSec}s — backing off`);
      await db.failJob(job.id, `FloodWait: ${waitSec}s`, waitSec);
      await db.updateWorkerState({
        last_flood_wait_at: new Date().toISOString(),
        last_flood_wait_seconds: waitSec,
      });
      await db.writeAudit(
        job.job_type,
        { query: job.query_text },
        latency,
        false,
        "FLOOD_WAIT",
        `${waitSec}s`,
        job.id,
      );
      // Sleep the flood wait — Telegram is strict
      await new Promise((r) => setTimeout(r, Math.min(waitSec, 600) * 1000));
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[job ${job.id}] failed:`, msg);
      await db.failJob(job.id, msg);
      await db.writeAudit(
        job.job_type,
        { query: job.query_text },
        latency,
        false,
        "ERROR",
        msg,
        job.id,
      );
    }
    return "processed";
  }
}

async function main() {
  console.log(`=== mtproto-worker v${WORKER_VERSION} starting ===`);
  console.log(`workspace=${env.WORKSPACE_ID} worker_id=${env.WORKER_ID}`);

  await db.ensureWorkerStateRow();

  console.log("[boot] connecting to Telegram...");
  const me = await tg.connect();
  console.log(`[boot] logged in as ${me.username ?? "(no username)"} (${me.phone})`);

  await db.updateWorkerState({
    is_online: true,
    last_heartbeat_at: new Date().toISOString(),
    account_phone_masked: me.phone,
    account_username: me.username,
    account_user_id: me.userId,
    worker_version: WORKER_VERSION,
    worker_id: env.WORKER_ID,
    last_error: null,
  });

  const initialCfg = await db.readAggressiveness();
  const rateLimiter = new RateLimiter(initialCfg);
  console.log(`[boot] aggressiveness=${initialCfg.level} daily_limit=${initialCfg.daily_limit} delay=${initialCfg.min_delay_ms}-${initialCfg.max_delay_ms}ms`);

  let lastHeartbeat = 0;
  let lastConfigRefresh = 0;

  while (!stopping) {
    const now = Date.now();

    // Heartbeat
    if (now - lastHeartbeat > env.HEARTBEAT_INTERVAL_SECONDS * 1000) {
      await heartbeat();
      lastHeartbeat = now;
    }

    // Refresh config every 30s so UI changes apply live
    if (now - lastConfigRefresh > 30_000) {
      await refreshConfig(db, rateLimiter);
      lastConfigRefresh = now;
    }

    const outcome = await processOneJob(rateLimiter);

    if (outcome === "idle") {
      await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_SECONDS * 1000));
    } else if (outcome === "quota_exceeded") {
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
    }
    // if "processed" — loop immediately, rateLimiter will gate the next call
  }

  console.log("[shutdown] stopping...");
  await db.updateWorkerState({ is_online: false, last_heartbeat_at: new Date().toISOString() });
  await tg.disconnect();
  console.log("[shutdown] bye");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[fatal]", err);
  try {
    await db.updateWorkerState({
      is_online: false,
      last_error: err instanceof Error ? err.message : String(err),
    });
  } catch { /* ignore */ }
  process.exit(1);
});
