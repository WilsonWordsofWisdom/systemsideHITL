import { redirect } from "next/navigation";
import { CsrfField, Notice, btn } from "@/components/journey";
import { appConfig } from "@/lib/app";
import { getCurrentSession } from "@/lib/auth/current";
import { getDb } from "@/lib/db/server";
import {
  AUTHORIZE_PARAM_NAMES,
  checkAuthorizeRequest,
  pickAuthorizeParams,
} from "@/lib/oauth/authorize";

// Consent screen for an MCP client (FR30, control M3): names the client and what
// it will be able to do. The account holder must be signed in; the gate still
// applies to everything the client does.
export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  const raw = await searchParams;
  const params = pickAuthorizeParams(raw);
  const origin = appConfig().appOrigin;
  const check = await checkAuthorizeRequest(getDb(), params, origin);

  if (check.kind === "fatal") {
    return (
      <div className="max-w-xl">
        <h1 className="mb-4 text-[28px] leading-9">This request can&apos;t continue</h1>
        <Notice tone="error" title={check.message}>
          No access was granted. Return to the application and try connecting again.
        </Notice>
      </div>
    );
  }
  if (check.kind === "redirect_error") redirect(check.url);

  const current = await getCurrentSession();
  if (!current || current.session.approvalOnly) {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  }

  const returnHost = new URL(check.redirectUri).host;
  return (
    <div className="max-w-xl">
      <p className="mb-6 rounded-xl bg-info-container px-6 py-3 text-on-info-container">
        You are signing in on <strong>{new URL(origin).host}</strong>
      </p>
      <h1 className="mb-4 text-[28px] leading-9">Allow {check.client.name} to use your account?</h1>
      <p className="mb-4">
        <strong>{check.client.name}</strong> is an automated assistant. If you allow it, it can
        browse your applications and start drafts as <strong>{current.user.name}</strong>.
      </p>
      <p className="mb-4">
        Submitting, paying, changing your recovery details or deleting still needs your approval
        with your passkey each time, and the assistant is always identified as an automated
        assistant.
      </p>
      <p className="mb-6 text-sm text-on-surface-variant">
        Access lasts one hour. The application will return to <strong>{returnHost}</strong>.
      </p>
      <form action="/api/oauth/authorize" method="post" className="flex flex-wrap gap-3">
        <CsrfField csrf={current.csrf} />
        {AUTHORIZE_PARAM_NAMES.map((name) =>
          params[name] ? <input key={name} type="hidden" name={name} value={params[name]} /> : null,
        )}
        <button type="submit" name="decision" value="allow" className={btn.filled}>
          Allow access
        </button>
        <button type="submit" name="decision" value="deny" className={btn.outlined}>
          Deny
        </button>
      </form>
    </div>
  );
}
