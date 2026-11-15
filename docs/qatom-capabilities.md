# Qatom capability evidence

## Current evidence boundary

The Qatom seller guide is a seller setup guide. Its instructions cover publishing catalog items, checking public discovery, and using `agent_checkout` for seller-side launch validation. Those steps are not buyer checkout contract evidence for TrendIE: the guide does not establish that a checkout operation atomically binds an approved amount and currency, nor does it define a receipt shape suitable for settlement verification. The guide also warns that a failed paid call may still charge and that a complete fulfillment response must be retained. TrendIE therefore does not use seller examples as authority to dispatch a buyer purchase.

Primary references reviewed 2026-11-15:

- [TODAQ Micro documentation](https://docs.m.todaq.net/) — official documentation landing page. The linked guide itself was inaccessible to this review; no claims below are attributed to its contents.
- [Qatom seller guide repository](https://github.com/StarwaterHeaven/qatom-seller-guide) — canonical seller setup guide and linked skill. Seller launch checks do not establish buyer-side atomic price binding or a provider receipt contract.
- [Qatom seller guide skill](https://github.com/StarwaterHeaven/qatom-seller-guide/blob/main/skills/qatom-seller-guide/SKILL.md) — setup notes describe the master MCP URL, catalog discovery and seller-side purchase workflows; they do not document a verified buyer OAuth/custom MCP connector authorization contract.

### Auth metadata observed 2026-11-15

At 2026-11-15 09:27:49 UTC, an unauthenticated HTTPS `GET` to the MCP endpoint returned HTTP 401 with `WWW-Authenticate: Bearer realm="TODAQ MCP"` and `resource_metadata="https://mcp.m.todaq.net/.well-known/oauth-protected-resource"`. Direct HTTPS `GET` of that advertised protected-resource metadata document returned resource `https://mcp.m.todaq.net`, authorization server `https://pay.m.todaq.net`, bearer method `header`, scopes `openid`, `profile`, `email`, `twin`, `offline_access`, and resource documentation URL `https://docs.todaq.net/mcp`.

Direct HTTPS `GET` of the advertised authorization server metadata at [pay.m.todaq.net/.well-known/oauth-authorization-server](https://pay.m.todaq.net/.well-known/oauth-authorization-server) returned issuer `https://pay.m.todaq.net`, authorization, token, registration and JWKS endpoints under `/v4/oidc/` (`auth`, `token`, `reg`, `jwks`), response type `code`, grants `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:token-exchange`, PKCE method `S256`, and token endpoint auth methods `client_secret_basic`, `client_secret_post`, `none`. The primary [protected resource metadata](https://mcp.m.todaq.net/.well-known/oauth-protected-resource) and [authorization server metadata](https://pay.m.todaq.net/.well-known/oauth-authorization-server) advertise an OAuth authorization flow with PKCE. This is metadata evidence only; it does not show that a client registered, login/consent succeeded, a token was issued, or the MCP endpoint accepted a token. The documentation URL was not fetched successfully and its contents are not represented here.

Use an existing approved MCP client that supports OAuth PKCE, or request a provider-approved `client_id` and redirect URI. The user completes provider login and consent in that client. Do not invent a client ID, perform dynamic client registration/account creation, or call token exchange endpoints. Supply `QATOM_MCP_TOKEN` to the local probe only after a valid token has been supplied securely through the approved secret mechanism. The secure token request expired without receiving a value; no token was issued or tested by this task.

### Observed locally

The read-only MCP client performs `initialize` and `tools/list`; its capability collector records only a display-sanitized endpoint, timestamp, token presence, access verification, numeric status/auth challenge, tool names, canonical schema fingerprints and read-only annotations. `accessVerified` becomes true only after initialization and `tools/list` succeed; it does not verify identity. Token presence alone does not establish access. It never stores credentials, raw tool descriptions, provider error text or raw responses. It never calls checkout, continuation, catalog fulfillment or account modification. A checkout tool being listed is discovery evidence only. Atomic price/currency binding and receipt guarantee remain `unknown` until provider evidence and the Person 1 authority contract establish them.

Unauthenticated live evidence from 2026-11-14 is recorded in the runbook: initialize returned HTTP 401 with a Bearer challenge and protected-resource metadata URL, with no tool inventory. A further read-only probe was run on 2026-11-15 at 09:25:16.299 UTC using Node 22.23.4 against `https://mcp.m.todaq.net/mcp`. It reported `tokenPresent:false`, `accessVerified:false`, HTTP 401, an auth challenge, unavailable tool inventory (`tools:[]`), and no checkout tool present in the local candidate. Atomic price/currency binding and receipt guarantee remain `unknown`. No credential file was read, no paid tool was called, and no checkout was attempted. HTTP 401 and an unavailable inventory do not establish that Qatom checkout is unsupported.

The probe used local candidate `53215e8` (`npm run qatom:probe`) before this documentation-only update. This evidence describes that candidate's read-only CLI behavior; it does not establish authenticated provider capabilities or live checkout support.

## Authority boundary proposed for Person 1 review

This is a proposed Qatom adapter request/response shape, not an agreed route or server implementation. Use the common principle V1 envelope: explicit version, full server-approved proposal, and an already persisted binding. Do not let an adapter construct authority from caller input.

Request: `{ version: 1, proposal: <full PurchaseProposal>, binding: <ApprovedBinding> }` where the binding is loaded/returned by the gateway and contains immutable authenticated owner and intent identity/version, canonical proposal fingerprint, approval identity, provider/platform, exact seller/item, amount and scale, currency/asset, provider arguments, expiry, persisted provider reference where applicable, and execution ID.

Response: `{ version: 1, executionId, status: "succeeded" | "failed" | "unknown" | "pending" | "blocked", checkedResult?, providerReference?, reasonCode? }`. `succeeded` requires a checked provider result and actual receipt evidence matching the binding. Ambiguous dispatch/persistence remains `unknown`; never blind-retry it. This shape needs Person 1 agreement and must not be read as an implemented server contract.

## Buyer connector setup evidence and remaining gate

The metadata advertises PKCE OAuth, bearer-header transport, an issuer, endpoints and scopes. It does not verify usable client registration, approved redirect URI, which scopes a buyer needs, the token's effective audience, user login/consent, buyer access, authenticated MCP tool schemas or an accepted bearer token. Do not paste a login, token or PIN into chat. If a token is later supplied securely, use the exact environment-variable name `QATOM_MCP_TOKEN`; presence alone is not authenticated tool-schema evidence.

Before enabling buyer execution, obtain authenticated sanitized tool inventory, checkout schema, proof the checkout operation binds the approved exact price and currency atomically, supported receipt semantics, and agreement on the persisted authority contract. Spend ceiling remains zero.
