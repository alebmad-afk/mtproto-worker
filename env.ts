import "dotenv/config";

export type Env = {
  MTPROTO_API_ID: number;
  MTPROTO_API_HASH: string;
  MTPROTO_SESSION_STRING: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  WORKSPACE_ID: string;
  WORKER_ID: string;
  POLL_INTERVAL_SECONDS: number;
  HEARTBEAT_INTERVAL_SECONDS: number;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

export function loadEnv(): Env {
  const apiIdRaw = required("MTPROTO_API_ID");
  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error("MTPROTO_API_ID must be a positive integer");
  }

  return {
    MTPROTO_API_ID: apiId,
    MTPROTO_API_HASH: required("MTPROTO_API_HASH"),
    MTPROTO_SESSION_STRING: required("MTPROTO_SESSION_STRING"),
    SUPABASE_URL: required("SUPABASE_URL"),
    SUPABASE_SERVICE_KEY: required("SUPABASE_SERVICE_KEY"),
    WORKSPACE_ID: required("WORKSPACE_ID"),
    WORKER_ID: optional("WORKER_ID", `worker-${process.env.HOSTNAME ?? "local"}-${process.pid}`),
    POLL_INTERVAL_SECONDS: Number(optional("POLL_INTERVAL_SECONDS", "5")),
    HEARTBEAT_INTERVAL_SECONDS: Number(optional("HEARTBEAT_INTERVAL_SECONDS", "30")),
  };
}

export const WORKER_VERSION = "0.1.1";
