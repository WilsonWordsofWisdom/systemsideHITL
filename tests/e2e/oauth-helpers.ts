// Shared OAuth steps for the e2e specs: register a client, sign in and consent in
// the browser, capture the loopback callback and exchange the code for a token.
import { createHash, randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { DEMO, ORIGIN, PASSWORD } from "./helpers";

export const CALLBACK = "http://127.0.0.1:9/callback";

export const verifier = randomBytes(32).toString("base64url");
export const challenge = createHash("sha256").update(verifier).digest("base64url");

export async function register(page: Page, name = "Test MCP agent", origin = ORIGIN) {
  const res = await page.request.post(`${origin}/api/oauth/register`, {
    data: { client_name: name, redirect_uris: [CALLBACK] },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).client_id as string;
}

export function authorizeUrl(clientId: string, over: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "mcp",
    resource: `${ORIGIN}/mcp`,
    ...over,
  });
  return `/oauth/authorize?${q}`;
}

// The client's loopback callback, answered by the test instead of a real server.
export async function captureCallback(page: Page) {
  let seen: URL | null = null;
  await page.route("http://127.0.0.1:9/**", (route) => {
    seen = new URL(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>callback</p>" });
  });
  return () => seen as URL | null;
}

export async function signInHere(page: Page) {
  await page.getByLabel("Email address").fill(DEMO.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// The whole flow: a registered client and a bearer token for /mcp as the demo user,
// from the main server or a variant server (each token is bound to its origin).
export async function mcpToken(page: Page, name = "Test MCP agent", origin = ORIGIN) {
  const clientId = await register(page, name, origin);
  const callback = await captureCallback(page);
  await page.goto(`${origin}${authorizeUrl(clientId, { resource: `${origin}/mcp` })}`);
  if (page.url().includes("/login")) await signInHere(page);
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect.poll(() => callback()?.searchParams.get("code")).toBeTruthy();
  const res = await page.request.post(`${origin}/api/oauth/token`, {
    form: {
      grant_type: "authorization_code",
      code: callback()!.searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    },
  });
  expect(res.status()).toBe(200);
  return { clientId, token: (await res.json()).access_token as string };
}
