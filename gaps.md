# Integration and execution gaps

**Reviewed against:** `PRD.md`, `Division.md`, `feature_list.json`, and `origin/develop` at `9133094` (merged to `main` at `0c08845`)
**Branch:** `codex/p5-mvp-status`, based on latest `origin/develop`
**Review type:** source and documentation review. The repository records live Gateway/PostgreSQL evidence for PDF and replay demos below; those demos were not rerun for this status reconciliation. No real provider checkout or payment was performed for this review.

This file distinguishes implementation present in source from behavior demonstrated end to end. A route, adapter, fixture, or mock test is not evidence that the full protected purchase flow works against PostgreSQL and a provider.

## Current result

The repository contains substantial gateway, agent, inspection, adapter, dashboard, and demo code. It does **not yet demonstrate the PRD's complete purchase flow**: discover a real listing, inspect its content, produce a proposal, authorize it against a trusted intent, execute it through GOAT or Qatom, verify the provider result, persist the outcome, and display that evidence after reload.

The remaining acceptance blockers are:

1. The shared proposal, authorization, and execution contracts are not aligned across the frontend, gateway, and adapters.
2. Qatom checkout is not implemented through the gateway; its HTTP authority remains fail-closed.
3. GOAT has an active-mode HTTP client in source, but its binding and recovery behavior do not yet meet the server-owned durable authority contract, and no real transaction has been verified.
4. The frontend does not execute payments or display persisted decision, inspection, and payment outcomes.
5. PostgreSQL-backed demo evidence is recorded for PDF and replay scenarios, but the isolated current-revision integration suite and safe audit-preserving reset remain incomplete. A team update reports PostgreSQL is running on a Mac and a dedicated TrendIE database/schema is still needed; that endpoint was not reachable from this Windows workspace. The local Docker Compose attempt here failed because Docker reported its storage filesystem as read-only. Docker is optional when the gateway can reach an existing PostgreSQL instance.
6. Several demos use mocked authorities, signers, transactions, or manually constructed decisions while printing stronger success claims.

## Gap register

### G-01 — Shared contracts are not aligned

**Priority:** P0  
**Accountable owner:** Person 1 / Awais  
**Supporting owners:** Person 2 / GOAT, Person 3 / Qatom, Person 4 / agent proposal contract, Person 5 / Nasar frontend contract

- `packages/contracts` defines a versioned proposal with `ownerId`, `intentVersion`, `platform`, `itemId`, `sellerId`, scaled integer `money`, `asset`, `chain`, and `providerArgs`.
- The gateway and web BFF still use a legacy proposal shape: `intentId`, seller, product, amount, currency, destination, and source reference.
- The intent and approval API does not yet expose the same versioned, provider-specific binding expected by QPE adapters.
- The web UI supports only demo USDC/USDT with six decimal places and now states this limitation in the authorization form. Qatom uses USD-TDN with scale 3; GOAT native transfers use a different asset and scale. The UI cannot currently register the platform-specific intents required by both integrations.
- Approval, execution result, continuation, checkpoint, and reconciliation contracts still differ between gateway routes and the GOAT/Qatom authority ports.

**Needed to close:** agree and version one intent/proposal/approval/result contract; add compatibility tests across the gateway, frontend BFF, agent, and adapters; remove legacy coercions and unsupported placeholder mappings.

### G-02 — PostgreSQL is provisionable but not verified here

**Priority:** P0 for integrated acceptance  
**Accountable owner:** Person 1 / Awais (PostgreSQL and gateway tests)  
**Supporting owner:** Person 5 / Nasar (frontend-to-gateway integration and runbook)

