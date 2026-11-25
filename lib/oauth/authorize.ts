// Validation of an authorization request (OAuth 2.1 section 4.1.1, MCP
// authorization spec). Until the client and its exact redirect URI are known, an
// error is shown on our own page and never redirected (no open redirect).
// After that, errors go back to the registered redirect URI.
import type { AppDb } from "../db/types";
import { redirectMatches, resolveClient, type OAuthClient } from "./clients";
import { validChallenge } from "./grants";
import { MCP_SCOPE, oauthUrls } from "./metadata";
import { parseScopes } from "./scopes";

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
  prompt?: string;
}

export const AUTHORIZE_PARAM_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
  "prompt",
] as const;

export type AuthorizeCheck =
  | { kind: "fatal"; message: string }
  | { kind: "redirect_error"; url: string }
  | {
      kind: "ok";
      client: OAuthClient;
      redirectUri: string;
      state: string | null;
      codeChallenge: string;
      scope: string;
      resource: string;
    };

export function authorizationRedirect(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
  issuer: string,
) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  // RFC 9207: tell the client which authorization server answered.
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export function pickAuthorizeParams(source: Record<string, unknown>): AuthorizeParams {
  const out: AuthorizeParams = {};
  for (const name of AUTHORIZE_PARAM_NAMES) {
    const v = source[name];
    if (typeof v === "string" && v.length <= 2048) out[name] = v;
  }
  return out;
}

export async function checkAuthorizeRequest(
  db: AppDb,
  p: AuthorizeParams,
  origin: string,
): Promise<AuthorizeCheck> {
  const u = oauthUrls(origin);
  const client = await resolveClient(db, p.client_id);
  if (!client) return { kind: "fatal", message: "This application isn't registered." };
  if (!p.redirect_uri || !redirectMatches(client, p.redirect_uri)) {
    return {
      kind: "fatal",
      message: "The return address doesn't match the registered application.",
    };
  }
  const state = p.state && p.state.length <= 500 ? p.state : null;
  const fail = (error: string, description: string): AuthorizeCheck => ({
    kind: "redirect_error",
    url: authorizationRedirect(
      p.redirect_uri!,
      { error, error_description: description, state },
      u.issuer,
    ),
  });
  if (p.response_type !== "code")
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (p.code_challenge_method !== "S256" || !validChallenge(p.code_challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (client.kind === "poppy") {
    // Poppy agents name the scopes they need (Poppy 4.7). A sign-in without
    // `resource` covers the whole domain; one with it covers that service only.
    const scopes = parseScopes(p.scope);
    if (!scopes) return fail("invalid_scope", "Ask for one or more of the scopes this site lists.");
    if (p.resource && p.resource !== origin && p.resource !== u.resource) {
      return fail("invalid_target", "Unknown resource.");
    }
    return {
      kind: "ok",
      client,
      redirectUri: p.redirect_uri,
      state,
      codeChallenge: p.code_challenge!,
      scope: scopes.join(" "),
      resource: p.resource ?? origin,
    };
  }
  if (p.resource && p.resource !== u.resource) return fail("invalid_target", "Unknown resource.");
  const scopes = (p.scope ?? MCP_SCOPE).split(" ").filter(Boolean);
  if (scopes.some((s) => s !== MCP_SCOPE))
    return fail("invalid_scope", `Only the "${MCP_SCOPE}" scope is supported.`);
  return {
    kind: "ok",
    client,
    redirectUri: p.redirect_uri,
    state,
    codeChallenge: p.code_challenge!,
    scope: MCP_SCOPE,
    resource: u.resource,
  };
}

// Sign-in may return only to the authorization page (used by /login?next=).
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  if (!value.startsWith("/oauth/authorize?") || value.includes("\\") || value.startsWith("//")) {
    return null;
  }
  return value;
}
