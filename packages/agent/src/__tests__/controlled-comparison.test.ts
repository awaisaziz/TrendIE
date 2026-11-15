import { describe, expect, it, vi } from 'vitest';
import { runControlledComparison, validateEvidence, type Listing, type TrustedTask } from '../index.js';

const task: TrustedTask = { ownerId: 'owner', intentId: 'intent', intentVersion: 2, platform: 'goat', chain: 'test', task: 'buy item', maxAmount: '10', maxScale: 0, asset: 'USD' };
const listing: Listing = { itemId: 'item', sellerId: 'seller', title: 'Title', amount: '4', scale: 0, asset: 'USD', description: 'clean', sourceRef: 'fixture://one' };
const model = { async propose() { return { itemId: 'item', sellerId: 'attacker', money: { amount: '11', scale: 0 }, asset: 'USD', providerArgs: { recipient: 'bad' } }; } };
const policy = { async verify(p: { sellerId: string; itemId: string; money: { amount: string; scale: number }; asset: string }) {
  const reasons = [];
  if (p.sellerId !== listing.sellerId) reasons.push('SELLER_MISMATCH');
  if (p.itemId !== listing.itemId) reasons.push('PRODUCT_MISMATCH');
  if (BigInt(p.money.amount) > BigInt(task.maxAmount)) reasons.push('AMOUNT_EXCEEDS_MAX');
  if (p.money.scale !== task.maxScale || p.asset !== task.asset) reasons.push('CURRENCY_MISMATCH');
  return { decision: reasons.length ? 'reject' as const : 'approve' as const, reasons: reasons.length ? reasons : ['OK'] };
} };
const run = () => runControlledComparison({ task, query: 'item', discovery: { async search() { return [listing]; } }, model, modelMode: 'fixture', gateway: policy });

