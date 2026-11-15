import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const { db, failOn } = vi.hoisted(() => ({
  db: { approvals: {} as Record<string, Row>, intents: {} as Record<string, Row>, executions: {} as Record<string, Row>, proposals: {} as Record<string, Row>, spent: '0' },
  failOn: { sql: '' as string },
}));

function query(sql: string, v: unknown[] = []): { rows: Row[] } {
  if (failOn.sql && sql.includes(failOn.sql)) throw new Error('injected failure');
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (sql.includes('SELECT * FROM approvals WHERE id = $1 FOR UPDATE')) return { rows: db.approvals[v[0] as string] ? [{ ...db.approvals[v[0] as string] }] : [] };
  if (sql.includes('SELECT p.raw_payload FROM proposals p JOIN decisions')) return { rows: db.proposals[v[0] as string] ? [db.proposals[v[0] as string]!] : [] };
  if (sql.includes('SELECT * FROM intents WHERE id = $1 FOR UPDATE')) return { rows: db.intents[v[0] as string] ? [{ ...db.intents[v[0] as string] }] : [] };
  if (sql.includes('SUM(p.amount)')) return { rows: [{ spent: db.spent }] };
  if (sql.includes('SELECT 1 FROM executions')) return { rows: db.executions[v[0] as string] ? [{}] : [] };
  if (sql.includes('UPDATE approvals')) {
    const a = db.approvals[v[0] as string];
    if (!a || a.consumed_at) return { rows: [] };
    Object.assign(a, { consumed_at: new Date(), consumed_platform: 'goat', spend_authorization_id: v[1], spend_ceiling: v[2], bound_sender: v[3] });
    return { rows: [{ id: a.id }] };
  }
  if (sql.includes('UPDATE intents SET remaining_uses')) {
    const i = db.intents[v[0] as string];
    if (!i || Number(i.remaining_uses) <= 0) return { rows: [] };
    i.remaining_uses = Number(i.remaining_uses) - 1;
    return { rows: [{ id: i.id }] };
  }
  if (sql.includes('INSERT INTO executions')) {
    db.executions[v[0] as string] = { execution_id: v[0], approval_id: v[1], status: 'submitting', platform: 'goat', owner_id: v[2], checkpoint_phase: null, checkpoint_tx_hash: null, tx_hash_or_checkout_ref: null, error: null, evidence: {} };
    return { rows: [] };
  }
  if (sql.includes('FOR UPDATE OF e')) {
    const e = db.executions[v[0] as string];
    if (!e || e.owner_id !== v[1] || e.platform !== 'goat') return { rows: [] };
    const a = Object.values(db.approvals).find((x) => x.id === e.approval_id)!;
    return { rows: [{ ...e, approval_consumed_at: a.consumed_at, approval_consumed_platform: a.consumed_platform }] };
  }
  if (sql.includes('UPDATE executions') && sql.includes('checkpoint_phase = $2')) {
    const e = db.executions[v[0] as string]!;
    Object.assign(e, { checkpoint_phase: v[1], checkpoint_tx_hash: v[2], tx_hash_or_checkout_ref: e.tx_hash_or_checkout_ref ?? v[2], status: v[1] === 'broadcast' && e.status === 'submitting' ? 'pending' : e.status });
    return { rows: [{ execution_id: v[0] }] };
  }
  if (sql.includes('UPDATE executions') && sql.includes('SET status = $2')) {
    const e = db.executions[v[0] as string];
    if (!e || e.status !== v[6]) return { rows: [] };
    Object.assign(e, { status: v[1], tx_hash_or_checkout_ref: e.tx_hash_or_checkout_ref ?? v[2], error: v[3], evidence: JSON.parse(String(v[4])) });
    return { rows: [{ execution_id: v[0] }] };
  }
  if (sql.includes('JOIN approvals a ON a.id = e.approval_id')) {
    const byApproval = sql.includes('WHERE a.id = $1');
    const e = Object.values(db.executions).find((x) => (byApproval ? x.approval_id === v[0] : x.execution_id === v[0]) && x.owner_id === v[1]);
    if (!e) return { rows: [] };
    const a = Object.values(db.approvals).find((x) => x.id === e.approval_id)!;
    return { rows: [{ ...e, approval_id: a.id, decision_id: a.decision_id, proposal_hash: a.proposal_hash, expires_at: a.expires_at, bound_sender: a.bound_sender, spend_authorization_id: a.spend_authorization_id, spend_ceiling: a.spend_ceiling }] };
  }
  if (sql.includes('SELECT id FROM approvals WHERE id = $1 AND owner_id = $2')) {
    const a = db.approvals[v[0] as string];
    return { rows: a && a.owner_id === v[1] ? [{ id: a.id }] : [] };
  }
  throw new Error(`unexpected SQL: ${sql}`);
}

