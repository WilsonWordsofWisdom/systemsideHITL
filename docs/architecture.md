# Architecture: System-side HITL prototype ("DemoGov Permits")

Source: `ref/HITL-prototype-build-spec.md`. Status: **draft, awaiting owner sign-off**.

## 1. Shape

One Next.js (App Router, TypeScript) deployment. One Postgres database. Two entry routes (Web UI/API and MCP) converge on **one guard function**. That choke point is the whole point of the prototype, so everything else is arranged around keeping it single and bypass-proof.

## 2. System context and runtime flow

```mermaid
flowchart LR
  subgraph Actors
    H[Human browser]
    BA[Browser agent<br/>Route 2]
    MA[MCP agent<br/>Route 1]
    PH[Approver phone<br/>/device]
  end

  subgraph App["Next.js app (single deployment)"]
    LP["/ landing page"]
    LOGIN["/login<br/>records login signals"]
    UI[Journey UI pages]
    API[Journey API routes]
    MCP["/mcp Streamable HTTP<br/>+ OAuth AS"]
    APR["/approve/[ticketId]"]
    DEV["/device/[userId]"]
    SSE[SSE events]
    CON["/console (admin)"]

    subgraph Core["lib/hitl - enforcement core"]
      CL[classifier]
      PO[policy engine<br/>hitl-policy.yaml]
      G{{hitlGuard}}
      TK[ticket service]
      HS[canonical hash]
    end
    WA[webauthn.ts]
    WBA[webBotAuth.ts]
    LOG[log.ts]
  end

  DB[(Postgres)]
  KD[(Agent key directories<br/>Signature-Agent)]

  H --> LP
  BA --> LP
  LP --> LOGIN
  LOGIN --> CL
  LOGIN --> DB
  H --> UI
  BA --> UI
  BA --> API
  UI --> API
  MA --> MCP
  API --> G
  MCP --> G
  G --> CL --> WBA --> KD
  G --> PO
  G --> TK --> HS
  TK --> DB
  G --> LOG --> DB
  G -->|allow / ticket ok| EX[execute action] --> DB
  G -->|gate| TK
  G -->|deny| X[403 + reason]
  PH --> DEV --> WA
  H --> APR --> WA --> TK
  TK --> SSE --> UI
  SSE --> DEV
  CON --> DB
```

## 3. Gated-action sequence

```mermaid
sequenceDiagram
  participant A as Agent
  participant S as App (guard)
  participant DB as Postgres
  participant U as Human (approve page / phone)

  A->>S: submit_application (no ticket)
  S->>S: classify actor, decide() = gate
  S->>DB: create ticket (pending, payload_hash, expires_at)
  S-->>A: requires_human_approval + ticket_id + continue_url
  A-->>U: relays continue_url (agent behaviour under test)
  U->>S: GET /approve/ticket (signed in as ticket user)
  S->>DB: load ticket preview (never from URL params)
  U->>S: POST webauthn/options (challenge bound to ticket+hash+nonce)
  U->>S: POST approve (assertion, UV required)
  S->>DB: verify, state pending -> approved
  S-->>A: SSE / poll shows approved
  A->>S: retry with ticket id + same payload
  S->>DB: UPDATE ... SET consumed WHERE state='approved' AND hash matches AND not expired
  S-->>A: executed (exactly once)
```

## 4. Landing page, sign-in and session identity

### 4.1 Landing page `/`

Plain, server-rendered, neutral. It says what the site is (a fictional permit service prototype), lists the journey steps in order, and links to sign-in. It carries the "Prototype for testing, not a real government service" banner. It contains **no instructions aimed at models**. When `AGENT_HINTS=on` it additionally says that some steps need approval from the account holder and links to `/llms.txt` and `/agents.md`; with the flag off (baseline) those are absent, so we can measure how much the hints change agent behaviour.

### 4.2 Sign-in `/login`

| Method | Who can complete it | Notes |
|---|---|---|
| Password (demo accounts) | Humans and agents | The only method an agent can finish. Password comes from env (`DEMO_USER_PASSWORD`) via the seed script, is given to testers in the test prompt/README, and is never committed. |
| Passkey | Humans (needs an authenticator) | Establishes `signin_method=passkey`. |
| OAuth consent (MCP) | MCP clients | Shows the client name; the session is created as `declared_agent` with the client as `act`. |

