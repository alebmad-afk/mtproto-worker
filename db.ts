import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

export type MtprotoJob = {
  id: string;
  workspace_id: string;
  discovery_query_id: string | null;
  job_type: "search_global" | "search_contacts" | "resolve_username" | "get_channel_info";
  query_text: string;
  query_metadata: Record<string, unknown>;
  priority: number;
  status: "pending" | "claimed" | "completed" | "failed" | "flood_wait";
  attempts: number;
  max_attempts: number;
};

export type WorkerStateUpdate = {
  is_online?: boolean;
  last_heartbeat_at?: string;
  account_phone_masked?: string | null;
  account_username?: string | null;
  account_user_id?: string | null;
  requests_today?: number;
  requests_total?: number;
  last_flood_wait_at?: string | null;
  last_flood_wait_seconds?: number | null;
  total_flood_waits?: number;
  last_error?: string | null;
  worker_version?: string;
  worker_id?: string;
};

export type AggressivenessConfig = {
  level: "safe" | "normal" | "aggressive";
  daily_limit: number;
  min_delay_ms: number;
  max_delay_ms: number;
  requests_today: number;
  requests_today_reset_at: string;
};

export class Db {
  readonly client: SupabaseClient;
  readonly workspaceId: string;
  readonly workerId: string;

