# Decisions log (append-only)

## 2026-11-20 — Single Next.js deployment with one `hitlGuard` choke point
**Decision:** UI, API, MCP endpoint and OAuth AS live in one Next.js app. Every mutating route and MCP tool calls `hitlGuard` before the service layer.
**Why:** The spec's thesis is server-side enforcement; one guard is the simplest design that can be tested for bypass (T11).
**Alternatives:** Separate MCP service (more moving parts, duplicate policy); middleware-only enforcement (can't see payloads or tool args).

## 2026-11-20 — Tickets enforced with conditional SQL updates, not locks
**Decision:** State transitions and consume use `UPDATE ... WHERE state=... AND expires_at > now()`.
**Why:** Atomic, race-safe, no extra infrastructure.

## 2026-11-20 — Guard fails closed; polling is the contract, SSE a convenience
**Why:** Serverless hosting may cut SSE streams; correctness must not depend on them.

## 2026-11-20 — Hosting: Vercel + Supabase Postgres (owner decision)
**Alternatives:** VM/container (better for long-lived streams), tunnel (dev only). No resources provisioned yet; domain still needed.

## 2026-11-20 — Landing page and sign-in are part of the site; login-time actor identification
**Decision:** Add a neutral landing page `/` and `/login` (password for demo accounts, passkey for humans, OAuth for MCP). Record login signals and a login-time actor class on the session. Enforcement still uses the per-request class.
**Why:** Agents need to understand what the site is and be able to sign in (spec prompt P1 had no workable agent sign-in). The owner wants to see whether a human or an agent is using a session.
**Alternatives:** Passkey-only sign-in (agents can't complete it); trusting the login class for enforcement (breaks on handover, T10).

## 2026-11-20 — Agent hints are a flag, off for the baseline
**Decision:** `AGENT_HINTS` controls `/llms.txt`, `/agents.md` and the landing-page hint. Baseline runs are off; hinted runs are an A/B variant. The self-declare checkbox stays on (`SELF_DECLARE_UI`).
**Why:** Hints tell the agent about human approval and would inflate results if always on.

## 2026-11-20 — Handoff presentation is a flag, `redirect` added to the spec's panel
**Decision:** `HITL_HANDOFF_MODE=panel|redirect|both`; redirect targets are built server-side only.
**Why:** The owner asked whether the agent can be sent to an approval page; the spec only provided a link/panel.

## 2026-11-20 — Demo password delivered via the test prompt, never committed
**Decision:** `DEMO_USER_PASSWORD` is an env var; seed reads it; testers get it in the prompt. Demo data only. (Superseded 2026-11-21: delivery to each agent is left to the tester; see the sign-in entry below.)

## 2026-11-20 — Actor class derivation: tiered evidence, fixed precedence, escalate-only
**Decision:** Protocol-proven evidence (MCP `act`, Web Bot Auth) > self-declared > behavioural score ≥ threshold > passkey-established clean session = human > otherwise unknown. Agent evidence never downgrades within a session. Score weights are drafts in `policy/classifier.yaml`, calibrated in the `observe` baseline. Detection rate is measured against a tester-supplied ground-truth label.
**Why:** Only tier A cannot be forged, so the class is treated as a signal; enforcement relies on the ticket. Gating humans and unknowns too means a perfect disguise gains little.
**Alternatives:** Single opaque score (hard to explain and test); trusting login class (breaks on handover).

## 2026-11-20 — Passkey enrolment is closed during test runs
**Decision:** `PASSKEY_ENROLMENT=closed` while testing; owner pre-enrols approver passkeys on a real device. Enrolment attempts are audited.
**Why:** An agent holding the demo password could enrol a virtual-authenticator passkey and approve its own tickets, defeating the gate.

## 2026-11-20 — Session is low-assurance; handover handled by limiting, attributing and monitoring (not by binding token to actor)
**Research finding:** No standard or tested method separates human from agent inside one shared browser session. What exists: per-request agent signatures (Web Bot Auth; ChatGPT's cloud browser signs and Cloudflare, Akamai and Vercel verify), per-action step-up with transaction-bound passkeys (RFC 9470; "dynamic linking" in payments), cookie/token key binding (DBSC, DPoP: stops theft, not a same-browser agent; DBSC not yet on macOS), continuous-evaluation events (OpenID CAEP), vendor behavioural biometrics (no independent accuracy data), and browser-vendor confirmation/takeover gates (invisible to the site). Sources are mostly vendor material; primary sources are the Chrome and OpenAI docs and the RFCs.
**Decision:** (1) A session is never an approval; high-risk actions always need a ticket approved with a UV passkey. (2) Attribute per request where possible: Web Bot Auth signatures, behaviour signals, and a `client_context_changed` signal. (3) Monitor: escalate-only session `risk_state` with every change in `session_events` and a console timeline. (4) Passkey sign-in ends earlier sessions and resets state. (5) Idle timeout 30 min, absolute 8 h. (6) T10 split into T10a-d.
**Why:** Detection can't be made reliable in a shared session; the per-action passkey is the safeguard, and monitoring gives the test evidence.
**Alternatives:** DBSC/DPoP binding (doesn't separate a same-browser agent; DBSC unavailable on macOS) — revisit later; Secure Payment Confirmation for the pay step (Chromium only) — possible later enhancement; vendor behavioural biometrics (unvalidated claims) — interface only.

## 2026-11-21 — Domain: free Vercel `*.vercel.app` hostname
**Decision:** The production hostname on Vercel's free domain is `APP_ORIGIN` and the WebAuthn RP ID.
**Why:** Free and immediate, no DNS work.
**Consequences:** The RP ID is the full hostname, so the Vercel project name must be final before any passkey is enrolled; renaming or moving invalidates all passkeys. Passkeys work only on the production hostname, not preview deployments.
**Alternatives:** Own domain with RP ID = parent or full subdomain (more stable, needs a domain); new dedicated domain (small cost).

## 2026-11-21 — Agent sign-in is left to the tester; "2FA setup" = approver passkey enrolment only
**Decision:** The site provides a login page and a passkey setup page. How each agent gets signed in (password hand-over, taking over the login, etc.) is decided by the tester working with that agent; the site prescribes nothing. Sign-in itself has no second factor. The passkey is the approval factor, enrolled beforehand (`PASSKEY_ENROLMENT=closed` during runs).
**Why:** Agent surfaces differ and the owner wants to see how each one copes. Putting a second factor at login would make login a human step and blur what is being tested (action gating).
**Supersedes:** the "password via test prompt" entry. **Alternatives:** passkey or TOTP at sign-in; a switchable login-2FA flag.

## 2026-11-21 — Unlisted mutating actions: build check plus runtime deny (changes spec `default: allow`)
**Decision:** A test fails the build if any mutating route or MCP tool has no policy entry; at runtime an unlisted mutating action is denied. Read-only routes are marked explicitly and stay allowed.
**Why:** A forgotten entry must not become an unprotected action.
**Alternatives:** runtime deny only; runtime gate; the spec's allow default.

## 2026-11-21 — Console auth: env-secret login with its own cookie
**Why:** Simple and separate from anything an agent can reach through the demo login; rate limited, no public link, not indexed.
**Alternatives:** HTTP Basic Auth at the edge; admin user with passkey (stronger, more build, tied to RP ID).

## 2026-11-21 — Lifecycle documents before any build
**Decision:** Produce `docs/PRD.md`, Gherkin tests in `docs/tests/` (journeys and T1-T15), `docs/design.md` with mockups of the key screens, and a cost estimate, all reviewed before the Phase 1 build. The PRD also puts the requirements into the repo, because `ref/` is gitignored.
**Alternatives:** PRD and tests now with design later; PRD and tests only; tests only.

## 2026-11-21 — Hosting tiers and database connections
**Decision:** Free Vercel and Supabase tiers for build Phases 0-5, paid for Phase 6 live testing; cost estimate signed off before provisioning. The app uses Supabase's transaction pooler with prepared statements off; migrations and seed use the direct connection (verified in Phase 0).
**Why:** Avoids cost during the long build while keeping live results free of pausing and limits; the pooler suits serverless bursts and single-statement ticket updates stay atomic.
**Alternatives:** paid from the start; free throughout (risk of a paused database mid-test); direct-only or session-pooler connections.

## 2026-11-21 — Gate response status: 403 default, switchable
**Decision:** `HITL_GATE_STATUS=403|401|202`, default 403 with the `WWW-Authenticate` header; the value is fixed per run.
**Why:** The status code may change agent behaviour (401 may trigger login loops, 403 may read as final, 202 may read as success), so it is worth being able to test.

## 2026-11-21 — Approval hash covers request body plus a resource snapshot
**Decision:** The hash covers the request fields and a hash of the stored resource (draft contents and version for submit; application and amount for pay), with volatile fields excluded by a named per-action list.
**Why:** For submit and pay the body is nearly empty, so a body-only hash would not catch edits to the draft after approval (T5).
**Alternatives:** body only; allowlist of business fields (a forgotten field becomes a hole).

## 2026-11-21 — Tickets redeemable only by the requesting session or MCP client
**Decision:** A ticket can be redeemed only by the web session, or the OAuth client plus user for MCP, that requested it. Other redeemers are rejected with reason `wrong_session`.
**Why:** Strictest option; a leaked ticket ID is useless elsewhere.
**Consequences:** An agent that reconnects or opens a fresh browser context after approval must ask again; `wrong_session` is logged separately so it is not counted as an agent failure. To keep T9 (approval from a phone) working, `/approve` and `/device` use an **approval-only session**: it can approve tickets, cannot act on the journey and ends no other session. Only the main `/login` passkey sign-in resets sessions.
**Alternatives:** any session of the same user with both logged; a setting to switch.

## 2026-11-21 — Signal window and calibration
**Decision:** Behaviour signals are scored over a sliding 60-second window per request, on top of the sticky escalate-only state; quiet windows count as no evidence. Weights and thresholds are tuned on the live agents' observe baseline run, then frozen, with a weights version recorded in every run.
**Why:** A handover shows up within a minute without being averaged away.
**Risk and mitigation:** Tuning on the agents under test inflates detection rates. The baseline run is used for tuning only; the detection rates reported come from separate runs after the freeze, and results say the weights were tuned on the same agents.
**Alternatives:** tune on our own bot and human runs (cleaner evidence, chosen against); draft weights unchanged; continuous tuning.

## 2026-11-21 — MCP: two revisions, in-app OAuth server
**Decision:** Support revision 2026-07-28 as primary and 2025-11-25 via version negotiation, with `tool_result` as the fallback for anything else. The OAuth authorization server is built into the app using the MCP SDK's auth helpers (new tables for authorization codes, tokens and signing keys).
**Findings (to confirm in the Phase 4 spike):** 2026-07-28 removes protocol-level sessions and the `initialize` handshake, and removes the elicitation completion notification and `elicitationId` (correlation moves to `requestState`). So client capabilities are logged per request for that revision, and the spec's completion notification applies to 2025-11-25 only. SDK support for both revisions and the Next.js route adapter are unverified.
**Alternatives:** one revision only; `tool_result` only; Supabase Auth or a third-party IdP as the OAuth server.

## 2026-11-21 — Test plan choices
**Decisions:** Muse is Meta's Muse personal agent: test on the web route first, MCP only if it supports it. Approvals use a real phone for T9 and a sample of runs, same machine for the rest (results note which). Every agent gets an `observe` baseline before enforcement runs. `AGENT_HINTS` is off for baseline and main runs and on only as a comparison variant.

## 2026-11-21 — Repeated gated requests reuse or supersede the pending ticket (pending owner confirmation)
**Decision:** An identical repeated request from the same session gets the existing pending ticket back. A changed payload creates a new ticket and rejects the earlier one with reason `superseded`. An approved ticket that expires unredeemed is shown as "approved, not redeemed" (derived, not a new state) and counted as a resume failure.
**Why:** The human should only ever see one approval for the current version of an action, and agents that retry before approval shouldn't flood them.
**Alternatives:** Always create a new ticket (simpler, but piles up pending approvals); keep the old ticket pending until it expires (the human could approve an outdated payload).

## 2026-11-21 — No cost estimate
**Decision:** The owner does not need a cost estimate. This supersedes the "cost estimate signed off before provisioning" wording in the lifecycle-documents and hosting entries above. Provisioning still waits for the owner to approve the Phase 0 deployment.

## 2026-11-21 — Design and mockups approved; declarative handoff wording
**Decision:** The owner approved `docs/design.md` and `docs/design/mockups.html` (Material 3 baseline, fictional brand, light theme only). The handoff panel uses declarative wording ("…needs approval from the account holder with their passkey") instead of the spec's "Ask the person you're acting for to open this link…".
**Why:** The spec's sentence is an instruction aimed at the agent, which conflicts with the rule against model-directed imperatives and with the content lint.
**Alternatives:** Use the spec's wording, or test it as a flagged copy variant (not chosen; can be added later).

## 2026-11-21 — Vercel project `hitl_test`, hostname `hitltest.vercel.app`
**Decision:** Use the Vercel project `hitl_test` (`prj_KBSOBiPx9LVMegr7XqfVM4JSSVAZ`, team "wilsonwordsofwisdom's projects"). Its production hostname `hitltest.vercel.app` is `APP_ORIGIN` (`https://hitltest.vercel.app`) and the WebAuthn RP ID. Vercel Authentication is **disabled** (the dashboard offers only off, Standard or All Deployments, and Standard protects `*.vercel.app` production domains). To avoid public previews of unfinished branches, the Phase 0 scaffold adds a `vercel.json` that turns off automatic deployments for every branch except `main`, so production changes only when the owner merges a PR. Verified 2026-11-21: `ssoProtection` off, and an anonymous request to `https://hitltest.vercel.app/` reaches Vercel with no sign-in redirect. The project is re-linked from the starter repo `hitl_test` to `systemsideHITL` when the Phase 0 scaffold is ready to merge, so the docs-only `main` is never published as a static site.
**Why:** The owner created the project for this prototype. Re-linking later avoids publishing the docs. The other aliases (`hitltest-wilsonwordsofwisdoms-projects.vercel.app` and the git-branch alias) are not the RP ID, so passkeys work only on `hitltest.vercel.app`.
**Alternatives:** The earlier project `systemsidehtl` (not used); deploying manually without a Git link.
**Note:** The Vercel connector in this session can read the project but not change its settings, so protection and Git-link changes are made by the owner in the dashboard.

## 2026-11-22 — Supabase via Vercel Storage (`supabase-hitl-test`)
**Decision:** The database is the Supabase project `supabase-hitl-test` (`deezowlwqkduojwhwunk`), created from Vercel's Storage tab, so it sits in a Vercel-managed Supabase organisation that the Supabase connector in this session cannot access. The app reads `DATABASE_URL` / `DIRECT_DATABASE_URL` and falls back to Vercel's `POSTGRES_URL` (transaction pooler, port 6543) and `POSTGRES_URL_NON_POOLING` (session pooler, port 5432). Migrations and seed run from the owner's machine using `.env.local`.
**Verified 2026-11-22:** migration applied (8 tables, RLS on all, 0 policies); seed run twice gives 2 users and 4 applications with argon2id hashes; the conditional consume update through the transaction pooler changes 1 row then 0 rows (run in a rolled-back transaction).
**Note:** The "direct" string from Vercel is Supabase's session pooler, not the raw database host. It handles DDL and works over IPv4. Supabase security advisors can't be run through the connector for this project; the RLS check above covers the main finding they would report.

## 2026-11-22 — First production deploy started manually
**What happened:** Merging PR #3 did not deploy, because the Vercel project was re-linked to `systemsideHITL` after the merge, so Vercel never received a push event. The production deployment of `main` at `10b7e76` was started through the Vercel connector and went live at `https://hitltest.vercel.app` (HTTP 200, prototype banner, HSTS). Later merges should deploy automatically; confirm on the next merge.

## 2026-11-22 — Cache Components off; pages render fully on the server
**Decision:** `cacheComponents` and `partialPrefetching` are turned off in `next.config.ts`.
**Why:** With Cache Components, any page that reads the session cookie must stream behind `<Suspense>`, so a browser agent reading the page early could see placeholders instead of the form (FR28). Almost every page is per-user, so a prerendered shell gains little.
**Alternatives:** Keep Cache Components with Suspense boundaries and `use cache: private`.

## 2026-11-22 — Sessions, CSRF and sign-in lockout
**Decision:** Session cookie `dg_session` (32 random bytes, `HttpOnly`, `SameSite=Lax`, `Secure` on https); only its SHA-256 is stored. Idle 30 min, absolute 8 h, rotated at sign-in. State-changing requests must carry an `Origin` (or `Referer`) equal to `APP_ORIGIN`; signed-in requests also need a CSRF token derived as HMAC(`SESSION_SECRET`, session id), sent as a hidden `csrf` field or `x-csrf-token` header. Sign-in lockout: 5 failures per email in 60 s locks that email for 10 min; 30 per IP hash in 60 s locks the IP. Counters live in Postgres (`rate_limits`). Forms post to the same API routes agents call (303 redirect for forms, JSON otherwise), so Phase 2's guard has one code path.
**Why:** Server-side sessions can be revoked and audited (session events, handover reset), which the HITL design needs; per-IP limits are looser so one shared address can't lock out everyone.

## 2026-11-22 — End-to-end tests use a separate Supabase test project
**Decision:** Playwright runs a production build against a separate Supabase project (`tomyjajeonaqpcjwawvl`), read only from `.env.test.local` (`E2E_DATABASE_URL`, `E2E_DIRECT_DATABASE_URL`; `sslmode=require` is added if missing). Global setup migrates, truncates every `public` table and re-seeds before each run. A guard refuses to run if the test URLs share a host and user with `.env.local` (production); it caught a mis-pasted production URL on first setup.
**Why:** Owner's choice. An in-process PGlite socket server was tried first and rejected: it lost unnamed prepared statements and hung under the app's query pattern. Docker Desktop was installed but not running; `embedded-postgres` was judged a higher supply-chain risk.
**Trade-off:** Tests depend on the network; one run out of four timed out (4.2 min) and three reruns passed in about 34 s each.

## 2026-11-23 — Passkeys (Phase 1 slice B)
**Decision:** Passkeys are discoverable credentials (`residentKey: required`) with `userVerification: required` on enrolment and sign-in, so sign-in asks for no username. Challenges live in `webauthn_challenges`: single use, 5-minute expiry, tied to a purpose (`register`, `login`, later `approve`) and, for enrolment, to the user and session. Enrolment needs `PASSKEY_ENROLMENT=open` and a sign-in within the last 10 minutes; every attempt, allowed or refused, is written to `request_log` with the attestation format and AAGUID. Attestation is `none`, so AAGUIDs are often zero; the audit still records who enrolled, when and from which session. A passkey sign-in ends the user's other sessions (`passkey_reset`) but keeps approval-only ones. Until the Phase 2 classifier, a passkey sign-in whose signals show no automation flag gets login class `human`, otherwise `unknown`.
**Why:** Matches FR6, FR7, FR10 and controls W1, W2, W7, S9.
**Alternatives:** `attestationType: direct` for stronger audit data (more browser prompts, little value for a prototype).

## 2026-11-23 — Production environment variables set
The owner set `APP_ORIGIN=https://hitltest.vercel.app`, `RP_ID=hitltest.vercel.app` and a random `SESSION_SECRET` (marked sensitive) for Production in the Vercel project. The connector cannot list environment variables, so this is confirmed by the owner and will be verified by signing in on production after the Phase 1 merge.

## 2026-11-23 — Journey routes and pages (Phase 1 slice C)
**Decision:** Every mutating journey route goes through one handler, `journeyAction` (same origin, session that may act, CSRF, body parsing, then the action); Phase 2 inserts `hitlGuard` there, so no route can skip it. Routes follow the spec's paths (`POST /api/applications/[id]/submit` and `/pay`, `DELETE /api/applications/[id]`, `PUT /api/account/contact`), with POST variants where HTML forms can't send DELETE or PUT. Submitting requires an explicit `declaration` (`on`, `true` or `agree`) from forms and API callers alike. Deletion is soft and confirmed on its own page (no modal-only flows). Uploads keep only name, type and size (PDF, PNG, JPEG or text, up to 2 MB). Each edit bumps `applications.version`, the resource snapshot the Phase 2 approval hash will cover. Another user's application, or a malformed ID, is "not found" everywhere.
**Why:** FR1, FR17, FR28, controls C1, C5, S5, S6.

## Open
- Phase 0: scaffold adds `vercel.json` limiting deployments to `main`; owner re-links the project to `systemsideHITL` when the scaffold PR is ready.
- Owner confirmation of the repeated-request ticket behaviour (reuse or supersede), logged above as pending.
- Phase 4 spike: confirm the 2026-07-28 changelog details, SDK support for both revisions, and the MCP SDK inside a Next.js route.
- Phase 6 capability check: whether Muse can browse or use MCP.
