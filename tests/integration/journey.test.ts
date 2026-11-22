// Journey service: ownership (control C5), state machine (J02, J04) and inputs (S5, S6).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "@/lib/db/types";
import {
  JourneyError,
  attachDocument,
  createDraft,
  deleteApplication,
  getApplication,
  getContact,
  journeyState,
  listApplications,
  payFee,
  submitApplication,
  updateContact,
  updateDraft,
} from "@/lib/journey/service";
import { DEMO_USER_ID, SECOND_USER_ID } from "@/scripts/seed";
import { createTestDb } from "../helpers/db";

let db: AppDb;
let close: () => Promise<void>;
const SECOND_APP = "00000000-0000-4000-8000-000000000201";
const DETAILS = {
  title: "Riverside Picnic",
  date: "2026-12-12",
  attendance: "80",
  location: "Riverside Park",
};

beforeAll(async () => {
  ({ db, close } = await createTestDb({ seed: true }));
});
afterAll(async () => close());

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(JourneyError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("ownership (control C5)", () => {
  it("lists only the user's own applications", async () => {
    const titles = (await listApplications(db, DEMO_USER_ID)).map((a) => a.title);
    expect(titles).toContain("Summer Street Fair");
    expect(titles).not.toContain("Neighbourhood Garage Sale");
  });

  it("treats another user's application as not found for every action", async () => {
    await expectCode(getApplication(db, DEMO_USER_ID, SECOND_APP), "not_found");
    await expectCode(updateDraft(db, DEMO_USER_ID, SECOND_APP, DETAILS), "not_found");
    await expectCode(
      attachDocument(db, DEMO_USER_ID, SECOND_APP, {
        name: "a.pdf",
        type: "application/pdf",
        size: 10,
      }),
      "not_found",
    );
    await expectCode(submitApplication(db, DEMO_USER_ID, SECOND_APP), "not_found");
    await expectCode(payFee(db, DEMO_USER_ID, SECOND_APP), "not_found");
    await expectCode(deleteApplication(db, DEMO_USER_ID, SECOND_APP), "not_found");
    expect((await getApplication(db, SECOND_USER_ID, SECOND_APP)).status).toBe("paid");
  });

  it("treats malformed IDs as not found rather than erroring", async () => {
    await expectCode(getApplication(db, DEMO_USER_ID, "not-a-uuid"), "not_found");
  });
});

describe("journey state machine", () => {
  it("runs draft → submitted → paid once, bumping version on edits", async () => {
    const draft = await createDraft(db, DEMO_USER_ID);
    expect(draft.version).toBe(1);
    expect(journeyState(draft)).toMatchObject({ step: "details" });
    await expectCode(submitApplication(db, DEMO_USER_ID, draft.id), "incomplete");

    const edited = await updateDraft(db, DEMO_USER_ID, draft.id, DETAILS);
    expect(edited.version).toBe(2);
    expect(edited.title).toBe("Riverside Picnic");
    expect(journeyState(edited).nextActions).toContain("submit_application");

    const withDoc = await attachDocument(db, DEMO_USER_ID, draft.id, {
      name: "site-plan.pdf",
      type: "application/pdf",
      size: 2048,
    });
    expect(withDoc.version).toBe(3);
    // Metadata only (control S6).
    expect(withDoc.documents).toEqual([
      expect.objectContaining({ name: "site-plan.pdf", type: "application/pdf", size: 2048 }),
    ]);
    expect(Object.keys((withDoc.documents as object[])[0]).sort()).toEqual([
      "addedAt",
      "name",
      "size",
      "type",
    ]);

    await expectCode(payFee(db, DEMO_USER_ID, draft.id), "invalid_state");
    const submitted = await submitApplication(db, DEMO_USER_ID, draft.id);
    expect(submitted.status).toBe("submitted");
    await expectCode(submitApplication(db, DEMO_USER_ID, draft.id), "invalid_state");
    await expectCode(
      updateDraft(db, DEMO_USER_ID, draft.id, { location: "Elsewhere" }),
      "invalid_state",
    );

    const paid = await payFee(db, DEMO_USER_ID, draft.id);
    expect(paid.status).toBe("paid");
    expect((paid.details as { payment: { amount: number } }).payment.amount).toBe(50);
    await expectCode(payFee(db, DEMO_USER_ID, draft.id), "invalid_state");
  });

  it("blocks submit and pay once deleted (J04)", async () => {
    const draft = await createDraft(db, DEMO_USER_ID);
    await updateDraft(db, DEMO_USER_ID, draft.id, DETAILS);
    await deleteApplication(db, DEMO_USER_ID, draft.id);
    await expectCode(submitApplication(db, DEMO_USER_ID, draft.id), "not_found");
    await expectCode(payFee(db, DEMO_USER_ID, draft.id), "not_found");
    expect((await listApplications(db, DEMO_USER_ID)).map((a) => a.id)).not.toContain(draft.id);
  });

  it("only lets one of two concurrent submits through", async () => {
    const draft = await createDraft(db, DEMO_USER_ID);
    await updateDraft(db, DEMO_USER_ID, draft.id, DETAILS);
    const results = await Promise.allSettled([
      submitApplication(db, DEMO_USER_ID, draft.id),
      submitApplication(db, DEMO_USER_ID, draft.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("input validation (control S5)", () => {
  it.each([
    [{ date: "12/12/2026" }],
    [{ date: "2026-02-30x" }],
    [{ attendance: "0" }],
    [{ attendance: "lots" }],
    [{ title: "" }],
  ])("rejects bad details %j", async (input) => {
    const draft = await createDraft(db, DEMO_USER_ID);
    await expectCode(updateDraft(db, DEMO_USER_ID, draft.id, input), "invalid_input");
  });

  it("rejects disallowed or oversized documents", async () => {
    const draft = await createDraft(db, DEMO_USER_ID);
    await expectCode(
      attachDocument(db, DEMO_USER_ID, draft.id, {
        name: "x.exe",
        type: "application/x-msdownload",
        size: 10,
      }),
      "invalid_input",
    );
    await expectCode(
      attachDocument(db, DEMO_USER_ID, draft.id, {
        name: "big.pdf",
        type: "application/pdf",
        size: 3 * 1024 * 1024,
      }),
      "invalid_input",
    );
  });

  it("updates and validates recovery contact details", async () => {
    await expectCode(
      updateContact(db, DEMO_USER_ID, { recoveryEmail: "not-an-email" }),
      "invalid_input",
    );
    await expectCode(updateContact(db, DEMO_USER_ID, {}), "invalid_input");
    await updateContact(db, DEMO_USER_ID, {
      recoveryEmail: "New@Example.test",
      phone: "+1 555 0100",
    });
    expect(await getContact(db, DEMO_USER_ID)).toEqual({
      recoveryEmail: "new@example.test",
      phone: "+1 555 0100",
    });
  });

  it("searches by title and escapes wildcards", async () => {
    expect((await listApplications(db, DEMO_USER_ID, "summer")).map((a) => a.title)).toEqual([
      "Summer Street Fair",
    ]);
    expect(await listApplications(db, DEMO_USER_ID, "%")).toEqual([]);
  });
});