- The PRD specifies PostgreSQL. The repository now includes `gateway/docker-compose.yml` and root `db:up`, `db:down`, `db:migrate`, and `db:seed` scripts.
- A team update reports PostgreSQL is already running on a Mac, but a dedicated TrendIE database, application schema, and matching gateway/frontend environment files remain to be configured.
- From this Windows workspace, no PostgreSQL service was reachable. `npm run db:up` was attempted, but Docker failed to create the container with `read-only file system` while writing containerd snapshot metadata. Docker itself is not required when the gateway can reach an existing PostgreSQL server.
- The repository records live PostgreSQL-backed PDF and replay demo runs on develop. A safe, isolated current-revision database test run and frontend-to-database acceptance flow still need to be repeated and recorded.
- Gateway tests require an explicitly isolated PostgreSQL test database. Existing fixtures truncate the audit log, which conflicts with the audit protections; a safe reset strategy is still required before running the database suite.
- `docs/team-setup-guide.md` supports either the optional Compose database or an existing PostgreSQL host and references the root `npm run db:migrate` script. The reported Mac database is not yet configured/reachable from this gateway workspace.

**Needed to close:** provision a dedicated disposable TrendIE database on the available PostgreSQL host; ensure the gateway process can reach it (remember `localhost` is relative to the gateway host); configure matching local environment files; repair the audit-safe test reset; run migrations and seed only against that dedicated database; execute gateway and frontend endpoint tests and record the exact revision/results.

### G-03 — Gateway approval is not yet a complete shared adapter authority

**Priority:** P0  
**Accountable owner:** Person 1 / Awais  
**Supporting owners:** Person 2 / GOAT and Person 3 / Qatom (adapter consumers)

- Gateway verification, HMAC approval creation, expiry checks, approval consumption, and payment-result routes exist in source.
- The active GOAT HTTP client can call the legacy approval-consume endpoint and post result/checkpoint data. Its current binding is assembled client-side from the submitted proposal and spend-authorization input after consume; it is not fetched as an authoritative persisted binding from the gateway.
- The active GOAT client uses a locally derived expiry and a fallback sender address when none is configured. Those are not a substitute for gateway-owned identity, sender, amount, chain, provider arguments, and expiry binding.
- `getExecutionForReconciliation` still returns no record. The gateway execution read does not provide the complete owner-scoped proposal and binding needed by the adapter to reconcile uncertain writes.
- The Qatom HTTP authority still denies execution and rejects outcome/continuation persistence as unsupported.
- The frontend verification routes deliberately do not expose or consume approval references, and do not invoke either adapter.

**Needed to close:** implement server-owned claim/binding retrieval, atomic single-use consumption, durable execution claim, monotonic signed/broadcast checkpoints, checked outcome persistence, owner-scoped reconciliation reads, and Qatom continuation; prove the same exact proposal is bound through each step.

### G-04 — Qatom is read-only; checkout and receipt flow are missing

**Priority:** P0  
**Accountable owner:** Person 3 / Om (Qatom integration)  
**Supporting owner:** Person 1 / Awais (gateway authorization and persistence)

- The MCP client permits read-only catalog search when the provider marks the tool read-only.
- Write-capable tools and continuation are blocked by the client; the Qatom gateway authority denies claims.
- No authenticated provider tool/schema evidence or supported checkout result/receipt is recorded.
- Atomic price binding to the exact approved amount and currency is not implemented or verified. A separate quote followed by checkout would not prove this property.
- Local fake transport/capability tests do not establish a real Qatom checkout.

**Needed to close:** verify provider authentication and the actual checkout schema; obtain a same-operation atomic price guarantee; implement server-authorized checkout and conservative retries; verify a supported receipt against item, seller, amount, currency, and provider evidence; record any unsupported capability clearly.

### G-05 — GOAT payment acceptance is not demonstrated

**Priority:** P0  
**Accountable owner:** Person 2 / GOAT  
**Supporting owner:** Person 1 / Awais (gateway authority and persistence)

