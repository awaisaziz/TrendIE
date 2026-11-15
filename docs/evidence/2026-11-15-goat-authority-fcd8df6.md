# GOAT authority V1: synthetic route probe

**Status: CONFIRMED (synthetic Fastify route behavior at pinned source `fcd8df68641b3550f392aff65f5c20067200585c`).** This report records four failures reproduced against Awais's gateway route with an in-memory mock database. It is not PostgreSQL evidence, a live service check, proof of an actual transfer, or acceptance of the proposed contract. The four tests pass because they assert the vulnerable responses and mock effects.

## Reproduction

The source under test was the gateway tree at the pinned commit, copied into `/tmp/trendie-fcd8df6-probe`. The harness is preserved in [`2026-11-15-goat-authority-fcd8df6.test.ts.txt`](2026-11-15-goat-authority-fcd8df6.test.ts.txt). From the repository root, reproduce with Node 22.23.4 in an isolated scratch checkout. Installing the locked gateway dependencies uses the package registry; the test itself makes no database or provider calls.

```sh
mkdir -p /tmp/trendie-fcd8df6-probe
git archive fcd8df68641b3550f392aff65f5c20067200585c | tar -x -C /tmp/trendie-fcd8df6-probe
cp docs/evidence/2026-11-15-goat-authority-fcd8df6.test.ts.txt /tmp/trendie-fcd8df6-probe/gateway/test/goat-authority-probe.test.ts
cd /tmp/trendie-fcd8df6-probe/gateway
node --version  # v22.23.4
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec vitest run test/goat-authority-probe.test.ts
```

This harness stubs `db/client.js`, audit append, and role authentication. It uses no PostgreSQL connection, provider, secrets, environment file, chain, or funds. The mocked role hook always assigns `adapter-goat`; it does not test authentication.

## Confirmed cases

1. **Claim accepts caller proposal fields that differ from the stored approval proposal.** The fixture stores proposal hash `H`, amount `100`, and recipient A. The request supplies fingerprint `F`, amount `1`, and recipient B with a matching synthetic spend ceiling. The route returns 200 and binds F/amount 1/recipient B, then issues an approval-consumption update. It later returns the stored proposal, so the actual GOAT client rejects the mismatch and no transfer is demonstrated. The route reads `proposal_hash` only indirectly by loading approval and never compares a recomputed request hash with it. See [goatAuthority.ts at the pinned source](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/goatAuthority.ts#L62-L78) and [claim/consume path](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/goatAuthority.ts#L83-L140), [binding construction](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/goatAuthority.ts#L155-L192).

2. **Checkpoint accepts a replacement hash and acknowledges it as persisted.** Starting with hash A on the execution, a broadcast checkpoint with hash B receives a 200 acknowledgement naming B. The update overwrites `checkpoint_tx_hash`, while `COALESCE` preserves the old `tx_hash_or_checkout_ref`. The mock confirms those arguments and retained prior reference. No real persistence was exercised. See [checkpoint update and acknowledgement](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/goatAuthority.ts#L245-L296).

3. **Outcome changes a terminal success and its provider reference.** Starting with succeeded/ref A, the new `/v1/goat/executions/:executionId/outcome` route accepts failed/ref B, updates the mock row, and returns 200. There is no transition or reference consistency check in this route. The older route is `POST /executions/:id/result`; its guards do not cover this new endpoint. See [V1 outcome update and acknowledgement](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/goatAuthority.ts#L304-L374) and [older result route](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/executions.ts#L9-L43).

4. **Outcome creates a successful execution from an unconsumed approval.** With no execution row and `consumed_at: null`, a succeeded outcome request gets 200 and causes an insert in the mock. The route checks for an approval by execution ID, but not that it was consumed. See [outcome insert path](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/goatAuthority.ts#L323-L349).

## Source findings, not reproduced database cases

- Reconciliation selects by execution ID and checks the caller-supplied `ownerId` against an owner value from the joined row; the SQL itself does not filter by authenticated principal. This is a source-level authorization concern, not a tested PostgreSQL case. The stubbed role does not establish an independently authenticated owner. See [reconciliation query and owner check](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/goatAuthority.ts#L382-L420).
- Reconciliation fabricates missing proposal/binding values such as `item_1`, `seller_1`, default sender, `auth_1`, and an amount-derived spend ceiling. These are not authoritative persisted facts and should not be presented as such. See [fallback construction](https://github.com/PATELOM925/TrendIE/blob/fcd8df68641b3550f392aff65f5c20067200585c/gateway/src/routes/goatAuthority.ts#L423-L457).

## Follow-up for the gateway owner

Do not weaken the GOAT client to accommodate these responses. Awais owns the backend fix. The claim path needs strict matching of the stored proposal and approval hash, authenticated principal binding, and validation of HMAC/platform authority before consumption. Checkpoints need monotonic phase/hash rules. Outcome writes need consumed approval, owner/platform, and valid transition/reference guards; absent authority facts must fail closed. The agreed fingerprint/full-schema contract is still pending server agreement and implementation. Coordinate the findings with Awais; this report does not claim that coordination itself fixes the route.

See also the client proposal and its default-disabled posture in [`docs/goat-authority-v1.md`](../goat-authority-v1.md).
