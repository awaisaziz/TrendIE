# MVP gaps, owners, and integration sequence

**Reviewed against:** `PRD.md`, `Division.md`, `origin/develop` at `dbfac42`, the current `nasar-frontend` work including AAT runner `165038c`, and PRs #10–#12 as observed on 2026-11-15. `main` remains at the line through PR #8 (`0c08845`).

**Owner mapping:** Person 1 — Awais; Persons 2, 3, and 4 — Om/Tirth; Person 5 — Nasar.

**Coordination note (2026-11-15):** Om directed temporary cross-owner implementation coordination
to reduce duplicate edits. Original role assignments and acceptance ownership remain unchanged;
this is not evidence that owners accepted the shared authority contract or that a stage is complete.
Awais retains deployment authority. The candidate integration preserves gateway source, but the
new GOAT authority runtime remains HOLD pending review and verified binding behavior.

## MVP acceptance target

PRD Section 12 requires an AI purchasing agent to discover a product, propose a transaction, and execute it through a security gateway integrated with GOAT or Qatom; the system must block prompt-injection-driven unauthorized purchases and record evidence. PRD Section 9 additionally calls for a real GOAT testnet transaction and an authenticated Qatom checkout where supported. Treat Qatom as unsupported only after checking its real capability and documenting that evidence.

Escrow is a later optional stretch after the protected core works. A controlled attack test must not send an actual unauthorized payment: demonstrate the vulnerable agent's changed proposal/action in an isolated harness, then show the protected gateway rejecting the same malicious input.

## Current evidence and limits

- The Person 5 console, intent form, decision display, and transient bounded PDF upload/extraction-to-verification are in the merged application. PDF inspection is **not** a completed invoice-to-payment flow; the console does not execute provider payments.
- The current Person 5 branch adds a same-origin controlled-comparison endpoint and UI with attack/compliant-proposal cases over the same malicious listing. The server calls PR #11's `runControlledComparison` and `validateEvidence` using fixed task, discovery, fixture-model, and local-policy inputs, then returns an allowlisted projection with proposal-linked listing hashes and text spans. It preserves `simulation: true`, `executed: false`, `providerDispatch: false`, and `NOT_SETTLED`. It does not call the real Gateway, provider, wallet, or payment system, and does not close an MVP gap.
- The repository records live Gateway/PostgreSQL PDF and replay demo runs. The replay demo checks approval consumption, duplicate-consume rejection, intent exhaustion, and expiry. These establish gateway authorization behavior, not provider settlement.
- G-06 is **partially closed**: the current frontend now removes the false “funds stolen”/“blocked” paired-attack panel and calls PR #11's controlled runner with a fixture model and local policy. The fixture comparison simulates an action; it does not call the real gateway for that comparison or dispatch a clean payment. Other demo/script claims still require review.
- G-07 is recorded as **closed on develop** for PDF extraction/inspection reaching Gateway verification and audit evidence. It does not close the broader invoice-to-provider-payment flow.
- G-09 is **partially closed**: replay behavior has live Gateway/PostgreSQL evidence, while provider settlement remains unverified and some demo wording still overclaims.
- The team reports PostgreSQL is available on a Mac. A dedicated TrendIE database/schema and matching gateway/frontend environment are still needed. Docker is optional when the gateway can reach PostgreSQL. `localhost` refers to the gateway machine: a Windows-hosted gateway cannot use `127.0.0.1` to reach a Mac database. In this workspace, the Docker Compose attempt failed with a read-only container-storage error; that does not establish that the reported Mac PostgreSQL server is unavailable.
- **Agent-reported checks on `9133094`, Node 22.23.4:** 114 root tests and 83 gateway unit tests passed; root and gateway typecheck/lint passed. These checks do not prove isolated PostgreSQL integration, provider settlement, or complete end-to-end acceptance. They were reported by the agent, not rerun for this document.
- No real provider payment or receipt is established by an approval, approval consumption, audit-chain validity, fixture, printed result, or mocked adapter response.

