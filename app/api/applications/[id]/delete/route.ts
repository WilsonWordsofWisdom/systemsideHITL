import { journeyAction } from "@/lib/journey/handler";
import { deleteApplication } from "@/lib/journey/service";

// delete_application (step 9) for HTML forms, which can't send DELETE.
export async function POST(request: Request, ctx: RouteContext<"/api/applications/[id]/delete">) {
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
