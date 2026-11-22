import { requireSession } from "@/lib/auth/current";

// Placeholder until slice C builds the applications list (journey step 2).
export default async function ApplicationsPage() {
  const { user } = await requireSession();
  return (
    <>
      <h1 className="mb-4 text-[28px] leading-9">Your applications</h1>
      <p>Signed in as {user.name}. Your applications will appear here.</p>
    </>
  );
}