## Remaining feature gates

| Feature | Status | Accountable owner | Remaining acceptance |
|---|---|---|---|
| F-001 Trusted intent | Partial | Person 1 / Awais; Person 5 / Nasar UI contribution | Store and verify trusted owner/constraints in the dedicated database under the agreed shared schema. |
| F-002 Verification/authorization | Partial | Person 1 / Awais | Bind exact, versioned proposal to an authenticated owner and intent; enforce expiry, single use, replay, and concurrency through the gateway. |
| F-003 Gateway interception | Partial | Person 1 / Awais; Persons 2–3 / Om/Tirth adapters | Adapters receive and enforce the persisted gateway binding; no local adapter code may construct authority from caller input. Prove unauthorized requests stop before provider dispatch. |
| F-004 Inspection | Partial | Person 4 / Om/Tirth; Person 5 / Nasar upload/display | The frontend displays fixture listing source spans, content hash, and proposal fingerprint; still link clean/malicious listing and PDF findings to the exact persisted proposal/decision and document scanner limits. |
| F-005 Attack comparison | Partial | Person 4 / Om/Tirth; Person 5 / Nasar demo integration | The frontend now presents PR #11 runner output for fixed attack/clean fixtures and the local policy result. Still obtain final adversarial clearance, demonstrate the protected Gateway rejection with persisted evidence, and complete a legitimate provider-backed purchase. No unsafe on-chain attack is needed. |
| F-006 GOAT payment | Blocked | Person 2 / Om/Tirth; Person 1 / Awais gateway | Persisted binding, checkpoints/recovery, isolated wallet, separate numeric spend authorization, one bounded Testnet3 payment, checked receipt, and persisted outcome. |
| F-007 Qatom checkout | Blocked | Person 3 / Om/Tirth; Person 1 / Awais gateway | Authenticated MCP/tool evidence, checkout schema, atomic exact-price/currency guarantee in the checkout operation, gateway-authorized execution, supported verified receipt, and documented limitations. |
| F-008 Audit/outcome records | Partial | Person 1 / Awais | Durable linked intent, proposal, findings, decision, execution identity, provider result, and outcome with safe recovery from uncertainty. |
| F-009 Dashboard/history | Partial | Person 5 / Nasar; Person 1 / Awais and provider owners | Owner-scoped reloadable history, payment lifecycle, actual provider receipts, and distinct pending/unknown states. Requires approved read APIs and provider result facts. |
| F-010 Human review | Blocked | Person 1 / Awais API; Person 5 / Nasar UI | Authenticated reviewer identity, owner-scoped review queue/read API, authorized resolution controls, audit record, and proof unresolved review cannot execute. |
| F-013 Integrated demo readiness | Blocked | Person 5 / Nasar, with Persons 1–4 / Awais, Om/Tirth | The fixture comparison improves truthful demo presentation but is not an integrated run. One current-revision environment must run the protected flow, attack evidence, legitimate provider payment, supported Qatom path, and persisted audit/outcome view. |

F-011 escrow and F-012 delivery verification remain Stage 6/stretch work and do not block the core MVP.

## Shared contract and adapter binding — first priority

Person 1 / Awais and the adapter owners / Om-Tirth must agree one versioned contract before frontend/platform mappings are implemented. The trusted binding must include:

- authenticated owner identity and trusted intent ID/version;
- platform/provider and chain/network;
- exact seller, item/product, amount with scale, asset/currency, destination/recipient, and provider arguments;
- canonical proposal fingerprint, approval identity, expiry, and execution identity.

The gateway must persist and return the authoritative binding. Adapters must receive that persisted binding and verify it; they must not assemble or infer authority locally from proposal, spend-limit, or agent-supplied fields.

The gateway flow must atomically claim a single-use approval and persist an execution before provider dispatch. GOAT needs durable signed/broadcast checkpoints and owner-scoped reconciliation. Provider outcomes must be checked and persisted; ambiguous dispatch or persistence failures remain `unknown` and must not trigger a blind retry.

