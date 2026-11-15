import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackboardModel } from '../backboard.js';

const input = () => ({
  task: 'buy Product A',
  listings: [{ itemId: 'item-1', sellerId: 'Supplier A', title: 'Product A', amount: '100', scale: 6, asset: 'USDC' }],
  signal: new AbortController().signal,
  maxTurns: 1,
  maxToolCalls: 1,
});
const proposal = { itemId: 'item-1', sellerId: 'Supplier A', money: { amount: '100', scale: 6 }, asset: 'USDC', providerArgs: { recipient: '0xabc' } };

describe('Backboard adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires an API key', () => {
    vi.stubEnv('BACKBOARD_API_KEY', '');
    expect(() => createBackboardModel()).toThrow('BACKBOARD_API_KEY is required');
  });

  it('sends the key as X-API-Key and parses the proposal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ content: JSON.stringify(proposal) }) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await createBackboardModel({ apiKey: 'bb-test-key-123' }).propose(input());
    expect(result).toEqual(proposal);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.backboard.io/api/threads/messages');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('bb-test-key-123');
    expect(JSON.parse(init.body as string).stream).toBe(false);
  });

  it('rejects HTTP errors and invalid output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(createBackboardModel({ apiKey: 'bb-test-key-123' }).propose(input())).rejects.toThrow('HTTP 401');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ content: '{"itemId":"x"}' }) }));
    await expect(createBackboardModel({ apiKey: 'bb-test-key-123' }).propose(input())).rejects.toThrow('invalid');
  });
});
