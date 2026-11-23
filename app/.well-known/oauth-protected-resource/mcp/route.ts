import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { PUBLIC_CORS, protectedResourceMetadata } from "@/lib/oauth/metadata";

// RFC 9728 protected resource metadata for /mcp (path-suffixed form).
export function GET() {
  return NextResponse.json(protectedResourceMetadata(appConfig().appOrigin), {
    headers: PUBLIC_CORS,
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