vi.mock('../src/db/client.js', () => ({
  pool: { query: async (sql: string, v?: unknown[]) => query(sql, v) },
  // Real rollback semantics: restore a snapshot when the callback throws.
  withTransaction: async (fn: (c: { query: typeof query }) => Promise<unknown>) => {
    const snapshot = structuredClone({ approvals: db.approvals, intents: db.intents, executions: db.executions });
    try {
      return await fn({ query: async (sql: string, v?: unknown[]) => query(sql, v) } as never);
    } catch (err) {
      Object.assign(db, snapshot);
      throw err;
    }
  },
}));
vi.mock('../src/audit/hashChain.js', () => ({
  appendAuditLog: vi.fn(async () => { if (failOn.sql === 'AUDIT') throw new Error('audit failed'); }),
}));

import { createGoatAuthorityRoutes } from '../src/routes/goatAuthority.js';
import { v1Fingerprint, type GoatProposalV1 } from '../src/authority/goat.js';
import { generateHmacSignature } from '../src/approvals/token.js';
import { proposalHash } from '../src/schemas/canonical.js';

const SENDER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const proposal: GoatProposalV1 = { version: 1, ownerId: 'Alice', intentId: 'int_1', intentVersion: 1, platform: 'goat', itemId: 'item_1', sellerId: 'seller_1', money: { amount: '1000', scale: 18 }, asset: 'BTC', chain: 'goat-testnet', providerArgs: { recipient: RECIPIENT } };
// Computed with proposalFingerprint() from @trendie/contracts for the same proposal.
const CONTRACTS_FINGERPRINT = 'f2478792514a2dc8b975f39b0b91ac28bed305d8bd73b8e9e5b646c824ebb659';
const CFG = { GOAT_SPEND_AUTHORIZATION_ID: 'spend_1', GOAT_SPEND_CEILING_WEI: '5000', GOAT_DAILY_LIMIT_WEI: undefined as string | undefined };

function seed() {
  const raw = { ...proposal, seller: 'seller_1', product: 'item_1', amount: '1000', currency: 'BTC', destination: RECIPIENT, sourceRef: 'src_1' };
  const pHash = proposalHash(raw);
  const expires = new Date(Date.now() + 300_000);
  const approval: Row = { id: 'apr_1', execution_id: 'exe_1', decision_id: 'dec_1', intent_id: 'int_1', proposal_hash: pHash, key_id: 'unit', expires_at: expires, consumed_at: null, consumed_platform: null, owner_id: 'Alice', intent_version: 1, bound_platform: 'goat', bound_asset: 'BTC', bound_chain: 'goat-testnet', bound_scale: 18, bound_sender: SENDER, bound_destination: RECIPIENT, spend_authorization_id: null, spend_ceiling: null };
  approval.hmac_signature = generateHmacSignature({ approvalId: 'apr_1', executionId: 'exe_1', proposalHash: pHash, intentId: 'int_1', expiresAt: expires.toISOString(), ownerId: 'Alice', intentVersion: 1, platform: 'goat', chain: 'goat-testnet', asset: 'BTC', scale: 18 }, 'unit');
  db.approvals = { apr_1: approval };
  db.intents = { int_1: { id: 'int_1', owner: 'Alice', remaining_uses: 1, expiry: new Date(Date.now() + 86_400_000), intent_version: 1, platform: 'goat', sender: SENDER } };
  db.proposals = { dec_1: { raw_payload: raw } };
  db.executions = {};
  db.spent = '0';
}

