import { journeyAction } from "@/lib/journey/handler";
import { attachDocument } from "@/lib/journey/service";

// attach_document (step 4). Accepts a file upload (forms) or metadata (API).
// Only the name, type and size are kept; the file content is discarded (control S6).
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/applications/[id]/documents">,
) {
  const { id } = await ctx.params;
  return journeyAction(request, {
    action: "attach_document",
    resourceId: id,
    errorPath: `/apply/${id}/documents`,
    run: async ({ db, userId, body, formData }) => {
      const file = formData?.get("document");
      const meta =
        file instanceof File
          ? { name: file.name, type: file.type, size: file.size }
          : { name: body.name, type: body.type, size: Number(body.size) };
      const application = await attachDocument(db, userId, id, meta);
      return { redirect: `/apply/${id}/documents?added=1`, json: { application } };
    },
  });
}
