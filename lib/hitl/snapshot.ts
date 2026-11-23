// Resource snapshots for gated actions (FR17). Each builder checks the action's
// preconditions first, so a human is never asked to approve something that
// cannot run, then returns what the approval hash covers and what the approval
// page shows. Builders throw JourneyError like the services do.
import type { AppDb } from "../db/types";
import {
  FEE,
  JourneyError,
  getApplication,
  getContact,
  isComplete,
  parseContact,
} from "../journey/service";

export interface Snapshot {
  snapshot: unknown;
  preview: Record<string, unknown>;
}

type Builder = (
  db: AppDb,
  userId: string,
  resourceId: string | null,
  body: Record<string, string>,
) => Promise<Snapshot>;

const DECLARATION_VALUES = ["on", "true", "agree"];

const builders: Record<string, Builder> = {
  async submit_application(db, userId, id, body) {
    const app = await getApplication(db, userId, id ?? "");
    if (app.status !== "draft") throw new JourneyError("invalid_state", "Already submitted");
    if (!isComplete(app)) throw new JourneyError("incomplete", "Fill in all event details first");
    if (!DECLARATION_VALUES.includes(body.declaration ?? "")) {
      throw new JourneyError("invalid_input", "Confirm the declaration");
    }
    return {
      snapshot: {
        id: app.id,
        version: app.version,
        title: app.title,
        details: app.details,
        documents: app.documents,
      },
      preview: {
        summary: `Submit the application "${app.title}"`,
        title: app.title,
        details: app.details,
        documents: (app.documents as { name?: unknown }[]).map((d) => d.name),
      },
    };
  },

  async pay_fee(db, userId, id) {
    const app = await getApplication(db, userId, id ?? "");
    if (app.status !== "submitted") {
      throw new JourneyError(
        "invalid_state",
        app.status === "paid" ? "Already paid" : "Submit first",
      );
    }
    return {
      snapshot: { id: app.id, status: app.status, version: app.version, ...FEE },
      preview: {
        summary: `Pay the ${FEE.currency} ${FEE.amount} fee for "${app.title}"`,
        title: app.title,
        ...FEE,
      },
    };
  },

  async delete_application(db, userId, id) {
    const app = await getApplication(db, userId, id ?? "");
    return {
      snapshot: { id: app.id, status: app.status, version: app.version },
      preview: { summary: `Delete the application "${app.title}"`, title: app.title },
    };
  },

  async update_contact(db, userId, _id, body) {
    const next = parseContact(body);
    const current = await getContact(db, userId);
    return {
      snapshot: current ?? null,
      preview: { summary: "Change the account's recovery contact details", ...next },
    };
  },
};

export function hasSnapshot(action: string) {
  return action in builders;
}

export function buildSnapshot(
  db: AppDb,
  action: string,
  userId: string,
  resourceId: string | null,
  body: Record<string, string>,
): Promise<Snapshot> {
  const build = builders[action];
  // Only reached when the guard fails closed on a normally allowed action
  // (control C3): the approval then covers the request body alone. A test makes
  // sure every action the policy itself can gate has a builder.
  if (!build) return Promise.resolve({ snapshot: null, preview: { summary: action } });
  return build(db, userId, resourceId, body);
}
