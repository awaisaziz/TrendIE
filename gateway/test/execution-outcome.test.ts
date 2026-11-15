import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/client.js';
import { canTransition, sameOutcome } from '../src/executions/state.js';
import type { PaymentResult } from '../src/schemas/contracts.js';

const payment: PaymentResult = { executionId: 'exec-test', platform: 'qatom', status: 'succeeded', txHashOrCheckoutRef: 'synthetic-receipt', error: null, evidence: { checked: true } };
const approved = { id: 'approval-test', owner_id: 'owner_alice', consumed_at: new Date(), consumed_platform: 'qatom' };

async function postResult(options: { approval?: object | null; existing?: object; body?: PaymentResult; key?: string; auditFailure?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT * FROM approvals')) return { rows: options.approval === null ? [] : [options.approval ?? approved] };
    if (sql.includes('SELECT * FROM executions')) return { rows: options.existing ? [options.existing] : [] };
    if (sql.includes('INSERT INTO audit_log')) {
      if (options.auditFailure) throw new Error('synthetic audit failure');
      return { rows: [{ id: 1, row_hash: 'synthetic-hash' }] };
    }
    return { rows: [] };
  });
  const release = vi.fn();
  vi.spyOn(pool, 'connect').mockImplementation(async () => ({ query, release }) as unknown as pg.PoolClient);
  const app = await buildServer();
  try {
    const response = await app.inject({ method: 'POST', url: '/executions/exec-test/result', headers: { 'x-api-key': options.key ?? config.API_KEY_ADAPTER_QATOM }, payload: options.body ?? payment });
    return { response, queries: query.mock.calls.map(([sql]) => sql), release };
  } finally {
    await app.close();
  }
}

const stored = (status: string, overrides: object = {}) => ({ status, platform: 'qatom', tx_hash_or_checkout_ref: payment.txHashOrCheckoutRef, error: null, evidence: payment.evidence, ...overrides });

describe('execution outcome transaction boundary (offline database double)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { approval: null, code: 404 },
    { approval: { ...approved, consumed_at: null }, code: 403 },
    { approval: { ...approved, consumed_platform: null }, code: 403 },
    { approval: { ...approved, consumed_platform: 'goat' }, code: 403 },
    { key: config.API_KEY_ADAPTER_GOAT, code: 403 },
  ])('rejects an absent, unconsumed or cross-platform approval: $code', async ({ code, ...options }) => {
    const result = await postResult(options);
    expect(result.response.statusCode).toBe(code);
    expect(result.queries.some((sql) => /^\s*(INSERT|UPDATE)\b/.test(sql))).toBe(false);
  });

  it('returns an identical terminal result without another write or audit', async () => {
    const result = await postResult({ existing: stored('succeeded') });
    expect(result.response.statusCode).toBe(200);
    expect(result.queries.some((sql) => /INSERT|UPDATE executions/.test(sql))).toBe(false);
  });

  it('persists and audits a verified resolution of unknown in one transaction', async () => {
    const result = await postResult({ existing: stored('unknown') });
    expect(result.response.statusCode).toBe(200);
    expect(result.queries[0]).toBe('BEGIN');
    expect(result.queries[1]).toContain('approvals WHERE execution_id = $1 FOR UPDATE');
    expect(result.queries.findIndex((sql) => sql.includes('UPDATE executions'))).toBeLessThan(result.queries.findIndex((sql) => sql.includes('INSERT INTO audit_log')));
    expect(result.queries.at(-1)).toBe('COMMIT');
  });

  it.each([
    { existing: stored('failed') },
    { existing: stored('unknown', { tx_hash_or_checkout_ref: 'different-reference' }) },
    { existing: stored('unknown'), body: { ...payment, status: 'blocked' as const } },
    { existing: stored('unknown'), body: { ...payment, evidence: {} } },
  ])('rejects terminal conflicts, reference mutation or unsupported certainty', async (options) => {
    const result = await postResult(options);
    expect(result.response.statusCode).toBe(409);
    expect(result.queries.some((sql) => sql.includes('UPDATE executions'))).toBe(false);
  });

  it.each(['pending_approval', 'submitting', 'pending', 'unknown', 'blocked'] as const)('records initial %s without relabeling it', async (status) => {
    const result = await postResult({ body: { ...payment, status, txHashOrCheckoutRef: null, evidence: {} } });
    expect(result.response.statusCode).toBe(200);
    expect(result.response.json().status).toBe(status);
    expect(result.queries.some((sql) => sql.includes('INSERT INTO executions'))).toBe(true);
  });

  it('rolls back the execution write if audit persistence fails', async () => {
    const result = await postResult({ auditFailure: true });
    expect(result.response.statusCode).toBe(500);
    expect(result.queries).toContain('ROLLBACK');
    expect(result.queries).not.toContain('COMMIT');
    expect(result.release).toHaveBeenCalledOnce();
  });

  it('accepts a 512-character provider reference and rejects 513', async () => {
    const accepted = await postResult({ body: { ...payment, txHashOrCheckoutRef: 'r'.repeat(512) } });
    expect(accepted.response.statusCode).toBe(200);
    vi.restoreAllMocks();
    const denied = await postResult({ body: { ...payment, txHashOrCheckoutRef: 'r'.repeat(513) } });
    expect(denied.response.statusCode).toBe(400);
    expect(denied.queries).toEqual([]);
  });

  it('treats evidence key order as immaterial and permits read-only reconciliation progress', () => {
    const left = { ...payment, evidence: { a: 1, b: 2 } };
    expect(sameOutcome(left, { ...left, evidence: { b: 2, a: 1 } })).toBe(true);
    expect(canTransition('unknown', { ...payment, status: 'pending', evidence: {} })).toBe(true);
    expect(canTransition('succeeded', { ...payment, status: 'unknown' })).toBe(false);
  });
});
