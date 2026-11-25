// Web Bot Auth key directories (draft-ietf-webbotauth-httpsig-protocol-01 section
// 5.5, controls A5). The URL comes from the client's Signature-Agent header, so the
// fetch is guarded against SSRF: HTTPS on port 443 only, no redirects, a timeout,
// size and key-count caps, and every address the host resolves to must be public.
// The address check runs in the connection's own DNS lookup, so a name can't
// resolve to a public address for the check and a private one for the connection.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { get } from "node:https";
import { BlockList, isIP } from "node:net";

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

const MAX_BYTES = 64 * 1024;
const MAX_KEYS = 20;
const TIMEOUT_MS = 2_000;
const DIRECTORY_TYPE = "application/http-message-signatures-directory+json";
const WELL_KNOWN = "/.well-known/http-message-signatures-directory";

// The RFC 9421 example key must never verify production traffic (draft 6.8).
export const TEST_KEY_X = "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

// IPv4 addresses embedded in IPv6 (mapped ::ffff:a.b.c.d and NAT64 64:ff9b::/96)
// are checked as the IPv4 address they reach.
function embeddedIpv4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(
    ip,
  );
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family !== 6) return false;
  const v4 = embeddedIpv4(ip.toLowerCase());
  if (v4) return isPublicAddress(v4);
  return !blocked.check(ip, "ipv6");
}

// A directory URL we are willing to fetch, or null.
export function directoryUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not_a_url";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password) return "credentials";
  if (url.port && url.port !== "443") return "port";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // An IP literal skips DNS, so it is checked here.
  if (isIP(host) && !isPublicAddress(host)) return "private_address";
  if (!isIP(host) && !host.includes(".")) return "not_a_public_name";
  return null;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function publicLookup(hostname: string, options: { all?: boolean }, cb: LookupCallback) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, "");
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }), "");
    }
    if (options.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
}

function validJwk(k: unknown): k is Ed25519Jwk {
  const j = k as Partial<Ed25519Jwk> | null;
  return (
    !!j &&
    j.kty === "OKP" &&
    j.crv === "Ed25519" &&
    typeof j.x === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(j.x)
  );
}

export type DirectoryFetch = (url: string) => Promise<Ed25519Jwk[]>;

// Fetches a JSON document from a URL another party supplied, with the SSRF guard
// above: HTTPS on 443 only, every resolved address public, no redirects, a timeout
// and a size cap. Throws on any failure. Also used for Poppy agent metadata.
export function fetchPublicJson(
  raw: string,
  opts: { accept: string; maxBytes?: number },
): Promise<{ contentType: string; body: unknown }> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  return new Promise((resolve, reject) => {
    const problem = directoryUrlProblem(raw);
    if (problem) return reject(new Error(problem));
    const url = new URL(raw);
    const req = get(
      url,
      { lookup: publicLookup as never, timeout: TIMEOUT_MS, headers: { accept: opts.accept } },
      (res) => {
        // Any status but 200 is a failure, and redirects are never followed.
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`status ${res.statusCode}`));
        }
        const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error("too_large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          try {
            resolve({ contentType, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            reject(new Error("not_json"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// Fetches and validates a JWK Set; throws on any failure (a discovery failure).
export const fetchDirectory: DirectoryFetch = async (raw) => {
  const { contentType, body } = await fetchPublicJson(raw, {
    accept: `${DIRECTORY_TYPE}, application/json;q=0.5`,
  });
  const okType =
    contentType === DIRECTORY_TYPE ||
    (new URL(raw).pathname !== WELL_KNOWN && contentType === "application/json");
  if (!okType) throw new Error("content_type");
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length > MAX_KEYS) throw new Error("not_a_directory");
  return keys.filter(validJwk).map(({ kty, crv, x }) => ({ kty, crv, x }));
};

export type KeyResolver = (identifier: string, keyid: string) => Promise<Ed25519Jwk | null>;

interface CacheEntry {
  keys: Ed25519Jwk[];
  until: number;
}

// A cached resolver: a directory that resolves replaces the cached copy; a failed
// fetch never evicts it (draft 6.10) and is retried after a minute.
export function createKeyResolver(opts: {
  fetch?: DirectoryFetch;
  thumbprint: (jwk: Ed25519Jwk) => string;
  allowTestKeys?: boolean;
  ttlMs?: number;
  now?: () => number;
}): KeyResolver {
  const fetchKeys = opts.fetch ?? fetchDirectory;
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const failedUntil = new Map<string, number>();
  const MAX_ENTRIES = 200;

  return async (identifier, keyid) => {
    let entry = cache.get(identifier);
    if (!entry || entry.until <= now()) {
      if ((failedUntil.get(identifier) ?? 0) <= now()) {
        try {
          const keys = await fetchKeys(identifier);
          entry = { keys, until: now() + ttl };
          if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
          cache.set(identifier, entry);
          failedUntil.delete(identifier);
        } catch {
          if (failedUntil.size >= MAX_ENTRIES) failedUntil.clear();
          failedUntil.set(identifier, now() + 60_000);
        }
      }
    }
    const key = entry?.keys.find((k) => opts.thumbprint(k) === keyid) ?? null;
    if (key && key.x === TEST_KEY_X && !opts.allowTestKeys) return null;
    return key;
  };
}
