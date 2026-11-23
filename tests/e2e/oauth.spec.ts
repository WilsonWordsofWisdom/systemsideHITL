// The MCP OAuth server end to end (FR30, controls M1-M3): metadata, registration,
// sign-in and consent in the browser, code exchange with PKCE, and refusals.
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { decodeJwt } from "jose";
import { ORIGIN } from "./helpers";
import {
  CALLBACK,
  authorizeUrl,
  captureCallback,
  register,
  signInHere,
  verifier,
} from "./oauth-helpers";

test.describe.configure({ mode: "serial" });
test("metadata is published for the authorization server and the /mcp resource", async ({
  request,
}) => {
  const as = await request.get("/.well-known/oauth-authorization-server");
  expect(as.headers()["access-control-allow-origin"]).toBe("*");
  expect(await as.json()).toMatchObject({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/api/oauth/token`,
    code_challenge_methods_supported: ["S256"],
  });
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    const pr = await request.get(path);
    expect(await pr.json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
    });
  }
});

test("sign in, consent, and exchange the code for a token acting for the user (M1, M3)", async ({
  page,
}) => {
  const clientId = await register(page);
  const callback = await captureCallback(page);

  await page.goto(authorizeUrl(clientId));
  await expect(page).toHaveURL(/\/login\?next=/);
  await signInHere(page);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Allow Test MCP agent to use your account?",
  );
  await expect(page.getByRole("main")).toContainText("still needs your approval with your passkey");
  await expect(page.getByRole("main")).toContainText("127.0.0.1:9");
  await page.getByRole("button", { name: "Allow access" }).click();

  await expect.poll(() => callback()?.pathname).toBe("/callback");
  const url = callback()!;
  expect(url.searchParams.get("state")).toBe("state-123");
  expect(url.searchParams.get("iss")).toBe(ORIGIN);
  const code = url.searchParams.get("code")!;

  const exchange = (c: string, v = verifier) =>
    page.request.post("/api/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code: c,
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_verifier: v,
        resource: `${ORIGIN}/mcp`,
      },
    });
  const token = await exchange(code);
  expect(token.status()).toBe(200);
  const body = await token.json();
  expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
  expect(decodeJwt(body.access_token)).toMatchObject({
    iss: ORIGIN,
    aud: `${ORIGIN}/mcp`,
    client_id: clientId,
    act: { sub: clientId },
  });

  // The same code again is refused.
  const replay = await exchange(code);
  expect(replay.status()).toBe(400);
  expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
});

test("a wrong PKCE verifier is refused", async ({ page }) => {
  const clientId = await register(page);
  const callback = await captureCallback(page);
  await page.goto(authorizeUrl(clientId));
  await signInHere(page);
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect.poll(() => callback()?.searchParams.get("code")).toBeTruthy();
  const res = await page.request.post("/api/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: callback()!.searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: randomBytes(32).toString("base64url"),
    },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_grant" });
});

test("denying consent returns access_denied to the client", async ({ page }) => {
  const clientId = await register(page);
  const callback = await captureCallback(page);
  await page.goto(authorizeUrl(clientId));
  await signInHere(page);
  await page.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => callback()?.searchParams.get("error")).toBe("access_denied");
  expect(callback()!.searchParams.has("code")).toBe(false);
});

test("an unregistered redirect URI is shown as an error here, never followed", async ({ page }) => {
  const clientId = await register(page);
  let left = false;
  await page.route("https://evil.example/**", (route) => {
    left = true;
    return route.abort();
  });
  await page.goto(authorizeUrl(clientId, { redirect_uri: "https://evil.example/cb" }));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This request can't continue");
  expect(left).toBe(false);
});

test("registration refuses non-loopback http redirect URIs (M2)", async ({ request }) => {
  const res = await request.post("/api/oauth/register", {
    data: { client_name: "Bad", redirect_uris: ["http://evil.example/cb"] },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
});

test("sign-in ignores a return path other than the consent page", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent("https://evil.example/")}`);
  await signInHere(page);
  await expect(page).toHaveURL(/\/applications$/);
});
