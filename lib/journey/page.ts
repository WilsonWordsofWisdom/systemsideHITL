import "server-only";
import { notFound } from "next/navigation";
import { requireSession } from "../auth/current";
import { getDb } from "../db/server";
import { JourneyError, getApplication } from "./service";

// Loads one of the signed-in user's applications for a page; anything else is a 404.
export async function loadOwnApplication(id: string) {
  const current = await requireSession();
  try {
    const app = await getApplication(getDb(), current.user.id, id);
    return { ...current, app };
  } catch (err) {
    if (err instanceof JourneyError) notFound();
    throw err;
  }
}

export function details(app: { details: unknown }) {
  return app.details as {
    date?: string;
    attendance?: number;
    location?: string;
    payment?: { amount: number; currency: string; reference: string };
  };
}

export function documents(app: { documents: unknown }) {
  return app.documents as { name: string; type: string; size: number }[];
}
