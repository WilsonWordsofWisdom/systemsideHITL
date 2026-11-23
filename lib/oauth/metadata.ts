// OAuth metadata for the MCP endpoint (MCP authorization spec; RFC 8414, RFC 9728).
// The authorization server and the protected resource are this same app, so the
// issuer is APP_ORIGIN and the resource is APP_ORIGIN + /mcp (controls M1, M3).

export const MCP_SCOPE = "mcp";
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const CODE_TTL_SECONDS = 5 * 60;

export const oauthUrls = (origin: string) => ({
  issuer: origin,
  resource: `${origin}/mcp`,
  authorize: `${origin}/oauth/authorize`,
  token: `${origin}/api/oauth/token`,
  register: `${origin}/api/oauth/register`,
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
