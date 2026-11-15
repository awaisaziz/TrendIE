import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const { db, failOn } = vi.hoisted(() => ({
  db: { approvals: {} as Record<string, Row>, intents: {} as Record<string, Row>, executions: {} as Record<string, Row>, proposals: {} as Record<string, Row>, spent: '0' },
  failOn: { sql: '' as string },
}));

function approvalOf(e: Row): Row {
  return Object.values(db.approvals).find((x) => x.id === e.approval_id)!;
}

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
    Object.assign(a, { consumed_at: new Date(), consumed_platform: 'qatom', spend_ceiling: v[1] });
    return { rows: [{ id: a.id }] };
  }
  if (sql.includes('UPDATE intents SET remaining_uses')) {
    const i = db.intents[v[0] as string];
    if (!i || Number(i.remaining_uses) <= 0) return { rows: [] };
    i.remaining_uses = Number(i.remaining_uses) - 1;
    return { rows: [{ id: i.id }] };
  }
  if (sql.includes('INSERT INTO executions')) {
    db.executions[v[0] as string] = { execution_id: v[0], approval_id: v[1], status: 'submitting', platform: 'qatom', owner_id: v[2], tx_hash_or_checkout_ref: null, error: null, evidence: {} };
    return { rows: [] };
  }
  if (sql.includes('FOR UPDATE OF e')) {
    const e = db.executions[v[0] as string];
    if (!e || e.owner_id !== v[1] || e.platform !== v[2]) return { rows: [] };
    const a = approvalOf(e);
    return { rows: [{ ...e, approval_consumed_at: a.consumed_at, approval_consumed_platform: a.consumed_platform, approval_id_ref: a.id, approval_decision_id: a.decision_id, approval_proposal_hash: a.proposal_hash, approval_expires_at: a.expires_at }] };
  }
  if (sql.includes("SET status = 'submitting'")) {
    const e = db.executions[v[0] as string];
    if (!e || e.status !== 'pending_approval') return { rows: [] };
    e.status = 'submitting';
    return { rows: [{ execution_id: v[0] }] };
  }
  if (sql.includes('UPDATE executions') && sql.includes('SET status = $2')) {
    const e = db.executions[v[0] as string];
    if (!e || e.status !== v[6]) return { rows: [] };
    Object.assign(e, { status: v[1], tx_hash_or_checkout_ref: e.tx_hash_or_checkout_ref ?? v[2], error: v[3], evidence: JSON.parse(String(v[4])) });
    return { rows: [{ execution_id: v[0] }] };
  }
  if (sql.includes('FROM executions e JOIN approvals a ON a.id = e.approval_id')) {
    const e = Object.values(db.executions).find((x) => x.approval_id === v[0] && x.owner_id === v[1]);
    if (!e) return { rows: [] };
    const a = approvalOf(e);
    return { rows: [{ ...e, decision_id: a.decision_id, proposal_hash: a.proposal_hash, expires_at: a.expires_at }] };
  }
  if (sql.includes('SELECT id FROM approvals WHERE id = $1 AND owner_id = $2')) {
    const a = db.approvals[v[0] as string];
    return { rows: a && a.owner_id === v[1] ? [{ id: a.id }] : [] };
  }
  throw new Error(`unexpected SQL: ${sql}`);
}

