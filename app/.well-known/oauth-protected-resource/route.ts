import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { poppyOn } from "@/lib/flags";
import { PUBLIC_CORS, domainResourceMetadata } from "@/lib/oauth/metadata";
import { POPPY_SCOPES } from "@/lib/oauth/scopes";
import { GET as mcpMetadata, OPTIONS } from "./mcp/route";

export const dynamic = "force-dynamic";
export { OPTIONS };

// RFC 9728 metadata at the root location. Without POPPY it repeats the /mcp
// metadata for clients that don't add the path. With POPPY=on it describes the
// domain itself, which Poppy requires (resource = the origin, Poppy 1.0 section
// 3.2); MCP clients use the /mcp form named in the WWW-Authenticate challenge.
export function GET() {
  if (!poppyOn()) return mcpMetadata();
  return NextResponse.json(
    domainResourceMetadata(appConfig().appOrigin, Object.keys(POPPY_SCOPES)),
    { headers: PUBLIC_CORS },
  );
}
