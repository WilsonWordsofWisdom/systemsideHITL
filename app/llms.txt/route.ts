import { LLMS_TXT } from "@/lib/agent-hints";
import { agentHintsOn } from "@/lib/flags";

export const dynamic = "force-dynamic";

// /llms.txt (FR41): only when AGENT_HINTS=on; 404 in baseline runs.
export function GET() {
  if (!agentHintsOn()) return new Response("Not found", { status: 404 });
  return new Response(LLMS_TXT, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
