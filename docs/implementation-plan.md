# Implementation plan

Derived from `ref/HITL-prototype-build-spec.md` §12. Each step lists its verification. Test-first for the enforcement core. Security hard rules apply throughout (no secrets in git, `.env.example` only, pin CI actions).

## Prerequisites (owner decisions needed)

| # | Needed by | Decision | Default if unanswered |
|---|---|---|---|
| D1 | Phase 0 | Hosting + domain (RP ID) | Vercel + Supabase, owner-supplied domain |
| D2 | Phase 1 | Admin console auth | Env-secret login |
| D3 | Phase 2 | 403 vs 401 for gate response | Follow spec (403 + WWW-Authenticate), flagged |
| D4 | Phase 6 | Agent list incl. "Muse" | Owner-led |
| D5 | Phase 5 | Real phone vs same machine | Same machine, recorded in results |
| D6 | Phase 1 | How agents sign in | Password for demo accounts, supplied in the test prompt (never committed); passkey for humans |
| D7 | Phase 6 | Run baseline with `AGENT_HINTS` off, then on as an A/B variant | Yes: off first |

Resolved: hosting is Vercel + Supabase Postgres (domain still needed before deploy).

## Phase 0: Scaffold

1. Next.js + TS + Tailwind + Vitest + Playwright; ESLint/Prettier; `.env.example`. → verify: lint, typecheck and test commands pass on empty app.
2. Drizzle schema (spec §5) + migrations. `sessions` also gets `signin_method`, `login_signals jsonb`, `login_actor_class`, `risk_state`, `client_ctx_hash` and `expires_at`, plus a new `session_events` table (`session_id`, `ts`, `from_state`, `to_state`, `trigger`, `signals jsonb`). `scripts/seed.ts` creates the demo user, a second user and 2-3 applications; the demo password is read from `DEMO_USER_PASSWORD` (placeholder in `.env.example`). → verify: seed is idempotent; row counts asserted; no password literal in git.
3. Deploy to public HTTPS with the "Prototype, not a real government service" banner. → verify: loads at `APP_ORIGIN`.

## Phase 1: Journey + auth (no HITL yet)

1. Landing page `/`: neutral purpose statement, journey overview, prototype banner, link to sign-in; `AGENT_HINTS` flag wired but off. → verify: page contains no model-directed imperatives (text lint); hint block appears only when the flag is on.
2. Sign-in `/login`: password (demo accounts) and passkey enrol/sign-in via SimpleWebAuthn; "I'm an AI agent" checkbox behind `SELF_DECLARE_UI`; CSRF and rate limiting. `PASSKEY_ENROLMENT=open|closed` (closed during test runs; approver passkeys pre-enrolled by the owner); enrolment attempts are audited with actor class and attestation data. → verify: Playwright virtual-authenticator test; password sign-in works for the demo user; with enrolment closed, a password-authenticated session cannot add a passkey.
3. `public/signals.js` + `/api/signals` (moved up from Phase 2) loaded on `/login`; session stores `signin_method` and raw `login_signals`. → verify: a scripted browser run and a plain browser run store different signal sets.
4. Service layer: list/get/create/update/attach/submit/pay/update_contact/delete as plain functions with ownership checks. → verify: unit tests incl. cross-user isolation using the second user.
5. UI pages and API routes for steps 1-9 following the navigability rules in architecture §4.4 (one `h1`, labelled controls, one primary action, step indicator, next-step link). → verify: Playwright human happy path plus an accessibility-tree check that every journey page meets those rules.
6. Session lifecycle (architecture §4.9, layer 1): idle timeout 30 min, absolute 8 h, rotation at sign-in; passkey sign-in ends the user's earlier sessions. → verify: unit tests with a fake clock for expiry and rotation; e2e that passkey sign-in invalidates the old cookie.

## Phase 2: Core HITL (highest risk, most tests)

