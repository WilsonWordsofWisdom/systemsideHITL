# Visa Trusted Agent Protocol (TAP): fit with the prototype

Research note, 2026-11-25 (updated 2026-11-26 with costs, trade-offs and options), branch `research/trusted-agent-protocol`. It asks whether Visa's Trusted Agent Protocol can be added to DemoGov Permits, and what it would add. It is a research input, not a decision; decisions for the owner are at the end.

Sources and their limits: Visa's specification page on developer.visa.com showed only a landing summary, not the normative text, so the details below come from Visa's GitHub reference implementation (not normative), Visa's product terms, and Cloudflare's write-up. Items marked *(unconfirmed)* need checking against the full specification, which likely needs a Visa Developer account.

## 1. Summary

- **What it is:** Visa's way for an AI shopping agent to prove who it is to a merchant on every request, using **RFC 9421 HTTP Message Signatures**, the same base as Web Bot Auth, which we already verify. It adds a `tag` saying what the agent is doing (`agent-browser-auth` for browsing, `agent-payer-auth` for paying), a required `nonce` against replay, and agent keys published in a **Visa-operated directory** of Visa-registered agents. It can also carry consumer and payment identifiers (for example a Payment Account Reference or loyalty number) to prefill checkout.
- **Can it be incorporated? Yes, technically, and cheaply:** it is a variant of our existing Web Bot Auth verifier, about 1-2 days behind a flag. It would add one more tier A identity source ("Visa-registered agent").
- **But its value here is limited, and there are blockers:**
  - TAP is built for **card commerce**. Our journey has only a mock fee.
  - TAP proves **which agent** is calling and that it says it is browsing or paying. It does **not** prove that the person approved a specific action, so our passkey gate is still needed. The Visa terms leave collecting consent to the merchant.
  - **Live use needs Visa access:** the production key directory, its URL and format, and agent registration are not public.
  - **The terms are restrictive:** implementing the specification is licensed on condition of "strict conformance" to the latest version, with updates within six months of each Visa update. The sample code's licence is ambiguous (MIT-style file headers, but `LICENSE.md` points to Visa's Developer Center terms). This needs legal review before we use either.
- **Recommendation (revised 2026-11-26):**
  - **Now:** take the part of TAP's security gain that costs nothing: harden our own Web Bot Auth verifier with replay protection and path binding (option A, section 6). This is optional Phase 8 in the implementation plan.
  - **Later:** build a TAP verifier (option B) only if Phase 6 shows trial agents sending TAP signatures, or a payments use case appears, after legal review and Visa specification access.
  - **Production decision, not prototype:** verification at the network edge (option C).

## 2. How TAP works (verifier side)

| Item | TAP | Source |
|---|---|---|
| Signature standard | RFC 9421 HTTP Message Signatures (`Signature-Input`, `Signature`) | Visa README, Cloudflare |
| Covered components | `@authority`, `@path` (required set *unconfirmed*) | Cloudflare example, Visa sample |
| Parameters | `created`, `expires`, `keyid`, `alg`, `nonce`, `tag` | Cloudflare, Visa sample |
| Tags | `agent-browser-auth` (browsing), `agent-payer-auth` (paying) | Cloudflare, Visa sample agent |
| Algorithms | Ed25519; RSA-PSS-SHA256 in the sample (production *unconfirmed*) | Visa sample, Cloudflare |
| Lifetime | Not stated; the sample uses 8 minutes, the Cloudflare example 1 hour | Visa sample, Cloudflare |
| Replay | A nonce is required and must be unique (verifier keeps a cache) | Cloudflare, Visa README |
| Key discovery | Visa hosts a directory of Visa-registered agents; the key is found by `keyid`. No `Signature-Agent` header. Production URL and format *not public* | Cloudflare, Visa sample registry |
| Extra data | Consumer and payment identifiers "via query parameters", as consented by the consumer; field names and signing *unconfirmed* | Visa README |
| Cloudflare checks | Headers present → key by `keyid` → `created`/`expires` window → nonce unused → tag valid → rebuild signature base → verify | Cloudflare |

## 3. Compared with what we already have

