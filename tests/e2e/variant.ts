// A second app server with different experiment flags (HITL_HANDOFF_MODE,
// HITL_AUTORESUME, HITL_GATE_STATUS are fixed per run, so each variant needs its
// own process). It reuses the production build made by the main web server and
// the same test database.
import { spawn, type ChildProcess } from "node:child_process";
import { e2eAppEnv } from "./env";

export interface Variant {
  origin: string;
  stop: () => Promise<void>;
}

export async function startVariant(port: number, flags: Record<string, string>): Promise<Variant> {
  const origin = `http://localhost:${port}`;
  const child: ChildProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    env: { ...process.env, ...e2eAppEnv(origin), ...flags },
    stdio: "ignore",
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const up = await fetch(`${origin}/`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    origin,
    stop: async () => {
      // Kill the whole process group (npx and the Next.js server under it).
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}
