import { afterEach, describe, expect, it, vi } from 'vitest';
import { callGateway, isSameOriginJsonWrite } from './gateway-server';

const req = (headers: Record<string, string>, url = 'http://localhost:3000/api/verify') =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } });

describe('isSameOriginJsonWrite', () => {
  it('accepts the public origin behind a proxy that rewrites request.url', () => {
    expect(isSameOriginJsonWrite(req({ origin: 'https://trendie-eta.vercel.app', 'x-forwarded-host': 'trendie-eta.vercel.app', 'x-forwarded-proto': 'https' }))).toBe(true);
  });
  it('accepts a direct same-origin request', () => {
    expect(isSameOriginJsonWrite(req({ origin: 'http://localhost:3000' }))).toBe(true);
  });
  it('rejects a cross-site origin, a missing origin, and a non-JSON body', () => {
    expect(isSameOriginJsonWrite(req({ origin: 'https://evil.example', 'x-forwarded-host': 'trendie-eta.vercel.app', 'x-forwarded-proto': 'https' }))).toBe(false);
    expect(isSameOriginJsonWrite(req({}))).toBe(false);
    expect(isSameOriginJsonWrite(new Request('http://localhost:3000/x', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'text/plain' } }))).toBe(false);
  });
});

describe('gateway URL policy', () => {
  afterEach(() => vi.unstubAllEnvs());
  const env = (extra: Record<string, string>) => {
    vi.stubEnv('API_KEY_DASHBOARD', 'd'); vi.stubEnv('API_KEY_AGENT', 'a');
    for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  };
  it('refuses a remote gateway that is not allowlisted, and plain HTTP remotes', async () => {
    env({ GATEWAY_BASE_URL: 'https://gw.example.com', GATEWAY_ALLOWED_HOSTS: '' });
    await expect(callGateway('dashboard', '/intents' as never)).rejects.toThrow(/GATEWAY_ALLOWED_HOSTS/);
    env({ GATEWAY_BASE_URL: 'http://gw.example.com', GATEWAY_ALLOWED_HOSTS: 'gw.example.com' });
    await expect(callGateway('dashboard', '/intents' as never)).rejects.toThrow(/GATEWAY_ALLOWED_HOSTS/);
  });
  it('has no admin key fallback', async () => {
    env({ GATEWAY_BASE_URL: 'http://127.0.0.1:3000', API_KEY_ADMIN: '' });
    await expect(callGateway('admin', '/intents' as never)).rejects.toThrow(/API_KEY_ADMIN/);
  });
});
