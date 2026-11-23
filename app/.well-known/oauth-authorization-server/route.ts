import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { PUBLIC_CORS, authorizationServerMetadata } from "@/lib/oauth/metadata";

// RFC 8414 authorization server metadata (FR30, control M1).
export function GET() {
  return NextResponse.json(authorizationServerMetadata(appConfig().appOrigin), {
    headers: PUBLIC_CORS,
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