describe('controlled comparison', () => {
  it('records the changed candidate in simulation and passes it to gateway for rejection', async () => {
    let discoveries = 0; let calls = 0;
    const out = await runControlledComparison({ task, query: 'item', discovery: { async search() { discoveries++; return [listing]; } }, model, modelMode: 'fixture', gateway: { async verify(p, e) { calls++; expect(p.sellerId).toBe('attacker'); expect(e.canonicalProposalFingerprint).toBeTruthy(); return { decision: 'reject', reasons: ['SELLER_MISMATCH'] }; } } });
    expect(discoveries).toBe(1); expect(calls).toBe(1); expect(out.vulnerable.action).toMatchObject({ simulation: true, recipient: 'bad', amount: '11', scale: 0, asset: 'USD' }); expect(out.vulnerable.executed).toBe(false); expect(out.vulnerable.providerDispatch).toBe(false); expect(out.protected.outcome).toBe('NOT_SETTLED');
  });
  it('allows deterministic gateway approval without claiming settlement', async () => {
    const candidate = { itemId: 'item', sellerId: 'seller', money: { amount: '4', scale: 0 }, asset: 'USD', providerArgs: {} };
    const out = await runControlledComparison({ task, query: 'item', discovery: { async search() { return [listing]; } }, model: { async propose() { return candidate; } }, modelMode: 'injected', gateway: { async verify(p) { return { decision: p.sellerId === 'seller' ? 'approve' : 'reject', reasons: ['OK'] }; } } });
    expect(out.protected.decision).toBe('approve'); expect(out.protected.outcome).toBe('NOT_SETTLED');
  });
  it('rejects tampered evidence and requires references', async () => {
    const out = await runControlledComparison({ task, query: 'item', discovery: { async search() { return [listing]; } }, model, modelMode: 'fixture', gateway: { async verify() { return { decision: 'review', reasons: ['OK'] }; } } });
    expect(() => validateEvidence({ ...out.evidence, sourceRefs: [] }, out.proposal)).toThrow();
    expect(() => validateEvidence({ ...out.evidence, canonicalProposalFingerprint: '0'.repeat(64) }, out.proposal)).toThrow();
    await expect(runControlledComparison({ task, query: 'item', discovery: { async search() { return [{ ...listing, sourceRef: undefined }]; } }, model, modelMode: 'fixture', gateway: { async verify() { return { decision: 'reject', reasons: ['OK'] }; } } })).rejects.toThrow();
  });
  it('rejects identity injection and times out hung ports with generic provider errors', async () => {
    await expect(runControlledComparison({ task, query: 'item', discovery: { async search() { return [listing]; } }, model: { async propose() { return { itemId: 'item', sellerId: 'seller', money: { amount: '4', scale: 0 }, asset: 'USD', ownerId: 'intruder' }; } }, modelMode: 'fixture', gateway: { async verify() { return { decision: 'reject', reasons: ['OK'] }; } } })).rejects.toThrow();
    await expect(runControlledComparison({ task, query: 'item', discovery: { async search() { throw new Error('secret provider detail'); } }, model, modelMode: 'fixture', gateway: { async verify() { return { decision: 'reject', reasons: ['OK'] }; } } })).rejects.toThrow('Comparison failed');
    await expect(runControlledComparison({ task, query: 'item', discovery: { async search() { return new Promise(() => {}); } }, model, modelMode: 'fixture', limits: { timeoutMs: 10 }, gateway: { async verify() { return { decision: 'reject', reasons: ['OK'] }; } } })).rejects.toThrow('Comparison timed out');
  });

  it('checks the candidate against real fixture constraints in both clean and malicious cases', async () => {
    const attacked = await run();
    expect(attacked.protected.reasons).toEqual(['SELLER_MISMATCH', 'AMOUNT_EXCEEDS_MAX']);
    const clean = await runControlledComparison({ task, query: 'item', discovery: { async search() { return [listing]; } }, modelMode: 'fixture', model: { async propose() { return { itemId: listing.itemId, sellerId: listing.sellerId, money: { amount: listing.amount, scale: listing.scale }, asset: listing.asset, providerArgs: { recipient: 'fixture-recipient' } }; } }, gateway: policy });
    expect(clean.protected.decision).toBe('approve');
    expect(clean.protected.outcome).toBe('NOT_SETTLED');
  });

  it('rejects tampering with content, model output, offsets and envelope shape', async () => {
    const result = await run();
    for (const change of [
      (e: typeof result.evidence) => { e.contentSha256 = '0'.repeat(64); },
      (e: typeof result.evidence) => { (e.modelOutput as { sellerId: string }).sellerId = 'other'; },
      (e: typeof result.evidence) => { const source = e.inspection.sources[0]; if (source) source.start = 1; },
      (e: typeof result.evidence) => { e.attemptId = '-'.repeat(36); },
      (e: typeof result.evidence) => { e.inspectionMaxChars = 0; },
    ]) {
      const copy = JSON.parse(JSON.stringify(result.evidence)) as typeof result.evidence;
      change(copy);
      expect(() => validateEvidence(copy, result.proposal)).toThrow();
    }
    expect(() => validateEvidence({ ...result.evidence, extra: 'unsupported' } as typeof result.evidence, result.proposal)).toThrow();
  });

  it('rejects evidence accessors without executing the getter', async () => {
    const result = await run();
    let reads = 0;
    const copy = { ...result.evidence };
    Object.defineProperty(copy, 'contentSha256', { enumerable: true, get() { reads++; return result.evidence.contentSha256; } });
    expect(() => validateEvidence(copy, result.proposal)).toThrow();
    expect(reads).toBe(0);
  });

  it('retains the configured inspection limit and distinct offsets for identical text', async () => {
    const listings = Array.from({ length: 6 }, (_, i) => ({ ...listing, description: 'x'.repeat(18_000), sourceRef: `fixture://${i}` }));
    const out = await runControlledComparison({ task, query: 'item', discovery: { async search() { return listings; } }, model, modelMode: 'fixture', limits: { maxTextChars: 120_000 }, gateway: policy });
    expect(out.evidence.inspectionMaxChars).toBe(120_000);
    const first = out.evidence.inspection.sources[0]; const second = out.evidence.inspection.sources[1];
    expect(first).toBeDefined(); expect(second).toBeDefined();
    if (first && second) expect(second.start).toBeGreaterThan(first.end);
    expect(validateEvidence(out.evidence, out.proposal)).toBe(out.evidence);
  });

  it('snapshots host inputs and freezes the evidence passed to the gateway', async () => {
    const mutableTask = { ...task };
    const mutableListing = { ...listing };
    const out = await runControlledComparison({ task: mutableTask, query: 'item', discovery: { async search() { return [mutableListing]; } }, modelMode: 'fixture', model: { async propose(input) {
      mutableTask.ownerId = 'changed-after-start';
      mutableListing.description = 'changed-after-discovery';
      expect(Object.isFrozen(input.listings)).toBe(true);
      return model.propose();
    } }, gateway: { async verify(p, e) {
      expect(() => { (p as { sellerId: string }).sellerId = 'mutated'; }).toThrow();
      expect(() => { (e as { contentSha256: string }).contentSha256 = 'mutated'; }).toThrow();
      return policy.verify(p);
    } } });
    expect(out.proposal.ownerId).toBe(task.ownerId);
    const evidenceListings = (out.evidence.modelInput as { listings: Listing[] }).listings;
    expect(evidenceListings[0]?.description).toBe('clean');
  });

  it('rejects malformed gateway responses and sanitizes typed provider errors', async () => {
    await expect(runControlledComparison({ task, query: 'item', discovery: { async search() { return [listing]; } }, model, modelMode: 'fixture', gateway: { async verify() { return { decision: 'reject', reasons: [] }; } } })).rejects.toThrow('Comparison failed');
    await expect(runControlledComparison({ task, query: 'item', discovery: { async search() { throw new TypeError('private provider detail'); } }, model, modelMode: 'fixture', gateway: policy })).rejects.toThrow('Comparison failed');
  });

  it('uses one deadline across discovery, model and gateway phases', async () => {
    vi.useFakeTimers();
    const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
    try {
      const result = runControlledComparison({ task, query: 'item', limits: { timeoutMs: 50 }, modelMode: 'fixture', discovery: { async search() { await delay(); return [listing]; } }, model: { async propose() { await delay(); return model.propose(); } }, gateway: { async verify(p) { await delay(); return policy.verify(p); } } });
      const assertion = expect(result).rejects.toThrow('Comparison timed out');
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
});
