import { NextResponse } from "next/server";
import { appConfig } from "@/lib/app";
import { poppyOn } from "@/lib/flags";
import {
  PUBLIC_CORS,
  authorizationServerMetadata,
  poppyAuthorizationServerMetadata,
} from "@/lib/oauth/metadata";
import { POPPY_SCOPES } from "@/lib/oauth/scopes";

export const dynamic = "force-dynamic";

// RFC 8414 authorization server metadata (FR30, control M1). With POPPY=on it also
// describes Poppy sign-in (FR45): refresh tokens, revocation, private_key_jwt.
export function GET() {
  const origin = appConfig().appOrigin;
  return NextResponse.json(
    poppyOn()
      ? poppyAuthorizationServerMetadata(origin, Object.keys(POPPY_SCOPES))
      : authorizationServerMetadata(origin),
    { headers: PUBLIC_CORS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
