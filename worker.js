// mtproto-worker — single-file flat worker for Railway.
// All logic lives here so the GitHub upload requires NO folders.
//
// Required env vars (set in Railway):
//   MTPROTO_API_ID
//   MTPROTO_API_HASH
//   MTPROTO_SESSION_STRING
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   WORKSPACE_ID
// Optional:
//   WORKER_ID, POLL_INTERVAL_SECONDS, HEARTBEAT_INTERVAL_SECONDS

const { createClient } = require("@supabase/supabase-js");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { FloodWaitError } = require("telegram/errors");

const WORKER_VERSION = "0.1.0-flat";

// ---------- env ----------
function req(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required env var: ${name}`);
  return String(v);
}
function opt(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v) : fallback;
}

const env = {
  MTPROTO_API_ID: Number(req("MTPROTO_API_ID")),
  MTPROTO_API_HASH: req("MTPROTO_API_HASH"),
  MTPROTO_SESSION_STRING: req("MTPROTO_SESSION_STRING"),
  SUPABASE_URL: req("SUPABASE_URL"),
  SUPABASE_SERVICE_KEY: req("SUPABASE_SERVICE_KEY"),
  WORKSPACE_ID: req("WORKSPACE_ID"),
  WORKER_ID: opt("WORKER_ID", `worker-${process.env.HOSTNAME || "local"}-${process.pid}`),
  POLL_INTERVAL_SECONDS: Number(opt("POLL_INTERVAL_SECONDS", "5")),
  HEARTBEAT_INTERVAL_SECONDS: Number(opt("HEARTBEAT_INTERVAL_SECONDS", "30")),
};
if (!Number.isInteger(env.MTPROTO_API_ID) || env.MTPROTO_API_ID <= 0) {
  throw new Error("MTPROTO_API_ID must be a positive integer");
}

// ---------- supabase ----------
const supa = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function ensureWorkerStateRow() {
  const { data: existing } = await supa
    .from("mtproto_worker_state")
    .select("id")
    .eq("workspace_id", env.WORKSPACE_ID)
    .maybeSingle();
  if (!existing) {
    await supa.from("mtproto_worker_state").insert({
      workspace_id: env.WORKSPACE_ID,
      worker_id: env.WORKER_ID,
      aggressiveness_level: "safe",
      daily_limit: 200,
      min_delay_ms: 3000,
      max_delay_ms: 5000,
    });
  }
}

async function readAggressiveness() {
  const { data } = await supa
    .from("mtproto_worker_state")
    .select(
      "aggressiveness_level, daily_limit, min_delay_ms, max_delay_ms, requests_today, requests_today_reset_at",
    )
    .eq("workspace_id", env.WORKSPACE_ID)
    .single();
  if (!data) {
    return {
      level: "safe",
      daily_limit: 200,
      min_delay_ms: 3000,
      max_delay_ms: 5000,
      requests_today: 0,
      requests_today_reset_at: new Date().toISOString(),
    };
  }
  return {
    level: data.aggressiveness_level,
    daily_limit: data.daily_limit,
    min_delay_ms: data.min_delay_ms,
    max_delay_ms: data.max_delay_ms,
    requests_today: data.requests_today,
    requests_today_reset_at: data.requests_today_reset_at,
  };
}

async function updateWorkerState(patch) {
  const { error } = await supa
    .from("mtproto_worker_state")
    .update(patch)
    .eq("workspace_id", env.WORKSPACE_ID);
  if (error) console.error("[db] updateWorkerState failed:", error.message);
}

async function incrementRequestCounter() {
  const { data } = await supa
    .from("mtproto_worker_state")
    .select("requests_today, requests_total, requests_today_reset_at")
    .eq("workspace_id", env.WORKSPACE_ID)
    .single();
  if (!data) return;
  const sameDay = new Date(data.requests_today_reset_at).toDateString() === new Date().toDateString();
  await supa
    .from("mtproto_worker_state")
    .update({
      requests_today: sameDay ? data.requests_today + 1 : 1,
      requests_today_reset_at: sameDay ? data.requests_today_reset_at : new Date().toISOString(),
      requests_total: (data.requests_total || 0) + 1,
    })
    .eq("workspace_id", env.WORKSPACE_ID);
}

async function claimNextJob() {
  const { data: candidates } = await supa
    .from("mtproto_jobs")
    .select("id")
    .eq("workspace_id", env.WORKSPACE_ID)
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  if (!candidates || candidates.length === 0) return null;
  const targetId = candidates[0].id;
  const { data: claimed } = await supa
    .from("mtproto_jobs")
    .update({
      status: "claimed",
      worker_id: env.WORKER_ID,
      claimed_at: new Date().toISOString(),
      attempts: 1,
    })
    .eq("id", targetId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  return claimed || null;
}

async function completeJob(jobId, payload, candidatesInserted) {
  await supa
    .from("mtproto_jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      result_payload: payload,
      candidates_inserted: candidatesInserted,
    })
    .eq("id", jobId);
}

async function failJob(jobId, message, floodWaitSeconds) {
  await supa
    .from("mtproto_jobs")
    .update({
      status: floodWaitSeconds ? "flood_wait" : "failed",
      completed_at: new Date().toISOString(),
      error_message: message,
      flood_wait_seconds: floodWaitSeconds || null,
    })
    .eq("id", jobId);
}

async function writeAudit(requestType, payload, latencyMs, success, errorCode, errorMessage, jobId) {
  await supa.from("mtproto_audit_log").insert({
    workspace_id: env.WORKSPACE_ID,
    job_id: jobId || null,
    worker_id: env.WORKER_ID,
    request_type: requestType,
    request_payload: payload,
    latency_ms: latencyMs,
    success,
    error_code: errorCode || null,
    error_message: errorMessage || null,
  });
}

async function insertDiscoveryCandidates(discoveryQueryId, candidates) {
  if (!candidates.length) return 0;
  const rows = candidates.map((c) => ({
    workspace_id: env.WORKSPACE_ID,
    discovery_query_id: discoveryQueryId,
    source_type: c.is_group ? "telegram_chat" : "telegram_channel",
    source_origin: "telegram",
    title: c.title,
    url: c.username ? `https://t.me/${c.username}` : null,
    handle_or_identifier: c.username ? `@${c.username}` : null,
    snippet: c.description || null,
    description: c.description || null,
    provider_key: "mtproto",
    is_real: true,
    discovered_via: "search",
    raw_provider_payload: c.raw,
    telegram_entity_kind: c.is_group ? (c.is_megagroup ? "supergroup" : "group") : "channel",
    is_group_like: c.is_group,
    is_channel_like: !c.is_group,
    has_discussion_hint: !!c.has_discussion,
    monitoring_possible: true,
    requires_bot_connection: c.is_group,
    ai_used: false,
    relevance_score: c.score != null ? c.score : 0.5,
    source_quality_score: 0.7,
    message_signal_score: c.has_recent_messages ? 0.7 : 0.3,
    group_likelihood_score: c.is_group ? 1 : 0,
    ru_language_score: c.is_russian ? 1 : 0.3,
    content_signals: { matched_query: c.matched_query },
    audience_hints: c.audience_hints || [],
    reasoning_summary: `Found via MTProto search (${c.search_method})`,
    recommendation: c.is_group ? "manual_review" : "save_for_later",
    recommended_action: c.is_group ? "manual_review" : "save_for_later",
    review_status: "new",
    quality_label: "unknown",
  }));
  const { data, error } = await supa.from("discovery_results").insert(rows).select("id");
  if (error) {
    console.error("[db] insertDiscoveryCandidates failed:", error.message);
    return 0;
  }
  return (data && data.length) || 0;
}

