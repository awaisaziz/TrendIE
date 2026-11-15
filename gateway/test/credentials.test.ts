/**
 * Credential hardening tests (offline, no database).
 *
 * Covers service-key rotation and revocation, production secret strength,
 * the approval HMAC key ring, request throttling, and the separation of the
 * review-approver role from the dashboard role.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHmacKeyRing, loadConfig, type Config } from '../src/config.js';
import { createKeyRing, fingerprintKey } from '../src/auth/keyRing.js';
import { createRateLimiter } from '../src/auth/rateLimit.js';
import { generateHmacSignature, verifyHmacSignature, type ApprovalPayload } from '../src/approvals/token.js';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';

const strong = (label: string) => `${label}-${'x'.repeat(40)}`;

const baseEnv: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  CORS_ORIGINS: 'http://localhost:3000',
  TEST_DATABASE_URL: 'postgresql://fake@127.0.0.1:5432/gateway_test',
  APPROVAL_HMAC_SECRET: strong('hmac-current'),
  APPROVAL_KEY_ID: 'k2',
  API_KEY_AGENT: strong('agent'),
  API_KEY_ADAPTER_GOAT: strong('goat'),
  API_KEY_ADAPTER_QATOM: strong('qatom'),
  API_KEY_DASHBOARD: strong('dashboard'),
  API_KEY_ADMIN: strong('admin'),
  API_KEY_DASHBOARD_OWNER_ID: 'owner_alice',
  API_KEY_ADMIN_OWNER_ID: 'owner_alice',
  API_KEY_AGENT_OWNER_ID: 'owner_alice',
};

const prodEnv = { ...baseEnv, NODE_ENV: 'production', TEST_DATABASE_URL: undefined, DATABASE_URL: 'postgresql://fake@127.0.0.1:5432/gateway' };

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function cfg(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({ ...baseEnv, ...overrides });
}

describe('service key ring', () => {
  it('maps each current key to exactly its role', () => {
    const ring = createKeyRing(cfg());
    expect(ring.resolve(baseEnv.API_KEY_AGENT!)?.role).toBe('agent');
    expect(ring.resolve(baseEnv.API_KEY_ADMIN!)?.role).toBe('admin');
    expect(ring.resolve('not-a-key')).toBeUndefined();
    expect(ring.resolve('')).toBeUndefined();
  });

  it('accepts a previous key during rotation overlap', () => {
    const old = strong('agent-old');
    const ring = createKeyRing(cfg({ API_KEY_AGENT_PREVIOUS: old }));
    expect(ring.resolve(old)?.role).toBe('agent');
    expect(ring.resolve(baseEnv.API_KEY_AGENT!)?.role).toBe('agent');
  });

  it('rejects a revoked key even though it is still configured', () => {
    const ring = createKeyRing(cfg({ API_KEYS_REVOKED_SHA256: sha256(baseEnv.API_KEY_AGENT!) }));
    expect(ring.resolve(baseEnv.API_KEY_AGENT!)).toBeUndefined();
    expect(ring.resolve(baseEnv.API_KEY_ADMIN!)?.role).toBe('admin');
  });

  it('does not retain raw key values and rejects oversized input', () => {
    const ring = createKeyRing(cfg());
    expect(JSON.stringify([...ring.fingerprints()])).not.toContain(baseEnv.API_KEY_AGENT!);
    expect(fingerprintKey(baseEnv.API_KEY_AGENT!)).toBe(sha256(baseEnv.API_KEY_AGENT!));
    expect(ring.resolve('k'.repeat(10_000))).toBeUndefined();
  });

  it('maps the optional approver key to the approver role', () => {
    const approver = strong('approver');
    expect(createKeyRing(cfg({ API_KEY_APPROVER: approver })).resolve(approver)?.role).toBe('approver');
  });
});

describe('credential configuration', () => {
  it('rejects a key reused across current and previous slots without echoing it', () => {
    let message = '';
    try { cfg({ API_KEY_ADMIN_PREVIOUS: baseEnv.API_KEY_AGENT }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('API key values must be unique');
    expect(message).not.toContain(baseEnv.API_KEY_AGENT!);
  });

  it('rejects malformed revocation fingerprints', () => {
    expect(() => cfg({ API_KEYS_REVOKED_SHA256: 'not-a-hash' })).toThrow('API_KEYS_REVOKED_SHA256');
  });

  it('accepts strong secrets in production', () => {
    expect(() => loadConfig(prodEnv)).not.toThrow();
  });

  it.each([
    ['short service key', { API_KEY_AGENT: 'agent-secret-key-123' }],
    ['placeholder service key', { API_KEY_AGENT: `replace-with-${'a'.repeat(40)}` }],
    ['development HMAC secret', { APPROVAL_HMAC_SECRET: 'dev-hmac-secret-min-32-characters-long-key-12345' }],
    ['HMAC secret reused as a service key', { APPROVAL_HMAC_SECRET: prodEnv.API_KEY_ADMIN }],
    ['short previous service key', { API_KEY_AGENT_PREVIOUS: 'old-agent' }],
  ])('refuses to start in production with a %s', (_label, overrides) => {
    let message = '';
    try { loadConfig({ ...prodEnv, ...overrides }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/production/i);
    for (const value of Object.values(overrides)) expect(message).not.toContain(value as string);
  });

  it('parses previous HMAC keys and rejects malformed or duplicate entries', () => {
    const previous = strong('hmac-previous');
    const ring = buildHmacKeyRing(cfg({ APPROVAL_HMAC_PREVIOUS_KEYS: `k1:${previous}` }));
    expect([...ring.keys()].sort()).toEqual(['k1', 'k2']);
    expect(() => cfg({ APPROVAL_HMAC_PREVIOUS_KEYS: 'k1-without-secret' })).toThrow('APPROVAL_HMAC_PREVIOUS_KEYS');
    expect(() => cfg({ APPROVAL_HMAC_PREVIOUS_KEYS: 'k1:too-short' })).toThrow('APPROVAL_HMAC_PREVIOUS_KEYS');
    expect(() => cfg({ APPROVAL_HMAC_PREVIOUS_KEYS: `k2:${previous}` })).toThrow('APPROVAL_HMAC_PREVIOUS_KEYS');
  });
});

describe('approval HMAC key ring', () => {
  const payload: ApprovalPayload = {
    approvalId: 'apr_ring',
    executionId: 'exe_ring',
    proposalHash: 'ab'.repeat(32),
    intentId: 'int_ring',
    expiresAt: '2027-01-01T00:00:00.000Z',
  };
  const ring = new Map([
    ['k1', strong('hmac-previous')],
    ['k2', strong('hmac-current')],
  ]);

  it('verifies an approval signed with a previous key by its stored key id', () => {
    const oldSignature = generateHmacSignature(payload, 'k1', ring);
    expect(verifyHmacSignature(payload, oldSignature, 'k1', ring)).toBe(true);
  });

  it('does not accept a signature under a different key id', () => {
    const oldSignature = generateHmacSignature(payload, 'k1', ring);
    expect(verifyHmacSignature(payload, oldSignature, 'k2', ring)).toBe(false);
  });

  it('fails closed for a key id that is no longer loaded', () => {
    const oldSignature = generateHmacSignature(payload, 'k1', ring);
    const rotatedOut = new Map([['k2', ring.get('k2')!]]);
    expect(verifyHmacSignature(payload, oldSignature, 'k1', rotatedOut)).toBe(false);
    expect(() => generateHmacSignature(payload, 'k1', rotatedOut)).toThrow('Unknown approval signing key');
  });
});

describe('rate limiter', () => {
  it('allows up to the limit, then blocks until the window resets', () => {
    let now = 1_000;
    const limiter = createRateLimiter({ max: 2, windowMs: 1_000, now: () => now });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(true);
    const blocked = limiter.hit('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.hit('b').allowed).toBe(true);
    now += 1_001;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('reports a blocked identity without counting a new hit', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000, now: () => 0 });
    expect(limiter.isBlocked('a')).toBe(false);
    limiter.hit('a');
    expect(limiter.isBlocked('a')).toBe(true);
  });

  it('bounds the number of tracked identities', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => 0, maxEntries: 3 });
    for (let i = 0; i < 10; i += 1) limiter.hit(`id-${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});

describe('gateway credential enforcement (offline)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('honours rotation and revocation at the HTTP boundary', async () => {
    const old = strong('dashboard-old');
    const app = await buildServer(cfg({ API_KEY_DASHBOARD_PREVIOUS: old, API_KEYS_REVOKED_SHA256: sha256(baseEnv.API_KEY_AGENT!) }));
    try {
      const rotated = await app.inject({ method: 'GET', url: '/intents?limit=-1', headers: { 'x-api-key': old } });
      expect(rotated.statusCode).toBe(400);
      const revoked = await app.inject({ method: 'POST', url: '/verify', headers: { 'x-api-key': baseEnv.API_KEY_AGENT! }, payload: {} });
      expect(revoked.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('locks out a client after repeated invalid keys, without touching the database', async () => {
    const query = vi.spyOn(pool, 'query');
    const app = await buildServer(cfg({ AUTH_FAILURE_MAX: '3' }));
    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await app.inject({ method: 'GET', url: '/intents', headers: { 'x-api-key': `guess-${i}` } });
        expect(res.statusCode).toBe(401);
      }
      const locked = await app.inject({ method: 'GET', url: '/intents?limit=-1', headers: { 'x-api-key': baseEnv.API_KEY_DASHBOARD! } });
      expect(locked.statusCode).toBe(429);
      expect(locked.headers['retry-after']).toBeDefined();
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(query).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('throttles a single key that exceeds its request budget', async () => {
    const app = await buildServer(cfg({ RATE_LIMIT_MAX: '2' }));
    try {
      const call = () => app.inject({ method: 'GET', url: '/intents?limit=-1', headers: { 'x-api-key': baseEnv.API_KEY_DASHBOARD! } });
      expect((await call()).statusCode).toBe(400);
      expect((await call()).statusCode).toBe(400);
      expect((await call()).statusCode).toBe(429);
      const other = await app.inject({ method: 'POST', url: '/verify', headers: { 'x-api-key': baseEnv.API_KEY_AGENT! }, payload: {} });
      expect(other.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it('does not let the dashboard key resolve reviews', async () => {
    const connect = vi.spyOn(pool, 'connect');
    const approver = strong('approver');
    const app = await buildServer(cfg({ API_KEY_APPROVER: approver, API_KEY_APPROVER_OWNER_ID: 'owner_alice' }));
    const payload = { resolution: 'approve', notes: 'synthetic review' };
    try {
      const dashboard = await app.inject({ method: 'POST', url: '/reviews/dec_x/resolve', headers: { 'x-api-key': baseEnv.API_KEY_DASHBOARD! }, payload });
      expect(dashboard.statusCode).toBe(403);
      expect(connect).not.toHaveBeenCalled();
      const invalidBody = await app.inject({ method: 'POST', url: '/reviews/dec_x/resolve', headers: { 'x-api-key': approver }, payload: {} });
      expect(invalidBody.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it('does not let the approver key create intents', async () => {
    const approver = strong('approver');
    const app = await buildServer(cfg({ API_KEY_APPROVER: approver, API_KEY_APPROVER_OWNER_ID: 'owner_alice' }));
    try {
      const res = await app.inject({ method: 'POST', url: '/intents', headers: { 'x-api-key': approver }, payload: {} });
      expect(res.statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
