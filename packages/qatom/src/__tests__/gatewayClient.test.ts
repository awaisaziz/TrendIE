import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHttpGatewayAuthority } from '../gatewayClient.js';
import { proposalFingerprint, type PurchaseProposal } from '@trendie/contracts';

describe('HTTP GatewayAuthority for adapter-qatom', () => {
  const proposal: PurchaseProposal = {
    version: 1,
    ownerId: 'user_1',
    intentId: 'int_01',
    intentVersion: 1,
    platform: 'qatom',
    itemId: 'item_1',
    sellerId: 'supplier_a',
    money: { amount: '4500', scale: 3 },
    asset: 'USD-TDN',
    chain: 'qatom',
    providerArgs: { destination: 'supplier_a', sourceRef: 'listing:item_1' },
  };

  afterEach(() => vi.unstubAllGlobals());

  it('fails closed without making HTTP claim or outcome calls', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const authority = createHttpGatewayAuthority({ baseUrl: 'http://localhost:3000', apiKey: 'test-key' });

    const claim = await authority.claimExecution({
      caller: { ownerId: 'user_1' }, approvalReference: 'apr_test_123', proposal,
      fingerprint: proposalFingerprint(proposal),
    });

    expect(claim).toMatchObject({ kind: 'denied' });
    await expect(authority.recordOutcome('exec_1', {
      executionId: 'exec_1', platform: 'qatom', status: 'unknown',
    })).rejects.toThrow(/unsupported/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on continuation without making an HTTP claim call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const authority = createHttpGatewayAuthority({ baseUrl: 'http://localhost:3000', apiKey: 'test-key' });
    const result = await authority.claimContinuation({
      caller: { ownerId: 'user_1' }, approvalReference: 'apr_test_123',
      executionId: 'exec_1', providerReference: 'provider-ref',
    });

    expect(result).toMatchObject({ kind: 'denied' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HTTP GatewayAuthority for adapter-qatom (active mode)', () => {
  const proposal: PurchaseProposal = { version: 1, ownerId: 'owner_alice', intentId: 'int_q', intentVersion: 1, platform: 'qatom', itemId: 'item_q', sellerId: 'seller_q', money: { amount: '2500', scale: 3 }, asset: 'USD-TDN', chain: 'qatom-tdn', providerArgs: { sku: 'sku-1', quantity: 1 } };
  const fingerprint = proposalFingerprint(proposal);
  const binding = { executionId: 'exe_q', ownerId: 'owner_alice', intentId: 'int_q', intentVersion: 1, proposalFingerprint: fingerprint, platform: 'qatom', itemId: 'item_q', sellerId: 'seller_q', money: { amount: '2500', scale: 3 }, asset: 'USD-TDN', chain: 'qatom-tdn', providerArgs: { sku: 'sku-1', quantity: 1 }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const make = (fetchFn: typeof fetch) => createHttpGatewayAuthority({ baseUrl: 'http://127.0.0.1:3000', apiKey: 'k', mode: 'active', fetchFn });
  const claimInput = { caller: { ownerId: 'owner_alice' }, approvalReference: 'apr_q', proposal, fingerprint };

  it('posts the claim and returns the gateway binding', async () => {
    const fetchFn = reply(200, { version: 1, kind: 'claim', status: 'claimed', binding });
    const result = await make(fetchFn as never).claimExecution(claimInput);
    expect(result).toEqual({ kind: 'claimed', binding });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/v1/qatom/approvals/apr_q/claim');
    expect(JSON.parse(String(init.body))).toMatchObject({ version: 1, kind: 'claim', callerOwnerId: 'owner_alice', fingerprint });
  });

  it('denies on gateway errors, extra fields and malformed bindings', async () => {
    expect((await make(reply(409, { version: 1, error: { code: 'ALREADY_CLAIMED' } }) as never).claimExecution(claimInput)).kind).toBe('denied');
    expect((await make(reply(200, { version: 1, kind: 'claim', status: 'claimed', binding, extra: 1 }) as never).claimExecution(claimInput)).kind).toBe('denied');
    expect((await make(reply(200, { version: 1, kind: 'claim', status: 'claimed', binding: { ...binding, platform: 'goat' } }) as never).claimExecution(claimInput)).kind).toBe('denied');
    expect((await make(vi.fn(async () => { throw new Error('network'); }) as never).claimExecution(claimInput)).kind).toBe('denied');
  });

  it('requires a matching outcome acknowledgement', async () => {
    const result = { executionId: 'exe_q', platform: 'qatom' as const, status: 'unknown' as const };
    await expect(make(reply(200, { version: 1, kind: 'outcome_ack', status: 'persisted', executionId: 'exe_q', resultStatus: 'unknown' }) as never).recordOutcome('exe_q', result)).resolves.toBeUndefined();
    await expect(make(reply(200, { version: 1, kind: 'outcome_ack', status: 'persisted', executionId: 'exe_q', resultStatus: 'succeeded' }) as never).recordOutcome('exe_q', result)).rejects.toThrow();
    await expect(make(reply(409, { version: 1, error: { code: 'OUTCOME_CONFLICT' } }) as never).recordOutcome('exe_q', result)).rejects.toThrow();
  });

  it('maps continuation responses', async () => {
    const input = { caller: { ownerId: 'owner_alice' }, approvalReference: 'apr_q', executionId: 'exe_q', providerReference: 'qref-1' };
    const ok = await make(reply(200, { version: 1, kind: 'continuation', status: 'claimed', binding: { ...binding, providerReference: 'qref-1' } }) as never).claimContinuation(input);
    expect(ok.kind).toBe('claimed');
    expect((await make(reply(409, { version: 1, error: { code: 'ALREADY_CLAIMED' } }) as never).claimContinuation(input)).kind).toBe('already_claimed');
    expect((await make(reply(200, { version: 1, kind: 'continuation', status: 'claimed', binding }) as never).claimContinuation(input)).kind).toBe('denied');
  });

  it('refuses a plain HTTP remote gateway', () => {
    expect(() => createHttpGatewayAuthority({ baseUrl: 'http://gateway.example.com', apiKey: 'k', mode: 'active' })).toThrow();
  });
});
