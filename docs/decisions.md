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

## 2026-11-20 — Hosting recommendation: Vercel + Supabase Postgres (PENDING owner sign-off)
**Alternatives:** VM/container (better for long-lived streams), tunnel (dev only). No resources provisioned yet.

## Open
- 403 vs 401 for the gate response (spec §9.1 vs RFC 9470).
- Console admin auth mechanism.
- Which product "Muse" is.
