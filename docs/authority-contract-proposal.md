# Proposed adapter authority contract

Status: adapter-side requirements for Person 1 agreement, based on `mvp-gaps.md` at `dbfac42`.
This is a proposal, not a deployed API or proof of database durability. Awais owns authorization,
storage, migrations and server implementation. Persons 2/3 own strict consumption and provider
verification; Person 5 consumes approved read APIs. Routes and final wire shapes require agreement.

## Rules that must be shared

- Use the complete `@trendie/contracts` version-1 PurchaseProposal and its canonical fingerprint.
  Do not project it to the legacy seller/product/amount payload or reinterpret USD-TDN as USDC.
- The server derives authenticated owner and role from trusted authentication. Request owner IDs,
  fingerprints, spend ceilings and agent text are comparison inputs, never authorization sources.
- Store the exact owner, intent ID/version, provider/platform, chain, item, seller, amount and scale,
  asset, recipient and all provider arguments before approval. Recompute the complete fingerprint.
- Atomically consume approval once and create a unique execution claim before provider dispatch.
  The response must come from that persisted record; an execution ID alone is insufficient.
- Use the current intent version, remaining uses and server clock. Approval expiry cannot exceed
  intent expiry. Adapters validate the returned expiry; they never replace it with local now + TTL.
- An approval, consumed claim, signed hash or valid audit chain does not establish settlement.
  Provider verification and checked outcome persistence are separate acceptance gates.

## Required operations

| Operation | Request/comparison inputs | Trusted response and storage obligation |
|---|---|---|
| Claim approved execution | Opaque approval reference, complete proposal, fingerprint; GOAT spend authorization reference | Versioned claimed/denied/already-claimed result. Claimed includes execution ID, full stored proposal and full provider binding after the transaction commits. Validate authenticated owner, exact fingerprint and current intent. Never trust a submitted maximum as the granted ceiling. |
| Persist GOAT checkpoint | Execution ID, signed/broadcast phase and transaction hash | Durable acknowledgement of the exact execution/hash/phase. Hash is immutable once known; phase is idempotent and monotonic. A failed or uncertain acknowledgement cannot authorize another send. |
| Persist provider outcome | Execution ID, exact shared payment status, checked reference/evidence | Acknowledge the actual stored result in the same execution context. Identical results are idempotent; conflicting terminal results fail. Pending/unknown may resolve with verified evidence; unknown never means failed or zero. |
| Read execution for recovery | Authenticated owner and execution ID | Complete stored proposal/binding, signed/broadcast checkpoint, provider reference and outcome. Enforce owner and platform scope. No signing or provider resubmission is part of this read. |
| Claim Qatom continuation | Same approval, execution and persisted provider reference | Full authoritative Qatom binding and atomically serialized resume claim. Recheck owner, intent/version, expiry and reference. Missing/unknown previous dispatch is not permission to retry. |

Requests must be bounded, authenticated and validated. Response loss after a committed claim must
be recoverable by a read of the original approval/execution, never by minting another approval.
HTTP clients use bounded timeouts, response limits, no redirects and no automatic write retries.

## Provider binding requirements

GOAT's existing port requires fingerprint, owner, intent/version, sender, destination, BTC amount
and scale 18, chain ID 48816, authoritative expiry, spend authorization ID and granted ceiling.
Its current TypeScript expiry is epoch milliseconds. The server must supply the sender and ceiling;
there is no fallback address or client-created authority. Recovery also needs the original full
proposal, execution ID, hash and checkpoint phase.

Qatom's existing port requires execution ID, owner, intent/version, fingerprint, platform, item,
seller, amount/scale, asset, chain, provider arguments and authoritative expiry. Its current expiry
is an ISO timestamp; continuation additionally requires the same persisted provider reference.
Provider-specific expiry encodings must be explicit in the final versioned wire schema, not guessed.

A proposed transport envelope is `{ version: 1, executionId, proposal, binding }` within a typed
claim/recovery result. Both proposal and binding are server-returned. This envelope alone is not
proof of persistence: the server transaction, authentication and tests must establish that property.
Adapter work may test a proposed envelope with mocks while actual gateway integration remains off.
A legacy `{ executionId }` response must not be treated as an authoritative binding.

## Evidence required before enabling execution

1. Cross-package contract tests reject changed owner, intent version, platform, chain, seller/item,
   amount/scale, asset, recipient, provider arguments, fingerprint and expiry.
2. Isolated PostgreSQL tests prove one claim under concurrency, rollback on persistence/audit
   failure, replay/expiry denial, owner/platform-scoped reads and monotonic checkpoint/outcome writes.
3. Adapter tests preserve a known signed hash and unknown outcome after uncertain writes. A new
   process can recover from server records without a local cache and without resubmission.
4. Qatom authentication, atomic price protection and receipt facts are verified against actual
   provider capabilities. A separate quote is not same-operation price protection.
5. A real GOAT or Qatom action requires separately recorded numeric authorization and provider
   evidence. No actual unauthorized payment is part of the attack demonstration.

Open agreement: Person 1 must confirm final schema/route names, authentication/owner mechanism,
claim recovery lookup and database migration/reset plan. This document does not authorize a
migration, real wallet setup, paid provider call, deployment or production release.
