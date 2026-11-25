# Agent interaction standards: Poppy alignment and the wider landscape

Research note, 2026-11-24, branch `research/agent-protocol-standards`. It compares DemoGov Permits with the Personal Agent Protocol ("Poppy") 1.0 and surveys other open and industry standards for how agents work with enterprise systems. It is a research input, not a decision. Proposed decisions are listed at the end for the owner.

Source quality: the Poppy section is based on reading the Poppy 1.0 spec, guides and extension pages directly. The landscape section is based on web searches, many of them secondary write-ups; items marked *(secondary)* should be checked against the primary spec before we build on them.

## 1. Summary

- **Poppy fits our thesis better than any other standard found.** It is the only one that defines, end to end, how a *company* (our role) tells a personal agent that a step needs approval, and how the agent resumes: the **Operations** extension (`403 approval_required` with an `operation`, resend with `Poppy-Approval`, performed at most once). Our ticket model maps onto it almost one to one.
- **The main conceptual gap runs the other way.** In Poppy 1.0 an approval is the *personal agent's statement* that the user approved (`approver: "user" | "agent"`); the company "relies on the personal agent". Our prototype exists to test the opposite: the system demands proof of human presence (a UV passkey bound to the exact payload). Poppy lists **signed approvals** on its roadmap. Our ticket-bound WebAuthn approval is effectively a working prototype of that roadmap item, which is worth contributing back.
- **The largest technical gaps** are identity and sign-in: Poppy requires `/.well-known/poppy.json`, agent identity by client ID metadata document with `private_key_jwt`, refresh tokens and revocation, per-request **Session JWTs** (`Poppy-Session`) with a delegation, company-defined scopes with `scope_hints`, and `prompt=consent`. We have dynamic client registration with public clients, one `mcp` scope, no refresh tokens and no session header.
- **Everything we built for detection still has a place.** Poppy makes the honest agent easy to recognise (signed Session JWT, optional Web Bot Auth). Our classifier remains necessary for agents that don't speak Poppy, which is most browser agents today.
- **Recommendation:** add a Poppy-compatible surface behind a flag (`POPPY=on`) in three slices (discovery and errors; Operations as the gate's wire format; sign-in and Session JWTs), keep the passkey requirement for critical actions as company policy, and test with Poppy's own demo agent and validator. Rough size: similar to Phase 4 (MCP).

## 2. Poppy 1.0 in brief

| Item | Detail |
|---|---|
| What | Open protocol for personal agents and companies: discovery, identity, account access, and interactions over APIs (OpenAPI, MCP), web browsing and conversations with a company agent |
| Version | 1.0, published 2026-11-14 (0.4 was the release candidate, 2026-11-10). 1.1 is in draft. The demos page still calls it "a draft that changes often" |
| Licence and governance | Apache 2.0; GitHub org `personal-agent-protocol`; no named legal entity; about 100 listed design partners (listing is not endorsement) |
| Roles | User, Personal Agent (OAuth confidential client), **Company** (our role), Company Agent, Provider |
| Trust anchor | The domain that serves `/.well-known/poppy.json`. Company text is untrusted data and is never the user's approval |
| Built on | OAuth 2.0 and its BCPs (RFC 9700, 9728, 8414, 7636, 9207, 9126 PAR, 9449 DPoP, 8707, 8628, 7009), CIMD draft, RFC 7523 `private_key_jwt`, RFC 9421 + Web Bot Auth, MCP, OpenAPI, RFC 9651 structured fields |
| Not covered | CIBA, AP2, A2A, DIDs, verifiable credentials, audit or receipt formats, spending mandates |

Key mechanisms for us:

- **Discovery:** `poppy.json` with `organization`, `auth` (issuer, `scopes`, `scope_hints` with `changes: none | reversible | irreversible` and `personal_data`), `apis` (`openapi` / `mcp`), `web.browser_session_endpoint`, `tasks.endpoint`, `extensions`.
- **Agent identity:** `client_id` is an HTTPS URL serving the agent's metadata (CIMD); token endpoint auth is `private_key_jwt` (ES256 and PS384 MUST be accepted).
- **Session JWT** on every request in `Poppy-Session`: `typ: poppy-session+jwt`, ES256, signed by a delegated key carried in a `poppy_dlg` delegation JWT (at most 24 h) that chains to the agent's `jwks_uri`. Claims include `sid`, `sub` (pairwise user ID chosen by the agent), `htm`, `htu`, `iat`, `jti`, `ath`. Errors: `invalid_session` (400, never 401), `session_ended`, `version_unsupported`.
- **Sign-in:** Direct (authorization code + PKCE, preferred), Device (RFC 8628 + RFC 10027 cross-device rules), Mediated (transitional, retiring 2027-03-17). `scope` is required, the company MUST NOT grant more than requested, `prompt=consent`, refresh tokens always issued, sign-out = revoke.
- **Operations extension (v3):** the company refuses with `403 {"error":"approval_required","operation":{operation_id, revision, terms, summary, expires_at}}` (API), `isError: true` + `structuredContent.operation` (MCP), or a `Poppy-Operation` header with an approval endpoint (website). The agent resends the same request with `Poppy-Approval` (`operation_id`, `revision`, `approver`, `approved_at`, `input_type`, `reference`). The company performs each operation **at most once**, returns `503` + `Retry-After` while performing, and `approval_declined` with `reason` and `alternative` on refusal. A revision describes one exact set of terms; the comparison is semantic.
- **Browser join:** a one-time code lets the agent's browser join the agent's Poppy session (`__Host-poppy_join` cookie, `poppy:browser-sign-in` scope). This is a protocol-level, declared **handover**, which is exactly what our T10 scenarios try to detect heuristically.
- **Tasks endpoint:** `excluded_tasks` and a feedback endpoint, so a company can say up front which tasks agents may not do.

## 3. Gap analysis against our prototype

Effort: S = under a day, M = 1-3 days, L = more than 3 days.

| Area | Poppy 1.0 | DemoGov today | Gap | Effort |
|---|---|---|---|---|
| Discovery | `/.well-known/poppy.json` (MUST, if any capability is offered); `organization.domain` must match the host | `/llms.txt`, `/agents.md` behind `AGENT_HINTS` | Missing document. Easy to generate from the policy file and routes | S |
| Protected resource metadata | `/.well-known/oauth-protected-resource` with `resource = https://{domain}` | Path-scoped `/.well-known/oauth-protected-resource/mcp`, `resource = …/mcp` | Add the domain-level document; MCP server keeps its own resource (allowed) | S |
| AS metadata | `issuer`, `protected_resources`, `token_endpoint`, `revocation_endpoint`, `grant_types_supported` incl. `refresh_token` | `authorization_code` only, `token_endpoint_auth_methods_supported: ["none"]`, no revocation endpoint | Add refresh tokens, revocation (RFC 7009), `protected_resources` | M |
| Client identity | CIMD: `client_id` is an HTTPS URL; `private_key_jwt` client assertions, `aud` = issuer, exp ≤ 5 min | Dynamic client registration (RFC 7591), public clients, PKCE | New client type: fetch and cache CIMD (reuse the SSRF-guarded fetcher from Web Bot Auth), verify assertions (`jose` already present). Keep DCR for plain MCP clients | M |
| Scopes | Company-defined scopes with `scope_hints`; MUST NOT grant beyond request; `invalid_scope` | One scope `mcp` | Define e.g. `applications:read`, `applications:write`, `applications:submit`, `payments`, `account:contact`; hints come straight from `policy/hitl-policy.yaml` (submit, pay, delete = irreversible) | M |
| Consent | `prompt=consent`; page names the agent and lists every scope | Consent page names the client; single scope | Show scopes and hints; honour `prompt=consent` | S |
| Session JWT | `Poppy-Session` on every request; delegation chain to `jwks_uri`; `iat` window; `invalid_session` 400 | None. Agents are identified by OAuth token (MCP), Web Bot Auth or heuristics | New verifier (shape is similar to our Web Bot Auth verifier). A valid Session JWT becomes a new tier A signal: `declared_agent`, source `poppy_session` | M |
| Pairwise user ID | `sub` is the agent's opaque per-company ID for the user | Our own user ID | Store a link (agent `client_id` + `sub` → our user) at sign-in; never expose our ID | S |
| Version and extension headers | `Poppy-Version` checked on every Session request; `Poppy-Extensions`; unknown fields ignored | None | Middleware check plus errors | S |
| Web Bot Auth | SHOULD sign Session requests, covering `poppy-session` and `authorization` | Verifier built (Phase 5), covers `@authority` and `signature-agent` | Accept extra covered components; already compatible | S |
| Approval (Operations) | `approval_required` + `operation`; resend with `Poppy-Approval`; at most once; `503 Retry-After` while performing; `approval_declined` | Ticket + `requires_human_approval`, `continue_url`, `X-HITL-Ticket` retry, atomic consume | Wire-format mapping, see 3.1. The semantics already match, and our binding is stricter | M |
| Who approves | Approval is the agent's statement; `approver` may be `agent` | Only a UV passkey assertion from the account holder | **Deliberate divergence**, see 3.2 | – |
| Website approvals | `Poppy-Operation` header (`sid`, `ref`) on a 403; agent posts approval to the endpoint; browser repeats | Handoff panel, QR, `/approve`, `/device` | Add the header and endpoint for Poppy agents; keep the panel for everyone else | M |
| MCP | MCP 2025-06-18 or later; resource = server URL; AS must be the company issuer; Session header accepted | MCP 2026-07-28 and 2025-11-25; our AS | Accept `Poppy-Session` on `/mcp`; return `structuredContent.operation` in `tool_result` mode | S |
| Browser join | `browser_session_endpoint`, one-time code, `__Host-` cookie | Not present. Handover is detected by `client_context_changed` | New flow; gives a *declared* handover to compare with our detected one (T10) | M |
| Tasks | `excluded_tasks`, feedback endpoint | `update_contact` denied for agents at runtime | Publish `update_contact` as excluded; add the feedback endpoint (logs to `request_log`) | S |
| Errors and limits | JSON `{error}` codes; `429` + `Retry-After` (MUST wait) | JSON errors; 429 without `Retry-After` | Add `Retry-After`; map our error codes | S |
| Device sign-in | RFC 8628 with RFC 10027 cross-device protections | None (our `/device` is for approvals, not sign-in) | Optional; only if a Poppy agent without a browser needs it | M |
| Audit | Not specified; company keeps a record of each operation and approval | `request_log`, ticket timeline, `session_events`, console | We exceed it. Add `client_id`, `sub` and approval `reference` to the log | S |
| Privacy | Pairwise IDs, no personal data in IDs, tokens never in URLs or model context | Hashed IPs, demo data only, no tokens in agent-visible content | Mostly met; pairwise link table is the addition | – |

### 3.1 Mapping our ticket onto a Poppy operation

| Poppy operation field | Our ticket | Note |
|---|---|---|
| `operation_id` | `ticket_id` (`hitl_…`, 128+ bits) | Same role |
| `revision` | `payload_hash` (SHA-256 of canonical body + resource snapshot) | Poppy compares semantically; we compare exactly. Exact is stricter and still conforms, as long as one revision means one set of terms |
| `terms`, `summary` | `payload_preview` | Already built from the ticket row, never from the URL |
| `expires_at` | `expires_at` (≤ 10 min) | Same |
| Resend with `Poppy-Approval` | Retry with `X-HITL-Ticket` | Accept both |
| At most once | Atomic single-statement consume | Met; add `503 Retry-After` while performing |
| `approval_declined` + `reason`, `alternative` | Ticket `rejected` with reason | Add `alternative` (e.g. "submit on the website") |

### 3.2 The divergence: who proves the approval

Poppy 1.0 treats approval as something the personal agent attests to. That suits a world where the user trusts their own agent. Our research question assumes the company cannot rely on any agent's statement, so the company demands proof it can verify itself.

Proposal for alignment without giving up the thesis:

1. **Reversible, low-risk steps** (draft, details, documents): accept Poppy session identity; no approval needed (as today).
2. **Irreversible steps** (submit, pay, delete): return `approval_required`. Accept a `Poppy-Approval` **only together with** our ticket-bound passkey approval, so the operation is approved when the account holder has completed `/approve/<operation_id>`. The Poppy approval then records that the agent relayed it faithfully. Whether a company may require this extra step under Poppy 1.0 is not explicit in the spec; raise it as an issue on the Poppy GitHub repository.
3. **Critical steps** (recovery contact): list them in `excluded_tasks` and keep denying them for agents.
4. **Contribute:** describe our design (WebAuthn assertion, challenge bound to `operation_id` + `revision`, user verification required) as input to Poppy's "signed approvals" roadmap item.

This would also let the live tests measure something new: do Poppy agents relay a company-side approval link, or do they try to self-approve with `approver: "agent"`?

## 4. Other standards for agents and enterprise systems

| Standard | Body and status (Nov 2026) | What it covers | Relevance to us | Suggested action |
|---|---|---|---|---|
| **MCP** | Agentic AI Foundation (Linux Foundation); revisions 2025-11-25 and 2026-07-28 | Tools and resources for agents; OAuth 2.1; URL elicitation | Built (Phase 4) | Keep; Poppy reuses it |
| **Web Bot Auth** | IETF `webbotauth` WG; `draft-ietf-webbotauth-httpsig-protocol` adopted 2026-09, -01 in Oct 2026; verified by Cloudflare, Akamai, Amazon, Vercel and others *(secondary)* | Cryptographic agent identity over HTTP Message Signatures (RFC 9421) | Built (Phase 5); also the basis of Poppy operator signatures and of Visa's Trusted Agent Protocol *(secondary)* | Track WG changes; add Poppy covered components |
| **OAuth 2.x family** | IETF RFCs | Token exchange with `act` (RFC 8693), Rich Authorization Requests (RFC 9396), DPoP (9449), PAR (9126), resource indicators (8707), protected resource metadata (9728), device grant (8628) | We use `act`, PKCE and 9728. RAR's `authorization_details` is the standard way to put "submit application X with these details" into a token, close to our ticket binding | Consider RAR for gated MCP calls |
| **IETF agent auth drafts** | Individual drafts, none adopted: `draft-oauth-ai-agents-on-behalf-of-user` (expired Feb 2026), `draft-klrc-aiagent-auth`, `draft-mishra-oauth-agent-grants`, transaction tokens for agents *(secondary)* | On-behalf-of delegation, actor tokens | Similar to our `act` claim | Watch only |
| **OpenID CIBA** | OpenID Foundation, CIBA Core 1.0 (final) | Back-channel authentication: the service asks the user on a separate device | Our `/device` page is a *simulated* CIBA channel. A real CIBA endpoint would make T9 realistic and is what many banks use | Candidate for a later phase; Poppy does not use it |
| **OpenID AIIM community group** | OpenID Foundation; discussion group, not a spec producer; whitepaper "Identity Management for Agentic AI" (Oct 2025); NIST RFI response (Mar 2026) *(secondary)* | Problem map for agent identity, delegation chains | Background for our decisions log | Cite |
| **Shared Signals / CAEP** | OpenID Foundation | Push session revocation and risk events between systems | Our escalate-only `risk_state` could emit CAEP `session-revoked` / risk events | Optional |
| **A2A (Agent2Agent)** | Linux Foundation / AAIF; v1.0 (Mar 2026), v1.0.1 *(secondary)* | Agent-to-agent tasks over JSON-RPC, gRPC or REST; `input-required` task state | Only relevant if DemoGov runs its own company agent (Poppy's conversation channel covers that case too) | Not now |
| **AP2 (Agent Payments Protocol)** | Google, contributed to FIDO Alliance (Apr 2026), v0.2 *(secondary)* | Signed mandates proving what the user authorised to pay | Our pay step is a mock; AP2's user-signed mandate is another form of "proof the human agreed" | Reference in the design of signed approvals |
| **ACP** (OpenAI + Stripe) and **UCP** (Google + retailers) | Industry specs; ACP 2026-04-17, UCP 2026-08 *(secondary)*; Poppy has a `ucp` extension | Agentic checkout and commerce | Commerce-specific; not needed for a permit service | Not now |
| **Visa Trusted Agent Protocol, Mastercard Agent Pay** | Card networks *(secondary)* | Registered agents, agentic tokens, signed intent | Shows the payment industry also moving to verified agent identity plus a record of user intent | Cite; TAP assessed in [trusted-agent-protocol.md](trusted-agent-protocol.md) (2026-11-25) |
| **NIST NCCoE "Software and AI Agent Identity and Authorization"** | Concept paper (Feb 2026), comment summary, 10 design tenets (Oct-Nov 2026) *(secondary for the tenets)* | Applying existing IAM standards (OAuth, SPIFFE, MCP) to agents: delegated access, revocable permissions, audit trails | Strong match to our design; useful framing for a government audience | Map our controls to the tenets |
| **OWASP Top 10 for Agentic Applications (2026)** | OWASP GenAI Security Project (Dec 2025) | Risks ASI01-ASI10. ASI09 "human-agent trust exploitation" warns that the approval step itself can be manipulated | Supports our rule that the approval preview comes only from the ticket row, and our T15 test | Map our controls to ASI01-ASI10 |
| **WebMCP** | W3C Web Machine Learning CG draft (not standards track); Chrome origin trial; API name moving from `navigator.modelContext` to `document.modelContext` *(secondary)* | A web page registers tools for in-browser agents | Out of scope per PRD (non-goal); would let browser agents call our journey as tools | Revisit when stable |
| **llms.txt** | Community convention | Site summary for models | Built (Phase 5, `AGENT_HINTS`) | Keep; Poppy's `poppy.json` is the structured equivalent |

## 5. Proposed roadmap (if the owner wants Poppy alignment)

All behind a new flag `POPPY=on`, off by default, so the current test matrix is unchanged.

1. **Slice A: discovery and errors.** `/.well-known/poppy.json` generated from the policy file and routes (`scope_hints` from action risk); domain-level protected resource metadata; `tasks` endpoint with `update_contact` excluded; `Retry-After` on 429; `Poppy-Version` checks. Tests: document schema, domain match, Poppy demo agent validator.
2. **Slice B: Operations.** Gated responses also carry `error: "approval_required"` and an `operation` (API, MCP `structuredContent`, website `Poppy-Operation` header and endpoint); accept `Poppy-Approval` on resend together with a passkey-approved ticket; `503 Retry-After` while performing; `approval_declined` with `alternative`. Tests: the existing T2-T7 suites run again in Poppy format.
3. **Slice C: sign-in and sessions.** CIMD clients with `private_key_jwt`; real scopes; refresh tokens and revocation; Session JWT and delegation verifier as a new classifier tier A source; pairwise user link; browser join as a declared handover. Tests: unit vectors for the JWT chain, an integration test with a reference client, T10 with declared versus detected handover.
4. **Live test:** run P1-P3 with the Poppy demo agent and any personal agents that support Poppy by then, as an extra column in the results.

Dependencies to verify before slice C: the CIMD draft's current revision, and whether `jose` covers everything (it supports ES256 and PS384; no new dependency expected).

## 6. Decisions for the owner

**Update 2026-11-24:** decision 1 taken: Poppy alignment is planned as Phase 7 in one app and one deployment behind `POPPY=on` (decision D8 in `docs/implementation-plan.md` and `docs/decisions.md`), with the approval rule of section 3.2. Decisions 3 and 4 remain open.


1. Do we want Poppy alignment in this prototype (roadmap above), or only this analysis for the write-up?
2. If yes: accept the "Poppy approval **plus** passkey" rule for irreversible steps (section 3.2), and raise the compatibility question on the Poppy GitHub repository?
3. Is a real CIBA back-channel (replacing the simulated `/device` channel) worth a phase of its own after Poppy?
4. Should the security write-up map our controls to the NIST tenets and the OWASP agentic Top 10?

## Sources

Poppy (read directly):
- [Poppy documentation](https://personalagentprotocol.org/docs), [Poppy 1.0 specification](https://personalagentprotocol.org/docs/1.0/spec), [Guides](https://personalagentprotocol.org/docs/1.0/guides), [Extensions](https://personalagentprotocol.org/docs/1.0/extensions) including [Operations](https://personalagentprotocol.org/docs/1.0/extensions/operations), [UCP](https://personalagentprotocol.org/docs/1.0/extensions/ucp), [Mediated Sign-In](https://personalagentprotocol.org/docs/1.0/extensions/mediated-sign-in), [Browser control](https://personalagentprotocol.org/docs/1.0/extensions/browser-control), [Links](https://personalagentprotocol.org/docs/1.0/extensions/links), [Disclosures](https://personalagentprotocol.org/docs/1.0/extensions/disclosures); [Changelog](https://personalagentprotocol.org/docs/changelog); [Licence](https://personalagentprotocol.org/license)

Landscape (search results; many secondary):
- A2A: [Turing Post v1.0 guide](https://www.turingpost.com/p/a2a), [Tyk architecture](https://tyk.io/learning-center/a2a-protocol-architecture-and-technical-specification/)
- AP2: [Mintive enterprise guide](https://www.mintive.com/blog/ap2-agent-payments-protocol), [DeepInspect mandates guide](https://www.deepinspect.ai/blog/agent-payments-protocol-ap2)
- IETF OAuth agent drafts: [draft-oauth-ai-agents-on-behalf-of-user](https://datatracker.ietf.org/doc/draft-oauth-ai-agents-on-behalf-of-user/), [draft-klrc-aiagent-auth](https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/02/), [draft-mishra-oauth-agent-grants](https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/)
- Web Bot Auth: [IETF webbotauth WG](https://datatracker.ietf.org/wg/webbotauth/), [IETF 126 minutes](https://datatracker.ietf.org/doc/minutes-126-webbotauth/)
- NIST: [NCCoE project](https://www.nccoe.nist.gov/projects/software-and-ai-agent-identity-and-authorization), [Concept paper](https://csrc.nist.gov/pubs/other/2026/02/05/accelerating-the-adoption-of-software-and-ai-agent/ipd), [Comment summary](https://www.nist.gov/news-events/news/2026/09/comments-software-and-agentic-ai-identity-concept-paper), [10 tenets (Biometric Update)](https://www.biometricupdate.com/202611/nist-sets-10-principles-for-ai-agent-identity-and-authorization)
- OpenID: [AIIM community group](https://openid.net/cg/artificial-intelligence-identity-management-community-group/), [Agentic AI whitepaper](https://openid.net/new-whitepaper-tackles-ai-agent-identity-challenges/), [OIDF response to NIST](https://openid.net/oidf-responds-to-nist-on-ai-agent-security/)
- Commerce: [Google UCP under the hood](https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/), [Opascope protocols guide](https://opascope.com/insights/ai-shopping-assistant-guide-2026-agentic-commerce-protocols/), [Visa TAP vs Mastercard Agent Pay](https://www.b2bcentr.com/visa-trusted-agent-protocol-vs-mastercard-agent-pay/)
- WebMCP: [WebMCP reality check](https://studiomeyer.io/en/blog/webmcp-reality-check-may-2026)
- OWASP: [Auth0 on the agentic Top 10](https://auth0.com/blog/owasp-top-10-agentic-applications-lessons/), [Teleport takeaways](https://goteleport.com/blog/owasp-top-10-agentic-applications/)
