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
**Decision:** `DEMO_USER_PASSWORD` is an env var; seed reads it; testers get it in the prompt. Demo data only. (Pending owner confirmation of this sign-in approach.)

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

## Open
- 403 vs 401 for the gate response (spec §9.1 vs RFC 9470).
- Console admin auth mechanism.
- Which product "Muse" is.
- Domain for `APP_ORIGIN` / RP ID.
