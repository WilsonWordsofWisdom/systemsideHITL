// Journey services (PRD section 4 steps 2-9). Plain functions over the database:
// every query is scoped to the acting user (control C5), and the application
// state machine is enforced here. No HITL logic: Phase 2's guard runs before these.
import { and, desc, eq, ilike, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { randomToken } from "../auth/crypto";
import { applications, users } from "../db/schema";
import type { AppDb } from "../db/types";

export type JourneyErrorCode = "not_found" | "invalid_state" | "incomplete" | "invalid_input";
export const JOURNEY_ERROR_STATUS: Record<JourneyErrorCode, number> = {
  not_found: 404,
  invalid_state: 409,
  incomplete: 422,
  invalid_input: 400,
};

export class JourneyError extends Error {
  constructor(
    readonly code: JourneyErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export type Application = typeof applications.$inferSelect;
export const FEE = { amount: 50, currency: "USD" } as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Enter a real date");

export const DetailsInput = z
  .object({
    title: z.string().trim().min(1, "Enter the event name").max(120),
    date: isoDate,
    attendance: z.coerce.number().int().min(1, "Enter at least 1").max(100_000),
    location: z.string().trim().min(1, "Enter the location").max(200),
  })
  .partial();

const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/plain"];
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const DocumentInput = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().refine((t) => ALLOWED_TYPES.includes(t), "Upload a PDF, PNG, JPEG or text file"),
  size: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
});

export const ContactInput = z
  .object({
    recoveryEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/, "Enter a phone number like +1 555 0100")
      .optional(),
  })
  .refine((c) => c.recoveryEmail !== undefined || c.phone !== undefined, "Enter an email or phone");

const uuid = z.uuid();

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new JourneyError("invalid_input", result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}

export function isComplete(app: Application): boolean {
  const d = app.details as Record<string, unknown>;
  return Boolean(app.title && d.date && d.attendance && d.location);
}

// Step 2: list and search the user's applications (deleted ones are hidden).
export async function listApplications(db: AppDb, userId: string, search?: string) {
  const term = search?.trim().slice(0, 100);
  return db
    .select()
    .from(applications)
    .where(
      and(
        eq(applications.userId, userId),
        ne(applications.status, "deleted"),
        term ? ilike(applications.title, `%${term.replace(/[%_\\]/g, "\\$&")}%`) : undefined,
      ),
    )
    .orderBy(desc(applications.createdAt));
}

// Step 2: one application. Another user's (or a malformed) ID is "not found".
export async function getApplication(db: AppDb, userId: string, id: string) {
  if (!uuid.safeParse(id).success) throw new JourneyError("not_found");
  const [app] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .limit(1);
  if (!app || app.status === "deleted") throw new JourneyError("not_found");
  return app;
}

// Step 3: start a draft.
export async function createDraft(db: AppDb, userId: string, title = "New application") {
  const [app] = await db
    .insert(applications)
    .values({ userId, title: title.trim().slice(0, 120) || "New application" })
    .returning();
  return app;
}

