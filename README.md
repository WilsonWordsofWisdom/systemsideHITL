# systemsideHITL: DemoGov Permits

A prototype that tests whether **the website itself**, rather than the agent's chat surface, can decide when a person must step in. It pauses a commercial AI agent at high-risk steps, gets the account holder to approve on our own pages with a passkey, and hands control back so the agent can finish.

DemoGov Permits is a fictional permit service with demo data only. Production: <https://hitltest.vercel.app>.

- Requirements: [docs/PRD.md](docs/PRD.md) · Architecture: [docs/architecture.md](docs/architecture.md) · Design: [docs/design.md](docs/design.md) · Decisions: [docs/decisions.md](docs/decisions.md) · Build plan: [docs/implementation-plan.md](docs/implementation-plan.md)
- Test scenarios (Gherkin): [docs/tests/](docs/tests/)
- **Live agent testing (Phase 6): [tests/results/README.md](tests/results/README.md)**, with the prompts, run order and results template.

## How it works in one paragraph

Every mutating route and MCP tool goes through one server-side guard. The guard classifies the caller (human, declared agent, suspected agent, unknown), looks up the action in [policy/hitl-policy.yaml](policy/hitl-policy.yaml), and returns `allow`, `gate` or `deny`. A gated request gets a single-use ticket bound to the exact payload, and a `requires_human_approval` response with an approval link. The account holder approves on `/approve/<ticket>` or the phone page `/device/<user id>` with a passkey (user verification required); the agent then retries with `X-HITL-Ticket` and the action runs exactly once. Detection is a signal only; the passkey is the safeguard.

| Step | Human | Declared agent | Suspected agent |
|---|---|---|---|
| Browse, draft, details, documents, review | allow | allow | allow |
| Submit declaration, pay fee | gate | gate | gate |
| Delete application | gate | gate | deny |
| Change recovery contact | gate | deny | deny |

## Local development

Requires Node 22+ and Docker (for the end-to-end database).

```sh
npm install
cp .env.example .env.local   # then fill in the secrets locally; never commit them
npm run db:migrate && npm run db:seed
npm run dev                  # http://localhost:3000 (set APP_ORIGIN and RP_ID for localhost)
```

| Command | What it does |
|---|---|
| `npm run lint`, `npm run typecheck`, `npm run format:check` | Static checks |
| `npm test` | Unit and integration tests (Vitest, PGlite) |
| `npm run e2e:db:up` then `npm run test:e2e` | End-to-end tests (Playwright, local Docker Postgres) |
| `npm run db:migrate` | Apply migrations to the database in `.env.local` |

## Deployment

Vercel project `hitl_test` with Supabase Postgres. Merging to `main` deploys production. Secrets (`SESSION_SECRET`, `ADMIN_SECRET`, `DEMO_USER_PASSWORD`, database URLs) are set in Vercel project settings only. Migrations are applied by hand with `npm run db:migrate` before merging a change that needs them.

**Changing a flag on Vercel takes effect on the next deployment**, not immediately: change the environment variable, then redeploy production (Deployments, latest production deployment, Redeploy). Record the flag values in each results file.

## Experiment flags

| Flag | Values (default first) | Used for |
|---|---|---|
| `HITL_MODE` | `enforce` / `observe` | T12 baseline. `observe` also needs `HITL_ALLOW_OBSERVE=true`; the console shows a banner while it is on |
| `AGENT_HINTS` | `off` / `on` | A/B variant: serves `/llms.txt`, `/agents.md` and a landing-page note |
| `POPPY` | `off` / `on` | Phase 7: Personal Agent Protocol (Poppy) 1.0 support: discovery, sign-in for Poppy agents, Session checks, Operations approvals and browser join; off for baseline runs |
| `T15_FIXTURE` | `off` / `on` | T15 only: shows the prompt-injection notice on the journey and at `/notices/t15` |
| `MCP_GATE_MODE` | `tool_result` / `elicitation` | T13 |
| `MCP_STEP_SCOPED_TOOLS` | `off` / `on` | T14 |
| `HITL_HANDOFF_MODE` | `panel` / `redirect` / `both` | Handoff UX variants |
| `HITL_AUTORESUME` | `off` / `on` | Page resubmits by itself after approval |
| `HITL_GATE_STATUS` | `403` / `401` / `202` | HTTP status of a gated API response |
| `SELF_DECLARE_UI` | `on` / `off` | The "I'm an AI agent acting for someone" box at sign-in |
| `PASSKEY_ENROLMENT` | `closed` / `open` | Open only while the owner enrols approver passkeys |
| `TICKET_TTL_SECONDS` | `600` (1-600) | A shorter value makes T7 (expiry) quicker to run |

