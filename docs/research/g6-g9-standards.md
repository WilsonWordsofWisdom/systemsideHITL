# Open standards for gaps G6-G9: fit with the prototype

Research note, 2026-11-26, branch `research/g6-g9-standards`. It assesses four open standards, one for each of four known gaps, in the order recommended for building them:

| Order | Gap | Standard |
|---|---|---|
| 1 | **G7** Agent signatures don't cover the request body | HTTP Content-Digest (RFC 9530) |
| 2 | **G8** OAuth tokens aren't tied to one action or application | OAuth Rich Authorization Requests (RAR, RFC 9396), optionally with OpenID CIBA |
| 3 | **G6** Revocations and risk changes stay inside this app | OpenID Shared Signals Framework (SSF 1.0, CAEP 1.0, RISC 1.0) |
| 4 | **G9** No positive "real person on a real device" signal | Privacy Pass (RFCs 9576-9578; Apple's "private access tokens") |

It is a research input, not a decision. Decisions for the owner are at the end.

**Sources and their limits:**
- Statuses were checked against the RFC Editor, the IETF datatracker, the OpenID Foundation and Apple Developer pages.
- Items marked *(unconfirmed)* come from secondary sources or need the full specification text checked before building.
- The other standards from the wider survey are not assessed in depth here: DPoP, DBSC, AuthZEN, Secure Payment Confirmation, Verifiable Intent / AP2, Transaction Tokens and UCP. Their one-line verdicts are in section 6.

## 1. Summary

| Gap | Standard | Status | Closes the gap? | Effort | Third-party cost |
|---|---|---|---|---|---|
| G7 | Content-Digest | RFC, February 2024 | **Yes**, for agents that sign it | About ½ day (already optional Phase 8 step 6) | None |
| G8 | RAR | RFC, May 2023 | **Yes** at the OAuth level, for agents that send it | About 2 days, plus 3-5 days if combined with CIBA | None |
| G6 | SSF, CAEP, RISC | OpenID **Final**, September 2025 | **Yes** technically; the value needs a second system to receive the events | About 2-3 days, plus a test receiver | None |
| G9 | Privacy Pass | RFCs, June 2024 | **Partly.** A device signal, not proof of a person | About 2 days | An issuer run by Cloudflare or Fastly; production terms *(unconfirmed)* |

**Main findings:**
- **G7 is half-built already, and that needs care.** The verifier in [lib/webBotAuth.ts](../../lib/webBotAuth.ts) accepts any header as a covered component. An agent can therefore cover `content-digest` today: the signature then proves the **header** was sent, but we never check that the header matches the body. Until the check exists, the console and logs must not describe such a signature as covering the body.
- **G8's tangible gain is least privilege, not a new approval route.**
  - With RAR, a token can be limited to one application and named actions. A misused or stolen token can then do nothing to the person's other applications.
  - Using RAR consent as a **replacement** for the passkey hand-off is possible but duplicates our tickets. It's not recommended.
  - No agent we know of sends RAR today. Neither Poppy nor (*unconfirmed*) the MCP authorisation specification uses it, so early value is mainly for our own test agent.
- **G6 is the most "enterprise" of the four.**
  - It lets this site announce events (session revoked, credentials changed, risk raised) to an identity provider or an agent platform, and lets them warn us.
  - In a standalone prototype nobody is listening, so it needs a small test receiver to show it working.
- **G9 can't be closed by any open standard.**
  - Privacy Pass shows that a real, attested Apple device is present, with no identity revealed. Headless and cloud browsers usually can't produce one.
  - It does not prove a person is there: an agent driving the person's own Safari passes.
  - It stays a classifier input, never a gate. The passkey before irreversible steps remains our answer to covert agents.
- **None of the four replaces the passkey gate.** Each strengthens a different layer around it:
  - G7: attribution;
  - G8: token scope;
  - G6: cross-system revocation;
  - G9: detection.

**Recommendation:**
1. **G7:** do it with Phase 8 and make the body check mandatory rather than optional.
2. **G8:** build RAR as least-privilege token restriction (option 8A), and record CIBA with RAR (option 8C) as the way to also close G3.
3. **G6:** build a CAEP transmitter with poll delivery and a test receiver (option 6A).
4. **G9:** build it as a classifier input using Apple's demo issuers, **after** the Phase 6 weights are frozen or as a separate trial variant (option 9A). Treat a production issuer as a vendor decision.

## 2. G7: Content-Digest (RFC 9530)

### How it works

- **The header:** the sender adds `Content-Digest: sha-256=:<base64 hash of the body>:` (`sha-512` is also registered).
- **Signing it:** if the RFC 9421 signature covers `content-digest`, the signature binds the body: change one byte and either the digest no longer matches or the signature fails.
- **What the drafts say:**
  - RFC 9421 says it "does not define a means to directly cover HTTP message content" and defers to RFC 9530.
  - The current Web Bot Auth protocol draft (`draft-ietf-webbotauth-httpsig-protocol-01`) does not require Content-Digest for ordinary requests (*unconfirmed*: the search didn't reach the normative section). Its registry draft requires it only when signing an agent's key card.
  - Requiring it on our side would therefore be **site policy**, not draft conformance.

### What we have today

| Item | Today |
|---|---|
| Covered components accepted | `@authority` is required. `@method`, `@path`, `@query`, `@target-uri`, `@scheme` and any header (including `content-digest`) can be covered. |
| Digest checked against the body | **No** |
| Body bound to the person's approval | Yes, at the application level: the ticket stores a SHA-256 hash of the canonical payload and the stored resource, and a changed body needs a new approval. |
| Agent signs at sign-in, at passkey approval and on gated requests | Yes (`webBotAuthAgent` is called from the guard, `/api/auth/login` and `/api/auth/passkey/verify`) |

### What it would add, and what it wouldn't

| Adds | Matters here? |
|---|---|
| Proof that a named operator's key signed **this exact body**, not just "a request to this site" | Yes. Audit and attribution: the log can show which agent sent which payload |
| Stops a party between the signer and us (an agent platform's relay, a browser extension, a proxy) changing the body while keeping the agent's identity | Modest. TLS already protects the network path |
| Closes the "covered but unchecked" ambiguity above | Yes |

It does **not**:
- prove the person approved the body (the ticket and passkey do that);
- protect agents that don't sign;
- apply to Poppy or MCP requests, whose tokens and session JWTs don't cover the body.

### Costs and trade-offs

- **Cost:** about ½ day, no new dependency (`node:crypto`), no migration.
- **Reading the body:** the verifier must hash the raw body **before** JSON parsing, so the guard must pass the same bytes to both. This needs a size cap (the JSON bodies here are small) and a clone of the request.
- **Strict mode:** requiring a covered digest on `POST` requests in strict mode (`WBA_STRICT`) penalises agents that sign but don't include one. That is the same trade-off as the nonce rule in Phase 8. It should be measured in the trials, not assumed.

### Options

| Option | What | Effort |
|---|---|---|
| **7A (recommended).** Phase 8 step 6, made mandatory within Phase 8 | When `content-digest` is covered, check it against the body; a mismatch means "no signature signal" and is logged as `digest_mismatch`. In strict mode, require it for unsafe methods | About ½ day |
| 7B. Leave as is | Document that a covered digest is not checked | None |

## 3. G8: Rich Authorization Requests (RFC 9396), optionally with CIBA

### How it works

- **The request:** the client sends `authorization_details`, a JSON array of objects with a `type` (ours to define) and fields such as `actions`, `locations`, `identifier` or our own fields, alongside or instead of `scope`.
- **Consent and token:**
  - The authorisation server shows them on the consent page and can narrow them.
  - It returns the granted details in the token response and, for JWT access tokens, in the token.
  - The resource server enforces them.
- **Advertising support:** the server lists `authorization_details_types_supported` in its metadata and rejects unknown types with `invalid_authorization_details`.
- **With CIBA:** RAR also works in CIBA back-channel requests, so an agent can ask "approve this specific thing" on the person's phone with a `binding_message`.
  - Commercial services already combined the two in 2022, per the RFC's shepherd write-up.
  - CIBA is an OpenID Final specification (2021).

### What we have today

| Item | Today |
|---|---|
| MCP OAuth | One scope, `mcp` |
| Poppy OAuth | Named scopes (Poppy 4.7) with `scope_hints` in [lib/oauth/scopes.ts](../../lib/oauth/scopes.ts) |
| Token | A JWT carrying `scope`. The authorisation code row (`oauth_codes`) and refresh token rows store `scope` and `resource` |
| Binding to one action | Our single-use tickets (action, resource, payload hash, passkey) and Poppy Operations revisions |
| What a token can reach | Every application the account owns, for every action the scope covers. The passkey gate still applies to submit, pay and delete |

### Design sketch (option 8A)

- **Type:** a single `type`, for example `demogov_permit`, with:
  - `actions`: a subset of `read`, `update_draft`, `submit`, `pay`, `update_contact`, `delete`;
  - `application_ids`: specific applications, or `new` for a draft the agent may create;
  - optional `max_fee`, for pay.
- **Consent page:** shows the details in plain language, for example "This tool may submit and pay for application DG-1042 only."
- **Storage and tokens:** details are stored with the code and the refresh token family and copied into the access token, so refresh can't widen them.
- **Enforcement:** the guard and MCP tools check every action against the token's details **before** the policy decision.
  - Outside the details → 403 with the bearer error `insufficient_scope` (RFC 6750; RFC 9396 defines no resource-server error of its own), logged as `outside_authorization_details`.
  - Inside them, the gate works exactly as now (submit, pay and delete still need the passkey).
- **Without RAR:** tokens behave as today, scope only.

### What it would add, and what it wouldn't

| Adds | Matters here? |
|---|---|
| Least privilege: a token for one application can't touch another, and a token without `delete` can't even start a deletion | **Yes.** It limits the damage from a stolen token (G1) or a manipulated agent (T15 injection) |
| The person sees the specific scope at consent, which is clearer than "access your applications" | Yes |
| A standard, machine-readable description of what the agent asked for, in the audit trail | Yes |
| With CIBA (option 8C): a standard way for the agent to start an approval on the person's phone, closing G3 as well | Yes, the biggest credibility gain, but larger |

It does **not**:
- replace the passkey gate: consent happens before the agent prepares the payload, so it can't bind the final content;
- help agents that send only scopes, which today means all known agents.

### Costs and trade-offs

| Item | Cost or trade-off |
|---|---|
| Effort | 8A: about 2 days. 8C: a further 3-5 days (back-channel endpoint, notification to the device page by web push or polling, token polling, consent on the device). A native phone app is out of scope |
| Migration | Yes (0007): an `authorization_details jsonb` column on `oauth_codes` and on the refresh token table. Applied to production only with approval |
| Adoption | No known agent sends RAR. Poppy uses named scopes; the MCP authorisation specification is reported not to reference RFC 9396 *(unconfirmed)*. Until that changes, only our own test agent exercises it |
| Two ways to scope | Scopes and details must agree. Rule: details only narrow what scopes allow, never widen it |
| Consent fatigue | Tightly scoped tokens mean more consent prompts, for example one per application |
| Option 8B (rejected) | Letting a passkey-approved RAR consent replace the ticket hand-off for one action. The agent would put the payload hash in the details. This duplicates tickets, puts an irreversible approval before the agent has shown the final content, and splits approval across two mechanisms |

### Options

| Option | What | Effort |
|---|---|---|
| **8A (recommended).** RAR as least-privilege restriction, behind a flag (for example `OAUTH_RAR`) | Design sketch above | About 2 days + migration |
| 8B. RAR consent as pre-approval | Rejected (see above) | 3-4 days |
| **8C (record as option).** CIBA with RAR | Agent-started approval on the person's phone with the exact details; the passkey stays on the device. Also closes G3 | 3-5 days on top of 8A |

## 4. G6: Shared Signals Framework, CAEP and RISC

### How it works

- **Status:** the OpenID Foundation approved SSF 1.0, CAEP 1.0 and RISC 1.0 as Final Specifications in September 2025.
- **Roles:** a **transmitter** sends Security Event Tokens (SETs, RFC 8417: signed JWTs) to **receivers** that have set up a stream.
- **Discovery and streams:** a configuration document at `/.well-known/ssf-configuration`, plus a stream management API (create, configure, verify, add and remove subjects).
- **Delivery:** push (RFC 8935: the transmitter POSTs SETs) or poll (RFC 8936: the receiver fetches them).
- **Subjects:** standard subject identifiers (RFC 9493), for example opaque, email or issuer and subject.
- **CAEP events** (continuous access) include session revoked, credential change, token claims change, assurance level change and device compliance change. A risk level change event is in CAEP 1.0 *(unconfirmed: check the final text)*.
- **RISC events** (account security) include credential compromise, account disabled and sessions revoked.

### What we have today: events we'd transmit

| Our event (code) | CAEP or RISC event |
|---|---|
| `revokeSession` (signed out, rotated, idle, absolute, `poppy_signed_out`) | CAEP session revoked |
| `revokeOtherSessions(..., "passkey_reset")` | CAEP session revoked (each) or RISC sessions revoked |
| Passkey enrolled or removed | CAEP credential change |
| `revokeFamily` (token revoked by RFC 7009, or refresh-token reuse detected) | CAEP token claims change or session revoked *(mapping to confirm)*. Reuse detection may also justify RISC credential compromise toward the agent platform |
| `escalateRisk` to `agent_observed` or `handover_suspected` | CAEP risk level change *(unconfirmed)* |

**Events we could receive:**
- **From an identity provider:** "credential compromised" or "account disabled" → end every session and token for that user.
- **From an agent platform (a Poppy agent operator):** "our key or the user's agent credential is compromised" → revoke that client's token families.
- Today no external party could send either.

### Design sketch (option 6A)

- **Configuration and keys:**
  - The transmitter configuration document, behind a flag (for example `SSF`), off by default.
  - SETs signed with a new key, set by the owner as an env var; separate from the OAuth token key so it can be rotated on its own.
- **Delivery:**
  - **Poll delivery first:** a serverless app can't reliably retry pushes.
  - Events are written to an outbox table in the same transaction as the revocation, and the receiver polls and acknowledges them.
  - Push can follow if a receiver needs it.
- **Subjects and streams:**
  - Opaque, pairwise subject identifiers per receiver, never email addresses, so receivers can't link users across services.
  - Streams created only by the owner (the console's admin secret), not self-service.
- **A test receiver:** a small script, or a console page, that polls, verifies signatures and shows events. It demonstrates that, for example, signing out in the browser reaches the receiver within seconds.
- **Receiving events:** an optional step that accepts RISC credential compromise for a configured issuer and ends that user's sessions and tokens.

### What it would add, and what it wouldn't

| Adds | Matters here? |
|---|---|
| A revocation or handover suspicion here reaches other systems at once, instead of waiting for tokens to expire | In production, yes. In the prototype, only with the test receiver |
| Another system's warning ends our sessions and tokens | Same |
| Shows the design fits an enterprise identity estate | Yes, for the briefing |

It does **not** detect anything new. It only moves decisions we already make to systems that can act on them.

### Costs and trade-offs

| Item | Cost or trade-off |
|---|---|
| Effort | About 2-3 days (transmitter, outbox, poll endpoint, event mapping, test receiver). Receiving: about 1 day more |
| Migration | Yes: streams and outbox tables (with RLS, like every table) |
| New secret | A SET signing key, set by the owner (value never in git or chat) |
| Value without a partner | Demonstration only. Real value needs an identity provider or agent platform to subscribe. CAEP support in commercial identity products is reported by vendors *(unconfirmed for any specific product)* |
| Privacy | Events about people go to third parties: a data-sharing agreement and data protection assessment in production; minimal claims and pairwise subjects in any case |
| Operations | Stream verification, key rotation and receiver back-pressure are ongoing work; the outbox needs a retention limit |
| Trust in incoming events | A forged or mistaken "compromise" event can sign everyone out. Accept only from configured issuers with verified keys, and log every action taken |

### Options

| Option | What | Effort |
|---|---|---|
| **6A (recommended).** Transmitter with poll delivery and a test receiver | Design sketch above | About 2-3 days + migration + secret |
| 6B. Transmitter and receiver | 6A plus acting on RISC credential compromise from a configured issuer | About 3-4 days |
| 6C. Defer until an identity provider or agent platform is in scope | Record only | None |

## 5. G9: Privacy Pass (private access tokens)

### How it works

- **The flow:**
  1. The site answers a request with `401` and `WWW-Authenticate: PrivateToken challenge=..., token-key=...`, naming a token issuer and its public key (RFC 9577).
  2. The client asks an **attester** (on Apple devices, Apple) to vouch for the device.
  3. An **issuer** then signs a blinded token without learning which site or user it is for.
  4. The client presents `Authorization: PrivateToken token=...`.
- **Verification:**
  - The site checks the token's RSA blind signature (RFC 9578, token type 2, a standard RSA-PSS signature) against the issuer key, and that the token answers this challenge.
  - Each token is redeemed once.
  - The site learns only "an attested device passed the issuer's check", not who it is.
- **Who supports it:**
  - **Apple:** iOS 16 and macOS Ventura and later, in Safari and apps.
  - **Issuers:** Cloudflare and Fastly. Apple's developer page lists demo issuers for testing (`demo-pat.issuer.cloudflare.com`, `demo-issuer.private-access-tokens.fastly.com`).
  - **Production issuers** are used automatically for the CDNs' own bot-management customers (secondary sources). Whether an origin outside those services may use a production issuer, and on what terms, is *unconfirmed*.

### What we have today

- **Behaviour signals** (webdriver, untrusted events, pointer, timing, headers, user-agent tokens) are weighted in [policy/classifier.yaml](../../policy/classifier.yaml).
- **The classifier escalates only:** agent evidence is never downgraded, and a quiet window counts as no evidence.
- **No positive human-leaning signal exists.** A passkey session is called human only when its score is below the `clear` threshold.

### Design sketch (option 9A)

- **The challenge:** on `/login` and on the journey pages, a small subresource (for example `/api/pat/challenge`) answers with a Privacy Pass challenge naming a configured issuer.
  - Safari fetches and presents a token automatically; other browsers ignore the challenge.
  - The page never blocks on it.
- **Verification:** with `node:crypto`; no new dependency.
  - The challenge digest is bound to a server nonce stored per session.
  - Redemption is single use, using the existing replay table with a `pat:` key prefix.
- **Recording:** `pat_valid: true` goes into the session's signals and request log, and shows in the console.
- **The classifier:** a new, small **negative** weight, applied only to behaviour scores (tier C).
  - It never cancels tier A evidence (a signature, a Poppy session, a join) or a self-declaration.
  - It never lowers `risk_state`.
  - A missing token counts as no evidence, because most browsers aren't Apple's.
- **Flag and issuer:** behind a flag (for example `PRIVACY_PASS`), using the demo issuer in the prototype.

### What it would add, and what it wouldn't

| Adds | Matters here? |
|---|---|
| A privacy-preserving, cryptographic sign of a real Apple device, which headless and cloud browsers usually lack | Yes, for detection figures: fewer people misread as agents, and a measurable gap between people and cloud agents |
| A research result: how often trial agents present tokens | Yes |

It does **not** prove a person is present:
- An agent using the person's own Safari (computer-use on a Mac) gets tokens.
- Some analyses describe it as proof of a device and an Apple account in good standing, not of a human.
- It does nothing for Android, Windows or Linux users, and depends on Apple's attestation.

### Costs and trade-offs

| Item | Cost or trade-off |
|---|---|
| Effort | About 2 days. No migration (reuses the replay table) |
| Vendor dependency | Tokens come from Cloudflare's or Fastly's issuer and Apple's attester. Demo issuers are for testing; production terms are *unconfirmed (quote or terms needed)* |
| Fairness | Only Apple users can earn the signal. Using it as a gate would discriminate by device, so it stays a weight, never a requirement |
| Effect on trials | It changes classifier output. Add it after the Phase 6 weights are frozen, or run it as a separate trial variant, so the baseline isn't affected |
| Weakening detection | A negative weight is the first in the classifier. It must be bounded so it can't pull a session below `suspect` on its own (for example at most 10 points, with a test) |
| Alternatives | Chrome's Private State Tokens (W3C draft, Chrome only) are similar but issuer-run and not assessed here |

### Options

| Option | What | Effort |
|---|---|---|
| **9A (recommended).** Signal only, demo issuer, after the weights freeze | Design sketch above | About 2 days |
| 9B. Production issuer | 9A with a production issuer under agreed terms | Vendor decision |
| 9C. Don't build; rely on the passkey gate | Record that G9 is mitigated by design, not closed | None |

## 6. Other surveyed standards

| Standard | Helps G6-G9? | Verdict |
|---|---|---|
| DPoP (RFC 9449) | No (it signs the method and URL, not the body) | Keep for G1, stolen tokens |
| DBSC (W3C draft; Chrome) | No (it shows the session is on the same device, not a person) | Keep for G2, copied cookies |
| CIBA (OpenID Final) | G8 only with RAR (option 8C) | Keep for G3, a real phone approval |
| AuthZEN 1.0 (OpenID Final, January 2026) with OPA or Cedar | No | Keep for G4 and G5, read rules and shared policy |
| Transaction Tokens (IETF drafts) | Partly G6 and G8, between our own services only | Skip until the system is split into services |
| Secure Payment Confirmation (W3C CR draft) | Partly G8, for payments only | Skip unless the pay step takes real money |
| Verifiable Intent / AP2 mandates (early drafts) | Partly G7 and G8, for payments | Skip; borrow the idea of signed approval records |
| UCP (Google) | No | Commerce protocol; supports our "person finalises" rule |
| Visa TAP | No | See [trusted-agent-protocol.md](trusted-agent-protocol.md); only option A (optional Phase 8) is recommended |

## 7. Sequencing, effort and dependencies

| Order | Work | Effort | Migration | New secret | Flag | Affects the Phase 6 baseline? |
|---|---|---|---|---|---|---|
| 1 | G7 within Phase 8 (7A) | ½ day | No | No | `WBA_STRICT` (Phase 8) | Only in strict mode |
| 2 | G8 RAR (8A) | 2 days | Yes | No | `OAUTH_RAR` | No (only agents that send RAR) |
| 2b | G8 + G3 CIBA (8C, optional) | +3-5 days | Likely | Possibly (web push keys) | `CIBA` | No |
| 3 | G6 SSF transmitter (6A) | 2-3 days | Yes | Yes (SET signing key) | `SSF` | No |
| 4 | G9 Privacy Pass (9A) | 2 days | No | No | `PRIVACY_PASS` | **Yes**: after the weights freeze, or as a trial variant |

**Total:** about 6½-7½ days for 7A, 8A, 6A and 9A; about 10-12 with CIBA.

**Common rules:**
- Each piece goes behind a flag that is off by default.
- Each comes with unit and integration tests and a Gherkin scenario.
- Production migrations need the owner's approval.
- The passkey gate, tickets and policy are unchanged throughout.

## 8. Decisions for the owner

1. **G7:** make Content-Digest checking mandatory within optional Phase 8 (7A), and decide D9 (whether to build Phase 8).
2. **G8:** add RAR as least-privilege restriction (8A) as a new optional phase. Record CIBA with RAR (8C) as the route to also close G3. Reject RAR as pre-approval (8B).
3. **G6:** build the transmitter with a test receiver now (6A), or defer until an identity provider or agent platform is in scope (6C).
4. **G9:** build as a bounded classifier input after the Phase 6 weights are frozen (9A), or record G9 as mitigated by design (9C). A production issuer (9B) is a vendor decision.
5. **Plan:** whether to add the chosen options to [docs/implementation-plan.md](../implementation-plan.md) as optional phases, as was done for Phase 8.
6. **Briefing line:** open standards can make our signatures cover the body (G7), limit each agent token to the applications and actions the person chose (G8), and share revocations with other systems (G6). No standard proves a person is present on every request (G9). That is why every irreversible step still needs the person's own passkey.

## Sources

- [RFC 9530: Digest Fields](https://www.rfc-editor.org/rfc/rfc9530.html)
- [RFC 9421: HTTP Message Signatures](https://rfc-editor.org/rfc/rfc9421)
- [draft-ietf-webbotauth-httpsig-protocol-01](https://www.ietf.org/ietf-ftp/internet-drafts/draft-ietf-webbotauth-httpsig-protocol-01.html)
- [draft-meunier-web-bot-auth-architecture-05](https://datatracker.ietf.org/doc/html/draft-meunier-web-bot-auth-architecture-05) (nonce guidance)
- [Web Bot Auth registry draft](https://www.ietf.org/archive/id/draft-meunier-webbotauth-registry-02.html) (Content-Digest for signed cards)
- [RFC 9396: OAuth 2.0 Rich Authorization Requests](https://rfc-editor.org/rfc/rfc9396)
- [RAR shepherd write-up](https://datatracker.ietf.org/doc/draft-ietf-oauth-rar/writeup/) (RAR with CIBA in use)
- [MojoAuth: RAR for agents](https://mojoauth.com/blog/scoping-agent-permissions-rich-authorization-requests-rfc-9396-in-practice) (secondary; MCP claim unconfirmed)
- [OpenID Foundation: SSF, CAEP and RISC Final](https://openid.net/press-release-openid-foundation-finalizes-global-standards-for-real-time-identity-security/)
- [Help Net Security coverage](https://www.helpnetsecurity.com/2025/09/22/openid-standards-real-time-security-event-sharing/)
- [SGNL on the Final specifications](https://sgnl.ai/2025/09/sgnl-welcomes-the-publication-of-the-final-shared-signals-and-caep-specifications/)
- [RFC 9576: Privacy Pass Architecture](https://www.rfc-editor.org/rfc/rfc9576.html)
- [Apple Developer: Challenge Private Access Tokens](https://developer.apple.com/news/?id=huqjyh7k)
- [WWDC22: Replace CAPTCHAs with Private Access Tokens](https://developer.apple.com/videos/play/wwdc2022/10077/)
- [Fastly on Private Access Tokens](https://www.fastly.com/blog/private-access-tokens-stepping-into-the-privacy-respecting-captcha-less)
- [Supporting PATs on your web server](https://mercedesbernard.com/blog/supporting-pats/) (secondary)
- [Private Access Tokens, also not great](https://educatedguesswork.org/posts/private-access-tokens/) (critique)
- [HTTP Toolkit on Apple attestation](https://httptoolkit.com/blog/apple-private-access-tokens-attestation/) (critique)
- Poppy context: [Descope on Poppy](https://www.descope.com/learn/post/personal-agent-protocol) (named scopes; no RAR or SSF found)
