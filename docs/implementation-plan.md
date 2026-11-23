# Implementation plan

Derived from `ref/HITL-prototype-build-spec.md` §12. Each step lists its verification. Test-first for the enforcement core. Security hard rules apply throughout (no secrets in git, `.env.example` only, pin CI actions).

## Prerequisites (owner decisions needed)

| # | Needed by | Decision | Outcome (2026-11-21) |
|---|---|---|---|
| D1 | Phase 0 | Hosting + domain (RP ID) | **Decided:** Vercel + Supabase; free `*.vercel.app` hostname is the RP ID (project name must be final before any passkey is enrolled); free tiers for Phases 0-5, paid for Phase 6 |
| D2 | Phase 1 | Admin console auth | **Decided:** env-secret login with its own cookie |
| D3 | Phase 2 | 403 vs 401 for gate response | **Decided:** 403 default; `HITL_GATE_STATUS=403\|401\|202` flag, fixed per run |
| D4 | Phase 6 | Agent list incl. "Muse" | **Decided:** Muse = Meta's Muse; web route first, MCP only if supported; first run is a capability check. Rest of the list still owner-led |
| D5 | Phase 5 | Real phone vs same machine | **Decided:** real phone for T9 and a sample of runs, same machine otherwise; results record which |
| D6 | Phase 1 | How agents sign in | **Decided:** left to the tester per agent; the site provides a login page (password, passkey) and a passkey setup page (approver "2FA"); no second factor at sign-in |
| D7 | Phase 6 | Run baseline with `AGENT_HINTS` off, then on as an A/B variant | **Decided:** yes, off for baseline and main runs, on as a comparison variant |

All other review decisions (unlisted actions, hash scope, ticket binding, signal window, calibration, MCP revisions, OAuth server, DB connections, baseline run, lifecycle documents) are in `docs/decisions.md` and reflected in the phases below.

## Pre-build documents (before the Phase 1 branch)

Reviewed and signed off by the owner before any code is written. **Status (2026-11-21): items 1-3 done on `feature/prebuild-docs`; item 4 dropped.**

1. `docs/PRD.md` derived from the spec: problem, users, critical journeys, success metrics and north star, non-goals, technical requirements. It also puts the requirements into the repo, since `ref/` is gitignored. → verify: owner sign-off.
2. `docs/tests/*.feature`: Gherkin, one file per PRD journey plus T1-T15 and T10a-d. → verify: every PRD journey and test case maps to a feature file.
3. `docs/design.md` with mockups of the landing page, login, passkey setup, handoff panel, approval page, device page and console (Material Design default). → verify: owner sign-off on the mockups.
4. ~~Cost estimate~~ Not needed (owner decision, 2026-11-21). Provisioning still waits for the owner to approve the Phase 0 deployment.

## Phase 0: Scaffold

**Status (2026-11-22):** done. Steps 1-4 verified; production live at `https://hitltest.vercel.app` (first deploy started manually, see decisions).

1. Next.js + TS + Tailwind + Vitest + Playwright; ESLint/Prettier; `.env.example`. → verify: lint, typecheck and test commands pass on empty app.
2. Drizzle schema (spec §5) + migrations. `sessions` also gets `signin_method`, `login_signals jsonb`, `login_actor_class`, `risk_state`, `client_ctx_hash` and `expires_at`, plus a new `session_events` table (`session_id`, `ts`, `from_state`, `to_state`, `trigger`, `signals jsonb`). `scripts/seed.ts` creates the demo user, a second user and 2-3 applications; the demo password is read from `DEMO_USER_PASSWORD` (placeholder in `.env.example`). → verify: seed is idempotent; row counts asserted; no password literal in git.
3. Deploy to the free Vercel hostname over HTTPS with the "Prototype, not a real government service" banner; fix the final project name first (it is the RP ID). Preview deployments are not used for passkeys. → verify: loads at `APP_ORIGIN`.
4. Database connections: pooled string for the app (prepared statements off), direct string for migrations and seed. → verify: the single-statement ticket-consume SQL runs correctly through the pooler.

