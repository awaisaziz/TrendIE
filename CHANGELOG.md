# Changelog

## 2026-11-15 — Qatom authority, owner-scoped history, live-gateway comparison

- Qatom authority V1 on the gateway: claim, outcome, one atomic continuation per provider
  approval, and read-only recovery under `/v1/qatom/...`. It uses the same rules as GOAT: exact
  persisted proposal and shared fingerprint, approval HMAC, owner from the key, immutable terminal
  results and provider reference, and a success only with a receipt that matches the approved
  item and money. `QATOM_SPEND_CEILING` defaults to 0 (blocked); `QATOM_DAILY_LIMIT` is optional.
- `packages/qatom` HTTP authority client works in `mode: 'active'` with strict response checks.
  The default stays `disabled`. Live checkout still needs provider access and a verified price bound.
- Every owner-visible gateway route takes the owner only from the key binding and filters by it in
  SQL. An `owner` query value must match the key. History aliases share handlers instead of
  `fastify.inject`.
- The web attack comparison asks the live gateway when it is configured, shows the gateway decision
  id, and fails instead of falling back when the gateway errors. Without any gateway configuration
  it uses the fixture policy, labelled in the UI. The fixture now uses USDC (scale 6).
- Offline tests only. PostgreSQL behavior and live Qatom checkout are not verified.

## 2026-11-15 — GOAT authority V1 hardening

- Claim compares the request proposal with the persisted, signed proposal and recomputes the
  shared V1 fingerprint. It checks the approval HMAC, intent owner, version, expiry and uses
  before any write. Consume, use decrement, execution insert and audit happen in one transaction.
- The owner comes from the server-configured key binding (`API_KEY_*_OWNER_ID`), not from the request.
- Spend authorization is server-recorded (`GOAT_SPEND_AUTHORIZATION_ID`, `GOAT_SPEND_CEILING_WEI`).
  The default ceiling of 0 blocks every claim. Optional `GOAT_DAILY_LIMIT_WEI` adds a rolling
  24-hour limit per owner; pending and unknown payments count as spent.
- Checkpoint and outcome routes never create an execution. The first transaction hash is immutable,
  phases cannot go back, and terminal outcomes cannot change. Exact retries are idempotent.
- Added read-only recovery `GET /v1/goat/approvals/:approvalReference/execution` with a nullable checkpoint.
- The four probe cases in `docs/evidence/2026-11-15-goat-authority-fcd8df6.md` are now regression
  tests with safe results (`gateway/test/goat-authority-v1.test.ts`). Offline mocks only: PostgreSQL
  locking, concurrency and rollback are not verified. Qatom authority, history owner scoping and
  frontend gateway wiring remain open.

## Unreleased

- Record Om-directed temporary cross-owner implementation coordination (2026-11-15); original
  role assignments and acceptance ownership remain unchanged, and Awais retains deployment authority.
- Merge pinned `origin/develop` `ca50884d0198aab0584e2b48615dfa6397bd3bda` into candidate
  `e3607d220674777dc45c1397bfe7430a24b6c63f` at `48aca2976c83370850df886fa04ecdce870d6b4e`.
  Keep GOAT authority runtime HOLD; no push, deployment, database, or provider activity occurred.

- Update the project record with published PR #10 QPE (`afc1258`, 26 Qatom tests and read-only
  capability collector), published PR #11 AAT (`08016e6`, 35 agent tests) and draft PR #12 GOAT
  (`bdcf505`, complete V1 client and 32 GOAT tests). All target `develop`; none is merged and the
  proposed contracts remain unagreed. Record that lost `executionId` recovery by owner-scoped
  approval reference still requires an unimplemented server endpoint. Pin combined local candidate
  checks at `6397e1710ab7559a908af621ad0bdd24cf55fccf` (Node 22.23.4, root typecheck/lint and 135
  tests across 25 files); all five library builds and four PDF tests also passed. Both offline CLI modes remained `NOT_SETTLED`. These checks do not prove PR-head or
  global integration. Keep paid execution at zero, provider/authentication/price/receipt gates open,
  and all stages open with no final adversarial review claim.
