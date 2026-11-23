// Reading an MCP client's revision and capabilities from a request (FR34, M6).
import { describe, expect, it } from "vitest";
import { readMcpMessage, supportsUrlElicitation } from "@/lib/mcp/request";

const caps = { elicitation: { url: {} } };

describe("readMcpMessage", () => {
  it("reads revision 2026-07-28 capabilities from every request's _meta envelope", () => {
    const msg = readMcpMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "list_applications",
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": caps,
          "io.modelcontextprotocol/clientInfo": { name: "agent", version: "1" },
        },
      },
    });
    expect(msg).toEqual({
      method: "tools/call",
      client: {
        era: "modern",
        protocolVersion: "2026-07-28",
        capabilities: caps,
        clientInfo: { name: "agent", version: "1" },
      },
    });
    expect(supportsUrlElicitation(msg.client)).toBe(true);
  });

  it("reads 2025 capabilities from initialize only", () => {
    const init = readMcpMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: { elicitation: {} }, clientInfo: {} },
    });
    expect(init.client).toMatchObject({ era: "legacy", protocolVersion: "2025-11-25" });
    expect(supportsUrlElicitation(init.client)).toBe(false);

    const call = readMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(call).toEqual({
      method: "tools/list",
      client: { era: "legacy", protocolVersion: null, capabilities: null, clientInfo: null },
    });
  });

  it("has no method for notifications, batches and bodies that aren't JSON-RPC", () => {
    expect(
      readMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }).method,
    ).toBeNull();
    expect(readMcpMessage([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]).method).toBeNull();
    expect(readMcpMessage(null).method).toBeNull();
  });
});
