import { AGENTS_MD } from "@/lib/agent-hints";
import { agentHintsOn } from "@/lib/flags";

export const dynamic = "force-dynamic";

// /agents.md (FR41): only when AGENT_HINTS=on; 404 in baseline runs.
export function GET() {
  if (!agentHintsOn()) return new Response("Not found", { status: 404 });
  return new Response(AGENTS_MD, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
  });
}