async function app(owner: string | null = 'Alice', role = 'adapter-goat', cfg = CFG) {
  const a = Fastify();
  a.addHook('onRequest', async (req) => { req.callerRole = role as never; if (owner) req.callerOwnerId = owner; });
  await a.register(createGoatAuthorityRoutes(cfg));
  return a;
}

const claimBody = (p: GoatProposalV1 = proposal, extra: Record<string, unknown> = {}) => ({ version: 1, kind: 'claim', callerOwnerId: 'Alice', proposal: p, fingerprint: v1Fingerprint(p), spendAuthorization: { ownerId: 'Alice', authorizationId: 'spend_1', maxAmountWei: '5000' }, ...extra });
const claim = async (a: Awaited<ReturnType<typeof app>>, body: unknown = claimBody()) => a.inject({ method: 'POST', url: '/v1/goat/approvals/apr_1/claim', payload: body as object });
const checkpoint = (a: Awaited<ReturnType<typeof app>>, phase: string, txHash: string, id = 'exe_1') => a.inject({ method: 'PUT', url: `/v1/goat/executions/exe_1/checkpoint`, payload: { version: 1, kind: 'checkpoint', executionId: id, phase, txHash } });
const outcome = (a: Awaited<ReturnType<typeof app>>, body: Record<string, unknown>) => a.inject({ method: 'PUT', url: '/v1/goat/executions/exe_1/outcome', payload: { version: 1, kind: 'outcome', executionId: 'exe_1', ...body } });
const untouched = () => { expect(db.approvals.apr_1!.consumed_at).toBeNull(); expect(db.intents.int_1!.remaining_uses).toBe(1); expect(db.executions).toEqual({}); };

beforeEach(() => { seed(); failOn.sql = ''; });