- The AgentKit/viem adapter contains validation, chain checks, spend ceilings, receipt verification, and uncertain-outcome handling.
- The active HTTP authority has mocked-fetch tests, but has not been verified against the running gateway and PostgreSQL.
- The gateway claim/binding contract is not yet sufficiently aligned with the adapter's trusted binding and reconciliation requirements.
- No configured test wallet, separately authorized numeric testnet ceiling, real transaction, or checked receipt is recorded.
- `scripts/demo-goat-live.mjs` reads the public GOAT RPC's chain ID, block height, and an address balance. It then uses a fake authority and a fake signer that throws; it does not broadcast a transaction.
- The clean-purchase branch in `scripts/demo-attack.mjs` uses fake authority, fake signer, mock transaction hash, and mock receipt data.

**Needed to close:** complete and review the trusted gateway authority; provision an isolated test wallet and obtain a separate numeric spend authorization; run one bounded Testnet3 payment; verify the receipt and persisted outcome; retain uncertainty if dispatch or persistence is ambiguous.

### G-06 — Agent attack demo is not yet equivalent to the PRD demonstration

**Priority:** P0  
**Status:** **Partially closed on `develop`**
**Accountable owner:** Person 4 / Om & Tirth (agent and attack testing)  
**Supporting owners:** Person 1 / Awais (gateway decision), Person 5 / Nasar (playground integration)

- `scripts/demo-attack.mjs` submits the protected malicious proposal to the live gateway and verifies its rejection. Separately, the Person 5 branch now calls PR #11's controlled runner with fixed fixture ports and a local policy; that UI flow does not call the actual Gateway.
- The controlled runner uses a fixture model to produce the vulnerable proposal/action; its protected decision comes from a local fixture policy. It does not call the real gateway or execute a transfer. The clean path in `scripts/demo-attack.mjs` consumes a gateway approval, but does not dispatch a provider payment. The script header and final summary still overstate execution/settlement.
- The Person 5 branch removed the Web Console's former “Funds Stolen!”/“Blocked 0 satoshis” assertions. The comparison now reports a simulated action and `NOT_SETTLED`.
- The separate protected leg in `scripts/demo-attack.mjs` provides gateway-policy evidence; the new UI flow proves no gateway behavior. Neither provides a successful controlled unprotected-agent attack or a legitimate provider payment. No funds should be described as stolen or settled by these fixtures.

**Needed to close:** obtain final adversarial review of the integrated controlled harness; run the protected proposal through the live gateway and retain decision/audit evidence. A separate provider-backed legitimate payment is required for F-005/F-013 acceptance.

### G-07 — PDF extraction and verification evidence

**Priority:** P0  
**Status:** **Closed on `develop`**  
**Accountable owner:** Person 4 / Om & Tirth (inspection and PDF extraction)  
**Supporting owners:** Person 1 / Awais (persisted evidence), Person 5 / Nasar (upload and display)

- A hidden-text adversarial PDF fixture exists (`services/pdf-inspection/fixtures/adversarial-invoice.pdf`).
- **Resolved:** `scripts/demo-pdf-attack.mjs` now runs PyMuPDF extraction (`render_mode=3` stream), registers an immutable Intent on the live Gateway (`POST /intents`), and submits the extracted proposal and heuristic inspection payload directly to `POST /verify` on the live Gateway.
- The live Gateway deterministically halts the attack with `REJECT [AMOUNT_EXCEEDS_MAX, INJECTION_FLAGGED]`.
- The attack rejection is cryptographically appended and verified in the PostgreSQL audit ledger (`GET /audit/chain/verify`). Testable via `npm run demo:pdf`.
- **UI Progress:** Person 5 added transient bounded upload, extraction, and verification directly in the web console (`PdfUploadPanel.tsx`).

### G-08 — Decisions, outcomes, and human review are not fully available in the UI

**Priority:** P0 for outcome display; P1 for full dashboard/review  
**Accountable owner:** Person 5 / Nasar  
**Supporting owners:** Person 1 / Awais (audit/review APIs), Person 2 / GOAT and Person 3 / Qatom (provider results)

