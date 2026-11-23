import { journeyAction } from "@/lib/journey/handler";
import { updateDraft } from "@/lib/journey/service";

// update_draft (step 3).
export async function POST(request: Request, ctx: RouteContext<"/api/applications/[id]/details">) {
  const { id } = await ctx.params;
  return journeyAction(request, {
    action: "update_draft",
    errorPath: `/apply/${id}/details`,
    run: async ({ db, userId, body }) => {
      const application = await updateDraft(db, userId, id, body);
      return { redirect: `/apply/${id}/documents`, json: { application } };
    },
  });
}
