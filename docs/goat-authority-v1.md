# Proposed GOAT HTTP authority V1

This is a client proposal for Awais to review; it does not establish server support, authentication, persistence, or acceptance. The client remains fail-closed unless explicitly configured `mode: "active"`. A legacy `200 {"executionId":"..."}` is denied.

All responses are bounded to 64,000 bytes, strict JSON objects, and fetched with a 5 second default abort timeout and redirect rejection. Clients send no retries. A claim timeout is ambiguous: do not dispatch or automatically retry. If the execution ID is known, use owner-scoped reconciliation. If the claim acknowledgement was lost before an ID was received, recovery by approval reference is a remaining server-contract requirement; this client does not implement that lookup. Never retry a claim automatically. All endpoint paths below are proposed.

## Claim

`POST /v1/goat/approvals/{approvalReference}/claim`

Request: `{ "version": 1, "kind": "claim", "callerOwnerId": "user_1", "proposal": <full persisted PurchaseProposal>, "fingerprint": "<64 lowercase hex>", "spendAuthorization": { "ownerId": "user_1", "authorizationId": "auth_1", "maxAmountWei": "1000" } }`.

The response must be exactly `{ "version": 1, "kind": "claim", "status": "claimed", "executionId": "exec_1", "proposal": <full persisted PurchaseProposal>, "binding": <binding> }`. Binding is exactly `{ "platform":"goat", "fingerprint":"<original fingerprint>", "ownerId":"user_1", "intentId":"intent_1", "intentVersion":1, "sender":"0x...", "destination":"0x...", "asset":"BTC", "chainId":48816, "amount":"1000", "scale":18, "expiresAt":<epoch milliseconds>, "spendAuthorizationId":"auth_1", "spendCeilingWei":"1000" }`. Fields are authoritative server values, not defaults. Server must authenticate the principal independently; client-provided callerOwnerId is not authentication. Proposal arguments for GOAT are exactly `{ "recipient":"0x..." }`.

## Checkpoint and outcome

`PUT /v1/goat/executions/{executionId}/checkpoint` request `{ "version":1, "kind":"checkpoint", "executionId":"exec_1", "phase":"signed|broadcast", "txHash":"0x<64 hex>" }`. Durable acknowledgement must be exactly `{ "version":1, "kind":"checkpoint_ack", "status":"persisted", "executionId":"exec_1", "phase":"signed|broadcast", "txHash":"0x<same hash>" }`. Preserve both phase and hash monotonically.

`PUT /v1/goat/executions/{executionId}/outcome` request `{ "version":1, "kind":"outcome", "executionId":"exec_1", "status":"blocked|pending|succeeded|failed|unknown", "providerReference":"optional", "reason":"optional", "evidence":"optional" }`. A checked acknowledgement must be exactly `{ "version":1, "kind":"outcome_ack", "status":"persisted", "executionId":"exec_1", "resultStatus":"<same status>", "providerReference":"<same reference, or null when absent>" }`. Evidence must be supplied from checked provider facts; the client invents no recorded timestamp.

## Read-only reconciliation

`GET /v1/goat/executions/{executionId}?ownerId={ownerId}` returns exactly `{ "version":1, "kind":"reconciliation", "executionId":"exec_1", "ownerId":"user_1", "proposal":<full persisted PurchaseProposal>, "binding":<full binding>, "phase":"signed|broadcast", "txHash":"0x<64 hex>" }`. Server must enforce owner scope. This lookup only informs receipt checks; it never signs, broadcasts, or resubmits.

Until the server implements and independently verifies these contracts, all examples are proposed wire shapes for fake-fetch tests only.


Synthetic route probe evidence at pinned gateway source `fcd8df68641b3550f392aff65f5c20067200585c`: [report](evidence/2026-11-15-goat-authority-fcd8df6.md) and [frozen mocked probe](evidence/2026-11-15-goat-authority-fcd8df6.test.ts.txt). The probe records mocked Fastify route behavior only; it is not PostgreSQL or live-service evidence.
