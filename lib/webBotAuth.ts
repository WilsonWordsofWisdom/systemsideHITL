// Web Bot Auth: RFC 9421 HTTP Message Signatures from automated clients
// (draft-ietf-webbotauth-httpsig-protocol-01, FR37, controls A4, A7). A valid
// signature is tier A evidence that this one request comes from the agent named by
// its Signature-Agent URL. It can only make a request look more like an agent, so
// it never loosens a decision; any failure means "no signature signal".
// Only Ed25519 is supported. @authority is checked against the configured origin,
// never against the request's Host header (control S7).
import { createHash, webcrypto } from "node:crypto";
import {
  parseDictionary,
  parseItem,
  serializeInnerList,
  serializeItem,
  type Dictionary,
  type InnerList,
  type Item,
} from "structured-headers";
import { appConfig } from "./app";
import { createKeyResolver, type Ed25519Jwk, type KeyResolver } from "./webBotAuthDirectory";

export const WEB_BOT_AUTH_TAG = "web-bot-auth";
const MAX_LABELS = 5;
const SKEW_SECONDS = 60;
const DEFAULT_MAX_LIFETIME_SECONDS = 24 * 3600; // Draft 5.2: expires within 24 h.

export interface WebBotAuthResult {
  // The Signature-Agent URL without its query: the agent's identifier.
  agent: string;
  keyid: string;
  label: string;
}

export interface VerifyOptions {
  origin: string; // e.g. https://hitltest.vercel.app
  resolveKey: KeyResolver;
  now?: Date;
  maxLifetimeSeconds?: number;
}

// RFC 8037 appendix A.3 thumbprint, the keyid Web Bot Auth requires.
export function jwkThumbprint(jwk: Ed25519Jwk): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("base64url");
}

const isInnerList = (v: Item | InnerList): v is InnerList => Array.isArray(v[0]);

// The value of one covered component (RFC 9421 section 2), or null if it can't be
// produced (missing header, unsupported component or parameter).
function componentValue(
  request: Request,
  origin: URL,
  name: string,
  params: Map<string, unknown>,
): string | null {
  const url = new URL(request.url);
  const onlyKey = [...params.keys()].every((k) => k === "key");
  if (!onlyKey) return null;
  if (name.startsWith("@")) {
    if (params.size) return null;
    switch (name) {
      case "@method":
        return request.method;
      case "@authority":
        return origin.host;
      case "@scheme":
        return origin.protocol.replace(":", "");
      case "@target-uri":
        return `${origin.origin}${url.pathname}${url.search}`;
      case "@path":
        return url.pathname || "/";
      case "@query":
        return url.search || "?";
      default:
        return null;
    }
  }
  const raw = request.headers.get(name);
  if (raw === null) return null;
  const key = params.get("key");
  if (key === undefined) return raw.trim();
  if (typeof key !== "string") return null;
  try {
    const member = parseDictionary(raw).get(key);
    if (!member) return null;
    return isInnerList(member) ? serializeInnerList(member) : serializeItem(member);
  } catch {
    return null;
  }
}

// The signature base for one Signature-Input member (RFC 9421 section 2.5).
export function signatureBase(request: Request, origin: URL, input: InnerList): string | null {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const component of input[0]) {
    const [name, params] = component;
    if (typeof name !== "string") return null;
    const id = serializeItem(component);
    if (seen.has(id)) return null;
    seen.add(id);
    const value = componentValue(request, origin, name, params);
    if (value === null) return null;
    lines.push(`${id}: ${value}`);
  }
  lines.push(`"@signature-params": ${serializeInnerList(input)}`);
  return lines.join("\n");
}

// The Signature-Agent member a label names: dictionary form, or the legacy bare
// string (draft 5.2.1), which the signature then covers without a key.
function signatureAgentFor(
  request: Request,
  label: string,
): { url: string; component: string } | null {
  const raw = request.headers.get("signature-agent")?.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('"')) {
      const [value, params] = parseItem(raw);
      if (typeof value !== "string" || params.size) return null;
      return { url: value, component: '"signature-agent"' };
    }
    const member = parseDictionary(raw).get(label);
    if (!member || isInnerList(member) || typeof member[0] !== "string" || member[1].size) {
      return null;
    }
    return {
      url: member[0],
      component: serializeItem(["signature-agent", new Map([["key", label]])]),
    };
  } catch {
    return null;
  }
}

function identifierOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

async function verifyLabel(
  request: Request,
  opts: VerifyOptions,
  origin: URL,
  label: string,
  input: Item | InnerList,
  signatures: Dictionary,
): Promise<WebBotAuthResult | null> {
  if (!isInnerList(input)) return null;
  const p = input[1];
  if (p.get("tag") !== WEB_BOT_AUTH_TAG) return null;
  const alg = p.get("alg");
  if (alg !== undefined && alg !== "ed25519") return null;
  const keyid = p.get("keyid");
  const created = p.get("created");
  const expires = p.get("expires");
  if (typeof keyid !== "string" || !Number.isInteger(created) || !Number.isInteger(expires)) {
    return null;
  }
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const maxLife = opts.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
  if ((created as number) > now + SKEW_SECONDS) return null;
  if ((expires as number) <= now) return null;
  if ((expires as number) - (created as number) > maxLife) return null;

  // It must cover @authority and the Signature-Agent member it is attributed to.
  const covered = new Set(input[0].map((c) => serializeItem(c)));
  const agent = signatureAgentFor(request, label);
  if (!covered.has('"@authority"') || !agent || !covered.has(agent.component)) return null;
  const identifier = identifierOf(agent.url);
  if (!identifier) return null;

  const sig = signatures.get(label);
  if (!sig || isInnerList(sig) || !(sig[0] instanceof ArrayBuffer)) return null;
  const base = signatureBase(request, origin, input);
  if (base === null) return null;

  const jwk = await opts.resolveKey(agent.url, keyid);
  if (!jwk || jwkThumbprint(jwk) !== keyid) return null;
  const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  const ok = await webcrypto.subtle.verify("Ed25519", key, sig[0], new TextEncoder().encode(base));
  return ok ? { agent: identifier, keyid, label } : null;
}

// Verifies the request's Web Bot Auth signatures; the first valid one wins.
export async function verifyWebBotAuth(
  request: Request,
  opts: VerifyOptions,
): Promise<WebBotAuthResult | null> {
  const inputHeader = request.headers.get("signature-input");
  const sigHeader = request.headers.get("signature");
  if (!inputHeader || !sigHeader) return null;
  let inputs: Dictionary;
  let signatures: Dictionary;
  try {
    inputs = parseDictionary(inputHeader);
    signatures = parseDictionary(sigHeader);
  } catch {
    return null;
  }
  const origin = new URL(opts.origin);
  for (const [label, input] of [...inputs].slice(0, MAX_LABELS)) {
    try {
      const result = await verifyLabel(request, opts, origin, label, input, signatures);
      if (result) return result;
    } catch {
      // A malformed key or signature is no signal, never an error.
    }
  }
  return null;
}

let sharedResolver: KeyResolver | undefined;

// The classifier's view (tier A): the agent a valid signature names, or null.
export async function webBotAuthAgent(
  request: Request,
): Promise<{ source: "web_bot_auth"; agent: string } | null> {
  if (!request.headers.has("signature-input")) return null;
  sharedResolver ??= createKeyResolver({ thumbprint: jwkThumbprint });
  try {
    const result = await verifyWebBotAuth(request, {
      origin: appConfig().appOrigin,
      resolveKey: sharedResolver,
    });
    return result ? { source: "web_bot_auth", agent: result.agent } : null;
  } catch {
    return null;
  }
}
