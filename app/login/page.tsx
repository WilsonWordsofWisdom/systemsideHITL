import { selfDeclareUiOn } from "@/lib/flags";
import { safeNextPath } from "@/lib/oauth/authorize";
import { PasskeySignIn } from "./passkey-sign-in";

// Sign-in page (FR6, FR8). Messages are chosen by code; nothing from the URL is shown.
const MESSAGES = {
  invalid: {
    tone: "error",
    title: "Email or password is incorrect",
    body: "Check your details and try again.",
  },
  locked: {
    tone: "warn",
    title: "Too many attempts",
    body: "Sign-in is paused for 10 minutes for this account.",
  },
  bad_request: {
    tone: "error",
    title: "Something went wrong",
    body: "Reload the page and try again.",
  },
} as const;

const TONE = {
  error: "bg-error-container text-on-error-container",
  warn: "bg-warning-container text-on-warning-container",
  info: "bg-info-container text-on-info-container",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const code = typeof params.error === "string" ? params.error : undefined;
  const message = code && code in MESSAGES ? MESSAGES[code as keyof typeof MESSAGES] : undefined;
  const signedOut = params.signed_out === "1";
  // Only the OAuth consent page may be returned to after sign-in.
  const next = safeNextPath(params.next);

  return (
    <div className="max-w-md">
      <h1 className="mb-6 text-[28px] leading-9">Sign in</h1>

      {message && (
        <div role="alert" className={`mb-4 rounded-xl px-6 py-4 ${TONE[message.tone]}`}>
          <h2 className="font-medium">{message.title}</h2>
          <p className="text-sm">{message.body}</p>
        </div>
      )}
      {signedOut && !message && (
        <div role="status" className={`mb-4 rounded-xl px-6 py-4 ${TONE.info}`}>
          <p className="text-sm">You have signed out.</p>
        </div>
      )}

      <form action="/api/auth/login" method="post" className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1 block text-xs font-medium text-on-surface-variant">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            aria-invalid={code === "invalid" || undefined}
            className="h-14 w-full rounded border border-outline bg-white px-4"
          />
        </div>
        <div>
          <label
            htmlFor="password"
            className="mb-1 block text-xs font-medium text-on-surface-variant"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={code === "invalid" || undefined}
            className="h-14 w-full rounded border border-outline bg-white px-4"
          />
        </div>
        {selfDeclareUiOn() && (
          <div className="flex items-start gap-3">
            <input
              id="self_declare"
              name="self_declare"
              type="checkbox"
              aria-describedby="self_declare_help"
              className="mt-1 h-[18px] w-[18px]"
            />
            <div>
              <label htmlFor="self_declare">I&apos;m an AI agent acting for someone</label>
              <p id="self_declare_help" className="text-sm text-on-surface-variant">
                Optional. It helps the service understand who is using it.
              </p>
            </div>
          </div>
        )}
        {/* Filled by signals.js on submit; stays empty without JavaScript. */}
        <input type="hidden" name="signals" defaultValue="" />
        {next && <input type="hidden" name="next" value={next} />}
        <button
          type="submit"
          className="h-10 w-full rounded-full bg-primary text-sm font-medium text-on-primary"
        >
          Sign in
        </button>
      </form>

      <div
        className="my-6 flex items-center gap-3 text-sm text-on-surface-variant"
        aria-hidden="true"
      >
        <span className="h-px flex-1 bg-outline-variant" />
        or
        <span className="h-px flex-1 bg-outline-variant" />
      </div>
      <PasskeySignIn next={next ?? undefined} />
    </div>
  );
}