// Step 3: edit a draft. Each change bumps `version` (part of the approval snapshot, FR17).
export async function updateDraft(db: AppDb, userId: string, id: string, input: unknown) {
  const changes = parseOrThrow(DetailsInput, input);
  const app = await getApplication(db, userId, id);
  if (app.status !== "draft") throw new JourneyError("invalid_state", "Only drafts can be edited");
  const { title, ...rest } = changes;
  const [updated] = await db
    .update(applications)
    .set({
      title: title ?? app.title,
      details: { ...(app.details as Record<string, unknown>), ...rest },
      version: sql`${applications.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .returning();
  return updated;
}

// Step 4: attach a supporting document. Only metadata is stored (control S6).
export async function attachDocument(db: AppDb, userId: string, id: string, input: unknown) {
  const doc = parseOrThrow(DocumentInput, input);
  const app = await getApplication(db, userId, id);
  if (app.status !== "draft") throw new JourneyError("invalid_state", "Only drafts can be changed");
  const documents = [
    ...(app.documents as Record<string, unknown>[]),
    { name: doc.name, type: doc.type, size: doc.size, addedAt: new Date().toISOString() },
  ];
  const [updated] = await db
    .update(applications)
    .set({ documents, version: sql`${applications.version} + 1`, updatedAt: new Date() })
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .returning();
  return updated;
}

// Step 6: submit the legal declaration. Phase 2 gates this action.
export async function submitApplication(db: AppDb, userId: string, id: string) {
  const app = await getApplication(db, userId, id);
  if (app.status !== "draft") throw new JourneyError("invalid_state", "Already submitted");
  if (!isComplete(app)) throw new JourneyError("incomplete", "Fill in all event details first");
  const [updated] = await db
    .update(applications)
    .set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(applications.id, id),
        eq(applications.userId, userId),
        eq(applications.status, "draft"),
      ),
    )
    .returning();
  if (!updated) throw new JourneyError("invalid_state", "Already submitted");
  return updated;
}

// Step 7: pay the mock $50 fee. Phase 2 gates this action.
export async function payFee(db: AppDb, userId: string, id: string) {
  const app = await getApplication(db, userId, id);
  if (app.status !== "submitted") {
    throw new JourneyError(
      "invalid_state",
      app.status === "paid" ? "Already paid" : "Submit first",
    );
  }
  const payment = {
    ...FEE,
    reference: `MOCK-${randomToken(6).toUpperCase()}`,
    paidAt: new Date().toISOString(),
  };
  const [updated] = await db
    .update(applications)
    .set({
      status: "paid",
      paidAt: new Date(),
      details: { ...(app.details as Record<string, unknown>), payment },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(applications.id, id),
        eq(applications.userId, userId),
        eq(applications.status, "submitted"),
      ),
    )
    .returning();
  if (!updated) throw new JourneyError("invalid_state", "Already paid");
  return updated;
}

// Step 9: delete (soft). Deleted applications can't be submitted or paid (J04).
export async function deleteApplication(db: AppDb, userId: string, id: string) {
  await getApplication(db, userId, id);
  const [updated] = await db
    .update(applications)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .returning();
  return updated;
}

// Step 8: change recovery email or phone. Phase 2 denies this to agents.
export async function getContact(db: AppDb, userId: string) {
  const [row] = await db
    .select({ recoveryEmail: users.recoveryEmail, phone: users.phone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

export async function updateContact(db: AppDb, userId: string, input: unknown) {
  const raw = (input ?? {}) as Record<string, unknown>;
  const cleaned = Object.fromEntries(
    Object.entries({ recoveryEmail: raw.recoveryEmail, phone: raw.phone }).filter(
      ([, v]) => typeof v === "string" && v.trim() !== "",
    ),
  );
  const contact = parseOrThrow(ContactInput, cleaned);
  const [row] = await db
    .update(users)
    .set(contact)
    .where(eq(users.id, userId))
    .returning({ recoveryEmail: users.recoveryEmail, phone: users.phone });
  return row;
}

export type JourneyStep = "details" | "documents" | "review" | "declare" | "pay" | "done";

// Where an application is in the journey and what can happen next (FR31's
// get_journey_state uses this in Phase 4).
export function journeyState(app: Application) {
  switch (app.status) {
    case "draft":
      return {
        step: (isComplete(app) ? "review" : "details") as JourneyStep,
        nextActions: [
          "update_draft",
          "attach_document",
          ...(isComplete(app) ? ["submit_application"] : []),
          "delete_application",
        ],
      };
    case "submitted":
      return { step: "pay" as JourneyStep, nextActions: ["pay_fee", "delete_application"] };
    case "paid":
      return { step: "done" as JourneyStep, nextActions: ["delete_application"] };
    default:
      return { step: "done" as JourneyStep, nextActions: [] as string[] };
  }
}
