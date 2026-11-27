// Application configuration read from environment variables only (control S7).
// Never derive the origin or RP ID from request headers.

export type HitlMode = "enforce" | "observe";

export interface AppConfig {
  appOrigin: string;
  rpId: string;
  ticketTtlSeconds: number;
  // The configured mode. Use effectiveHitlMode(): observe mode ends by itself at
  // observeUntil (control C6, gap H6).
  hitlMode: HitlMode;
  observeUntil: Date | null;
}

const MAX_TICKET_TTL_SECONDS = 600; // Tickets live at most 10 minutes (control T3).
// Observe mode may be switched on for at most this long at a time (control C6, gap H6).
export const MAX_OBSERVE_MS = 24 * 60 * 60 * 1000;
// An ISO 8601 date and time with an explicit time zone, e.g. 2026-12-12T18:00:00Z.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export class ConfigError extends Error {}

export type EnvSource = Record<string, string | undefined>;

function required(env: EnvSource, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

export function loadConfig(env: EnvSource = process.env, now = new Date()): AppConfig {
  const originRaw = required(env, "APP_ORIGIN");
  let origin: URL;
  try {
    origin = new URL(originRaw);
  } catch {
    throw new ConfigError("APP_ORIGIN must be a valid URL");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new ConfigError("APP_ORIGIN must be an origin without a path, query or fragment");
  }
  if (origin.protocol !== "https:" && !LOCAL_HOSTS.has(origin.hostname)) {
    throw new ConfigError("APP_ORIGIN must use https unless it is localhost");
  }

  // WebAuthn: the RP ID must equal the origin's host or be a registrable suffix of it.
  const rpId = required(env, "RP_ID").toLowerCase();
  const host = origin.hostname.toLowerCase();
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    throw new ConfigError("RP_ID must equal the APP_ORIGIN host or be a parent domain of it");
  }

  const ttlRaw = env.TICKET_TTL_SECONDS?.trim() || String(MAX_TICKET_TTL_SECONDS);
  const ticketTtlSeconds = Number(ttlRaw);
  if (
    !Number.isInteger(ticketTtlSeconds) ||
    ticketTtlSeconds < 1 ||
    ticketTtlSeconds > MAX_TICKET_TTL_SECONDS
  ) {
    throw new ConfigError(
      `TICKET_TTL_SECONDS must be an integer from 1 to ${MAX_TICKET_TTL_SECONDS}`,
    );
  }

  // Observe mode logs decisions without blocking, so it needs an explicit second
  // switch (control C6) and an end time at most 24 hours ahead, after which the
  // gate is enforced again without a redeploy (gap H6).
  const modeRaw = env.HITL_MODE?.trim() || "enforce";
  if (modeRaw !== "enforce" && modeRaw !== "observe") {
    throw new ConfigError('HITL_MODE must be "enforce" or "observe"');
  }
  let observeUntil: Date | null = null;
  if (modeRaw === "observe") {
    if (env.HITL_ALLOW_OBSERVE !== "true") {
      throw new ConfigError("HITL_MODE=observe also requires HITL_ALLOW_OBSERVE=true");
    }
    const untilRaw = env.HITL_OBSERVE_UNTIL?.trim() ?? "";
    if (!ISO_WITH_ZONE.test(untilRaw) || Number.isNaN(Date.parse(untilRaw))) {
      throw new ConfigError(
        "HITL_MODE=observe also requires HITL_OBSERVE_UNTIL, a date and time with a time zone (e.g. 2026-12-12T18:00:00Z)",
      );
    }
    observeUntil = new Date(untilRaw);
    if (observeUntil.getTime() - now.getTime() > MAX_OBSERVE_MS) {
      throw new ConfigError("HITL_OBSERVE_UNTIL must be at most 24 hours ahead");
    }
  }

  return { appOrigin: origin.origin, rpId, ticketTtlSeconds, hitlMode: modeRaw, observeUntil };
}

// The mode in force now: observe only while its end time hasn't passed (gap H6).
export function effectiveHitlMode(
  cfg: Pick<AppConfig, "hitlMode" | "observeUntil">,
  now = new Date(),
): HitlMode {
  return cfg.hitlMode === "observe" && cfg.observeUntil !== null && now < cfg.observeUntil
    ? "observe"
    : "enforce";
}
