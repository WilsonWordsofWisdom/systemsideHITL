# Implementation plan

Derived from `doc/HITL-prototype-build-spec.md` §12. Each step lists its verification. Test-first for the enforcement core. Security hard rules apply throughout (no secrets in git, `.env.example` only, pin CI actions).

## Prerequisites (owner decisions needed)

| # | Needed by | Decision | Default if unanswered |
|---|---|---|---|
| D1 | Phase 0 | Hosting + domain (RP ID) | Vercel + Supabase, owner-supplied domain |
| D2 | Phase 1 | Admin console auth | Env-secret login |
| D3 | Phase 2 | 403 vs 401 for gate response | Follow spec (403 + WWW-Authenticate), flagged |
| D4 | Phase 6 | Agent list incl. "Muse" | Owner-led |
| D5 | Phase 5 | Real phone vs same machine | Same machine, recorded in results |

## Phase 0: Scaffold

1. Next.js + TS + Tailwind + Vitest + Playwright; ESLint/Prettier; `.env.example`. → verify: lint, typecheck and test commands pass on empty app.
2. Drizzle schema (spec §5) + migrations + `scripts/seed.ts` (demo user, second user, 2-3 applications). → verify: seed is idempotent; row counts asserted.
3. Deploy to public HTTPS with the "Prototype, not a real government service" banner. → verify: loads at `APP_ORIGIN`.

## Phase 1: Journey + auth (no HITL yet)

1. Session auth (email+password stub) and passkey enrolment/sign-in via SimpleWebAuthn. → verify: Playwright virtual-authenticator test.
2. Service layer: list/get/create/update/attach/submit/pay/update_contact/delete as plain functions with ownership checks. → verify: unit tests incl. cross-user isolation using the second user.
3. UI pages and API routes for steps 1-9. → verify: Playwright human happy path.

## Phase 2: Core HITL (highest risk, most tests)

1. `hash.ts` canonical JSON. → unit tests: key order, volatile-field exclusion, determinism.
2. `policy.ts` + `policy/hitl-policy.yaml`. → unit: full action × actor matrix; invalid YAML fails boot.
3. `tickets.ts` state machine. → unit: valid/invalid transitions; **concurrent consume test, exactly one winner**.
4. `classifier.ts` signals 3-6 + `public/signals.js` + `/api/signals`. → unit with fixture signal sets; record all signals even when class is unchanged.
5. `guard.ts`, wired into every mutating route; add a test that fails if a mutating route lacks the guard. → T11 bot test.
6. WebAuthn approve flow: ticket-bound challenge, UV required, user match, counter update. → e2e with virtual authenticator; T4 negative case.
7. Gated response contract (§9.1) and handoff panel with QR, countdown, JSON script tag, Continue button; `HITL_AUTORESUME` flag. → e2e.
8. SSE + polling fallback; `request_log` writes on every guard call. → verify T5, T6, T7, T11 pass.

Exit criteria: every high-risk action blocked without an approved ticket; retry executes exactly once.

## Phase 3: Console

1. `/console` table, ticket timeline, filters (session, agent, run ID), CSV/JSON export, reset. → verify: e2e that a gated flow is visible with signals; reset empties logs and restores seed.

## Phase 4: MCP server

1. OAuth AS with dynamic client registration, consent screen, `act` claim (use SDK helpers). → integration test decodes token.
2. `/mcp` with tools 1-9 + `get_approval_status` + `get_journey_state`, all calling the same guard. Classifier returns `declared_agent` on this route.
3. Gate modes: `tool_result` first, then `elicitation`; log client capabilities on `initialize`. Step-scoped `tools/list` from DB state behind `MCP_STEP_SCOPED_TOOLS`.
4. → verify: SDK-client integration test (list, gated call, approve via API, retry); manual run from one real client (Claude Code).

## Phase 5: Agent identity + device channel

1. `webBotAuth.ts` against RFC 9421 test vectors; key-directory cache. → signed test request becomes `declared_agent`.
2. `/device/[userId]` simulated CIBA with SSE and passkey assertion; `device-approve` endpoint. → T9 with Playwright bot.
3. `/llms.txt`, `/agents.md`, self-declare option behind feature flags.

## Phase 6: Live agent testing (owner-led)

README with per-agent connection steps, `tests/results/TEMPLATE.md`, standard prompts P1-P3. Run T12 (`observe`) first, then enforce. Execute T1-T15 per agent.

## Order and parallelism

Phases 0 → 1 → 2 are strictly sequential. Console (3) and MCP (4) both depend only on Phase 2 and can overlap. Phase 5 depends on 2 and 4.

## Not built (per spec)

Real payments, real IdPs, bot-detection vendors (interface only), multi-tenancy, i18n.
