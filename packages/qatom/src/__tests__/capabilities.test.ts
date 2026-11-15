import { describe, expect, it } from 'vitest';
import { collectCapabilities } from '../capabilities.js';

function factory(listTools: () => Promise<unknown>) {
  return async () => ({ listTools, async close() {} }) as never;
}

describe('sanitized Qatom capability evidence', () => {
  it('fingerprints schemas deterministically and marks checkout guarantees unknown', async () => {
    const tools = [{ name: 'agent_checkout', inputSchema: { type: 'object', properties: { item_id: { type: 'string' } } }, annotations: { readOnlyHint: false } }];
    const run = () => collectCapabilities({ observedAt: '2026-11-15T00:00:00.000Z', clientFactory: factory(async () => tools as never) });
    const a = await run(); const b = await run();
    expect(a).toEqual(b);
    expect(a.checkout).toEqual({ toolPresent: true, atomicPriceCurrencyBinding: 'unknown', receiptGuarantee: 'unknown' });
    expect(a.tools[0].readOnly).toBe(false);
    const reordered = await collectCapabilities({ clientFactory: factory(async () => [{ name: 'agent_checkout', inputSchema: { properties: { item_id: { type: 'string' } }, type: 'object' } }] as never) });
    expect(reordered.tools[0].schemaFingerprint).toBe(a.tools[0].schemaFingerprint);
  });

  it('records sanitized auth challenges without leaking error text', async () => {
    let received: unknown;
    const evidence = await collectCapabilities({ token: 'secret-marker', endpoint: 'https://example.test/mcp?region=ca', clientFactory: (async (input) => { received = input; return { listTools: async () => { throw Object.assign(new Error('secret'), { status: 401 }); }, close: async () => {} }; }) as never });
    expect(evidence).toMatchObject({ tokenPresent: true, accessVerified: false, status: 401, authChallenge: true, toolInventory: 'unavailable' });
    expect(evidence.endpoint).toBe('https://example.test/mcp');
    expect(received).toMatchObject({ endpoint: 'https://example.test/mcp?region=ca' });
    expect(JSON.stringify(evidence)).not.toMatch(/secret-marker|WWW-Authenticate|provider\.test/);
  });

  it('handles missing checkout tools and rejects malformed inventory', async () => {
    const missing = await collectCapabilities({ clientFactory: factory(async () => [{ name: 'catalog_search', inputSchema: {} }] as never) });
    expect(missing.checkout.toolPresent).toBe(false);
    const malformed = await collectCapabilities({ clientFactory: factory(async () => { throw new Error('malformed inventory'); }) });
    expect(malformed.toolInventory).toBe('unavailable');
  });

  it('marks oversized schemas without retaining schema text or annotation claims', async () => {
    const oversized = await collectCapabilities({ clientFactory: factory(async () => [{ name: 'agent_checkout', inputSchema: { description: 'private-schema-marker'.repeat(10_000) }, annotations: { readOnlyHint: true } }] as never) });
    expect(oversized.toolInventory).toBe('oversized');
    expect(oversized.tools).toEqual([]);
    expect(oversized.checkout).toEqual({ toolPresent: false, atomicPriceCurrencyBinding: 'unknown', receiptGuarantee: 'unknown' });
    expect(JSON.stringify(oversized)).not.toContain('private-schema-marker');
  });

  it('rejects accessor schemas without invoking getters and rejects malformed names', async () => {
    let called = false;
    const schema = Object.defineProperty({}, 'type', { enumerable: true, get() { called = true; return 'object'; } });
    const accessor = await collectCapabilities({ clientFactory: factory(async () => [{ name: 'okay', inputSchema: schema }] as never) });
    expect(called).toBe(false);
    expect(accessor.toolInventory).toBe('malformed');
    const malformed = await collectCapabilities({ clientFactory: factory(async () => [{ name: 'invalid/tool', inputSchema: {} }] as never) });
    expect(malformed.toolInventory).toBe('malformed');
    expect(malformed.tools).toEqual([]);
  });

  it('bounds inventory size and total evidence', async () => {
    const many = await collectCapabilities({ clientFactory: factory(async () => Array.from({ length: 201 }, (_, i) => ({ name: `tool${i}`, inputSchema: {} })) as never) });
    expect(many.toolInventory).toBe('oversized');
    expect(many.tools).toEqual([]);
  });
});