## Running a test session

1. **Pick a run ID** (letters, digits, `-` and `_`, up to 40 characters), for example `chatgpt-web-p1-01`.
2. **Start the agent with the run ID in the URL.** Web: `https://hitltest.vercel.app/?run=<id>`. MCP: `https://hitltest.vercel.app/mcp?run=<id>`. Every request in that browser or MCP session is then logged against the run.
3. **Open the console** at `/console` (admin secret), filter by the run, and fill in the ground truth: agent label, who was really acting (agent, human, mixed) and notes. The classifier never reads it.
4. **Give the agent the standard prompt** from [tests/results/README.md](tests/results/README.md), word for word.
5. **Approve as the account holder** when the agent relays the approval link, on the same machine or on a phone via "Send to my phone instead".
6. **Export** the run from the console (CSV or JSON) and fill in a results file from [tests/results/TEMPLATE.md](tests/results/TEMPLATE.md).
7. **Reset demo data** in the console between runs. It keeps users, passkeys, registered MCP clients and run labels.

## Connecting each agent

Agent products change quickly: confirm the menus and plan requirements at test time, and record the product version in the results file. How an agent gets signed in is up to the tester (decision D6); record what was done.

**About the demo password:** if you type it into an agent's chat, it is sent to that agent's provider. It is a demo-only password; rotate `DEMO_USER_PASSWORD` (and reseed) after the test series. Never put it in a results file.

### Route 1: MCP

The server is Streamable HTTP at `https://hitltest.vercel.app/mcp` with OAuth 2.1 and dynamic client registration, so clients register themselves. On first use the client opens a consent page; sign in as the demo user and allow access. Tools: `list_applications`, `get_application`, `get_journey_state`, `get_approval_status`, `create_draft`, `update_draft`, `attach_document`, `submit_application`, `pay_fee`, `update_contact`, `delete_application`.

| Client | How to connect |
|---|---|
| Claude Code | `claude mcp add --transport http demogov "https://hitltest.vercel.app/mcp?run=<id>"`, then `/mcp` in a session to sign in |
| Claude (desktop or claude.ai) | Settings, Connectors, add a custom connector with the MCP URL; connect and complete the consent page |
| GitHub Copilot in VS Code (agent mode) | Add to `.vscode/mcp.json`: `{"servers": {"demogov": {"type": "http", "url": "https://hitltest.vercel.app/mcp?run=<id>"}}}`, start the server, sign in when prompted |
| ChatGPT | Developer mode connectors (apps): add a custom connector with the MCP URL and OAuth; availability depends on the plan |
| Other MCP clients | Any client with Streamable HTTP and OAuth support; record its protocol revision (the console shows it) |

The console shows each MCP client's protocol revision and whether it supports URL elicitation, which T13 needs.

### Route 2: Web UI

Open `https://hitltest.vercel.app/?run=<id>` in the agent's browser, then give it the prompt.

| Agent | Notes |
|---|---|
| Claude in Chrome | Runs in your own Chrome profile; use a separate profile for testing so the agent never sees your other sign-ins |
| Microsoft Copilot in Edge | Agent mode in Edge |
| ChatGPT agent | Remote browser; if it signs requests (Web Bot Auth), the console shows "Web Bot Auth" and T10d applies |
| Perplexity Comet | Agentic browser |
| Manus | Remote browser |
| Grok | Only if it has a browsing agent at test time |
| Muse (Meta) | First run is a capability check: can it browse, and does it support MCP? Test the web route, and MCP only if supported (decision D4) |

The approver passkey lives on the owner's device, never in the agent's browser. If the agent's browser is on the same machine, the approval is not truly out of band; the results file records which device approved.
