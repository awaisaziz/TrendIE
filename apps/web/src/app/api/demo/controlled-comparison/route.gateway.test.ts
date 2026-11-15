import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
  configured: true,
  calls: [] as Array<{ role: string; path: string; body?: unknown }>,
  verify: { ok: true, status: 200, data: { id: 'dec_live_1', decision: 'reject', reasonCodes: ['SELLER_MISMATCH', 'DESTINATION_NOT_ALLOWED'] } } as { ok: boolean; status: number; data: unknown },
}));

vi.mock('@/lib/gateway-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gateway-server')>();
  return {
    ...actual,
    getDemoOwnerId: () => {
      if (!gateway.configured) throw new actual.GatewayConfigurationError('Set a local DEMO_OWNER_ID before using gateway-backed features.');
      return 'owner_alice';
    },
    callGateway: vi.fn(async (role: string, path: string, options: { body?: unknown } = {}) => {
      gateway.calls.push({ role, path, body: options.body });
      if (path.startsWith('/intents/')) return { ok: false, status: 404, data: {} };
      if (path === '/intents') return { ok: true, status: 201, data: {} };
      if (path === '/verify') return gateway.verify;
      throw new Error(`unexpected path ${path}`);
    }),
  };
});

import { POST } from './route';

const run = (scenario: 'attack' | 'clean') => POST(new Request('http://localhost:3000/api/demo/controlled-comparison', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
  body: JSON.stringify({ scenario }),
}));

beforeEach(() => {
  gateway.configured = true;
  gateway.calls = [];
  gateway.verify = { ok: true, status: 200, data: { id: 'dec_live_1', decision: 'reject', reasonCodes: ['SELLER_MISMATCH', 'DESTINATION_NOT_ALLOWED'] } };
});

describe('controlled comparison route', () => {
  it('asks the live gateway and returns its decision id', async () => {
    const res = await run('attack');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protectedPolicy).toMatchObject({ source: 'gateway', decisionId: 'dec_live_1', decision: 'reject', reasons: ['SELLER_MISMATCH', 'DESTINATION_NOT_ALLOWED'], providerDispatch: false, outcome: 'NOT_SETTLED' });
    const created = gateway.calls.find((c) => c.path === '/intents');
    expect(created?.body).toMatchObject({ owner: 'owner_alice', seller: 'trusted-seller', product: 'fixture-item', maxAmount: '1000000', currency: 'USDC', allowedDestinations: ['fixture-trusted-recipient'] });
    const verify = gateway.calls.find((c) => c.path === '/verify');
    expect(verify?.role).toBe('agent');
    expect(verify?.body).toMatchObject({ proposal: { seller: 'attacker', product: 'fixture-item', amount: '1250000', currency: 'USDC', destination: 'fixture-attacker' } });
    expect((verify?.body as { inspection: { flags: unknown[] } }).inspection.flags.length).toBeGreaterThan(0);
  });

  it('shows a gateway review decision for the matching purchase', async () => {
    gateway.verify = { ok: true, status: 200, data: { id: 'dec_live_2', decision: 'review', reasonCodes: ['INJECTION_FLAGGED'] } };
    const body = await (await run('clean')).json();
    expect(body.protectedPolicy).toMatchObject({ source: 'gateway', decision: 'review', decisionId: 'dec_live_2' });
  });

  it('uses the labelled fixture policy only when no gateway is configured', async () => {
    gateway.configured = false;
    const body = await (await run('attack')).json();
    expect(body.protectedPolicy).toMatchObject({ source: 'fixture', decision: 'reject' });
    expect(body.protectedPolicy.decisionId).toBeUndefined();
    expect(gateway.calls).toEqual([]);
  });

  it('fails instead of falling back when the configured gateway errors', async () => {
    gateway.verify = { ok: false, status: 503, data: {} };
    const res = await run('attack');
    expect(res.status).toBe(502);
  });
});