  constructor(env: Env) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.workspaceId = env.WORKSPACE_ID;
    this.workerId = env.WORKER_ID;
  }

  async ensureWorkerStateRow(): Promise<void> {
    const { data: existing } = await this.client
      .from("mtproto_worker_state")
      .select("id")
      .eq("workspace_id", this.workspaceId)
      .maybeSingle();

    if (!existing) {
      await this.client.from("mtproto_worker_state").insert({
        workspace_id: this.workspaceId,
        worker_id: this.workerId,
        aggressiveness_level: "safe",
        daily_limit: 200,
        min_delay_ms: 3000,
        max_delay_ms: 5000,
      });
    }
  }

  async readAggressiveness(): Promise<AggressivenessConfig> {
    const { data, error } = await this.client
      .from("mtproto_worker_state")
      .select("aggressiveness_level, daily_limit, min_delay_ms, max_delay_ms, requests_today, requests_today_reset_at")
      .eq("workspace_id", this.workspaceId)
      .single();

    if (error || !data) {
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
      level: data.aggressiveness_level as "safe" | "normal" | "aggressive",
      daily_limit: data.daily_limit,
      min_delay_ms: data.min_delay_ms,
      max_delay_ms: data.max_delay_ms,
      requests_today: data.requests_today,
      requests_today_reset_at: data.requests_today_reset_at,
    };
  }

  async updateWorkerState(patch: WorkerStateUpdate): Promise<void> {
    const { error } = await this.client
      .from("mtproto_worker_state")
      .update(patch)
      .eq("workspace_id", this.workspaceId);
    if (error) {
      console.error("[db] updateWorkerState failed:", error.message);
    }
  }

  async incrementRequestCounter(): Promise<void> {
    const { data } = await this.client
      .from("mtproto_worker_state")
      .select("requests_today, requests_total, requests_today_reset_at")
      .eq("workspace_id", this.workspaceId)
      .single();
    if (!data) return;

    const resetAt = new Date(data.requests_today_reset_at);
    const now = new Date();
    const sameDay = resetAt.toDateString() === now.toDateString();

    await this.client
      .from("mtproto_worker_state")
      .update({
        requests_today: sameDay ? data.requests_today + 1 : 1,
        requests_today_reset_at: sameDay ? data.requests_today_reset_at : now.toISOString(),
        requests_total: (data.requests_total ?? 0) + 1,
      })
      .eq("workspace_id", this.workspaceId);
  }

  async claimNextJob(): Promise<MtprotoJob | null> {
    // Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED via RPC would be cleaner,
    // but we use an UPDATE ... WHERE id IN (subselect) pattern that's race-safe.
    const { data: candidates } = await this.client
      .from("mtproto_jobs")
      .select("id")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1);

    if (!candidates || candidates.length === 0) return null;
    const targetId = candidates[0].id;

    const { data: claimed, error } = await this.client
      .from("mtproto_jobs")
      .update({
        status: "claimed",
        worker_id: this.workerId,
        claimed_at: new Date().toISOString(),
        attempts: 1,
      })
      .eq("id", targetId)
      .eq("status", "pending") // race guard
      .select("*")
      .maybeSingle();

    if (error || !claimed) return null;
    return claimed as MtprotoJob;
  }

  async completeJob(jobId: string, payload: unknown, candidatesInserted: number): Promise<void> {
    await this.client
      .from("mtproto_jobs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        result_payload: payload as never,
        candidates_inserted: candidatesInserted,
      })
      .eq("id", jobId);
  }

  async failJob(jobId: string, message: string, floodWaitSeconds?: number): Promise<void> {
    const status = floodWaitSeconds ? "flood_wait" : "failed";
    await this.client
      .from("mtproto_jobs")
      .update({
        status,
        completed_at: new Date().toISOString(),
        error_message: message,
        flood_wait_seconds: floodWaitSeconds ?? null,
      })
      .eq("id", jobId);
  }

  async writeAudit(
    requestType: string,
    payload: Record<string, unknown>,
    latencyMs: number,
    success: boolean,
    errorCode?: string,
    errorMessage?: string,
    jobId?: string,
  ): Promise<void> {
    await this.client.from("mtproto_audit_log").insert({
      workspace_id: this.workspaceId,
      job_id: jobId ?? null,
      worker_id: this.workerId,
      request_type: requestType,
      request_payload: payload as never,
      latency_ms: latencyMs,
      success,
      error_code: errorCode ?? null,
      error_message: errorMessage ?? null,
    });
  }

  /**
   * Insert candidates into discovery_results. Called when MTProto search returns chats.
   * Designed to be additive — runs alongside the web-search edge function output.
   */
  async insertDiscoveryCandidates(
    discoveryQueryId: string,
    candidates: DiscoveryCandidatePayload[],
  ): Promise<number> {
    if (!candidates.length) return 0;

    const candidateKey = (c: DiscoveryCandidatePayload) => c.username
      ? `url:https://t.me/${c.username.toLowerCase()}`
      : `title:${c.title.toLowerCase().trim()}`;
    const localSeen = new Set<string>();
    const uniqueCandidates = candidates.filter((candidate) => {
      const key = candidateKey(candidate);
      if (localSeen.has(key)) return false;
      localSeen.add(key);
      return true;
    });

    const { data: existingRows } = await this.client
      .from("discovery_results")
      .select("url, title")
      .eq("discovery_query_id", discoveryQueryId);
    const existingKeys = new Set(
      (existingRows ?? []).map((row) => row.url
        ? `url:${String(row.url).toLowerCase()}`
        : `title:${String(row.title ?? "").toLowerCase().trim()}`),
    );
    const freshCandidates = uniqueCandidates.filter((candidate) => !existingKeys.has(candidateKey(candidate)));
    if (!freshCandidates.length) return 0;

    const score100 = (score: number | undefined, fallback: number) => {
      const value = score ?? fallback;
      return value <= 1 ? Math.round(value * 100) : Math.round(value);
    };

    const rows = freshCandidates.map((c) => ({
      workspace_id: this.workspaceId,
      discovery_query_id: discoveryQueryId,
      source_type: c.is_group ? "telegram_chat" : "telegram_channel",
      source_origin: "telegram",
      title: c.title,
      url: c.username ? `https://t.me/${c.username}` : null,
      handle_or_identifier: c.username ? `@${c.username}` : null,
      snippet: c.description ?? null,
      description: c.description ?? null,
      provider_key: "mtproto",
      is_real: true,
      discovered_via: "search",
      raw_provider_payload: c.raw as never,
      telegram_entity_kind: c.is_group ? (c.is_megagroup ? "supergroup" : "group") : "channel",
      is_group_like: c.is_group,
      is_channel_like: !c.is_group,
      has_discussion_hint: c.has_discussion ?? false,
      monitoring_possible: true,
      requires_bot_connection: c.is_group, // groups need bot to read messages
      ai_used: false,
      relevance_score: score100(c.score, c.is_group ? 78 : 62),
      source_quality_score: c.is_group ? 86 : 68, // MTProto = high-trust source
      message_signal_score: c.has_recent_messages ? 82 : 45,
      actionability_score: c.is_group ? 78 : 42,
      audience_fit_score: c.is_group ? 76 : 48,
      commercial_signal_potential: c.description ? 72 : 42,
      snippet_relevance_score: c.description ? 78 : 30,
      description_relevance_score: c.description ? 78 : 30,
      title_relevance_score: c.score ?? 60,
      content_signal_score: c.description ? 84 : 35,
      group_likelihood_score: c.is_group ? 92 : 18,
      ru_language_score: c.is_russian ? 90 : 45,
      content_signals: { matched_query: c.matched_query, message_evidence: c.description } as never,
      audience_hints: c.audience_hints ?? [],
      reasoning_summary: `Found via MTProto search (${c.search_method})`,
      recommendation: c.is_group ? "manual_review" : "save_for_later",
      recommended_action: c.is_group ? "manual_review" : "save_for_later",
      review_status: "new",
      quality_label: "unknown",
    }));

    const { data, error } = await this.client
      .from("discovery_results")
      .insert(rows as never)
      .select("id");

    if (error) {
      console.error("[db] insertDiscoveryCandidates failed:", error.message);
      return 0;
    }
    return data?.length ?? 0;
  }
}

export type DiscoveryCandidatePayload = {
  username: string | null;
  title: string;
  description: string | null;
  is_group: boolean;
  is_megagroup: boolean;
  has_discussion?: boolean;
  has_recent_messages?: boolean;
  is_russian?: boolean;
  score?: number;
  matched_query: string;
  search_method: "search_global" | "search_contacts" | "resolve_username";
  audience_hints?: string[];
  raw: unknown;
};
