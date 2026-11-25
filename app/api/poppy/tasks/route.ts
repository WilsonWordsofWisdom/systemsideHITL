import { appConfig } from "@/lib/app";
import { poppyOn } from "@/lib/flags";
import { getPolicy } from "@/lib/hitl/policy";
import { tasksResponse } from "@/lib/poppy/discovery";
import { notFound, versionProblem } from "@/lib/poppy/version";

export const dynamic = "force-dynamic";

// Poppy tasks endpoint (Poppy 1.0 section 9, FR42): tasks agents may not do, taken
// from the policy file, and the feedback endpoint. The same for every caller, so
// the Session header is not needed to answer it.
export function GET(request: Request) {
  if (!poppyOn()) return notFound();
  const problem = versionProblem(request);
  if (problem) return problem;
  return Response.json(tasksResponse(appConfig().appOrigin, getPolicy()), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