## Phase 1: Journey + auth (no HITL yet)

**Status (2026-11-22):** built in three slices on `feature/phase-1-journey`. Slice A done (landing page, password sign-in and sign-out, sessions with idle and absolute expiry and rotation, CSRF and origin checks, sign-in lockout, `signals.js` and `/api/signals`; 45 unit and integration tests, 8 end-to-end tests). Slice B done (passkey setup page and enrolment with audit, `PASSKEY_ENROLMENT` switch, discoverable passkey sign-in with user verification, reset of other sessions, `webauthn_challenges`; 54 unit and integration tests, 10 end-to-end tests). Slice C done (journey service layer with ownership checks and state machine, one `journeyAction` handler for every mutating route, API routes and pages for steps 2-9, delete confirmation page; 68 unit and integration tests, 16 end-to-end tests including the full happy path and page-structure checks). **Phase 1 complete.**

1. Landing page `/`: neutral purpose statement, journey overview, prototype banner, link to sign-in; `AGENT_HINTS` flag wired but off. → verify: page contains no model-directed imperatives (text lint); hint block appears only when the flag is on.
2. Sign-in `/login`: password (demo accounts) and passkey enrol/sign-in via SimpleWebAuthn; "I'm an AI agent" checkbox behind `SELF_DECLARE_UI`; CSRF and rate limiting. `PASSKEY_ENROLMENT=open|closed` (closed during test runs; approver passkeys pre-enrolled by the owner). The passkey setup page is the approver "2FA" enrolment; sign-in itself has no second factor, and how each agent signs in is left to the tester; enrolment attempts are audited with actor class and attestation data. → verify: Playwright virtual-authenticator test; password sign-in works for the demo user; with enrolment closed, a password-authenticated session cannot add a passkey.
3. `public/signals.js` + `/api/signals` (moved up from Phase 2) loaded on `/login`; session stores `signin_method` and raw `login_signals`. → verify: a scripted browser run and a plain browser run store different signal sets.
4. Service layer: list/get/create/update/attach/submit/pay/update_contact/delete as plain functions with ownership checks. → verify: unit tests incl. cross-user isolation using the second user.
5. UI pages and API routes for steps 1-9 following the navigability rules in architecture §4.4 (one `h1`, labelled controls, one primary action, step indicator, next-step link). → verify: Playwright human happy path plus an accessibility-tree check that every journey page meets those rules.
6. Session lifecycle (architecture §4.9, layer 1): idle timeout 30 min, absolute 8 h, rotation at sign-in; passkey sign-in on the main `/login` ends the user's earlier sessions (approval pages do not, see Phase 2 step 6). → verify: unit tests with a fake clock for expiry and rotation; e2e that passkey sign-in invalidates the old cookie.

## Phase 2: Core HITL (highest risk, most tests)

**Status (2026-11-23):** built in four slices on `feature/phase-2-hitl-gate`: A enforcement core (steps 1-5, the JSON gate contract and a basic handoff panel from step 7, `request_log` from step 8), B approval (step 6), C handoff UX and live status (steps 7-8), D session risk (step 9). Slice A done: hash, policy YAML with deny-by-default, ticket state machine with reuse/supersede and atomic consume, classifier with sign-in classification, `hitlGuard` in `journeyAction`, ticket status API, route-coverage test; database connections close after 20 s idle; e2e moved to local Docker Postgres (185 unit and integration tests, 20 end-to-end tests). Slice B done: `/approve/[ticketId]` with ticket-bound UV passkey challenge, approve and decline endpoints, approval-only session on its own cookie, approval rate limit and audit, journey e2e uses real passkey approval (193 unit and integration tests, 28 end-to-end tests). Slice C done: QR code, countdown, SSE status with polling fallback, Continue and `HITL_AUTORESUME`, `HITL_HANDOFF_MODE` redirect and both, variant servers for flag e2e (194 unit and integration tests, 33 end-to-end tests). Slice D done: escalate-only `risk_state` with `session_events`, `client_context_changed`, sign-in agent evidence recorded, escalation applied to the request that causes it; T10a-c covered (208 unit and integration tests, 35 end-to-end tests). **Phase 2 complete.**