The form includes an "I'm an AI agent acting for someone" checkbox (`SELF_DECLARE_UI`, default on). It is a signal, not a trust grant; an agent that isn't told about it won't tick it, which is itself a result.

### 4.3 Identifying human vs agent at login

`/login` loads `signals.js` and records, per sign-in attempt, everything below on the session row (`signin_method`, `login_signals`, `login_actor_class`):

| Signal | Source |
|---|---|
| Self-declared agent (checkbox or `X-Agent`) | form / header |
| Web Bot Auth signature, operator | request headers + key directory |
| Automation signals: `navigator.webdriver`, pointer movement before clicks, time-to-complete, paste vs typed input, event-timing regularity, focus/visibility | `signals.js` → `/api/signals` |
| Sign-in method (passkey with UV vs password) | server |
| UA tokens, missing browser headers, no prior page view | request heuristics |

The classifier turns these into `human | declared_agent | suspected_agent | unknown` using the same code path as per-request classification (spec §6). The exact precedence and scoring are in §4.7, and how each signal can be evaded is in §4.8.

**How the login class is used**
- **Enforcement never relies on it.** The guard recomputes the class on every request, so a human who signs in and then hands the tab to an agent is still caught (T10).
- Agent evidence at login persists for the session as a prior (it can raise scrutiny); human evidence at login never lowers it.
- The console shows the **login class next to the per-request class** and flags a mismatch as a probable handover.
- Passkey sign-in is a weak human indicator at login only. Detection is a signal, and the guard still gates humans.

### 4.4 Agent navigability requirements (Phase 1 acceptance)

- Every journey page: one `h1`, labelled form controls, one clearly named primary action, a step indicator, and a "next step" link.
- Server-rendered forms with stable names/ARIA labels; no CAPTCHA, no modal-only flows, no hidden state in client JS.
- Landing page doubles as a journey overview.
- MCP: tool names/descriptions say what the tool does and its risk level in neutral, declarative language; `get_journey_state` returns the next allowed actions.

### 4.5 Handoff presentation variants

`HITL_HANDOFF_MODE=panel|redirect|both`:
- `panel`: spec §9.2 panel with link, QR, status and machine-readable JSON.
- `redirect`: after a gated submission the server redirects to `/approve/[ticketId]`. The URL is built server-side only, never from client input.
- `both`: panel plus a redirect link.

In redirect mode an agent in the human's browser lands on the approval page. The passkey prompt can't be satisfied by the agent and the ticket stays pending (T4). "Send to my phone" moves the approval to `/device`.

### 4.6 Feature flags

| Flag | Values | Baseline | Purpose |
|---|---|---|---|
| `HITL_MODE` | enforce / observe | observe first (T12) | log without blocking |
| `AGENT_HINTS` | on / off | off | llms.txt, agents.md, landing hint |
| `SELF_DECLARE_UI` | on / off | on | login checkbox |
| `HITL_HANDOFF_MODE` | panel / redirect / both | panel | handoff UX |
| `HITL_AUTORESUME` | on / off | off | auto-resubmit after approval |
| `MCP_STEP_SCOPED_TOOLS` | on / off | off | scoped `tools/list` |
| `MCP_GATE_MODE` | elicitation / tool_result | tool_result | MCP gate variant |

### 4.7 How the final actor class is derived

One function, `classifyActor`, used at sign-in and on every request. Inputs are grouped by how much they can be trusted:

