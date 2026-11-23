// A second app server with different experiment flags (HITL_HANDOFF_MODE,
// HITL_AUTORESUME, HITL_GATE_STATUS, HITL_MODE are fixed per run, so each variant
// needs its own process). It reuses the production build made by the main web
// server and the same test database.
import { spawn } from "node:child_process";
import { e2eAppEnv } from "./env";

export interface Variant {
  origin: string;
  stop: () => Promise<void>;
}

const up = (origin: string) =>
  fetch(`${origin}/`).then(
    (r) => r.ok,
    () => false,
  );

async function waitFor(check: () => Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export async function startVariant(port: number, flags: Record<string, string>): Promise<Variant> {
  const origin = `http://localhost:${port}`;
  // A server still on this port would answer for the new one; wait for it to go.
  await waitFor(async () => !(await up(origin)), 15_000, `port ${port} to be free`);
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    env: { ...process.env, ...e2eAppEnv(origin), ...flags },
    stdio: "ignore",
    detached: true,
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  await waitFor(
    async () => {
      if (exited) throw new Error(`variant server on port ${port} exited during start-up`);
      return up(origin);
    },
    60_000,
    `variant server on port ${port}`,
  );
  return {
    origin,
    stop: async () => {
      // Kill the whole process group (npx and the Next.js server under it), then
      // wait until the port is closed so the next variant can bind it.
      if (child.pid && !exited) process.kill(-child.pid, "SIGTERM");
      await waitFor(async () => !(await up(origin)), 15_000, `port ${port} to close`);
    },
  };
}
