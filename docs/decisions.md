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

## 2026-11-21 — Repeated gated requests reuse or supersede the pending ticket (confirmed by the owner 2026-11-23)
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

## 2026-11-23 — Phase 1 deployed; Vercel Git link corrected
**What happened:** Merging PR #4 did not deploy either. The `hitl_test` project was still linked to `WilsonWordsofWisdom/systemsidehtl`, an empty repo Vercel created on 21 Nov for the unused `systemsidehtl` project, so pushes to `systemsideHITL` never reached Vercel (the PR #3 deploy had been started manually). The owner re-linked the project to `systemsideHITL` and deployed `main` at `63de463` by hand. Migrations `0001` and `0002` were applied to production first (3 migrations, Phase 1 tables present). Verified on `https://hitltest.vercel.app`: password sign-in sets the session and lands on `/applications` with the 3 seeded applications, `X-Frame-Options: DENY` and the CSP are sent, sign-out works. A deploy created from the commit SHA rather than the branch was skipped by the `vercel.json` rule, as designed.
**Next:** confirm that the next merge to `main` deploys automatically.

## 2026-11-23 — Enforcement core (Phase 2 slice A)
**Decision:** `hitlGuard` runs inside `journeyAction` before every mutating journey action. Policy lives in `policy/hitl-policy.yaml` (spec table unchanged; no `default: allow`, read-only actions listed by name, anything else unlisted is denied; `update_contact` marked critical). Classifier weights live in `policy/classifier.yaml` (version `draft-1`); both files are validated with zod at load and an invalid file fails the request rather than allowing it. Tickets are `hitl_` plus 256 random bits; every transition is one conditional `UPDATE`; redemption re-checks user, action, payload hash and expiry in the consume statement. The approval hash covers action, resource, the request body minus named volatile fields (`csrf`, `hitl_ticket`, `signals`, `continue_url`) and a SHA-256 of the resource snapshot. Snapshot builders check preconditions first (complete draft and declaration for submit, submitted for pay), so no ticket is issued for an action that could not run. Ticket creation is limited to 20 per user and 60 per IP hash per minute. A classifier failure turns any non-deny decision into `gate`, or `deny` for critical actions. Gated web forms return to their step page with `?ticket=`, which shows the handoff panel only to the requesting session; API callers get the spec 9.1 contract with `HITL_GATE_STATUS` (default 403). The ticket can be passed as `X-HITL-Ticket` or a `hitl_ticket` form field (forms can't set headers). The sign-in routes now set `login_actor_class` with the same classifier.
**Why:** FR1-FR3, FR11-FR19, FR21, FR23-FR25, controls C1-C4, T1-T7, T9, A1-A2, S10, L1.
**Consequence for tests:** Playwright's Chrome reports `navigator.webdriver`, so the e2e browser is classified `suspected_agent`. The journey e2e now expects submit and pay to be gated (approved in the test database until slice B builds the approval page) and delete and contact changes to be denied.
**Alternatives:** policy in TypeScript instead of YAML (spec asks for YAML); a ticket for any precondition failure (the human could approve something impossible).

## 2026-11-23 — Database connections close after 20 s idle
**Finding:** The intermittent end-to-end hang (first seen in Phase 1 as a 4.2-minute stall) was reproduced against a local production build: after about 70 s without traffic, the next query was written to a pooled connection the Supabase pooler path had already dropped without notice, and waited about 285 s before failing with `ECONNRESET` (HTTP 500). postgres.js keeps idle connections indefinitely by default.
**Decision:** `lib/db/client.ts` sets `idle_timeout: 20` s, `max_lifetime: 300` s and `connect_timeout: 10` s alongside `prepare: false`. Verified: requests after idle gaps of 75, 90 and 120 s complete in 1.6-3.6 s with no connection errors. The same settings apply on Vercel, where function instances also sit idle between requests.
**Alternatives:** TCP keepalive tuning (not exposed by postgres.js per connection); retrying failed queries (would hide the stall rather than prevent it, and is unsafe for non-idempotent writes).

## 2026-11-23 — End-to-end tests run against local Postgres in Docker
**Decision:** Playwright now uses a local Postgres 17.12 container (`docker-compose.e2e.yml`, official image pinned by digest, bound to `127.0.0.1:54329`, data in memory) by default: `npm run e2e:db:up` then `npm run test:e2e`. The Supabase test project stays available with `E2E_TARGET=supabase`, behind the same guard against the production database. Global setup fails fast with a clear message if the database is unreachable.
**Why:** The owner's Mac runs Cloudflare WARP, which proxies every TCP connection and cuts some database connections without notice; the owner can't change WARP settings (split tunnels or pausing need the network admin). After the 20-second idle fix, the remote suite still hung on such connections. Local traffic doesn't go through WARP. The suite now passes in about 12 s (was 10-18 minutes with hangs). WARP's TLS inspection also explains the `SELF_SIGNED_CERT_IN_CHAIN` error Node gave for `hitltest.vercel.app`.
**Trade-off:** Local runs no longer go through Supabase's transaction pooler. That path was verified in Phase 0 (atomic consume through the pooler) and is exercised by production; an e2e run against the Supabase test project in GitHub Actions can be added before Phase 6.
**Alternatives:** WARP split-tunnel exclusion for `*.pooler.supabase.com` or pausing WARP (both need the network admin); CI-only e2e against Supabase.
**Supersedes:** the 2026-11-22 entry's choice of the Supabase test project as the only e2e database.

## 2026-11-23 — Passkey approval and approval-only sessions (Phase 2 slice B)
**Decision:** `/approve/[ticketId]` shows the request from the ticket row only (the query string is never read), the domain strip, the requesting actor class and the expiry, with "Approve with passkey" and "Decline". The WebAuthn challenge is `SHA-256(ticketId | payload_hash | nonce)`: the nonce is single use and stored with the ticket ID in `webauthn_challenges` (migration `0003` adds `ticket_id` and `nonce`), and the expected challenge is recomputed from the ticket row at verify time, so an assertion for one ticket can't approve another and a payload change after the challenge was issued fails. Approval needs the ticket's own user, a credential registered to that user, `APP_ORIGIN` and the RP ID, and the user-verified flag; then `pending -> approved` in one conditional update. Failed attempts are logged and limited (10 per user, 30 per IP hash per minute, 5-minute lock). A signed-out visitor, or another account, sees no preview and can sign in with a passkey on the page. That sign-in creates an **approval-only session under its own cookie `dg_approval`**: it never replaces or ends `dg_session`, ends no other session, and is refused by journey routes even if sent as the main cookie. The approver is the approval-only session if present, else the main session; in the agent's own browser the main session is the user's, so the UV passkey assertion is what stops the agent (T4). Redirects after the approval sign-in are built server-side from a validated ticket ID. The guard now reports a supplied ticket's state (unknown, wrong session, pending, used, declined, expired) before the action's preconditions, so a replay after the action ran gets `consumed`, not "Already submitted".
**Why:** FR20, FR21, controls W1-W4, W11, T4, T7-T9; J02 and J05.
**Not yet:** "Send to my phone instead" (`/device`, Phase 5); the OTP fallback (W9) stays off and unbuilt.
**Alternatives:** one cookie with an approval flag on the session (an approval-only sign-in would sign the agent's browser out of the journey).

## 2026-11-23 — Handoff panel, live status and variants (Phase 2 slice C)
**Decision:** The handoff panel shows what is being approved, the approval link, a QR code of the link (`qrcode` 1.5.4, rendered as SVG on the server; checked on the registry: published since 2010, about 42M weekly downloads, MIT, production audit clean), a countdown and the live status. Status comes from a short-lived SSE stream (`GET /api/hitl/[ticketId]/events`: checks every 1.5 s, closes after 25 s with a `reconnect` event, and stops as soon as the client goes away); the client reopens it, and falls back to polling `GET /api/hitl/[ticketId]` every 3 s on any stream error. On approval the panel shows "Approved: continue" and a Continue button that resubmits exactly the approved request: the guard stores the hashed request fields (volatile fields removed) in the ticket preview, so the resubmission matches the approval hash. `HITL_AUTORESUME=on` resubmits without a click. `HITL_HANDOFF_MODE=redirect` sends a gated form straight to `/approve/[ticketId]` (URL built from `APP_ORIGIN` and the ticket ID only); `both` adds a "Go to the approval page" button to the panel. Declined, superseded and expired requests show what happened and "Submit again".
**Testing variants:** the flags are fixed per run, so the e2e suite starts extra app servers on ports 3101 and 3102 from the same build (`tests/e2e/variant.ts`) to test redirect mode with `HITL_GATE_STATUS=202`, and auto-resume with `both`. Test pages that end on a waiting panel are now closed, because each held an event stream open; an earlier full run stalled on that.
**Why:** spec 9.2, FR24, FR26, FR27, architecture risk 2 (SSE on serverless) and section 8 (polling is the contract).
**Alternatives:** a QR code drawn on the client (more JavaScript, and agents reading the HTML would see no code); long-lived SSE (cut by function timeouts).

## 2026-11-23 — Session risk state and handover (Phase 2 slice D)
**Decision:** `sessions.risk_state` changes only through `escalateRisk` in `lib/auth/session.ts`: one conditional update that matches only a live session below the target state, plus a `session_events` row (`risk_changed`, from and to state, trigger, signals). `nextRiskState` encodes the architecture 4.9 diagram: a changed client context (user-agent or IP hash differs from sign-in) moves `clean` or `agent_observed` to `handover_suspected`; fresh agent evidence (tier A, B or a score at the threshold, not a class carried over) moves `clean` to `agent_observed`, or to `handover_suspected` if the session started with a human-leaning passkey login; nothing lowers it. Sign-in with agent evidence starts the session at `agent_observed` (`login_agent_evidence`). The guard applies the transition on every guarded request and, when the state rises, classifies the same request again under the new state, so the escalation counts at once (a changed context alone scores 30, below the threshold, but makes that request `suspected_agent`). A fresh passkey sign-in on `/login` remains the only way back: it starts a new clean session and ends the others.
**Why:** FR35-FR38, controls A8, A9, S10; T10a-c.
**Scope:** the classifier and risk state run on guarded (mutating) requests; page views and reads don't classify. The console timeline of these events is Phase 3; Web Bot Auth per-request attribution (T10d) is Phase 5.
**Test runner stall:** see "E2E stalls were the Mac sleeping" below; the virtual-authenticator clean-up added here is kept as hygiene but was not the cause.

## 2026-11-23 — Phase 2 deployed; automatic deploys confirmed
Migration `0003` was applied to production before PR #5 was merged (4 migrations; `webauthn_challenges.ticket_id` and `nonce` present, RLS on). Merging PR #5 started the production deploy of `1b4989e` on its own, confirming the Git link fix; branch pushes create skipped deployments as `vercel.json` intends. Verified on `https://hitltest.vercel.app` with the demo account from a script: a form submit returns to the step page with a ticket and the handoff panel (QR code and JSON present); an API submit gets `403` with the step-up header and the same pending ticket; the approval page shows the domain strip and the passkey button; decline sets the ticket to `rejected`; a contact change is denied. A draft "Production check (delete me)" was left in the demo account (deleting it needs a passkey approval).

## 2026-11-23 — Console access, run tagging and ground truth (Phase 3 slice A)
**Decision:** `/console` is opened with `ADMIN_SECRET` (at least 16 characters; the console shows "not set up" without it), not with any user account. A correct secret sets `dg_admin`: an HttpOnly, SameSite=Strict cookie of `<expiry>.<HMAC>` keyed with `SESSION_SECRET` over the expiry and a fingerprint of the admin secret, valid 8 hours, so changing `ADMIN_SECRET` signs every admin out. Console writes need a CSRF token derived from that cookie. Five wrong secrets in a minute lock console sign-in from that IP hash for 10 minutes; every attempt is logged. The console is not linked anywhere and sends `noindex` (meta tag and `X-Robots-Tag`). Runs are tagged by `?run=<id>` (letters, digits, `_`, `-`, up to 40) on any page: `proxy.ts` sets a `dg_run` cookie, sign-in copies it to `sessions.run_id` (migration `0004`), guard rows use the session's run, and approval rows use the run of the session that asked. The tester's ground truth lives in a new `runs` table (agent label, who was acting: agent, human or mixed, notes), shown beside the classifier output and never read by the classifier. The request table filters by run, agent label (through `runs`) and session ID prefix; CSV and JSON exports use the same filters, keep IPs hashed, quote every CSV cell and neutralise spreadsheet formulas. The policy and classifier weights are shown read-only.
**Why:** FR16, FR39, FR40, controls A6, C6, L2, L4.
**Changes from the spec:** the "dropdown that stores the run in the session" is the console's run filter plus a start link to give the agent (`<origin>/?run=<id>`); the run itself is set by the start URL.
**Alternatives:** an admin user with a passkey (stronger, more to build, tied to the RP ID); a stateful admin session table (revocable, not needed for one tester).

## 2026-11-23 — E2E stalls were the Mac sleeping
**Finding:** Intermittent e2e stalls of 39 s to 5 minutes (and once a 240 s build timeout) were the owner's Mac going into idle sleep on battery (`sleep 1`, `displaysleep 2` in `pmset`) about a minute after the last keypress, mid-run. A Playwright trace kept on failure showed the app answering in milliseconds and the browser then idle for 78 s; the power log shows `Idle Sleep` at 16:49:34 and `DarkWake` at 16:50:54 local, the same 78 s. Database lock checks, 300 timed Docker connections (max 12 ms) and a larger test pool ruled out the app and the database.
**Decision:** `playwright.config.ts` starts `caffeinate -i -w <pid>` on macOS outside CI, which blocks idle sleep only while the test process runs and leaves power settings unchanged. Kept from the investigation: failing tests keep a trace (`trace: "retain-on-failure"`); variant servers wait for their port to free before starting and after stopping; specs reset the per-user ticket counters before each test, because one demo user now creates more than the 20 tickets a minute the limit allows (the limit itself is tested separately); pages left on a waiting panel are closed; virtual authenticators are removed after each test.
**Alternatives:** asking the owner to change power settings or stay plugged in (easy to forget; the run fails confusingly).

## 2026-11-23 — Console detail panel, live table and reset (Phase 3 slice B)
**Decision:** Selecting a ticket or a row's time opens a detail panel beside the table, with Ticket and Session tabs. Ticket: created (requesting actor class and score, requesting session), approved (method, whether on an approval-only session, time to approve) or declined, superseded or expired, then consumed (redeeming session, times executed), plus rejected redemption attempts, with `wrong_session` worded as not an agent error. An approved ticket past its expiry is flagged "approved, not redeemed" (a resume failure) in the panel and the table. Session: login class beside the class of its latest request, a "probable handover" flag when they disagree about an agent or the risk state is `handover_suspected`, and the timeline of sign-in, risk changes and revocation. The table re-renders every 5 s (can be paused). "Reset demo data" asks for confirmation in a dialog (the only dialog in the product), then in one transaction deletes request log, session events, client signals, tickets, challenges, sessions, rate limits and applications, restores the seed applications and clears the demo users' recovery contact details; the reset is then logged with the counts removed. Users and passwords, passkeys (the owner's real approver credentials), run ground truth and MCP clients are kept. Seed data moved to `lib/db/seed-data.ts`, shared by the seed script and the reset.
**Why:** FR39, design.md 4.8, controls L3, A3; J11.
**Alternatives:** resetting passkeys too (would remove the owner's enrolled approver passkeys on production); a reset confirmation page instead of a dialog.

## 2026-11-23 — Phase 3 deployed
Migration `0004` was applied to production before PR #6 was merged (5 migrations; `runs` with RLS, `sessions.run_id`). The merge deployed `4a57323` automatically. Verified on production: `/console` serves the sign-in with `X-Robots-Tag: noindex, nofollow` and the `noindex` meta tag; the landing page has no console link; `/?run=prodcheck1` sets an HttpOnly run cookie and the following sign-in is stored with that run; a demo-user session gets the console sign-in and a `403` on export. `ADMIN_SECRET` is not yet set on production, so the console shows "not set up".

## 2026-11-23 — Phase 4 spike: MCP SDK 2.x, both revisions, inside Next.js
**Findings (from the published packages, read without running them, then tested):**
- `@modelcontextprotocol/sdk` 1.32.2 (latest 1.x, 2026-10-23) supports protocol revisions only up to 2025-11-25.
- The split 2.x SDK, `@modelcontextprotocol/server`, `client` and `core` 2.4.0 (2026-10-23, same maintainers, about 34M weekly downloads for `server`), serves both eras. Revision 2026-07-28 ("modern") is negotiated through `server/discover`, and the 2025 revisions ("legacy") through `initialize`, with a codec chosen per request. `createMcpHandler(factory, { legacy: "stateless" })` serves both from one factory as a web-standard `Request` -> `Response` handler, building a fresh server per request. It performs no token verification: `authInfo` is passed through to tools.
- Confirmed 2026-07-28 details from the SDK source: no `initialize`; the version is negotiated per request in a `_meta` envelope; `server/discover` is mandatory for servers; the elicitation completion notification is removed (the client retries the original request); out-of-band input uses `input_required` with `inputRequests` and `requestState`; `subscriptions/listen` replaces the HTTP GET stream; sampling, roots and logging are deprecated.
- The 2.4.0 client defaults to the legacy handshake (`versionNegotiation` must be `auto` or a pin to use 2026-07-28). Many real clients are therefore likely to arrive on 2025-11-25, which supports serving both.
- Verified: `tests/integration/mcp-spike.test.ts` (pinned 2026-07-28, auto, legacy 2025-11-25 and the default client, each calling a tool), and a temporary route in a production Next.js build called over HTTP on all three (removed afterwards; nothing unauthenticated was committed).
- The 2.x SDK has no OAuth authorization server. It has only resource-server pieces (bearer verification and RFC 9728 metadata, Express-only) and Zod schemas for OAuth payloads. The 1.x authorization-server router was Express-only too.
**Decision:** Use the 2.x SDK (`@modelcontextprotocol/server` at runtime, `@modelcontextprotocol/client` for tests only), served by `createMcpHandler` in a Next.js route. Both added after a registry check; `npm audit --omit=dev` is clean, and they share the app's `zod` 4.

## 2026-11-23 — MCP OAuth: a minimal authorization server built into the app (supersedes "using the SDK's auth helpers")
**Decision (owner, 2026-11-23):** Hand-build a small OAuth 2.1 authorization server in the app, because the SDK no longer provides one: dynamic client registration (RFC 7591, exact redirect URIs, HTTPS or loopback), a consent screen naming the client, authorization code with PKCE S256 only, short-lived signed JWT access tokens with `sub` = user, `act` = client and `aud` = the `/mcp` resource, and authorization server (RFC 8414) and protected resource (RFC 9728) metadata. Payloads are validated with the SDK's OAuth Zod schemas.
**Why:** It fits Next.js route handlers on Vercel, keeps the `act` claim and consent screen under our control, and has no third-party account.
**Risk and mitigation:** This is security-sensitive code that we own. Each OAuth control (M1-M3) gets negative tests, the token library is checked on the registry before install, and the design follows the MCP authorization spec.
**Alternatives:** `oidc-provider` (certified, but expects Node/Koa request objects and needs a storage adapter); an external IdP with MCP support (least code, adds a third party and possible cost).

## 2026-11-23 — MCP OAuth server details (Phase 4 slice A)
**Decision:**
- **Metadata:** RFC 8414 at `/.well-known/oauth-authorization-server`; RFC 9728 at `/.well-known/oauth-protected-resource/mcp` and at the root path.
- **Registration:** `POST /api/oauth/register` (RFC 7591) accepts public clients only (`token_endpoint_auth_method: none`, `authorization_code` only) with 1-5 redirect URIs. Each URI must be HTTPS, or HTTP on `localhost`, `127.0.0.1` or `[::1]`, with no fragment or credentials. It is validated with the SDK's `OAuthClientMetadataSchema`, and the client name is cleaned and shortened for the consent screen. Limited to 30 registrations per IP hash per hour.
- **Authorization:** `/oauth/authorize` shows an unknown client or unregistered redirect URI on our own page and never redirects (no open redirect). Other errors go back to the registered URI with `state` and `iss` (RFC 9207). It requires `response_type=code`, PKCE S256, `resource` equal to `<origin>/mcp` when sent, and the scope `mcp`.
- **Sign-in and consent:** a signed-out user goes to `/login?next=…`, where only `/oauth/authorize?…` is accepted as a return path (password and passkey sign-in). The consent page names the client and the account, and says that every gated action still needs the account holder's passkey.
- **Returning to the client:** the consent decision returns through a small page with its own strict CSP and `no-referrer`. A redirect after a form post would be blocked by our `form-action 'self'` policy, and this way the code stays out of our own URLs.
- **Codes:** a code is stored as a SHA-256 and lasts 5 minutes. It is redeemed in one conditional update, bound to client, redirect URI, user, PKCE challenge and resource. A replayed code revokes the token issued from it.
- **Tokens:** access tokens are `at+jwt` JWTs signed HS256 with a key derived from `SESSION_SECRET` (the issuer and the resource are this same app, so there is no published key set and no key table). They carry `iss`, `sub` = user, `aud` = `<origin>/mcp`, `act.sub` = `client_id` = the client, `scope`, `jti` and a 1-hour `exp`. Each one is recorded in `oauth_tokens`, so verification also checks that it was issued here and isn't revoked. There are no refresh tokens; a client signs in again after an hour.
- **Other:** metadata, registration and token endpoints send `Access-Control-Allow-Origin: *` (they use no cookies). "Reset demo data" also clears codes and tokens but keeps registered clients. New tables `oauth_codes` and `oauth_tokens` (migration `0005`). Dependencies: `jose` 6.2.16 (panva, MIT, no dependencies; the newest release was under two weeks old, so the previous one was pinned) and `@modelcontextprotocol/core` 2.4.0 as a direct dependency.

**Why:** FR30, controls M1-M3, the MCP authorization spec.
**Not yet:** OAuth Client ID Metadata Documents (URL client IDs) and refresh tokens; add if a live client needs them.

## Open
- Apply migration `0005` to production before merging Phase 4.
- Owner sets `ADMIN_SECRET` (a long random value) in `.env.local` and in Vercel Production before using the console.
- Optional before Phase 6: GitHub Actions e2e run against the Supabase test project (exercises the pooler).
- Phase 6 capability check: whether Muse can browse or use MCP.