// ---------- telegram ----------
const session = new StringSession(env.MTPROTO_SESSION_STRING);
const tg = new TelegramClient(session, env.MTPROTO_API_ID, env.MTPROTO_API_HASH, {
  connectionRetries: 5,
  useWSS: false,
  autoReconnect: true,
});
let tgConnected = false;

async function tgConnect() {
  if (!tgConnected) {
    await tg.connect();
    tgConnected = true;
  }
  const me = await tg.getMe();
  const phoneRaw = me.phone || "";
  const phoneMasked = phoneRaw ? `+${phoneRaw.slice(0, 1)}***${phoneRaw.slice(-4)}` : "unknown";
  return { phone: phoneMasked, username: me.username || null, userId: me.id.toString() };
}

function looksRussian(s) {
  return /[А-Яа-яЁё]/.test(s || "");
}
function fuzzyScore(query, title) {
  const q = (query || "").toLowerCase().trim();
  const t = (title || "").toLowerCase();
  if (!q || !t) return 0.3;
  if (t.includes(q)) return 0.9;
  const words = q.split(/\s+/).filter((w) => w.length >= 3);
  const m = words.filter((w) => t.includes(w)).length;
  return Math.min(0.85, 0.3 + 0.2 * m);
}

async function searchContacts(query, limit = 50) {
  const result = await tg.invoke(new Api.contacts.Search({ q: query, limit }));
  const out = [];
  for (const c of result.chats || []) {
    if (c.className !== "Channel" && c.className !== "Chat") continue;
    const isChannel = c.className === "Channel";
    const isMegagroup = isChannel && c.megagroup === true;
    const username = isChannel ? c.username || null : null;
    const title = c.title || "";
    if (!username && !isMegagroup) continue;
    const isGroup = isMegagroup || c.className === "Chat";
    out.push({
      username, title, description: null,
      is_group: isGroup, is_megagroup: isMegagroup,
      has_discussion: false, has_recent_messages: true,
      is_russian: looksRussian(title),
      score: fuzzyScore(query, title),
      matched_query: query, search_method: "search_contacts",
      raw: { id: c.id ? c.id.toString() : null, title, username, isMegagroup },
    });
  }
  return out;
}

