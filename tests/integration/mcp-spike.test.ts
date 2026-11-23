// Phase 4 spike (implementation plan, Phase 4): confirm that the MCP SDK runs as a
// stateless, per-request server behind a web-standard Request -> Response handler
// (the shape of a Next.js route handler), and answers a tool call from the SDK
// client on revision 2026-07-28 (modern era) and on 2025-11-25 (legacy era).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// One factory serves both eras: createMcpHandler routes 2026-07-28 requests to the
// modern path (server/discover, per-request envelope) and 2025-era requests to a
// stateless initialize-based fallback. A fresh server is built per request.
const mcp = createMcpHandler(
  () => {
    const server = new McpServer({ name: "demogov-spike", version: "0.0.1" });
    server.registerTool(
      "ping",
      {
        description: "Returns the text it is given.",
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => ({ content: [{ type: "text", text: `pong: ${text}` }] }),
    );
    return server;
  },
  { legacy: "stateless" },
);

// The handler a Next.js route would export: web-standard Request in, Response out.
const handler = (request: Request) => mcp.fetch(request);

type ClientOptions = ConstructorParameters<typeof Client>[1];

async function connect(options?: ClientOptions) {
  const client = new Client({ name: "spike-client", version: "0.0.1" }, options);
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (url, init) => handler(new Request(url, init)),
  });
  await client.connect(transport);
  return client;
}

describe("MCP SDK spike", () => {
  it("negotiates 2026-07-28 (modern era, server/discover) when pinned, and calls a tool", async () => {
    const client = await connect({ versionNegotiation: { mode: { pin: "2026-07-28" } } });
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["ping"]);
    const result = await client.callTool({ name: "ping", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "pong: hi" }]);
    await client.close();
  });

  it("auto mode discovers 2026-07-28 against this server", async () => {
    const client = await connect({ versionNegotiation: { mode: "auto" } });
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    await client.close();
  });

  it("negotiates 2025-11-25 (legacy era, initialize) and calls a tool", async () => {
    const client = await connect({ supportedProtocolVersions: ["2025-11-25"] });
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    const result = await client.callTool({ name: "ping", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "pong: hi" }]);
    await client.close();
  });

  it("a default client uses the legacy handshake (the SDK's default mode)", async () => {
    const client = await connect();
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    await client.close();
  });
});