- Implement Awais gateway shared authority, binding, and owner-scoped history endpoints:
  - Add migration `003_shared_binding_and_authority.sql` for `intents` (`intent_version`, `platform`, `chain`, `asset`, `scale`, `sender`), `approvals` (`owner_id`, `intent_version`, `bound_platform`, `bound_asset`, `bound_chain`, `bound_scale`, `bound_sender`, `bound_destination`, `spend_authorization_id`, `spend_ceiling`), and `executions` (`checkpoint_phase`, `checkpoint_tx_hash`, `owner_id`).
  - Implement `GET /approvals/:id` returning authoritative persisted binding with platform scoping and HMAC verification.
  - Implement owner-scoped history APIs (`GET /history/decisions?owner=...`, `GET /history/executions?owner=...`, `GET /history/review-queue?owner=...`, `GET /intents?owner=...`).
  - Implement GOAT Authority V1 endpoints (`POST /v1/goat/approvals/:approvalReference/claim`, `PUT /v1/goat/executions/:executionId/checkpoint`, `PUT /v1/goat/executions/:executionId/outcome`, `GET /v1/goat/executions/:executionId`).
  - Add 13 unit tests in `gateway/test/authority-history.test.ts` (96 gateway unit tests, 114 root tests pass; all typecheck and lint clean).

- Record `develop` at `9133094` (Node 22.23.4: 114 root tests, 83 gateway unit tests pass, plus
  typecheck and lint). This includes Tirth's paired attack comparison (G-06 closed), Nassar's
  transient PDF upload UI, replay/expiry live-Gateway-and-PostgreSQL demo (G-09 partial), PDF demo
  against live Gateway API and audit chain (G-07 closed), and documentation reconciliation. G-01,
  G-02, G-03, G-04, G-05, G-08, and G-10 remain open.
- Update CONTEXT.md and docs/plan.md: reflect current develop head, accurate test counts,
  gap register status, and prioritized next-owner actions. No PostgreSQL integration, provider
  settlement, or complete end-to-end acceptance is established.

- Merge reviewed Om PRs #1–#3 and combined gateway PR #4 into develop. Final source 9ffdba5 is
  cleared for local/test integration only; main and production remain unchanged. Add the final
  team handoff, preserve remaining stage gates and track non-blocking audit follow-ups.

- Incorporate Awais HMAC integrity verification and audit/intent-list endpoints; retain expiry,
  consumed-platform and transactional outcome guards through the merge.
- Sanitize unexpected gateway errors, bound database-backed proposal fields, use prototype-safe
  API-key lookup, reject unused GOAT action metadata and remove the conflicting root pnpm workspace.
- Correct the prior Node runtime claim: the named Homebrew path was Node 25. Actual Node 22.23.4
  is available through fnm; validate the executable version before running checks.

- Make the GOAT HTTP authority bridge fail closed: claims deny without HTTP; checkpoint and outcome
  writes report the unsupported contract; reconciliation returns no record. Document required
  trusted stored-binding, durable write, and owner-scoped recovery endpoints as pending.

- Merge reviewed Om PRs #1–#3 into `develop` in dependency order; retain `main` as the production gate.
- Add guarded database test configuration and separate gateway checks. Harden exact policy identity,
  expiry boundaries, review revalidation, transactional intent/audit writes, CORS and distinct role keys.
  Combined validation and fresh adversarial review remain required.
- Add the `@trendie/goat` workspace package with guarded native Testnet3 transfer, durable signed
  and broadcast checkpoint hooks, post-checkpoint/pre-broadcast authorization revalidation, and
  read-only reconciliation of signed or broadcast hashes. Signed-only unknown and mismatched cases
  stay uncertain; no transaction is resubmitted.
- Add a public-export local AAT → Qatom integration fixture with synthetic discovery, proposal,
  test-only authority, atomic-claim behavior and fake receipt. It is not the Awais gateway and does
  not make provider calls.
- Extend root workspace coverage and document local stage implementation separately from owner and
  live evidence. Awais's gateway is present in the unpublished candidate; Nassar's frontend is pending. Authenticated
  Qatom schemas, atomic price limits and verified checkout remain open.
- Scope a `minimatch@11.0.8` override to the `typescript-estree` dependency path and remove the
  vulnerable nested 10.2.6 lock entry. The full audit no longer reports the seven moderate findings;
  two high AgentKit/Zod audit entries remain and are documented as an external-use release risk.