async function searchMessagesGlobal(query, limit = 30) {
  try {
    const result = await tg.invoke(new Api.messages.SearchGlobal({
      q: query,
      filter: new Api.InputMessagesFilterEmpty(),
      minDate: 0, maxDate: 0, offsetRate: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      offsetId: 0, limit, broadcastsOnly: false,
    }));
    const chats = result.chats || [];
    const out = []; const seen = new Set();
    for (const c of chats) {
      if (c.className !== "Channel" && c.className !== "Chat") continue;
      const isChannel = c.className === "Channel";
      const isMegagroup = isChannel && c.megagroup === true;
      const username = isChannel ? c.username || null : null;
      const title = c.title || "";
      const key = username || `id:${c.id ? c.id.toString() : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!username && !isMegagroup) continue;
      const isGroup = isMegagroup || c.className === "Chat";
      out.push({
        username, title, description: null,
        is_group: isGroup, is_megagroup: isMegagroup,
        has_discussion: false, has_recent_messages: true,
        is_russian: looksRussian(title),
        score: 0.8, matched_query: query, search_method: "search_global",
        raw: { id: c.id ? c.id.toString() : null, title, username, isMegagroup },
      });
    }
    return out;
  } catch (err) {
    if (err instanceof FloodWaitError) throw err;
    console.warn("[telegram] searchMessagesGlobal failed:", err.message);
    return [];
  }
}

async function resolveUsername(username) {
  try {
    const clean = username.replace(/^@/, "").trim();
    if (!clean) return null;
    const result = await tg.invoke(new Api.contacts.ResolveUsername({ username: clean }));
    const chat = result.chats[0];
    if (!chat || (chat.className !== "Channel" && chat.className !== "Chat")) return null;
    const isChannel = chat.className === "Channel";
    const isMegagroup = isChannel && chat.megagroup === true;
    const isGroup = isMegagroup || chat.className === "Chat";
    return {
      username: clean, title: chat.title || "", description: null,
      is_group: isGroup, is_megagroup: isMegagroup,
      has_discussion: false, has_recent_messages: true,
      is_russian: looksRussian(chat.title || ""),
      score: 0.5, matched_query: username, search_method: "resolve_username",
      raw: { id: chat.id ? chat.id.toString() : null, title: chat.title, username: clean },
    };
  } catch (err) {
    if (err instanceof FloodWaitError) throw err;
    console.warn(`[telegram] resolveUsername(${username}) failed:`, err.message);
    return null;
  }
}

// ---------- rate limiter ----------
let rl = { lastAt: 0, cfg: null };
function withinQuota() {
  const c = rl.cfg; if (!c) return true;
  const sameDay = new Date(c.requests_today_reset_at).toDateString() === new Date().toDateString();
  if (!sameDay) return true;
  return c.requests_today < c.daily_limit;
}
function remainingToday() {
  const c = rl.cfg; if (!c) return 0;
  const sameDay = new Date(c.requests_today_reset_at).toDateString() === new Date().toDateString();
  return sameDay ? Math.max(0, c.daily_limit - c.requests_today) : c.daily_limit;
}
async function waitBeforeNext() {
  const c = rl.cfg; if (!c) return;
  const elapsed = Date.now() - rl.lastAt;
  const target = c.min_delay_ms + Math.random() * Math.max(0, c.max_delay_ms - c.min_delay_ms);
  const sleep = Math.max(0, target - elapsed);
  if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
  rl.lastAt = Date.now();
}

// ---------- main loop ----------
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function heartbeat() {
  await updateWorkerState({
    is_online: true,
    last_heartbeat_at: new Date().toISOString(),
    worker_version: WORKER_VERSION,
    worker_id: env.WORKER_ID,
  });
}

async function processOneJob() {
  if (!withinQuota()) {
    console.log(`[loop] daily quota exhausted (${remainingToday()} left). Sleeping 5min.`);
    return "quota_exceeded";
  }
  const job = await claimNextJob();
  if (!job) return "idle";
  console.log(`[job ${job.id}] claimed: ${job.job_type} "${job.query_text}"`);
  const t0 = Date.now();
  try {
    await waitBeforeNext();
    let candidates = [];
    switch (job.job_type) {
      case "search_contacts":
        candidates = await searchContacts(job.query_text, 50); break;
      case "search_global":
        candidates = await searchMessagesGlobal(job.query_text, 30); break;
      case "resolve_username": {
        const one = await resolveUsername(job.query_text);
        candidates = one ? [one] : []; break;
      }
      default: throw new Error(`Unsupported job_type: ${job.job_type}`);
    }
    await incrementRequestCounter();
    let inserted = 0;
    if (job.discovery_query_id && candidates.length > 0) {
      inserted = await insertDiscoveryCandidates(job.discovery_query_id, candidates);
    }
    await completeJob(job.id, { found: candidates.length, inserted }, inserted);
    await writeAudit(job.job_type, { query: job.query_text }, Date.now() - t0, true, undefined, undefined, job.id);
    console.log(`[job ${job.id}] done: ${candidates.length} found, ${inserted} inserted, ${Date.now() - t0}ms`);
    return "processed";
  } catch (err) {
    const latency = Date.now() - t0;
    if (err instanceof FloodWaitError) {
      const waitSec = err.seconds || 60;
      console.warn(`[job ${job.id}] FloodWait ${waitSec}s`);
      await failJob(job.id, `FloodWait: ${waitSec}s`, waitSec);
      await updateWorkerState({
        last_flood_wait_at: new Date().toISOString(),
        last_flood_wait_seconds: waitSec,
      });
      await writeAudit(job.job_type, { query: job.query_text }, latency, false, "FLOOD_WAIT", `${waitSec}s`, job.id);
      await new Promise((r) => setTimeout(r, Math.min(waitSec, 600) * 1000));
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[job ${job.id}] failed:`, msg);
      await failJob(job.id, msg);
      await writeAudit(job.job_type, { query: job.query_text }, latency, false, "ERROR", msg, job.id);
    }
    return "processed";
  }
}

