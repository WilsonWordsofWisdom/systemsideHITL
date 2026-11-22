import { journeyAction } from "@/lib/journey/handler";
import { JourneyError, submitApplication } from "@/lib/journey/service";

// submit_application (step 6): the legal declaration. High risk; gated in Phase 2.
export async function POST(request: Request, ctx: RouteContext<"/api/applications/[id]/submit">) {
  const { id } = await ctx.params;
  return journeyAction(request, {
    action: "submit_application",
    errorPath: `/apply/${id}/declare`,
    run: async ({ db, userId, body }) => {
      if (!["on", "true", "agree"].includes(body.declaration ?? "")) {
        throw new JourneyError("invalid_input", "Confirm the declaration");
      }
      const application = await submitApplication(db, userId, id);
      return { redirect: `/apply/${id}/pay`, json: { application } };
    },
  });
}