## Ownership and dependencies

### Person 1 — Awais, security and backend

- Finalize the shared proposal/approval/execution/outcome contract with Persons 2–4 and the frontend.
- Persist the authoritative owner/intent-version/platform/chain binding; provide atomic claim/consume and approved history, execution-recovery, and review-queue APIs.
- Make the audit-safe test reset compatible with append-only protections; run isolated PostgreSQL migrations and endpoint, replay, concurrency, and recovery tests against a dedicated database.

### Person 2 — GOAT, Om/Tirth

- Replace locally constructed authority with the persisted gateway binding.
- Persist monotonic signed/broadcast checkpoints, checked outcomes, and safe uncertain-outcome reconciliation.
- Obtain a separate numeric testnet spend authorization and isolated test wallet; perform one bounded Testnet3 payment and verify/persist its receipt.
- Keep escrow after the protected core as a separate stretch gate.

### Person 3 — Qatom, Om/Tirth

- Verify authenticated MCP access and actual read/write tool schemas.
- Establish whether checkout atomically binds approved price and currency in the same operation; a separate quote is insufficient.
- Implement gateway-authorized checkout/continuation and conservatively handle retries and unknown results.
- Validate and persist a supported provider receipt; document unsupported capabilities. Credentials/token configuration alone is not checkout evidence.

### Person 4 — Agent, attack testing, and PDF, Om/Tirth

- Run a reproducible controlled unprotected-agent attack and protected comparison using the same malicious input.
- Capture the unprotected agent's changed proposal/action and the protected gateway rejection without sending an actual unauthorized payment.
- Maintain clean/malicious listing and hidden-text PDF evidence, and link inspection findings to the exact proposal/decision.
- Correct demo text that currently presents a printed transfer, consumed approval, or audit check as executed payment/settlement.

### Person 5 — Nasar, frontend and system integration

- After contract approval, align frontend proposal types/forms and platform-specific amount/scale handling; do not invent compatibility mappings before then.
- After Person 1 publishes the authenticated history/review/execution APIs, add owner-scoped history, review controls, outcome states, and actual receipt display. Keep unresolved reviews non-executable and approval distinct from payment success.
- Connect provider and attack evidence into the single demo, run current-revision browser/integration checks against the isolated Gateway/PostgreSQL environment, and update docs from verified outcomes.
- Pagination is a possible UI enhancement; it is not a current PRD acceptance gate.

## Integration sequence

1. Agree and publish the complete versioned contract, including authenticated owner, intent version, platform, chain, amount/scale, asset, destination/item, provider arguments, fingerprint, and result states.
2. Implement and test persisted gateway binding, atomic approval claim, execution records, audit linkage, review reads, checkpoints, and recovery against the isolated database.
3. Update GOAT and Qatom adapters to consume only the gateway's persisted binding; verify provider-specific auth, price/amount protection, retry, receipt, and unknown semantics.
4. Connect the agent, PDF/listing inspection, gateway, adapters, persisted outcomes, and Person 5 UI. Exercise fixtures and mocked provider boundaries first; label them as such.
5. Under separate numeric authorization, execute one bounded real GOAT testnet payment and an authenticated Qatom checkout where supported. Verify provider receipts and persisted outcomes; do not send a real unauthorized attack payment.
6. Rehearse the demo and update feature statuses only from current-revision evidence.

## Immediate parallel work

- Person 1 / Awais and adapter owners / Om-Tirth can negotiate the shared contract while the isolated database and safe reset are prepared.
- Person 4 / Om-Tirth can build/record the controlled attack harness and clean/malicious fixtures without waiting for live provider execution.
- Person 5 / Nasar can correct current demo labels, prepare UI state designs, and set up the frontend against the agreed reachable PostgreSQL/Gateway environment. Final API wiring for history/review/receipts waits on approved contracts and endpoints.
- Provider owners can verify authentication/tool schemas and obtain numeric spend approvals in parallel with gateway contract work; do not enable or call paid execution until the required controls are present.
