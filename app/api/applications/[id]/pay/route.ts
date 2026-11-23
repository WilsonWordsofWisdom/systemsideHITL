import { journeyAction } from "@/lib/journey/handler";
import { payFee } from "@/lib/journey/service";

// pay_fee (step 7): mock $50 payment. High risk; gated in Phase 2.
export async function POST(request: Request, ctx: RouteContext<"/api/applications/[id]/pay">) {
  const { id } = await ctx.params;
  return journeyAction(request, {
    action: "pay_fee",
    errorPath: `/apply/${id}/pay`,
    run: async ({ db, userId }) => {
      const application = await payFee(db, userId, id);
      return { redirect: `/applications/${id}?paid=1`, json: { application } };
    },
  });
}
