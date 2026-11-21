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

## Open
- Phase 0: verify the pooled database connection settings; fix the final Vercel project name before any passkey is enrolled.
- Owner confirmation of the repeated-request ticket behaviour (reuse or supersede), logged above as pending.
- Phase 4 spike: confirm the 2026-07-28 changelog details, SDK support for both revisions, and the MCP SDK inside a Next.js route.
- Phase 6 capability check: whether Muse can browse or use MCP.