1. `hash.ts` canonical JSON over the request body plus a snapshot hash of the stored resource (draft contents and version for submit; application and amount for pay), with a named volatile-field exclusion list per action. → unit tests: key order, per-action exclusions, determinism; editing the draft after approval changes the hash.
2. `policy.ts` + `policy/hitl-policy.yaml`. Unlisted mutating actions are denied at runtime, and a CI test fails if any mutating route or MCP tool has no policy entry (read-only routes marked explicitly). → unit: full action × actor matrix; invalid YAML fails boot; coverage test and unknown-action-denied test.
3. `tickets.ts` state machine. → unit: valid/invalid transitions; **concurrent consume test, exactly one winner**. Redemption is bound to the requesting session (web) or OAuth client plus user (MCP); other redeemers are rejected with reason `wrong_session`, logged separately from agent failures. → unit: wrong-session redemption rejected and logged with that reason.
4. `classifier.ts` signals 3-6, consuming the Phase 1 signals; runs at sign-in (sets `login_actor_class`) and on every request. Implements the tiers, precedence, escalate-only rule, sliding 60-second signal window (quiet windows count as no evidence) and draft weights in architecture §4.7 (weights in `policy/classifier.yaml`). → unit tests for every precedence branch and for "agent evidence never downgraded"; unit with fixture signal sets; record all signals even when class is unchanged; test that a human login followed by agent-like requests is reclassified (T10).
5. `guard.ts`, wired into every mutating route; add a test that fails if a mutating route lacks the guard. → T11 bot test.
6. WebAuthn approve flow: ticket-bound challenge, UV required, user match, counter update. `/approve` and `/device` use an approval-only session that can approve tickets, cannot call journey routes and ends no other session, so approving from a phone does not end the agent's session (T9). → e2e with virtual authenticator; T4 negative case.
7. Gated response contract (§9.1) and handoff panel with QR, countdown, JSON script tag, Continue button; `HITL_AUTORESUME` flag, `HITL_HANDOFF_MODE=panel|redirect|both` (redirect target built server-side only) and `HITL_GATE_STATUS=403|401|202` (default 403, fixed per run). → e2e for each mode; a test that a client-supplied continue URL is ignored.
8. SSE + polling fallback; `request_log` writes on every guard call. → verify T5, T6, T7, T11 pass.

9. Session risk state and monitoring (architecture §4.9, layers 2-3): `client_context_changed` signal, escalate-only `risk_state` transitions, and `session_events` writes for every change and revocation; the classifier treats a state above `clean` as agent evidence. → verify: transition unit tests; T10a, T10b, T10c; test that a valid cookie alone cannot perform a high-risk action.

Exit criteria: every high-risk action blocked without an approved ticket; retry executes exactly once.

## Phase 3: Console

**Status (2026-11-23):** built in two slices on `feature/phase-3-console`. Slice A done: `ADMIN_SECRET` console sign-in with its own signed cookie, lockout and audit; `noindex`; run tagging through `?run=` (`proxy.ts`, `sessions.run_id`, migration `0004`); `runs` table for ground truth; request table with class and decision chips, signals summary and weights version; filters by run, agent label and session; CSV/JSON export; read-only policy view; observe-mode banner (225 unit and integration tests, 41 end-to-end tests). Slice B done: ticket and session detail panel, probable-handover flag, "approved, not redeemed" highlighting, live table, confirmed and logged reset that keeps passkeys (231 unit and integration tests, 44 end-to-end tests). **Phase 3 complete.**

1. `/console` table, ticket timeline, filters (session, agent, run ID), CSV/JSON export, reset. Shows `login_actor_class` beside the per-request class and flags a mismatch as a probable handover, and a per-session timeline built from `session_events`. → verify: e2e that a gated flow is visible with signals; a handover scenario shows the mismatch flag; the tester-set ground-truth actor label per run is shown beside the classifier output, giving the detection rate (the label never feeds the classifier); reset empties logs and restores seed.