vi.mock('../src/db/client.js', () => ({
  pool: { query: async (sql: string, v?: unknown[]) => query(sql, v) },
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

import { createQatomAuthorityRoutes } from '../src/routes/qatomAuthority.js';
import { qatomFingerprint, type QatomProposalV1 } from '../src/authority/qatom.js';
import { generateHmacSignature } from '../src/approvals/token.js';
import { proposalHash } from '../src/schemas/canonical.js';

const proposal: QatomProposalV1 = { version: 1, ownerId: 'owner_alice', intentId: 'int_q', intentVersion: 1, platform: 'qatom', itemId: 'item_q', sellerId: 'seller_q', money: { amount: '2500', scale: 3 }, asset: 'USD-TDN', chain: 'qatom-tdn', providerArgs: { sku: 'sku-1', quantity: 1 } };
// Computed with proposalFingerprint() from @trendie/contracts for the same proposal.
const CONTRACTS_FINGERPRINT = 'ae5c83d7e08e21a8e30363f5fb9e0ac1ad16c13169895132282989fed5731b63';
const CFG = { QATOM_SPEND_CEILING: '5000', QATOM_DAILY_LIMIT: undefined as string | undefined };

function seed() {
  const raw = { ...proposal, seller: 'seller_q', product: 'item_q', amount: '2500', currency: 'USD-TDN', destination: 'qatom-merchant', sourceRef: 'src_q' };
  const pHash = proposalHash(raw);
  const expires = new Date(Date.now() + 300_000);
  const approval: Row = { id: 'apr_q', execution_id: 'exe_q', decision_id: 'dec_q', intent_id: 'int_q', proposal_hash: pHash, key_id: 'unit', expires_at: expires, consumed_at: null, consumed_platform: null, owner_id: 'owner_alice', intent_version: 1, bound_platform: 'qatom', bound_asset: 'USD-TDN', bound_chain: 'qatom-tdn', bound_scale: 3 };
  approval.hmac_signature = generateHmacSignature({ approvalId: 'apr_q', executionId: 'exe_q', proposalHash: pHash, intentId: 'int_q', expiresAt: expires.toISOString(), ownerId: 'owner_alice', intentVersion: 1, platform: 'qatom', chain: 'qatom-tdn', asset: 'USD-TDN', scale: 3 }, 'unit');
  db.approvals = { apr_q: approval };
  db.intents = { int_q: { id: 'int_q', owner: 'owner_alice', remaining_uses: 1, expiry: new Date(Date.now() + 86_400_000), intent_version: 1, platform: 'qatom' } };
  db.proposals = { dec_q: { raw_payload: raw } };
  db.executions = {};
  db.spent = '0';
}

async function app(owner: string | null = 'owner_alice', role = 'adapter-qatom', cfg = CFG) {
  const a = Fastify();
  a.addHook('onRequest', async (req) => { req.callerRole = role as never; if (owner) req.callerOwnerId = owner; });
  await a.register(createQatomAuthorityRoutes(cfg));
  return a;
}
type App = Awaited<ReturnType<typeof app>>;

const claimBody = (p: QatomProposalV1 = proposal, extra: Record<string, unknown> = {}) => ({ version: 1, kind: 'claim', callerOwnerId: 'owner_alice', proposal: p, fingerprint: qatomFingerprint(p), ...extra });
const claim = (a: App, body: unknown = claimBody()) => a.inject({ method: 'POST', url: '/v1/qatom/approvals/apr_q/claim', payload: body as object });
const outcome = (a: App, result: Record<string, unknown>) => a.inject({ method: 'PUT', url: '/v1/qatom/executions/exe_q/outcome', payload: { version: 1, kind: 'outcome', result: { executionId: 'exe_q', platform: 'qatom', ...result } } });
const continuation = (a: App, providerReference = 'qref-1', approvalReference = 'apr_q') => a.inject({ method: 'POST', url: '/v1/qatom/executions/exe_q/continuation', payload: { version: 1, kind: 'continuation', callerOwnerId: 'owner_alice', approvalReference, providerReference } });
const untouched = () => { expect(db.approvals.apr_q!.consumed_at).toBeNull(); expect(db.intents.int_q!.remaining_uses).toBe(1); expect(db.executions).toEqual({}); };
const receipt = { itemId: 'item_q', money: { amount: '2500', scale: 3 }, receiptId: 'rcpt-1' };

beforeEach(() => { seed(); failOn.sql = ''; });

describe('Qatom authority V1 claim', () => {
  it('uses the same fingerprint as @trendie/contracts', () => {
    expect(qatomFingerprint(proposal)).toBe(CONTRACTS_FINGERPRINT);
  });

  it('claims the exact persisted proposal once and returns the adapter binding', async () => {
    const a = await app();
    const res = await claim(a);
    expect(res.statusCode).toBe(200);
    expect(res.json().binding).toEqual({ executionId: 'exe_q', ownerId: 'owner_alice', intentId: 'int_q', intentVersion: 1, proposalFingerprint: CONTRACTS_FINGERPRINT, platform: 'qatom', itemId: 'item_q', sellerId: 'seller_q', money: { amount: '2500', scale: 3 }, asset: 'USD-TDN', chain: 'qatom-tdn', providerArgs: { sku: 'sku-1', quantity: 1 }, expiresAt: (db.approvals.apr_q!.expires_at as Date).toISOString() });
    expect(db.intents.int_q!.remaining_uses).toBe(0);
    const replay = await claim(a);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('ALREADY_CLAIMED');
  });

  it.each([
    ['amount', { money: { amount: '1', scale: 3 } }],
    ['itemId', { itemId: 'item_other' }],
    ['sellerId', { sellerId: 'seller_other' }],
    ['providerArgs', { providerArgs: { sku: 'sku-2', quantity: 1 } }],
  ])('rejects a tampered %s before any write', async (_name, change) => {
    const res = await claim(await app(), claimBody({ ...proposal, ...change } as QatomProposalV1));
    expect(res.json().error.code).toBe('PROPOSAL_MISMATCH');
    untouched();
  });

  it('takes the owner from the key and blocks at the zero ceiling', async () => {
    expect((await claim(await app('owner_mallory'))).json().error.code).toBe('OWNER_MISMATCH');
    expect((await claim(await app(null))).json().error.code).toBe('OWNER_UNBOUND');
    expect((await claim(await app('owner_alice', 'adapter-qatom', { ...CFG, QATOM_SPEND_CEILING: '0' }))).json().error.code).toBe('SPEND_CEILING_ZERO');
    expect((await claim(await app('owner_alice', 'adapter-qatom', { ...CFG, QATOM_SPEND_CEILING: '2499' }))).json().error.code).toBe('SPEND_CEILING_EXCEEDED');
    expect((await claim(await app('owner_alice', 'adapter-goat'))).statusCode).toBe(403);
    untouched();
  });

  it('enforces the daily limit and rolls back on audit failure', async () => {
    db.spent = '3000';
    expect((await claim(await app('owner_alice', 'adapter-qatom', { ...CFG, QATOM_DAILY_LIMIT: '5000' }))).json().error.code).toBe('DAILY_LIMIT_EXCEEDED');
    failOn.sql = 'AUDIT';
    expect((await claim(await app())).statusCode).toBe(503);
    untouched();
  });
});

describe('Qatom authority V1 outcome and continuation', () => {
  it('never writes an outcome for an unclaimed approval', async () => {
    expect((await outcome(await app(), { status: 'succeeded', actual: receipt })).statusCode).toBe(404);
    untouched();
  });

  it('requires a matching receipt for success and keeps terminal results', async () => {
    const a = await app();
    await claim(a);
    expect((await outcome(a, { status: 'succeeded' })).statusCode).toBe(400);
    expect((await outcome(a, { status: 'succeeded', actual: { ...receipt, money: { amount: '9999', scale: 3 } } })).json().error.code).toBe('RECEIPT_MISMATCH');
    expect((await outcome(a, { status: 'succeeded', providerReference: 'qref-1', actual: receipt })).statusCode).toBe(200);
    expect((await outcome(a, { status: 'succeeded', providerReference: 'qref-1', actual: receipt })).statusCode).toBe(200);
    expect((await outcome(a, { status: 'failed', reason: 'late failure' })).json().error.code).toBe('OUTCOME_CONFLICT');
    expect(db.executions.exe_q!.status).toBe('succeeded');
  });

  it('runs one continuation per provider approval without using the intent again', async () => {
    const a = await app();
    await claim(a);
    expect((await outcome(a, { status: 'pending_approval', providerReference: 'qref-1' })).statusCode).toBe(200);
    expect((await continuation(a, 'qref-other')).json().error.code).toBe('PROPOSAL_MISMATCH');
    expect((await continuation(a, 'qref-1', 'apr_other')).statusCode).toBe(404);
    const ok = await continuation(a);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().binding).toMatchObject({ executionId: 'exe_q', providerReference: 'qref-1', proposalFingerprint: CONTRACTS_FINGERPRINT });
    expect((await continuation(a)).json().error.code).toBe('ALREADY_CLAIMED');
    expect(db.intents.int_q!.remaining_uses).toBe(0);
    expect((await outcome(a, { status: 'unknown', providerReference: 'qref-2' })).json().error.code).toBe('OUTCOME_CONFLICT');
    expect((await outcome(a, { status: 'blocked', reason: 'late' })).json().error.code).toBe('OUTCOME_CONFLICT');
  });

  it('hides another owner\'s execution and supports read-only recovery', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/v1/qatom/approvals/apr_q/execution' })).json().kind).toBe('unclaimed_observation');
    await claim(a);
    const rec = await a.inject({ method: 'GET', url: '/v1/qatom/approvals/apr_q/execution' });
    expect(rec.json()).toMatchObject({ kind: 'execution_record', executionId: 'exe_q', status: 'submitting', result: null });
    const b = await app('owner_mallory');
    expect((await outcome(b, { status: 'failed', reason: 'x' })).statusCode).toBe(404);
    expect((await b.inject({ method: 'GET', url: '/v1/qatom/approvals/apr_q/execution' })).statusCode).toBe(404);
  });
});
