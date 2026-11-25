import { appConfig } from "@/lib/app";
import { poppyOn } from "@/lib/flags";
import { poppyDocument } from "@/lib/poppy/discovery";
import { notFound } from "@/lib/poppy/version";

export const dynamic = "force-dynamic";

// /.well-known/poppy.json (Poppy 1.0 section 3, FR42): only with POPPY=on.
export function GET() {
  if (!poppyOn()) return notFound();
  return Response.json(poppyDocument(appConfig().appOrigin), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