(async function main() {
  console.log(`=== mtproto-worker v${WORKER_VERSION} starting ===`);
  console.log(`workspace=${env.WORKSPACE_ID} worker_id=${env.WORKER_ID}`);
  await ensureWorkerStateRow();
  console.log("[boot] connecting to Telegram...");
  const me = await tgConnect();
  console.log(`[boot] logged in as ${me.username || "(no username)"} (${me.phone})`);
  await updateWorkerState({
    is_online: true,
    last_heartbeat_at: new Date().toISOString(),
    account_phone_masked: me.phone,
    account_username: me.username,
    account_user_id: me.userId,
    worker_version: WORKER_VERSION,
    worker_id: env.WORKER_ID,
    last_error: null,
  });
  rl.cfg = await readAggressiveness();
  console.log(`[boot] aggressiveness=${rl.cfg.level} daily_limit=${rl.cfg.daily_limit} delay=${rl.cfg.min_delay_ms}-${rl.cfg.max_delay_ms}ms`);

  let lastHeartbeat = 0, lastConfigRefresh = 0;
  while (!stopping) {
    const now = Date.now();
    if (now - lastHeartbeat > env.HEARTBEAT_INTERVAL_SECONDS * 1000) {
      await heartbeat(); lastHeartbeat = now;
    }
    if (now - lastConfigRefresh > 30_000) {
      rl.cfg = await readAggressiveness(); lastConfigRefresh = now;
    }
    const outcome = await processOneJob();
    if (outcome === "idle") await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_SECONDS * 1000));
    else if (outcome === "quota_exceeded") await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
  }
  console.log("[shutdown] stopping...");
  await updateWorkerState({ is_online: false, last_heartbeat_at: new Date().toISOString() });
  if (tgConnected) await tg.disconnect();
  console.log("[shutdown] bye");
  process.exit(0);
})().catch(async (err) => {
  console.error("[fatal]", err);
  try {
    await updateWorkerState({
      is_online: false,
      last_error: err instanceof Error ? err.message : String(err),
    });
  } catch {}
  process.exit(1);
});
