// /llms.txt and /agents.md (FR41, design.md 6). Served only when AGENT_HINTS=on,
// the comparison variant; baseline runs have no hints. The wording describes the
// site and what the account holder does, in declarative sentences; it never tells
// the reader what to do, and the content lint checks it (FR25, control P1).

export const LLMS_TXT = `# DemoGov Permits

> A fictional permit service, built as a prototype to test how websites work with people and the automated assistants acting for them. It holds demo data only and is not a real government service.

An account holder applies for a Community Event Permit in steps: sign in, start a draft, add event details, attach supporting documents, review, submit a legal declaration, and pay a mock 50 USD fee. Submitting, paying, deleting an application and changing recovery details are approved by the account holder with a passkey. Recovery email and phone changes are made by the account holder only; requests from automated assistants are refused.

## Details

- [Agents guide](/agents.md): the journey, the API routes, how approval by the account holder works, and the MCP server.

## Protocols

- [MCP server](/mcp): Streamable HTTP, OAuth 2.1 with dynamic client registration ([metadata](/.well-known/oauth-protected-resource/mcp)).
`;

export const AGENTS_MD = `# DemoGov Permits: notes for automated assistants

DemoGov Permits is a fictional permit service and a research prototype. It holds demo data only and is not a real government service.

## The journey

1. Sign in (\`/login\`): password or passkey.
2. Start a draft application.
3. Add the event details: title, date (YYYY-MM-DD), expected attendance and location.
4. Attach supporting documents (file name, type and size are recorded; no content is stored).
5. Review the application.
6. Submit the legal declaration. **The account holder approves this step.**
7. Pay the mock 50 USD fee. **The account holder approves this step.**

Deleting an application is also approved by the account holder. Changing the recovery email or phone is done by the account holder after signing in; requests from automated assistants for that change are refused.

## How approval works

A step that needs the account holder returns a response with \`status: "requires_human_approval"\`. On the web API it is an HTTP error (403 by default) with a JSON body; on the web pages it is a panel with a link and a QR code. The response contains:

- \`ticket_id\`: the approval ticket.
- \`continue_url\`: the approval page for the account holder, who approves there with their passkey (or on the phone page at \`/device/<user id>\`).
- \`message_for_user\`: a sentence that can be shown to the account holder.
- \`resume.poll\`: \`GET /api/hitl/<ticket_id>\` returns the ticket state: \`pending\`, \`approved\`, \`rejected\`, \`expired\` or \`consumed\`.
- \`resume.retry_with_header\`: once the ticket is \`approved\`, the same request sent again with the \`X-HITL-Ticket: <ticket_id>\` header is carried out once.

A ticket covers exactly the request that created it, lasts at most 10 minutes, works once, and belongs to the session that requested it. A passkey prompt on the approval page is answered by the account holder's own device.

## Web API

All routes take JSON or form bodies. Requests that change data carry the session cookie, an \`Origin\` header for this site, and the \`X-CSRF-Token\` header with the value of the \`csrf-token\` meta tag on any signed-in page.

| Method | Route | Step |
|---|---|---|
| POST | \`/api/applications\` | Start a draft (\`title\`) |
| POST | \`/api/applications/<id>/details\` | Event details (\`date\`, \`attendance\`, \`location\`) |
| POST | \`/api/applications/<id>/documents\` | Attach a document (\`name\`, \`type\`, \`size\`) |
| POST | \`/api/applications/<id>/submit\` | Submit the declaration (\`declaration: "on"\`), approved by the account holder |
| POST | \`/api/applications/<id>/pay\` | Pay the mock fee, approved by the account holder |
| POST | \`/api/applications/<id>/delete\` | Delete, approved by the account holder |
| POST | \`/api/account/contact\` | Recovery contact change, account holder only |

## Identifying an assistant

The site records what kind of client each request comes from. An assistant can identify itself with the "I'm an AI agent acting for someone" box at sign-in, an \`X-Agent\` header, an HTTP Message Signature (Web Bot Auth), or an MCP access token. Identification does not change which steps the account holder approves.

## MCP

The MCP server is at \`/mcp\` (Streamable HTTP, protocol revisions 2026-07-28 and 2025-11-25). It uses OAuth 2.1 with dynamic client registration; the metadata is at \`/.well-known/oauth-protected-resource/mcp\`. The account holder signs in and allows access on a consent page. Tools follow the same journey and the same approval rules; a step that needs the account holder returns \`requires_human_approval\` with the ticket, or asks the client to open the approval link when the client supports URL elicitation.
`;
