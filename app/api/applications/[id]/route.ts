import { journeyAction, journeyRead } from "@/lib/journey/handler";
import { deleteApplication, getApplication, journeyState } from "@/lib/journey/service";

// get_application (steps 2 and 5), with where it is in the journey.
export async function GET(_request: Request, ctx: RouteContext<"/api/applications/[id]">) {
  const { id } = await ctx.params;
  return journeyRead(async ({ db, userId }) => {
    const application = await getApplication(db, userId, id);
    return { application, journey: journeyState(application) };
  });
}

// delete_application (step 9), JSON callers. Forms use POST .../delete.
export async function DELETE(request: Request, ctx: RouteContext<"/api/applications/[id]">) {
  const { id } = await ctx.params;
  return journeyAction(request, {
    action: "delete_application",
    resourceId: id,
    errorPath: `/applications/${id}/delete`,
    run: async ({ db, userId }) => {
      await deleteApplication(db, userId, id);
      return { redirect: "/applications?deleted=1", json: { ok: true } };
    },
  });
}
