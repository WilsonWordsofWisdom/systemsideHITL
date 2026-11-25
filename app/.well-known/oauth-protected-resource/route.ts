import { poppyOn } from "@/lib/flags";
import { notFound } from "@/lib/poppy/version";
import { GET as mcpMetadata, OPTIONS } from "./mcp/route";

export const dynamic = "force-dynamic";
export { OPTIONS };

// RFC 9728 metadata at the root location, for clients that don't add the path.
// With POPPY=on this location is the domain's metadata for Poppy, which may only
// name an issuer that meets Poppy's sign-in rules (slice C). Until then it answers
// 404, meaning "no issuer" (Poppy 1.0 section 3.2). MCP clients use the /mcp form
// named in the WWW-Authenticate challenge, so they are unaffected.
export function GET() {
  if (poppyOn()) return notFound();
  return mcpMetadata();
}
