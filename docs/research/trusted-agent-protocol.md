# Visa Trusted Agent Protocol (TAP): fit with the prototype

Research note, 2026-11-25, branch `research/trusted-agent-protocol`. It asks whether Visa's Trusted Agent Protocol can be added to DemoGov Permits, and what it would add. It is a research input, not a decision; decisions for the owner are at the end.

Sources and their limits: Visa's specification page on developer.visa.com showed only a landing summary, not the normative text, so the details below come from Visa's GitHub reference implementation (not normative), Visa's product terms, and Cloudflare's write-up. Items marked *(unconfirmed)* need checking against the full specification, which likely needs a Visa Developer account.

## 1. Summary

- **What it is:** Visa's way for an AI shopping agent to prove who it is to a merchant on every request, using **RFC 9421 HTTP Message Signatures**, the same base as Web Bot Auth, which we already verify. It adds a `tag` saying what the agent is doing (`agent-browser-auth` for browsing, `agent-payer-auth` for paying), a required `nonce` against replay, and agent keys published in a **Visa-operated directory** of Visa-registered agents. It can also carry consumer and payment identifiers (for example a Payment Account Reference or loyalty number) to prefill checkout.
- **Can it be incorporated? Yes, technically, and cheaply:** it is a variant of our existing Web Bot Auth verifier, about 1-2 days behind a flag. It would add one more tier A identity source ("Visa-registered agent").
- **But its value here is limited, and there are blockers:**
  - TAP is built for **card commerce**. Our journey has only a mock fee.
  - TAP proves **which agent** is calling and that it says it is browsing or paying. It does **not** prove that the person approved a specific action, so our passkey gate is still needed. The Visa terms leave collecting consent to the merchant.
  - **Live use needs Visa access:** the production key directory, its URL and format, and agent registration are not public.
  - **The terms are restrictive:** implementing the specification is licensed on condition of "strict conformance" to the latest version, with updates within six months of each Visa update. The sample code's licence is ambiguous (MIT-style file headers, but `LICENSE.md` points to Visa's Developer Center terms). This needs legal review before we use either.
- **Recommendation:** don't build it now. Record it as a compatible option. Revisit if the service ever takes real payments or a payments partner asks for it, after legal review and Visa specification access. If the owner wants it for the comparison anyway, build the verifier only, behind a flag, tested with our own test keys (section 5).

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

**Would add:**
- A recognised commercial agent identity (Visa-registered) as **tier A evidence**, with the same effect as Web Bot Auth: the request is classified `declared_agent`, logged, and shown in the console.
- An extra signal at the payment step: an `agent-payer-auth` signature means the agent claims it is paying, which can be recorded beside the ticket.
- Coverage for agents that sign with TAP but not with plain Web Bot Auth, if Visa-registered agents appear in the trials.

**Wouldn't add:**
- **Proof of the person's approval.** The passkey gate stays exactly as it is for submit, pay and delete. Visa's own terms make the merchant responsible for consents.
- **Data protection.** We would *not* accept consumer or payment identifiers from query parameters. Our journey doesn't need them, and accepting personal data in URLs would add privacy risk.

## 5. If we build it: design (not started)

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

## 6. Decisions for the owner

1. **Build now, or record as an option?** Recommendation: record it, given the commerce focus, closed key directory and licence conditions.
2. **Legal review** of Visa's TAP product terms and the sample code licence before any implementation or reuse.
3. **Specification access:** register on Visa Developer to read the full specification, if TAP stays on the roadmap.
4. **Briefing:** mention TAP as an emerging payments-industry standard that our design is compatible with (same RFC 9421 base as our Web Bot Auth support), noting it identifies the agent but doesn't replace proof of the person's approval.

## Sources

- [Visa Trusted Agent Protocol repository](https://github.com/visa/trusted-agent-protocol) (README, component READMEs, sample verifier and agent; read, not copied)
- [Visa TAP specification page](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications/) (landing summary only)
- [Visa TAP product terms](https://developer.visa.com/docs/trusted-agent-protocol/product-terms) (dated 2025-10-10)
- [Cloudflare: Securing agentic commerce](https://blog.cloudflare.com/secure-agentic-commerce)
- Secondary explainers, for context only: [Finextra deep dive](https://www.finextra.com/blogposting/29617/deep-dive-the-role-of-visas-trusted-agent-protocol-in-agentic-commerce), [Web Bot Auth vs Visa TAP](https://tomcn.uk/news/2026-10-26-web-bot-auth-vs-visa-tap-mastercard-agent-pay), [Cloudflare and payments companies announcement](https://www.cloudflare.net/news/news-details/2025/Cloudflare-Collaborates-with-Leading-Payments-Companies-to-Secure-and-Enable-Agentic-Commerce/default.aspx)
