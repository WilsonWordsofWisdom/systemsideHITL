import { journeyAction, journeyRead } from "@/lib/journey/handler";
import { getContact, updateContact } from "@/lib/journey/service";

export async function GET() {
  return journeyRead(async ({ db, userId }) => ({ contact: await getContact(db, userId) }));
}

// update_contact (step 8): recovery email or phone. Critical; denied to agents in Phase 2.
function update(request: Request) {
  return journeyAction(request, {
    action: "update_contact",
    errorPath: "/account/contact",
    run: async ({ db, userId, body }) => {
      const contact = await updateContact(db, userId, body);
      return { redirect: "/account/contact?saved=1", json: { contact } };
    },
  });
}

// PUT for API callers (spec section 3); POST for HTML forms.
export const PUT = update;
export const POST = update;