1. `hash.ts` canonical JSON. → unit tests: key order, volatile-field exclusion, determinism.
2. `policy.ts` + `policy/hitl-policy.yaml`. → unit: full action × actor matrix; invalid YAML fails boot.
3. `tickets.ts` state machine. → unit: valid/invalid transitions; **concurrent consume test, exactly one winner**.
4. `classifier.ts` signals 3-6, consuming the Phase 1 signals; runs at sign-in (sets `login_actor_class`) and on every request. Implements the tiers, precedence, escalate-only rule and draft weights in architecture §4.7 (weights in `policy/classifier.yaml`). → unit tests for every precedence branch and for "agent evidence never downgraded"; unit with fixture signal sets; record all signals even when class is unchanged; test that a human login followed by agent-like requests is reclassified (T10).
5. `guard.ts`, wired into every mutating route; add a test that fails if a mutating route lacks the guard. → T11 bot test.
6. WebAuthn approve flow: ticket-bound challenge, UV required, user match, counter update. → e2e with virtual authenticator; T4 negative case.
7. Gated response contract (§9.1) and handoff panel with QR, countdown, JSON script tag, Continue button; `HITL_AUTORESUME` flag and `HITL_HANDOFF_MODE=panel|redirect|both` (redirect target built server-side only). → e2e for each mode; a test that a client-supplied continue URL is ignored.
8. SSE + polling fallback; `request_log` writes on every guard call. → verify T5, T6, T7, T11 pass.

9. Session risk state and monitoring (architecture §4.9, layers 2-3): `client_context_changed` signal, escalate-only `risk_state` transitions, and `session_events` writes for every change and revocation; the classifier treats a state above `clean` as agent evidence. → verify: transition unit tests; T10a, T10b, T10c; test that a valid cookie alone cannot perform a high-risk action.

Exit criteria: every high-risk action blocked without an approved ticket; retry executes exactly once.

## Phase 3: Console

1. `/console` table, ticket timeline, filters (session, agent, run ID), CSV/JSON export, reset. Shows `login_actor_class` beside the per-request class and flags a mismatch as a probable handover, and a per-session timeline built from `session_events`. → verify: e2e that a gated flow is visible with signals; a handover scenario shows the mismatch flag; the tester-set ground-truth actor label per run is shown beside the classifier output, giving the detection rate (the label never feeds the classifier); reset empties logs and restores seed.

## Phase 4: MCP server

1. OAuth AS with dynamic client registration, consent screen, `act` claim (use SDK helpers). → integration test decodes token.
2. `/mcp` with tools 1-9 + `get_approval_status` + `get_journey_state`, all calling the same guard. Classifier returns `declared_agent` on this route. Tool names and descriptions state purpose and risk neutrally. → verify: a test rejects descriptions containing model-directed imperatives ("ignore", "you must", etc.).
3. Gate modes: `tool_result` first, then `elicitation`; log client capabilities on `initialize`. Step-scoped `tools/list` from DB state behind `MCP_STEP_SCOPED_TOOLS`.
4. → verify: SDK-client integration test (list, gated call, approve via API, retry); manual run from one real client (Claude Code).

## Phase 5: Agent identity + device channel

1. `webBotAuth.ts` against RFC 9421 test vectors; key-directory cache. → signed test request becomes `declared_agent`; T10d: a signed request on a human's cookie session is classified `declared_agent` per request and logged against the same session.
2. `/device/[userId]` simulated CIBA with SSE and passkey assertion; `device-approve` endpoint. → T9 with Playwright bot.
3. `/llms.txt` and `/agents.md`, served only when `AGENT_HINTS=on`. (Landing page and self-declare checkbox already exist from Phase 1.) → verify: both return 404 with the flag off.

## Phase 6: Live agent testing (owner-led)

README with per-agent connection steps, `tests/results/TEMPLATE.md`, standard prompts P1-P3. P1 is amended to include the demo password via a `<DEMO_PASSWORD>` placeholder filled in at test time. Run T12 (`observe`) first, then enforce, all with `AGENT_HINTS=off`; repeat the key scenarios with `AGENT_HINTS=on` as the A/B variant. Execute T1-T15 per agent.

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
