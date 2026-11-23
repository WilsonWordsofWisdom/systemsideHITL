// Demo accounts and past applications, shared by the seed script and the
// console's "Reset demo data" (fixed IDs, so restoring them is idempotent).
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
export const SECOND_USER_ID = "00000000-0000-4000-8000-000000000002";

export const seedUsers = [
  { id: DEMO_USER_ID, email: "demo@demogov.test", name: "Demo User" },
  { id: SECOND_USER_ID, email: "second@demogov.test", name: "Second User" },
];

export const seedApplications = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    userId: DEMO_USER_ID,
    status: "paid" as const,
    title: "Summer Street Fair",
    details: { date: "2026-06-20", attendance: 300, location: "High Street" },
    submittedAt: new Date("2026-05-02T10:00:00Z"),
    paidAt: new Date("2026-05-02T10:05:00Z"),
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    userId: DEMO_USER_ID,
    status: "submitted" as const,
    title: "Autumn Craft Market",
    details: { date: "2026-10-10", attendance: 120, location: "Town Hall car park" },
    submittedAt: new Date("2026-09-01T09:30:00Z"),
    paidAt: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    userId: DEMO_USER_ID,
    status: "draft" as const,
    title: "Winter Lights Walk",
    details: { date: "2026-12-18", attendance: 60, location: "Riverside Park" },
    submittedAt: null,
    paidAt: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000201",
    userId: SECOND_USER_ID,
    status: "paid" as const,
    title: "Neighbourhood Garage Sale",
    details: { date: "2026-08-08", attendance: 40, location: "Elm Close" },
    submittedAt: new Date("2026-07-15T14:00:00Z"),
    paidAt: new Date("2026-07-15T14:10:00Z"),
  },
];