| | Web Bot Auth (built, Phase 5) | Visa TAP | Poppy sessions (built, Phase 7) |
|---|---|---|---|
| Proves | Which operator's agent sent the request | Which Visa-registered agent sent it, and whether it is browsing or paying | Which agent, for which user, in which session |
| Signature | RFC 9421, Ed25519 | RFC 9421, Ed25519 (RSA-PSS in sample) | JWT (ES256) with a delegation chain |
| Keys | Operator's own directory, named by `Signature-Agent` | Visa-operated directory, by `keyid` | Operator's `jwks_uri` |
| Replay | Time window only | Nonce, single use | `jti`, single use |
| Who can take part | Any operator | Agents Visa approves | Any agent with a published client metadata document |
| Proves the person approved the action | No | No | No (the agent's statement only) |

TAP is closest to Web Bot Auth. Cloudflare describes it as building on Web Bot Auth "by introducing a new tag". The main differences are the closed, Visa-run key directory, the required nonce, and the browsing/paying tags.

## 4. What it would and wouldn't add

| Benefit | What it gives us | Matters for the prototype? |
|---|---|---|
| Recognised agent identity | A Visa-registered agent is tier A evidence (`declared_agent`), logged and shown in the console, like Web Bot Auth | Yes |
| Vetted identity | Web Bot Auth proves *who* signed; a TAP key is listed by Visa after onboarding, so it also carries a third party's vetting | Yes: a stronger trust tier |
| Central revocation | Visa de-lists a misbehaving agent and every merchant stops trusting it, with no allow or block lists of our own | In principle; untestable without Visa access |
| Replay protection | The nonce makes each signature single use. Our Web Bot Auth check enforces only the time window | Yes, and a gap we can close without TAP (option A) |
| Path binding | The signature covers the page or operation as well as the site; ours covers only `@authority` | Yes, also closable without TAP (option A) |
| Declared intent (browse or pay) | A policy input: a pay request signed `agent-browser-auth` is an agent acting beyond its declared purpose | Partly: one payment step, a mock one |
| Network-edge enforcement | CDNs (Cloudflare, Akamai) verify TAP and can apply managed rules before traffic reaches the app | Production only |
| Incentive to identify | Payment networks and CDNs reward signing, so more agent traffic becomes identifiable | Yes, if trial agents sign with TAP |
| Audit evidence | Store the verified signature and tag with the ticket: signed proof of which registered agent asked to pay | Modest here; real for payments |
| Research value | Compare Web Bot Auth, TAP and Poppy on the same journey in the trials | Yes |
| Consumer and payment identifiers | Prefilled checkout, returning-customer recognition, fewer chargebacks | No: we would decline them (personal data in URLs, not needed) |

**What it does not add:** proof that the person approved the action. The passkey gate stays exactly as it is for submit, pay and delete; Visa's terms make the merchant responsible for consents.

## 5. Costs and trade-offs

Pricing for Visa access and CDN plans was not available; items marked *(quote needed)* need a vendor quote.

| Benefit | What we would need | Cost and trade-offs |
|---|---|---|
| Vetted identity, central revocation, declared intent | Access to Visa's agent key directory: likely Visa Developer registration and accepting the TAP product terms. Whether a commercial (acquirer or merchant) relationship is needed is *unconfirmed* | Licence obligations (strict conformance; updates within 6 months of each Visa change); legal review; Visa decides who is trusted, so legitimate unlisted agents look unknown; Mastercard runs a separate directory for Agent Pay, so each network is another integration |
| Replay protection, path binding | Nothing from Visa: changes to our own verifier | About ½-1 day. Agents that send no nonce or don't cover `@path` get no extra protection; a strict mode can withhold the strongest identity credit from them |
| Network-edge enforcement | A CDN or WAF verifying TAP in front of the app | Subscription: Cloudflare's advanced bot features have historically been an Enterprise add-on; whether TAP rules need it is *unconfirmed (quote needed)*. Cloudflare can't proxy `*.vercel.app`, so a custom domain is needed, which changes the passkey RP ID: **every enrolled passkey must be re-enrolled**. A second proxy in front of Vercel adds a hop and configuration. Rules live in the vendor's configuration (lock-in). The passkey gate and tickets stay in the app regardless |
| Incentive to identify | Nothing directly | Real only if trial agents sign with TAP; unknown until Phase 6 |
| Audit evidence | Store signature and tag with the ticket | Small effort and storage |

**Cross-cutting:**
- **Dependency:** verification depends on Visa's directory being reachable. Caching softens it, and failure must mean "unknown agent", never "human".
- **Bias in the trials:** if only Visa-registered agents earn the strongest tier, detection results partly measure who Visa has onboarded.
- **Privacy:** consumer and card identifiers would need a data protection assessment in any production use.
- **Concentration:** a compromise of a central directory affects every merchant at once.

## 6. Options

| Option | Effort | Third-party cost | What it buys |
|---|---|---|---|
| **A. Harden our Web Bot Auth** (nonce and path binding) | About ½-1 day | None | Most of TAP's security gain for signing agents; no vendor, no licence. Optional Phase 8 |
| **B. TAP verifier in the app**, behind `VISA_TAP` | 1-2 days, plus legal review and ongoing updates | Visa Developer registration; directory access *unconfirmed* | Vetted Visa identity and intent signals, if trial agents use TAP |
| **C. Edge verification** (Cloudflare or Akamai) | Days, plus re-enrolling all passkeys | CDN plan, likely an advanced tier *(quote needed)*, plus a custom domain | Network-edge filtering; a production infrastructure decision |

### Option A in detail: what it buys and what it doesn't

In our design a verified signature grants **no extra privileges**: it makes the caller a declared agent, treated the same or more strictly. So the benefit of option A is mainly:
- **Trustworthy attribution.** A captured signature can't be replayed to make other traffic look like a named operator's agent, which keeps the console and the Phase 6 detection figures accurate.
- **No framing of real agents.** Malicious traffic can't be pinned on a vendor.
- **A prerequisite for rewarding verified agents.** If verified agents ever get a smoother path or higher limits, signed identity becomes worth stealing, and replay protection becomes essential.
- **Narrower scope.** A signature that today is valid for any page for up to 24 hours becomes valid for one page, once.
- **Alignment.** It brings Web Bot Auth to the single-use standard TAP and Poppy already require, and the code can later serve a TAP profile.

It doesn't stop replay of the request itself (sessions, CSRF and single-use tickets already do), doesn't protect the body (that needs `Content-Digest`, RFC 9530, an optional step), and gives nothing for agents that don't cooperate. The plan is in [docs/implementation-plan.md](../implementation-plan.md), Phase 8 (optional).

## 7. Option B design: a TAP verifier (not started)

Behind a new flag `VISA_TAP=on`, off by default, like `POPPY`.

1. **Verifier profile** in [lib/webBotAuth.ts](../../lib/webBotAuth.ts), sharing the RFC 9421 parsing:
   - accept `tag` `agent-browser-auth` or `agent-payer-auth`;
   - require `@authority` (checked against `APP_ORIGIN`, as now) and `@path`;
   - require a `nonce`, recorded in the existing replay table (`poppy_jtis`, with a `tap:` key prefix) until the signature expires;
   - bound the lifetime (for example at most 8 minutes, to be confirmed against the specification);
   - Ed25519 first; RSA-PSS-SHA256 only if the specification requires it (`jose` and Web Crypto both support it, so no new dependency).
2. **Key source:** a configured Visa directory URL (`VISA_TAP_DIRECTORY_URL`), fetched with the existing SSRF guard and cached, with the key looked up by `keyid`. In tests, a local directory with our own test keys, allowed only in test mode like Poppy's loopback agents.
3. **Classifier:** a new tier A source `visa_tap` with the agent name from the directory, and the tag logged.
4. **Policy:** no change. A TAP agent is a declared agent; pay still needs the passkey, and an `agent-browser-auth` signature on a pay request is logged as a mismatch.
5. **Tests:** unit tests for parsing and each failure (wrong tag, missing nonce, replayed nonce, expired, wrong authority or path, unknown key); one end-to-end test with a signing test agent.

Effort: about 1-2 days. No migration (it reuses the replay table). It can't be validated live until we have access to Visa's directory.

## 8. Decisions for the owner

1. **Option A (optional Phase 8):** build now, or after the Phase 6 baseline shows how trial agents sign.
2. **Option B:** record as an option (recommended); revisit if trial agents send TAP signatures or a payments use case appears.
3. **Legal review** of Visa's TAP product terms and the sample code licence before any implementation or reuse.
4. **Specification access:** register on Visa Developer to read the full specification, if TAP stays on the roadmap.
5. **Option C:** treat as a production infrastructure decision with bot management and domain choices.
6. **Briefing:** payment-network agent standards strengthen how agents are identified, but bring licence obligations, directory dependence and, at the edge, CDN and domain changes. None replaces proof of the person's approval. We harden our own signature checks now and revisit network standards when there is a payments use case.

## Sources

- [Visa Trusted Agent Protocol repository](https://github.com/visa/trusted-agent-protocol) (README, component READMEs, sample verifier and agent; read, not copied)
- [Visa TAP specification page](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications/) (landing summary only)
- [Visa TAP product terms](https://developer.visa.com/docs/trusted-agent-protocol/product-terms) (dated 2025-10-10)
- [Cloudflare: Securing agentic commerce](https://blog.cloudflare.com/secure-agentic-commerce)
- Secondary explainers, for context only: [Finextra deep dive](https://www.finextra.com/blogposting/29617/deep-dive-the-role-of-visas-trusted-agent-protocol-in-agentic-commerce), [Web Bot Auth vs Visa TAP](https://tomcn.uk/news/2026-10-26-web-bot-auth-vs-visa-tap-mastercard-agent-pay), [Cloudflare and payments companies announcement](https://www.cloudflare.net/news/news-details/2025/Cloudflare-Collaborates-with-Leading-Payments-Companies-to-Secure-and-Enable-Agentic-Commerce/default.aspx)
