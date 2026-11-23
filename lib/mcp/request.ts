// What an MCP request says about its client (FR34, control M6). Revision
// 2026-07-28 carries the client's capabilities in every request's `_meta`
// envelope; the 2025 revisions declare them once, in `initialize`. Legacy
// requests are served statelessly, so the capabilities from the session's
// latest `initialize` are read back from request_log.
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { and, desc, eq } from "drizzle-orm";
import { requestLog } from "../db/schema";
import type { AppDb } from "../db/types";

export type McpEra = "modern" | "legacy";

export interface McpClientInfo {
  era: McpEra;
  protocolVersion: string | null;
  capabilities: Record<string, unknown> | null;
  clientInfo: Record<string, unknown> | null;
}

export interface McpMessage {
  // The JSON-RPC method of a single request; null for notifications, responses,
  // batches and bodies that aren't JSON.
  method: string | null;
  client: McpClientInfo;
}

const obj = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 40) : null);

export function readMcpMessage(body: unknown): McpMessage {
  const msg = obj(body);
  const params = obj(msg?.params);
  const meta = obj(params?._meta);
  const isRequest = msg !== null && typeof msg.method === "string" && msg.id !== undefined;
  const method = isRequest ? (msg.method as string).slice(0, 60) : null;
  if (meta && PROTOCOL_VERSION_META_KEY in meta) {
    return {
      method,
      client: {
        era: "modern",
        protocolVersion: str(meta[PROTOCOL_VERSION_META_KEY]),
        capabilities: obj(meta[CLIENT_CAPABILITIES_META_KEY]),
        clientInfo: obj(meta[CLIENT_INFO_META_KEY]),
      },
    };
  }
  const init = method === "initialize";
  return {
    method,
    client: {
      era: "legacy",
      protocolVersion: init ? str(params?.protocolVersion) : null,
      capabilities: init ? obj(params?.capabilities) : null,
      clientInfo: init ? obj(params?.clientInfo) : null,
    },
  };
}

// The capabilities a legacy client declared in this session's latest initialize.
export async function legacyClientInfo(db: AppDb, sessionId: string): Promise<McpClientInfo> {
  const [row] = await db
    .select({ signals: requestLog.actorSignals })
    .from(requestLog)
    .where(and(eq(requestLog.sessionId, sessionId), eq(requestLog.pathOrTool, "initialize")))
    .orderBy(desc(requestLog.ts))
    .limit(1);
  const logged = obj(row?.signals.mcp);
  return {
    era: "legacy",
    protocolVersion: str(logged?.protocolVersion),
    capabilities: obj(logged?.capabilities),
    clientInfo: obj(logged?.clientInfo),
  };
}

export function supportsUrlElicitation(client: McpClientInfo) {
  return obj(obj(client.capabilities?.elicitation)?.url) !== null;
}