- The console displays authorization details, proposal comparison, gateway decision, and scanner findings for the current session.
- A verification decision is displayed as **not executed**; the UI does not consume approval or call an adapter.
- Session decisions are lost on reload. The persisted audit view currently focuses on intent-created events; it does not reconstruct proposal, inspection, decision, and execution records as a coherent history.
- The audit-chain verification endpoint/UI can check chain integrity, but that is not a transaction history or proof that every required outcome is present.
- A gateway review-resolution POST exists for dashboard/admin service roles, but it does not establish an authenticated reviewer identity or owner-scoped review queue; the console has no review controls.
- Payment states such as `submitting`, `pending`, `pending_approval`, `succeeded`, `failed`, and `unknown`, plus provider receipts/references, are not presented as a connected lifecycle in the console.
- Person 5's UI now labels current decisions as session-only and explains that persisted proposal, inspection, review, and payment history is unavailable. `/audit` events do not carry a usable intent binding for verified decisions, and the gateway has no owner-scoped review-list or decision/proposal/evidence history endpoint. The existing review-resolution POST is not enough to build a safe queue.
- The audit badge now describes hash-chain integrity only; it does not claim all decisions are visible or that a payment settled.

**Needed to close:** Person 1 adds owner-scoped persisted history and review-list/read APIs with approved fields and authenticated reviewer identity; provider owners expose checked execution status and receipt facts. Person 5 can then display proposal, intent, reasons, inspection evidence, execution status and receipt, distinguish `unknown` and pending, and add reviewer controls. Prove unresolved proposals cannot execute.

### G-09 — Demo scripts and docs overstate some evidence

**Priority:** P1 for demo readiness and accurate acceptance reporting  
**Status:** **Partially closed on `develop` (gateway replay controls have live PostgreSQL demo evidence; no provider settlement is verified)**
**Accountable owner:** Person 5 / Nasar (integrated demo and documentation)  
**Supporting owners by evidence:** Person 1 / Awais (replay and audit demos), Person 2 / GOAT (`demo:goat`), Person 4 / Om & Tirth (agent and PDF demos)

- **Resolved for Replay Defense:** `scripts/demo-replay-attack.mjs` was upgraded to perform a true live duplicate consumption on the exact same HMAC approval token against `POST /approvals/:id/consume`. The Gateway executes atomic row updates in PostgreSQL:
  1. Attempt #1 consumes the approval (`200 OK`) and decrements `remaining_uses` to 0.
  2. Attempt #2 (Replay of same token) is rejected by Gateway with `HTTP 403 FORBIDDEN` (`Approval cannot be consumed: INTENT_EXHAUSTED`).
  3. Attempt #3 (Proposal resubmission against exhausted intent) is rejected by Gateway with `REJECT [INTENT_EXHAUSTED]`.
  4. Expired timestamps are rejected with `REJECT [INTENT_EXPIRED]`. Testable via `npm run demo:replay`.
- The PDF demo (`demo:pdf`) now runs directly against the live Gateway API and PostgreSQL audit log.
- `scripts/demo-goat-live.mjs` and `scripts/demo-attack.mjs` have been clarified to distinguish live read-only RPC checks from simulated settlement where live spend keys are restricted.
- `demo-replay` provides live Gateway/PostgreSQL evidence for single-use approval consumption, duplicate-consume rejection, intent exhaustion, and expiry. This tests the gateway capability boundary; it does not dispatch a provider transaction or prove duplicate payment side effects are impossible.
- `demo-attack.mjs` still labels its printed vulnerable `sendTransaction` and approval-consume-only clean path as on-chain execution/settlement. Those claims need to be corrected by the demo owner; approval consumption alone is not a provider payment.
- The PDF demo's `SOC-2 ready` label is also unsupported by the audit-chain check and should be removed or precisely qualified.

### G-10 — Feature status and project documentation need reconciliation

**Priority:** P1  
**Accountable owner:** Person 5 / Nasar (plan, feature list, and handoff consistency)  
**Supporting owners:** each feature owner validates the evidence for their feature; Om owns the main-branch release gate

