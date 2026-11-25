// A Poppy agent's identity: its client ID metadata document (CIMD) and key set
// (Poppy 1.0 section 4.1; FR45, FR46; control PP6). Both URLs come from the agent,
// so they are fetched with the SSRF guard and cached for a few minutes; a failed
// fetch is not retried for 30 seconds, and an unknown key ID refetches the key set
// at most once per 30 seconds.
import { appConfig } from "@/lib/app";
import { fetchPublicJson } from "@/lib/webBotAuthDirectory";

export interface AgentMetadata {
  clientId: string;
  name: string;
  logoUri: string | null;
  jwksUri: string;
  redirectUris: string[];
}

export type PublicJwk = Record<string, unknown> & { kty: string; kid?: string };

type FetchJson = (url: string) => Promise<unknown>;

const MAX_KEYS = 20;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Test mode only: agents on plain-HTTP localhost, and only while this app itself
// runs on http://localhost. Production (an https APP_ORIGIN) never allows it.
export function loopbackClientsAllowed(
  env: Record<string, string | undefined> = process.env,
  origin = appConfig().appOrigin,
) {
  return env.POPPY_ALLOW_LOOPBACK_CLIENTS === "true" && /^http:\/\/localhost(:\d+)?$/.test(origin);
}

const isLoopbackHttp = (u: URL) => u.protocol === "http:" && LOOPBACK.has(u.hostname);

// A client_id we would fetch: HTTPS, no query, fragment or credentials.
export function clientIdUrl(raw: string | null | undefined, allowLoopback = false): URL | null {
  if (!raw || raw.length > 512) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.search || u.hash || u.username || u.password) return null;
  if (u.protocol === "https:" || (allowLoopback && isLoopbackHttp(u))) return u;
  return null;
}

const defaultFetch: FetchJson = async (url) => {
  const u = new URL(url);
  if (isLoopbackHttp(u)) {
    if (!loopbackClientsAllowed()) throw new Error("loopback_not_allowed");
    const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    return res.json();
  }
  return (await fetchPublicJson(url, { accept: "application/json", maxBytes: 100 * 1024 })).body;
};

function sameHost(a: URL, b: URL) {
  return a.host.toLowerCase() === b.host.toLowerCase();
}

// Checks a fetched document against the rules in Poppy 4.1; throws if it fails.
export function validateMetadata(url: URL, doc: unknown, allowLoopback: boolean): AgentMetadata {
  const d = (doc ?? {}) as Record<string, unknown>;
  if (d.client_id !== url.toString()) throw new Error("client_id_mismatch");
  if (typeof d.jwks_uri !== "string") throw new Error("jwks_uri");
  const jwks = new URL(d.jwks_uri);
  if (
    !sameHost(jwks, url) ||
    (jwks.protocol !== "https:" && !(allowLoopback && isLoopbackHttp(jwks)))
  ) {
    throw new Error("jwks_uri");
  }
  if (
    !Array.isArray(d.redirect_uris) ||
    d.redirect_uris.length === 0 ||
    d.redirect_uris.length > 10
  ) {
    throw new Error("redirect_uris");
  }
  const redirectUris = d.redirect_uris.map((r) => {
    if (typeof r !== "string") throw new Error("redirect_uris");
    const ru = new URL(r);
    const ok = (ru.protocol === "https:" && sameHost(ru, url)) || isLoopbackHttp(ru);
    if (!ok || ru.hash) throw new Error("redirect_uris");
    return r;
  });
  if (
    d.token_endpoint_auth_method !== undefined &&
    d.token_endpoint_auth_method !== "private_key_jwt"
  ) {
    throw new Error("token_endpoint_auth_method");
  }
  const name =
    (typeof d.client_name === "string" ? d.client_name : url.host)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 80) || url.host;
  const logo =
    typeof d.logo_uri === "string" && d.logo_uri.startsWith("https://") ? d.logo_uri : null;
  return { clientId: url.toString(), name, logoUri: logo, jwksUri: jwks.toString(), redirectUris };
}

export function validateJwks(doc: unknown): PublicJwk[] {
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length > MAX_KEYS) throw new Error("not_a_key_set");
  return keys.filter((k): k is PublicJwk => {
    if (!k || typeof k !== "object") return false;
    const j = k as Record<string, unknown>;
    if (PRIVATE_MEMBERS.some((m) => m in j)) return false;
    if (j.kty === "EC")
      return j.crv === "P-256" && typeof j.x === "string" && typeof j.y === "string";
    if (j.kty === "RSA") {
      // 2048 to 4096-bit moduli (Poppy guides).
      const bits = typeof j.n === "string" ? Math.floor((j.n.length * 6) / 8) * 8 : 0;
      return typeof j.e === "string" && bits >= 2040 && bits <= 4104;
    }
    return false;
  });
}

interface Entry<T> {
  value: T;
  until: number;
}

export function createAgentMetadata(opts: { fetchJson?: FetchJson; now?: () => number } = {}) {
  const fetchJson = opts.fetchJson ?? defaultFetch;
  const now = opts.now ?? Date.now;
  const TTL = 5 * 60_000;
  const RETRY = 30_000;
  const clients = new Map<string, Entry<AgentMetadata>>();
  const keySets = new Map<string, Entry<PublicJwk[]> & { fetchedAt: number }>();
  const failed = new Map<string, number>();
  const cap = (m: Map<string, unknown>) => {
    if (m.size >= 200) m.delete(m.keys().next().value!);
  };

  async function client(clientId: string): Promise<AgentMetadata | null> {
    const allowLoopback = loopbackClientsAllowed();
    const url = clientIdUrl(clientId, allowLoopback);
    if (!url) return null;
    const hit = clients.get(url.toString());
    if (hit && hit.until > now()) return hit.value;
    if ((failed.get(url.toString()) ?? 0) > now()) return hit?.value ?? null;
    try {
      const value = validateMetadata(url, await fetchJson(url.toString()), allowLoopback);
      cap(clients);
      clients.set(url.toString(), { value, until: now() + TTL });
      return value;
    } catch {
      cap(failed);
      failed.set(url.toString(), now() + RETRY);
      return null;
    }
  }

  async function keys(jwksUri: string, kid?: string): Promise<PublicJwk[]> {
    const hit = keySets.get(jwksUri);
    const fresh = hit && hit.until > now();
    const missing = kid !== undefined && !hit?.value.some((k) => k.kid === kid);
    const mayRefetch = !hit || now() - hit.fetchedAt >= RETRY;
    if (fresh && !(missing && mayRefetch)) return hit.value;
    if (!mayRefetch) return hit?.value ?? [];
    if (!hit && (failed.get(jwksUri) ?? 0) > now()) return [];
    try {
      const value = validateJwks(await fetchJson(jwksUri));
      cap(keySets);
      keySets.set(jwksUri, { value, until: now() + TTL, fetchedAt: now() });
      return value;
    } catch {
      if (hit) hit.fetchedAt = now();
      else {
        cap(failed);
        failed.set(jwksUri, now() + RETRY);
      }
      return hit?.value ?? [];
    }
  }

  return { client, keys };
}

// The shared instance used by the app.
export const agentMetadata = createAgentMetadata();