| Tier | Evidence | Forgeable by an agent? | Effect |
|---|---|---|---|
| A. Protocol-proven | MCP token `act` claim / agent `client_id`; valid Web Bot Auth signature (key fetched from the agent's directory, verified per RFC 9421, fresh `created`/`expires`, covers `@authority`) | No (needs the agent's private key), but it can be **omitted** | `declared_agent`, confidence high |
| B. Self-declared | "I'm an AI agent" checkbox, `X-Agent` header | Yes, trivially (just don't send it) | `declared_agent`, confidence low, `self_declared=true` |
| C. Behavioural score | `signals.js`: webdriver, pointer movement before clicks, time to complete, paste vs typed, timing regularity, `isTrusted` mix, focus patterns | Yes, by an adaptive agent | adds to a 0-100 score |
| D. Request heuristics | agent UA tokens, missing browser headers, API call with no prior page view, no signals posted | Yes | adds to the same score |
| E. Human-leaning | session established by passkey with UV | Partly (see §4.8); and a human can hand the session over | only lets a clean session be called `human` |

**Precedence (first match wins):**
1. Any tier A evidence → `declared_agent` (confidence high).
2. Else any tier B evidence → `declared_agent` (confidence low).
3. Else score ≥ `T_suspect` → `suspected_agent`.
4. Else passkey-established session AND score < `T_clear` AND no agent evidence in this session → `human`.
5. Else → `unknown`.

**Rules that keep it safe**
- **Escalate only.** Evidence of an agent anywhere in the session (login or later) keeps the session at least that class. A quiet request never downgrades it.
- **No evidence is not evidence of a human.** Absence of agent signals yields `unknown` unless rule 4 holds.
- **All signals are logged** even when they didn't change the class, with the score, the weights applied and the tier that decided it.
- **Draft score weights** (tunable in `policy/classifier.yaml`; calibrate during the `observe` baseline run): webdriver true +50, untrusted input events +30, no pointer movement before click +20, form completed under 2 s +20, perfectly regular timing +15, missing browser headers +15, agent UA token +40, session used from a different client context +30, API call with no prior page view +10. `T_suspect` = 50, `T_clear` = 20.
- **Ground truth is separate.** Testers label each run with the real agent and actor (run ID plus agent label). The console compares the classifier's output with that label to give the detection rate. The label never feeds the classifier.

### 4.8 Can an agent evade or disguise itself?

Yes for tiers B to E, no for tier A, and the design assumes this.

| Signal | How an agent gets around it |
|---|---|
| Checkbox / `X-Agent` | Doesn't tick it or doesn't send it. An agent that was never told about it won't. |
| Web Bot Auth | Cannot be forged, but most agents don't sign, so absence proves nothing. |
| Automation signals | Overrides `navigator.webdriver`; drives real Chrome so events are `isTrusted` (CDP input events are); adds pointer jitter and random delays; slows form completion; skips `signals.js` by calling the API directly. |
| Sign-in method | A human signs in with a passkey and hands the tab to an agent; the login class goes stale. |
| UA / header heuristics | Agentic browsers send ordinary Chrome headers. |

**What a successful disguise buys.** At best the agent is classified `human` or `unknown`. Under the policy, every high-risk action is **gated for human and unknown too**: `submit_application`, `pay_fee`, `update_contact` and `delete_application`. So a perfect disguise changes only two outcomes: `update_contact` goes from *deny* to *gate*, and `delete_application` from *deny* (suspected only) to *gate*. It still needs a ticket approved by the real person with a UV passkey. That is why detection is a signal and the safeguard is the ticket.

**What cannot be bypassed from the agent side:** the server-side guard, single-use tickets bound to user + action + payload hash, and a passkey assertion with user verification.

**The one real hole this analysis found: passkey self-enrolment.** If an agent has the demo password and drives a browser with a virtual authenticator (Playwright/CDP can create one), it could enrol its own passkey on the account and then approve its own tickets. Controls:
- `PASSKEY_ENROLMENT=closed` during test runs; approver passkeys are enrolled beforehand by the owner on a real device.
- Enrolment (when open) requires a fresh sign-in and is itself written to the audit log with the actor class and attestation data (AAGUID, attestation format). A virtual authenticator can't reliably be told from a real one, so this is detection by audit, not prevention.
- The CI virtual authenticator is allowed only when `NODE_ENV=test`.

**Other residual risks**
- A human who approves without reading. Mitigated by showing the preview from the DB and the domain on the approval page; not eliminated.
- An agent that knows a device PIN can satisfy user verification with it. Out of scope for the prototype; note it in results if testers use PIN-only authenticators.

### 4.9 Session handover and assurance

**The gap.** A session cookie is a bearer token. It says nothing about who is using it, so a human and an agent in the same browser look the same to it. No standard or tested method lets a website separate them reliably inside one session (research summary in `docs/decisions.md`). The design therefore does not try to bind a token to an actor. It makes the session low-assurance, attributes actors per request where it can, and monitors switches.

**Principle: a session is never an approval.** The cookie permits only low-risk actions. Every high-risk action needs a ticket approved with a UV passkey for that exact action (§3). An undetected handover therefore gains the agent nothing beyond the low-risk steps.

**Layer 1: limit what the session can do.**
- Idle timeout 30 min and absolute lifetime 8 h; session rotated at sign-in.
- Passkey sign-in with UV ends every earlier session for that user and starts a new one with a clean state. This is the way a human takes a session back after an agent used it.
- Passkey enrolment closed during test runs (§4.8).

**Layer 2: attribute the actor per request.**
- A valid Web Bot Auth signature marks that request `declared_agent` (tier A) even on a human's cookie. This is the one tested way to attribute a single request independent of the token.
- Behaviour signals and request heuristics run on every request (tiers C and D).
- A new signal, `client_context_changed`, fires when the session is used from a different client context (user-agent hash or IP hash changes mid-session). It catches a cookie copied into a script.

**Layer 3: monitor and record switches.** Each session has a `risk_state`, escalate-only:

```mermaid
stateDiagram-v2
  [*] --> clean: sign-in, no agent evidence
  clean --> agent_observed: agent evidence (tiers A-D at or above threshold)
  clean --> handover_suspected: agent evidence after a human-leaning login,<br/>or client context changed
  agent_observed --> handover_suspected: context changed
  agent_observed --> [*]: session ended
  handover_suspected --> [*]: session ended
  clean --> [*]: session ended
```

- Every state change is written to `session_events` (`from_state`, `to_state`, trigger, signals), plus `session_revoked` events with a reason (idle, absolute, rotated by passkey sign-in, admin reset). This borrows the shape of OpenID CAEP's `risk-level-change` and `session-revoked` events but stays internal; there is no external transmitter.
- The classifier treats a state above `clean` as agent evidence, so the escalate-only rule holds across requests.
- The console shows a per-session timeline of these events beside the login class and the per-request class.

**Scenarios and expected outcomes (test cases T10a-d):**

| Case | What happens | Expected result |
|---|---|---|
| T10a Human to agent, undetected | Class stays `human`/`unknown` | Every high-risk action still gated; only `update_contact` is gated instead of denied |
| T10b Agent to human | Session stays above `clean` | Human can use gated actions; `update_contact` denied until a fresh passkey sign-in resets the session |
| T10c Cookie copied into a script | `client_context_changed` plus missing signals | Flagged `handover_suspected`; gate still holds |
| T10d Signing agent in a user's session | Signature verified per request | Each signed request classified `declared_agent`; logged against the same session |

**Not solved, by design.** A careful agent in the user's own browser can't be reliably told from the human, and the DBSC and DPoP key-binding schemes don't help here (they stop cookie theft, not a same-browser agent). DBSC is also not yet available on macOS Chrome. The protection is the per-action passkey.

## 5. Module boundaries

| Module | Responsibility | Depends on | Owns state |
|---|---|---|---|
| `lib/hitl/guard.ts` | The only decision+enforcement entry; returns ok / denied / gated / ticketInvalid | classifier, policy, tickets, hash, log | none |
| `lib/hitl/classifier.ts` | Actor class + all signals, per request and at login | webBotAuth, session signals | none (reads `sessions`, signal rows) |
| `lib/auth/session.ts` | Sign-in (password, passkey, OAuth), session create, stores login signals and class | classifier, webauthn | `sessions` |
| `app/page.tsx`, `app/login` | Landing page and sign-in UI, loads `signals.js` | auth/session | none |
| `lib/hitl/policy.ts` | Load YAML at boot, `decide()` | yaml file | in-memory, read-only |
| `lib/hitl/tickets.ts` | Create, get, approve, reject, expire, atomic consume | db, hash | `hitl_tickets` |
| `lib/hitl/hash.ts` | Canonical JSON + SHA-256 | none | none |
| `lib/webauthn.ts` | Options/verify wrappers, UV check, challenge binding | simplewebauthn, db | `passkeys`, challenge nonce |
| `lib/webBotAuth.ts` | RFC 9421 verify, key-directory fetch + cache | network | key cache |
| `lib/sse.ts` | Ticket state fan-out | tickets | none |
| `lib/log.ts` | Writes `request_log` | db | `request_log` |
| `app/mcp` | Tool registry, step-scoped listing, gate-mode variants | guard, services | MCP sessions |
| `app/api/**`, UI | Thin adapters calling services via guard | guard | none |

Rule: journey services (create draft, submit, pay, etc.) are plain functions taking an authorised context. Routes and MCP tools are adapters that call `hitlGuard` first, then the service. A lint/unit check asserts that every mutating route and tool references the guard.

## 6. State ownership

- **Tickets:** Postgres only. State transitions happen in single conditional `UPDATE ... WHERE state=...` statements. This makes consume race-safe without locks.
- **Session and actor class:** the enforcement class is recomputed per request, never cached. The session stores raw signals plus the *login-time* class (`signin_method`, `login_signals`, `login_actor_class`) for display and as a prior; it is never an authorisation input on its own.
- **Session risk state:** `sessions.risk_state` (`clean | agent_observed | handover_suspected`) is escalate-only and changes only through `lib/auth/session.ts`, which appends every change to `session_events`. Ending a session never deletes its events.
- **WebAuthn challenge:** server-side row or signed cookie holding `nonce` plus `ticket_id`. The expected challenge is recomputed as `H(ticketId || payload_hash || nonce)` at verify time.
- **Journey state for MCP:** derived from `applications.status`, so there is no separate state machine to drift.

## 7. Controls

Every security control and check implemented on the system side. Nothing is built yet, so all rows are **planned**; the "Verified by" column names the test or phase that will prove each one. The back end is the only enforcement point; UI checks are cosmetic.

### 7.1 Authorisation and enforcement

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| C1 | Single `hitlGuard` called by every mutating route and MCP tool; no gated action runs without it | `lib/hitl/guard.ts`, route/tool adapters | Route-coverage test fails if a mutating route/tool lacks the guard (Phase 2); T11 |
| C2 | Policy decision (`allow`/`gate`/`deny`) made server-side from `policy/hitl-policy.yaml`, loaded at boot, read-only | `lib/hitl/policy.ts` | Action × actor matrix unit test; invalid YAML fails boot (Phase 2) |
| C3 | Fail closed: classifier or policy error becomes `gate` (or `deny` for critical actions), never `allow` | guard | Fault-injection unit test (Phase 2) |
| C4 | Unlisted mutating action is not allowed by default. The spec's `default: allow` applies only to routes explicitly marked read-only (design change from spec) | policy + guard | Unit test: unknown action is gated/denied (Phase 2) |
| C5 | Ownership check on every resource access; users can only touch their own applications and contact details | service layer | Cross-user isolation tests with the second seeded user (Phase 1) |
| C6 | `HITL_MODE=observe` cannot be enabled unless an explicit env var allows it, and the console shows a persistent banner while on | config loader, console | Unit test on config; e2e banner check (Phase 3) |

### 7.2 Tickets

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| T1 | Ticket bound to user + action + resource + SHA-256 of canonical JSON payload; mismatch is rejected | `tickets.ts`, `hash.ts` | Hash unit tests; T5 (Phase 2) |
| T2 | Single use: consume is one conditional `UPDATE ... WHERE state='approved'` | `tickets.ts` | Concurrent-consume test, exactly one winner; T6 (Phase 2) |
| T3 | TTL ≤ 10 min; expiry checked at read and at consume, not by a cron | `tickets.ts` | T7 (Phase 2) |
| T4 | Ticket IDs ≥ 128 bits from a CSPRNG | `tickets.ts` | Unit test on ID length/format (Phase 2) |
| T5 | State machine permits only `pending→approved→consumed` and `pending→rejected\|expired`; other transitions error | `tickets.ts` | Transition unit tests (Phase 2) |
| T6 | A ticket works only for its own user; another user's ticket is rejected | guard | Unit + e2e (Phase 2) |
| T7 | `continue_url` and redirects are built server-side from `APP_ORIGIN`; client-supplied URLs are ignored | handoff builders | Test that a supplied URL is ignored (Phase 2) |
| T8 | Approval preview is read from the ticket row, never from URL parameters | approve page | e2e: tampered query string changes nothing (Phase 2) |
| T9 | Rate limit on ticket creation and approval attempts, per user and per IP hash, counters in Postgres (no extra service) | `lib/ratelimit.ts` | Unit test (Phase 2) |

### 7.3 Approval (WebAuthn)

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| W1 | `userVerification: "required"`; server checks the UV flag, RP ID, origin and signature counter | `lib/webauthn.ts` | e2e with virtual authenticator; negative cases (Phase 2) |
| W2 | Challenge = `H(ticketId ‖ payload_hash ‖ nonce)`; nonce is server-stored and single-use | `lib/webauthn.ts` | Replay and wrong-ticket assertion tests (Phase 2) |
| W3 | Approver must be signed in as the ticket's user | approve route | e2e (Phase 2) |
| W4 | Approval accepted only on `APP_ORIGIN`; the page shows the domain prominently | approve route and page | Origin-mismatch test (Phase 2) |
| W5 | The agent can't satisfy the passkey prompt; ticket stays pending | approve flow | T4 (Phase 2, live in Phase 6) |
| W6 | `/device` approval needs its own passkey assertion or device-bound secret | `device-approve` | T9 (Phase 5) |
| W7 | Passkey enrolment closed during test runs; when open it needs fresh sign-in and is audited with actor class and attestation data | enrolment route | Test that a password session can't add a passkey when closed (Phase 1) |
| W8 | Virtual authenticator permitted only when `NODE_ENV=test` | config + test harness | Startup assertion (Phase 1) |
| W9 | OTP fallback approval is flagged as weaker in logs and is off unless enabled | approve route | Unit test (Phase 2) |
| W10 | Approval page sends `frame-ancestors 'none'` and `X-Frame-Options: DENY` so it can't be clickjacked | security headers | Header test (Phase 1) |

### 7.4 Actor identification

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| A1 | Class recomputed on every request; derivation and precedence in §4.7 | `classifier.ts` | Unit test for every branch; T10 (Phase 2) |
| A2 | Escalate-only: agent evidence never downgraded within a session | classifier | Unit test (Phase 2) |
| A3 | All signals, score and deciding tier logged even when the class doesn't change | `log.ts` | Console e2e (Phase 3) |
| A4 | Web Bot Auth: verify RFC 9421 signature, `created`/`expires` freshness, tag, covered components including `@authority`; failure gives no signal, never trust | `webBotAuth.ts` | Test vectors (Phase 5) |
| A5 | Key-directory fetch: HTTPS only, timeout, size cap, cache, and SSRF guard (no private/loopback/link-local addresses, no redirects to them) | `webBotAuth.ts` | Unit tests with hostile URLs (Phase 5) |
| A6 | Ground-truth label is test metadata only and never an input to the classifier | classifier | Unit test (Phase 3) |
| A7 | A valid Web Bot Auth signature marks that single request `declared_agent`, even on a human's cookie | classifier | T10d (Phase 5) |
| A8 | `client_context_changed` signal (user-agent or IP hash differs from the one at sign-in) feeds the score | classifier, `session.ts` | Unit test; T10c (Phase 2) |
| A9 | Session `risk_state` is escalate-only; every change and revocation is appended to `session_events` | `lib/auth/session.ts` | Unit tests for transitions; T10a-b (Phase 2) |

### 7.5 MCP and OAuth

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| M1 | OAuth 2.1 with PKCE; short-lived tokens; token audience bound to `/mcp` | OAuth AS | Integration test (Phase 4) |
| M2 | Dynamic client registration validates redirect URIs (exact match, HTTPS or loopback) | OAuth AS | Unit tests (Phase 4) |
| M3 | Consent screen shows the client name; token carries `sub` and `act` | OAuth AS | Integration test decodes token (Phase 4) |
| M4 | Every MCP tool calls the same guard; the class on `/mcp` is always at least `declared_agent` | `app/mcp` | SDK-client integration test (Phase 4) |
| M5 | `tools/list` is computed from DB state; scoping is a convenience, never the enforcement | `app/mcp` | Test: calling a hidden tool is still gated/denied (Phase 4) |
| M6 | Client capabilities logged on `initialize` | `app/mcp`, `log.ts` | Console shows capabilities (Phase 4) |

### 7.6 Web session and transport

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| S1 | Session cookies `HttpOnly; Secure; SameSite=Lax`; session rotated on sign-in | `lib/auth/session.ts` | Unit/e2e (Phase 1) |
| S2 | CSRF protection on all cookie-authenticated POST/PUT/DELETE | middleware | Test: request without token is rejected (Phase 1) |
| S3 | Passwords hashed with argon2id (or bcrypt); login rate limit and lockout | `lib/auth/session.ts` | Unit tests (Phase 1) |
| S4 | Security headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, HSTS | `next.config` / middleware | Header test (Phase 1) |
| S5 | Input validation (schema) on every API route and MCP tool argument; parameterised queries via Drizzle | routes, tools, service layer | Unit tests with malformed input (Phase 1) |
| S6 | Document upload is fake: metadata only, no real files stored or parsed | `attach_document` | Test that no file content is persisted (Phase 1) |
| S7 | HTTPS only; `RP_ID` and `APP_ORIGIN` come from env, not from request headers | config | Startup assertion (Phase 0) |
| S8 | Session idle timeout 30 min, absolute lifetime 8 h; expired sessions are rejected | `lib/auth/session.ts` | Unit tests with a fake clock (Phase 1) |
| S9 | Passkey sign-in with UV ends all earlier sessions for that user and starts a clean one (the reset path after an agent used a session) | `lib/auth/session.ts` | Unit + e2e (Phase 1) |
| S10 | The session cookie never authorises a high-risk action on its own; the guard requires an approved ticket | guard | Covered by C1 and T11; explicit test that a valid cookie alone is gated (Phase 2) |

### 7.7 Content safety toward agents

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| P1 | No imperative instructions aimed at models in any served page, API message or MCP tool description | all content | Text lint test over pages and tool descriptions (Phases 1, 4) |
| P2 | `message_for_user` is declarative and addressed to the human | gate responses | Unit test on response builders (Phase 2) |
| P3 | No secrets, tokens or personal data in agent-visible content or error messages | response builders | Review checklist + test on error shapes (Phase 2) |
| P4 | Prompt-injection fixture (T15) isolated behind its own flag, off by default | fixture route | Test that it 404s when off (Phase 6) |

### 7.8 Data, secrets and platform

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| D1 | No secrets in git: `.env` ignored, `.env.example` has placeholders; secret scan before every commit; any leaked secret is rotated | repo, CI | Secret scan per PR (Phase 0) |
| D2 | `DEMO_USER_PASSWORD` and other secrets come from env/Vercel project settings only | config | Scan finds no literal (Phase 0) |
| D3 | Supabase: row-level security enabled on every table with no policies for the anon/authenticated roles, so the auto-generated API exposes nothing; the app uses a server-side DB connection; run Supabase security advisors after each migration | DB migrations | Advisor output clean (Phase 0) |
| D4 | IPs hashed in logs; demo data only; no real personal data | `log.ts`, seed | Unit test (Phase 2) |
| D5 | Fictional brand plus a visible "Prototype for testing, not a real government service" banner on every page | layout | e2e (Phase 0) |

### 7.9 Audit and admin

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| L1 | Every guard call writes a `request_log` row (decision, ticket, outcome, signals) | `log.ts` | Test: no guard path skips logging (Phase 2) |
| L2 | `/console` admin only, separate env-secret login, rate limited, own cookie | console middleware | e2e: non-admin gets 403 (Phase 3) |
| L3 | Reset-demo-data is admin only, needs confirmation, and is itself logged | console | e2e (Phase 3) |
| L4 | Exports contain hashed IPs and no secrets | console export | Unit test (Phase 3) |

### 7.10 Build and supply chain

| ID | Control | Enforced in | Verified by |
|---|---|---|---|
| B1 | Lockfile committed; new dependencies checked on the registry (age, downloads, maintainer) before install, then audited | repo process | `npm audit` per PR |
| B2 | Third-party CI actions pinned to commit SHA | `.github/workflows` | Review of CI changes |
| B3 | Changes to build, CI and deploy files get explicit human review | process | PR review |
| B4 | SAST every third PR; post-release security audit | process, per `sop/SECURITY_ASSESSMENT.md` | Scan results in PR |
| B5 | Tests are never deleted or weakened to make CI pass | process | PR review |

## 8. Failure handling

- Guard fails closed. Any classifier or policy error becomes `gate` (or `deny` for critical actions), never `allow`.
- Web Bot Auth key fetch failure downgrades to "no signature signal". It never blocks and never upgrades trust.
- Ticket expiry is evaluated at read and consume time (`now() < expires_at`), and a sweeper only tidies state. Correctness does not depend on a cron.
- SSE drop: clients fall back to polling `GET /api/hitl/[id]`. Polling is the contract, SSE is a convenience.
- `HITL_MODE=observe`: guard computes and logs the decision, then returns ok. It must be impossible to enable in a production-flagged environment without an explicit env var.

## 9. Scalability

Test-scale only: tens of requests per minute, a few concurrent tickets. No caching layer, queue or worker is needed. The only concurrency requirement is the atomic consume.

## 10. Deployment

**Chosen: Vercel + Supabase Postgres** (owner decision, 2026-11-20). Domain still to be supplied (it fixes the WebAuthn RP ID). Alternatives considered: single VM/container (better for long-lived SSE and MCP streams) and a `cloudflared` tunnel (dev only, unstable RP ID). No cloud resources are provisioned until the build branch starts and the domain is known.

## 11. Risks found in the spec

1. **Status code:** §9.1 pairs `403` with `WWW-Authenticate: ... insufficient_user_authentication`. RFC 9470 defines that error with `401`. Decide which; the test is whether agents react to the shape, so pick one and keep it fixed.
2. **SSE on serverless:** function timeouts cut streams. Use short-lived SSE with auto-reconnect and polling fallback, or choose option B.
3. **Step-scoped tools plus `list_changed`:** notifications need a long-lived server-to-client stream. Stateless serverless MCP can't push them. Compute `tools/list` from DB state per request (works everywhere) and treat push notification as best effort.
4. **OAuth authorization server inside the same app** (dynamic client registration, consent, `act` claim) is the largest single build item. Use the SDK's auth helpers rather than hand-rolling.
5. **URL elicitation (`-32042`)** depends on the SDK and client spec revision; build `tool_result` mode first, it's the universal fallback.
6. **`/device` is not truly out-of-band** if it uses the same platform authenticator on the same machine. Fine for protocol testing; note it in results when testers use one machine.
7. **Console admin auth** is unspecified. Assume a separate admin env-secret login.
8. **Payload hash scope:** define the volatile-field exclusion list per action up front. Otherwise a harmless field difference between ticket creation and retry causes false mismatches.
9. **Self-approval risk:** if an agent drives the human's already-signed-in browser, a platform authenticator still requires a user gesture and biometric. T4 verifies this; the virtual authenticator in CI is the exception and must never be enabled outside tests.
10. **"Muse"** remains unidentified (spec DECISION).
11. **Agent sign-in gap (spec §11.3):** prompt P1 gives only an email, but agents can't use passkeys. Resolved in §4.2: password sign-in for demo accounts, password supplied via the test prompt.
12. **No landing/purpose page in the spec:** added in §4.1, neutral by default, hints behind `AGENT_HINTS` so baseline vs hinted runs are comparable.
13. **Login-time detection is weak evidence:** agentic browsers look like Chrome and sessions can be handed over. Hence §4.3: record and display it, but enforce on the per-request class and gate humans too.
14. **Passkey self-enrolment by an agent** (virtual authenticator) would let it approve its own tickets. Controls in §4.8; closing enrolment during runs is a Phase 1 requirement.
15. **No tested way to separate human from agent in one session:** a cookie is a bearer token and cannot show who is acting. Mitigated by §4.9 (session never an approval, per-request attribution where agents sign, monitoring of switches), not eliminated.
16. **Demo password in prompts:** acceptable for demo data only; kept out of git, rotated per test round, and the demo accounts hold no real data.
