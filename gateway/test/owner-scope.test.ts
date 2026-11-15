import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { config, loadConfig } from '../src/config.js';
import { pool } from '../src/db/client.js';

const dashboard = { 'x-api-key': config.API_KEY_DASHBOARD };

describe('owner scope comes from the API key', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['/intents', '/history/decisions', '/history/executions', '/history/review-queue', '/reviews', '/decisions', '/executions', '/audit'])(
    'filters %s by the key owner in SQL',
    async (url) => {
      const query = vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => ({ rows: /COUNT\(/i.test(sql) ? [{ count: '0' }] : [] })) as never);
      const app = await buildServer();
      try {
        const res = await app.inject({ method: 'GET', url, headers: dashboard });
        expect(res.statusCode).toBe(200);
        expect(query).toHaveBeenCalled();
        for (const call of query.mock.calls) expect(call[1]).toContain('owner_alice');
      } finally {
        await app.close();
      }
    }
  );

  it('refuses another owner named in the query', async () => {
    const query = vi.spyOn(pool, 'query');
    const app = await buildServer();
    try {
      for (const url of ['/intents?owner=owner_mallory', '/history/executions?owner=owner_mallory', '/executions?owner=owner_mallory']) {
        const res = await app.inject({ method: 'GET', url, headers: dashboard });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('OWNER_MISMATCH');
      }
      expect(query).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('refuses a key with no bound owner', async () => {
    const query = vi.spyOn(pool, 'query');
    const cfg = loadConfig({ ...process.env, API_KEY_DASHBOARD_OWNER_ID: '' });
    const app = await buildServer(cfg);
    try {
      const res = await app.inject({ method: 'GET', url: '/intents', headers: dashboard });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('OWNER_UNBOUND');
      expect(query).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('refuses to create an intent for another owner', async () => {
    const connect = vi.spyOn(pool, 'connect');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/intents',
        headers: dashboard,
        payload: { id: 'int_x', owner: 'owner_mallory', seller: 's', product: 'p', maxAmount: '1', currency: 'USDC', allowedDestinations: ['d'], expiry: new Date(Date.now() + 60_000).toISOString(), remainingUses: 1, createdAt: new Date().toISOString() },
      });
      expect(res.statusCode).toBe(403);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