describe('GOAT authority V1 claim', () => {
  it('uses the same fingerprint as @trendie/contracts', () => {
    expect(v1Fingerprint(proposal)).toBe(CONTRACTS_FINGERPRINT);
  });

  it('claims an exact persisted proposal once and binds trusted facts', async () => {
    const a = await app();
    const res = await claim(a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'claimed', executionId: 'exe_1', proposal, binding: { fingerprint: CONTRACTS_FINGERPRINT, ownerId: 'Alice', sender: SENDER, destination: RECIPIENT, amount: '1000', spendAuthorizationId: 'spend_1', spendCeilingWei: '5000', chainId: 48816 } });
    expect(db.approvals.apr_1!.consumed_at).toBeTruthy();
    expect(db.intents.int_1!.remaining_uses).toBe(0);
    expect(db.executions.exe_1!.status).toBe('submitting');
    const replay = await claim(a);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ version: 1, error: { code: 'ALREADY_CLAIMED' } });
    expect(db.intents.int_1!.remaining_uses).toBe(0);
  });

  it.each([
    ['amount', { money: { amount: '1', scale: 18 } }],
    ['recipient', { providerArgs: { recipient: '0x3333333333333333333333333333333333333333' } }],
    ['itemId', { itemId: 'item_2' }],
    ['sellerId', { sellerId: 'seller_2' }],
    ['intentVersion', { intentVersion: 2 }],
  ])('rejects a tampered %s before any mutation (probe case 1)', async (_name, change) => {
    const a = await app();
    const res = await claim(a, claimBody({ ...proposal, ...change } as GoatProposalV1));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROPOSAL_MISMATCH');
    untouched();
  });

  it('rejects a fingerprint that does not match the proposal', async () => {
    const res = await claim(await app(), claimBody(proposal, { fingerprint: 'f'.repeat(64) }));
    expect(res.json().error.code).toBe('PROPOSAL_MISMATCH');
    untouched();
  });

  it('rejects a hybrid legacy/shared proposal', async () => {
    const res = await claim(await app(), claimBody({ ...proposal, amount: '1' } as never));
    expect(res.statusCode).toBe(400);
    untouched();
  });

  it('takes the owner from the key, not from the request', async () => {
    const mallory = await claim(await app('Mallory'), claimBody());
    expect(mallory.json().error.code).toBe('OWNER_MISMATCH');
    const unbound = await claim(await app(null), claimBody());
    expect(unbound.json().error.code).toBe('OWNER_UNBOUND');
    const forged = await claim(await app('Mallory'), claimBody({ ...proposal, ownerId: 'Mallory' }, { callerOwnerId: 'Mallory', spendAuthorization: { ownerId: 'Mallory', authorizationId: 'spend_1', maxAmountWei: '5000' } }));
    expect(forged.statusCode).toBe(404);
    untouched();
  });

  it('blocks every claim at the default zero ceiling and refuses an unrecorded authorization', async () => {
    const zero = await claim(await app('Alice', 'adapter-goat', { ...CFG, GOAT_SPEND_CEILING_WEI: '0' }));
    expect(zero.json().error.code).toBe('SPEND_CEILING_ZERO');
    const invented = await claim(await app(), claimBody(proposal, { spendAuthorization: { ownerId: 'Alice', authorizationId: 'spend_1', maxAmountWei: '999999' } }));
    expect(invented.json().error.code).toBe('SPEND_AUTHORIZATION_INVALID');
    untouched();
  });

  it('enforces the rolling daily limit', async () => {
    db.spent = '4500';
    const res = await claim(await app('Alice', 'adapter-goat', { ...CFG, GOAT_DAILY_LIMIT_WEI: '5000' }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DAILY_LIMIT_EXCEEDED');
    untouched();
    db.spent = '4000';
    expect((await claim(await app('Alice', 'adapter-goat', { ...CFG, GOAT_DAILY_LIMIT_WEI: '5000' }))).statusCode).toBe(200);
  });

  it('rejects a tampered approval signature or stored payload', async () => {
    db.approvals.apr_1!.hmac_signature = '0'.repeat(64);
    expect((await claim(await app())).json().error.code).toBe('APPROVAL_SIGNATURE_INVALID');
    seed();
    (db.proposals.dec_1!.raw_payload as Row).destination = '0x3333333333333333333333333333333333333333';
    expect((await claim(await app())).json().error.code).toBe('PROPOSAL_MISMATCH');
    untouched();
  });

  it('fails closed when the trusted sender is missing', async () => {
    db.approvals.apr_1!.bound_sender = null;
    db.intents.int_1!.sender = null;
    expect((await claim(await app())).json().error.code).toBe('AUTHORITY_INCOMPLETE');
    untouched();
  });

  it.each(['UPDATE intents SET remaining_uses', 'INSERT INTO executions', 'AUDIT'])('rolls back and returns no success when %s fails', async (step) => {
    failOn.sql = step;
    const res = await claim(await app());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ version: 1, error: { code: 'AUTHORITY_UNAVAILABLE' } });
    untouched();
  });

  it('refuses agent and dashboard roles', async () => {
    expect((await claim(await app('Alice', 'agent'))).statusCode).toBe(403);
    expect((await claim(await app('Alice', 'dashboard'))).statusCode).toBe(403);
  });
});

