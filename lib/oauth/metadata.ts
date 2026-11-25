// OAuth metadata for the MCP endpoint (MCP authorization spec; RFC 8414, RFC 9728).
// The authorization server and the protected resource are this same app, so the
// issuer is APP_ORIGIN and the resource is APP_ORIGIN + /mcp (controls M1, M3).

export const MCP_SCOPE = "mcp";
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const CODE_TTL_SECONDS = 5 * 60;
// Poppy sign-ins last until revoked or 30 days without use (FR45).
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const oauthUrls = (origin: string) => ({
  issuer: origin,
  resource: `${origin}/mcp`,
  authorize: `${origin}/oauth/authorize`,
  token: `${origin}/api/oauth/token`,
  register: `${origin}/api/oauth/register`,
  revoke: `${origin}/api/oauth/revoke`,
  resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
});

// RFC 8414 authorization server metadata. Public clients only, PKCE S256 only.
export function authorizationServerMetadata(origin: string) {
  const u = oauthUrls(origin);
  return {
    issuer: u.issuer,
    authorization_endpoint: u.authorize,
    token_endpoint: u.token,
    registration_endpoint: u.register,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

// With POPPY=on the same server also signs in Poppy agents (Poppy 1.0 section 3.2,
// FR45): client ID metadata documents with private_key_jwt, refresh tokens and
// revocation, named scopes, and the domain itself as a protected resource.
export function poppyAuthorizationServerMetadata(origin: string, scopes: string[]) {
  const u = oauthUrls(origin);
  return {
    ...authorizationServerMetadata(origin),
    revocation_endpoint: u.revoke,
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256", "PS384"],
    revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    scopes_supported: [MCP_SCOPE, ...scopes],
    protected_resources: [origin, u.resource],
    client_id_metadata_document_supported: true,
  };
}

// RFC 9728 metadata for the domain, which Poppy requires (resource = the origin).
export function domainResourceMetadata(origin: string, scopes: string[]) {
  return {
    resource: origin,
    authorization_servers: [oauthUrls(origin).issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: scopes,
    resource_name: "DemoGov Permits (prototype)",
  };
}

// RFC 9728 protected resource metadata for /mcp.
export function protectedResourceMetadata(origin: string) {
  const u = oauthUrls(origin);
  return {
    resource: u.resource,
    authorization_servers: [u.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [MCP_SCOPE],
    resource_name: "DemoGov Permits (prototype)",
  };
}

// Metadata and the token and registration endpoints use no cookies, so they can
// be read cross-origin by browser-based MCP clients.
export const PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Cache-Control": "no-store",
};
