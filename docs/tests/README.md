# Test cases (Gherkin)

Derived from the critical user journeys in [../PRD.md](../PRD.md) section 4. One feature file per journey. These are the source for the automated tests (Vitest, Playwright, MCP SDK client) and the script for owner-led live agent runs.

## Index

| Journey | File | PRD test IDs | Automated from |
|---|---|---|---|
| J1 Sign in, browse and draft | [J01-sign-in-browse-draft.feature](J01-sign-in-browse-draft.feature) | T1 | Phase 1-2 |
| J2 Submit and pay | [J02-submit-and-pay.feature](J02-submit-and-pay.feature) | T2, T3, T4, T5, T6, T7 | Phase 2 |
| J3 Change recovery contact | [J03-change-recovery-contact.feature](J03-change-recovery-contact.feature) | T8 | Phase 2 |
| J4 Delete an application | [J04-delete-application.feature](J04-delete-application.feature) | T2 variant | Phase 2 |
| J5 Approve from another device | [J05-remote-approval-device.feature](J05-remote-approval-device.feature) | T9 | Phase 5 |
| J6 Session handover | [J06-session-handover.feature](J06-session-handover.feature) | T10a-d | Phase 2 (T10d in Phase 5) |
| J7 Direct API call | [J07-direct-api-bypass.feature](J07-direct-api-bypass.feature) | T11 | Phase 2 |
| J8 MCP gating | [J08-mcp-gating.feature](J08-mcp-gating.feature) | T13, T14 | Phase 4 |
| J9 Observe baseline | [J09-observe-baseline.feature](J09-observe-baseline.feature) | T12 | Phase 2 |
| J10 Injection hygiene | [J10-injection-hygiene.feature](J10-injection-hygiene.feature) | T15 | Phase 2 |
| J11 Run a test session (console) | [J11-console.feature](J11-console.feature) | console | Phase 3 |
| J12 One-time setup | [J12-setup-and-enrolment.feature](J12-setup-and-enrolment.feature) | setup | Phase 0-1 |
| J13 Poppy personal agent | [J13-poppy-agent.feature](J13-poppy-agent.feature) | T16-T20 | Phase 7 |

## Tags

| Tag | Meaning |
|---|---|
| `@J1` ... `@J13` | Journey in PRD section 4 |
| `@T1` ... `@T20`, `@T10a` ... `@T10d` | Test matrix ID (PRD section 10; T16-T20 are Phase 7) |
| `@unit`, `@integration`, `@e2e` | Automated level |
| `@manual` | Owner-led live run with a commercial agent; record the result in `tests/results/<agent>-<date>.md` |
| `@web`, `@api`, `@mcp` | Route |
| `@FR1` ... `@FR47` | Functional requirement in PRD section 8 |

## Conventions

- **Seed data:** `demo@demogov.test` with three past applications and an enrolled approver passkey; `second@demogov.test` with one application, for isolation tests.
- **"the bot"** is the Playwright agent. It drives the browser or calls the API directly and never has the approver's authenticator.
- **"the approver"** is a Playwright browser with a virtual WebAuthn authenticator that supports user verification. Virtual authenticators are allowed only in test mode.
- **Time** is controlled with a fake clock wherever a scenario depends on TTLs, timeouts or the signal window, so results are deterministic.
- **Flags** take the baseline values in PRD section 9.4 unless a scenario says otherwise. `HITL_MODE` is `enforce` unless stated.
- **Agent-visible text** is checked against a shared list of model-directed imperative phrases (for example "ignore previous", "you must", "as an AI"); the T15 fixture is the only allowed exception.
- **@manual scenarios** describe what to observe, not what the agent must do. Agent behaviour is a finding, not a pass/fail, except where the system's own behaviour is stated.