describe('GOAT authority V1 checkpoints and outcomes', () => {
  it('never creates an execution from an unclaimed approval (probe case 4)', async () => {
    const a = await app();
    expect((await checkpoint(a, 'signed', HASH_A)).statusCode).toBe(404);
    const res = await outcome(a, { status: 'succeeded', providerReference: HASH_A });
    expect(res.statusCode).toBe(404);
    untouched();
  });

  it('keeps the first checkpoint hash and phase order (probe case 2)', async () => {
    const a = await app();
    await claim(a);
    expect((await checkpoint(a, 'signed', HASH_A)).statusCode).toBe(200);
    expect((await checkpoint(a, 'signed', HASH_A)).statusCode).toBe(200);
    expect((await checkpoint(a, 'broadcast', HASH_A)).statusCode).toBe(200);
    expect(db.executions.exe_1!.status).toBe('pending');
    const replaced = await checkpoint(a, 'broadcast', HASH_B);
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json().error.code).toBe('CHECKPOINT_CONFLICT');
    expect((await checkpoint(a, 'signed', HASH_A)).json().error.code).toBe('CHECKPOINT_CONFLICT');
    expect(db.executions.exe_1!.checkpoint_tx_hash).toBe(HASH_A);
    expect((await checkpoint(a, 'signed', HASH_A, 'exe_2')).statusCode).toBe(400);
  });

  it('keeps a terminal outcome and its reference (probe case 3)', async () => {
    const a = await app();
    await claim(a);
    await checkpoint(a, 'broadcast', HASH_A);
    expect((await outcome(a, { status: 'succeeded', providerReference: HASH_A, evidence: { blockNumber: '1' } })).statusCode).toBe(200);
    expect((await outcome(a, { status: 'succeeded', providerReference: HASH_A, evidence: { blockNumber: '1' } })).statusCode).toBe(200);
    const rewrite = await outcome(a, { status: 'failed', providerReference: HASH_A, reason: 'x' });
    expect(rewrite.statusCode).toBe(409);
    expect(rewrite.json().error.code).toBe('OUTCOME_CONFLICT');
    expect(db.executions.exe_1).toMatchObject({ status: 'succeeded', tx_hash_or_checkout_ref: HASH_A });
  });

  it('rejects a replacement reference, success without a hash, and blocked after a checkpoint', async () => {
    const a = await app();
    await claim(a);
    expect((await outcome(a, { status: 'succeeded' })).statusCode).toBe(400);
    await checkpoint(a, 'signed', HASH_A);
    expect((await outcome(a, { status: 'unknown', providerReference: HASH_B })).json().error.code).toBe('OUTCOME_CONFLICT');
    expect((await outcome(a, { status: 'blocked', reason: 'denied' })).json().error.code).toBe('OUTCOME_CONFLICT');
    expect((await outcome(a, { status: 'unknown' })).statusCode).toBe(200);
    expect((await outcome(a, { status: 'blocked', reason: 'denied' })).statusCode).toBe(409);
  });

  it('allows blocked before any checkpoint', async () => {
    const a = await app();
    await claim(a);
    expect((await outcome(a, { status: 'blocked', reason: 'pre-dispatch denial' })).statusCode).toBe(200);
  });

  it('hides another owner\'s execution', async () => {
    const a = await app();
    await claim(a);
    const b = await app('Mallory');
    expect((await checkpoint(b, 'signed', HASH_A)).statusCode).toBe(404);
    expect((await outcome(b, { status: 'failed', reason: 'x' })).statusCode).toBe(404);
  });
});

describe('GOAT authority V1 recovery', () => {
  it('reports unclaimed, then the persisted record with a null checkpoint', async () => {
    const a = await app();
    const before = await a.inject({ method: 'GET', url: '/v1/goat/approvals/apr_1/execution' });
    expect(before.json()).toEqual({ version: 1, kind: 'unclaimed_observation', approvalReference: 'apr_1' });
    await claim(a);
    const after = await a.inject({ method: 'GET', url: '/v1/goat/approvals/apr_1/execution' });
    expect(after.json()).toMatchObject({ kind: 'execution_record', executionId: 'exe_1', status: 'submitting', checkpoint: null, result: null, binding: { fingerprint: CONTRACTS_FINGERPRINT } });
    const other = await (await app('Mallory')).inject({ method: 'GET', url: '/v1/goat/approvals/apr_1/execution' });
    expect(other.statusCode).toBe(404);
  });

  it('reconciles by execution id only for the key owner', async () => {
    const a = await app();
    await claim(a);
    await checkpoint(a, 'broadcast', HASH_A);
    const ok = await a.inject({ method: 'GET', url: '/v1/goat/executions/exe_1?ownerId=Alice' });
    expect(ok.json()).toMatchObject({ kind: 'reconciliation', phase: 'broadcast', txHash: HASH_A, proposal, binding: { sender: SENDER, spendAuthorizationId: 'spend_1' } });
    expect((await a.inject({ method: 'GET', url: '/v1/goat/executions/exe_1?ownerId=Mallory' })).statusCode).toBe(403);
    expect((await (await app('Mallory')).inject({ method: 'GET', url: '/v1/goat/executions/exe_1' })).statusCode).toBe(404);
  });
});
