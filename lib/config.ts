// Application configuration read from environment variables only (control S7).
// Never derive the origin or RP ID from request headers.

export type HitlMode = "enforce" | "observe";

export interface AppConfig {
  appOrigin: string;
  rpId: string;
  ticketTtlSeconds: number;
  hitlMode: HitlMode;
}

const MAX_TICKET_TTL_SECONDS = 600; // Tickets live at most 10 minutes (control T3).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export class ConfigError extends Error {}

export type EnvSource = Record<string, string | undefined>;

function required(env: EnvSource, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

export function loadConfig(env: EnvSource = process.env): AppConfig {
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

  // Observe mode logs decisions without blocking, so it needs an explicit second switch (control C6).
  const modeRaw = env.HITL_MODE?.trim() || "enforce";
  if (modeRaw !== "enforce" && modeRaw !== "observe") {
    throw new ConfigError('HITL_MODE must be "enforce" or "observe"');
  }
  if (modeRaw === "observe" && env.HITL_ALLOW_OBSERVE !== "true") {
    throw new ConfigError("HITL_MODE=observe also requires HITL_ALLOW_OBSERVE=true");
  }

  return { appOrigin: origin.origin, rpId, ticketTtlSeconds, hitlMode: modeRaw };
}
