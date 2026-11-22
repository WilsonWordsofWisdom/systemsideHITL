import { journeyAction, journeyRead } from "@/lib/journey/handler";
import { createDraft, listApplications } from "@/lib/journey/service";

// list_applications (step 2).
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? undefined;
  return journeyRead(async ({ db, userId }) => ({
    applications: await listApplications(db, userId, q),
  }));
}

// create_draft (step 3).
export async function POST(request: Request) {
  return journeyAction(request, {
    action: "create_draft",
    errorPath: "/applications",
    run: async ({ db, userId, body }) => {
      const app = await createDraft(db, userId, body.title);
      return { redirect: `/apply/${app.id}/details`, json: { application: app } };
    },
  });
}