- **Historical finding from the initial gap review:** `feature_list.json` marked F-001–F-010 and F-013 `implemented`, despite the acceptance gaps in this document; F-011 and F-012 were `not_started`. The current status legend and evidence-based rows are documented in the progress note below.
- **Resolved in this reconciliation:** `CONTEXT.md`, `docs/plan.md`, and the current handoff now record `origin/develop` at `9133094` and `main` at `0c08845` after PR #8.
- `docs/integration.md` retains earlier pinned-source language and should be refreshed to distinguish newly added active-mode GOAT HTTP code from verified trusted gateway integration.
- **Resolved in this reconciliation:** the root README's demo instructions now reflect live Gateway/PostgreSQL use for PDF and replay, and state that no provider payment is performed.

**Progress:** `feature_list.json` defines `verified`, `partial`, `blocked`, and `not_started`; statuses remain evidence-based and F-005 remains partial. G-06 has been changed from closed to partially closed because the vulnerable-agent and clean-provider-payment paths are narrated/approval-only. See status notes for remaining component-owner validation.

**Needed to close:** feature owners validate their rows against current evidence; update branch/merge facts after integration; preserve explicit limits of source tests, mocked demos, database tests, and provider evidence.

## PRD acceptance still outstanding

### P0 MVP requirements

- A user can register an intent and the record is verified to persist in PostgreSQL.
- The exact same versioned proposal is validated by the gateway and bound to the adapter authorization.
- Replay, duplicate, expiry, amount, seller, product, destination, asset/currency, chain, and intent-version checks pass against isolated PostgreSQL endpoint tests.
- The inspected listing/PDF evidence is associated with the exact proposal and gateway decision.
- A controlled unprotected model attack is reproduced; the same input is stopped by the protected gateway flow.
- A legitimate purchase actually completes through a trusted adapter; no fake signer, result, or receipt is used as settlement proof.
- One bounded real GOAT Testnet3 transaction and receipt are verified.
- Authenticated Qatom discovery and an approved checkout/receipt are demonstrated where supported; unsupported capabilities remain clearly documented.
- Every attempt has linked, durable intent, proposal, decision/reason, inspection evidence, execution state, and outcome records.

### P1 and optional requirements

- Full persisted authorization/audit/outcome dashboard and human-review workflow.
- GOAT escrow deposit, release, refund, and dispute paths under a separate contract flow.
- Objective delivery evidence that gates escrow release.

### Security and release gates

- Prove wallet/payment credentials cannot enter model context through the integrated run.
- Keep original intent and owner identity outside agent-controlled data; establish real authenticated owner binding rather than only a local `DEMO_OWNER_ID`.
- Prove all provider writes require the server-owned, exact, one-use gateway approval.
- Persist execution claims before provider dispatch and recover uncertain writes through owner-scoped reconciliation; never blindly retry.
- Add numeric paid-model authorization before enabling the Gemini playground's external request path.
- Complete current dependency/license review and resolve or explicitly accept the documented high-severity AgentKit/Zod advisory before external release.
- Run current-revision root, gateway, PDF, and isolated database checks; then rehearse the end-to-end flow and keep test/demo/live evidence distinct.

## Suggested close-out order

1. Agree and implement the shared intent, proposal, approval, execution, result, and reconciliation contract.
2. Provision a disposable PostgreSQL database, repair the audit-safe test reset, and run migrations plus gateway endpoint tests.
3. Finish Qatom's verified checkout path and GOAT's server-owned binding/checkpoint/outcome/reconciliation path.
4. Connect agent, listing/PDF inspection, gateway, adapter, persisted audit, and dashboard into one flow.
5. Run deterministic attacks, duplicate/replay/expiry cases, uncertain-outcome recovery, a real bounded GOAT transaction, and an authenticated Qatom checkout if supported.
6. Update feature statuses and demo docs from the resulting evidence; keep escrow as a separate later acceptance gate.