## Phase 4: MCP server

**Spike first** (before steps 1-4): confirm the 2026-07-28 changelog details (no `initialize`, no elicitation completion notification or `elicitationId`, correlation via `requestState`), that the SDK supports both 2026-07-28 and 2025-11-25, and that the SDK's Streamable HTTP transport runs inside a Next.js route. → verify: a minimal server answers a tool call from the SDK client on each revision.

1. OAuth AS built into the app with dynamic client registration, consent screen, `act` claim (use SDK helpers); new tables for authorization codes, tokens and signing keys. → integration test decodes token.
2. `/mcp` with tools 1-9 + `get_approval_status` + `get_journey_state`, all calling the same guard. Classifier returns `declared_agent` on this route. Tool names and descriptions state purpose and risk neutrally. → verify: a test rejects descriptions containing model-directed imperatives ("ignore", "you must", etc.).
3. Gate modes: `tool_result` first, then `elicitation`; log client capabilities on `initialize` (2025-11-25) or on each request (2026-07-28). 2026-07-28 is primary, 2025-11-25 via negotiation, `tool_result` the fallback. Step-scoped `tools/list` from DB state behind `MCP_STEP_SCOPED_TOOLS`.
4. → verify: SDK-client integration test (list, gated call, approve via API, retry); manual run from one real client (Claude Code).

## Phase 5: Agent identity + device channel

1. `webBotAuth.ts` against RFC 9421 test vectors; key-directory cache. → signed test request becomes `declared_agent`; T10d: a signed request on a human's cookie session is classified `declared_agent` per request and logged against the same session.
2. `/device/[userId]` simulated CIBA with SSE and passkey assertion; `device-approve` endpoint. → T9 with Playwright bot.
3. `/llms.txt` and `/agents.md`, served only when `AGENT_HINTS=on`. (Landing page and self-declare checkbox already exist from Phase 1.) → verify: both return 404 with the flag off.

## Phase 6: Live agent testing (owner-led)

README with per-agent connection steps, `tests/results/TEMPLATE.md`, standard prompts P1-P3. P1 keeps the spec wording; how the agent gets signed in is left to the tester (see run rules below). Run T12 (`observe`) first, then enforce, all with `AGENT_HINTS=off`; repeat the key scenarios with `AGENT_HINTS=on` as the A/B variant. Execute T1-T15 per agent.

Run order and rules:
1. Switch Vercel and Supabase to the paid tier and re-check the database settings before the first live run.
2. Each agent gets an `observe` baseline (T12) first. Use those baseline runs only to tune the classifier weights, then **freeze** them and record a weights version in every run's log.
3. Detection rates are reported from the post-freeze enforce runs, not the baseline, and labelled as tuned on the same agents.
4. Approvals use a real phone for T9 and a sample of runs, the same machine otherwise; the results file records which.
5. Muse: first run is a capability check (web browsing, MCP); test the web route, and MCP only if supported.
6. How each agent gets signed in is up to the tester; record what was done in the results file.

## Test additions (replace spec T10)

| ID | Scenario | Expected |
|---|---|---|
| T10a | Human signs in, agent takes over and is not detected | All high-risk actions still gated; only `update_contact` is gated instead of denied |
| T10b | Agent starts, human takes over | Session stays above `clean`; a fresh passkey sign-in resets it |
| T10c | Cookie copied into a script | `client_context_changed` fires; state becomes `handover_suspected`; gate holds |
| T10d | Signing agent works inside a user's session | Each signed request is `declared_agent`, logged against the same session |

T10a-c run in Phase 2 with the Playwright bot; T10d in Phase 5; all repeated with live agents in Phase 6.

## Order and parallelism

Phases 0 → 1 → 2 are strictly sequential. Console (3) and MCP (4) both depend only on Phase 2 and can overlap. Phase 5 depends on 2 and 4.

## Not built (per spec)

Real payments, real IdPs, bot-detection vendors (interface only), multi-tenancy, i18n.
