import { PurchaseProposalSchema, canonicalJson, type PurchaseProposal } from '@trendie/contracts';
import { inspectText, type InspectionResult } from '@trendie/inspection';

export type Listing = { itemId: string; sellerId: string; title: string; amount: string; scale: number; asset: string; description?: string; sourceRef?: string };
export type Discovery = { search(query: string, signal: AbortSignal): Promise<unknown> };
export type Model = { propose(input: { task: string; listings: Listing[]; signal: AbortSignal; maxTurns: number; maxToolCalls: number }): Promise<unknown> };
export type TrustedTask = { ownerId: string; intentId: string; intentVersion: number; platform: 'qatom' | 'goat'; chain: string; task: string; maxAmount: string; maxScale: number; asset: string };
export type WorkflowResult = { proposal: PurchaseProposal; inspection: InspectionResult & { sources: Array<{ itemId: string; sellerId: string; start: number; end: number; sourceRef?: string }> }; source: 'scripted' | 'model' };
export type Limits = { timeoutMs?: number; maxListings?: number; maxTextChars?: number; maxTurns?: number; maxToolCalls?: number };

const defaults = { timeoutMs: 5_000, maxListings: 20, maxTextChars: 100_000, maxTurns: 1, maxToolCalls: 1 };
function validateLimits(input: Limits) {
  const limits = { ...defaults, ...input };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value)) throw new RangeError(`Invalid ${name}`);
  if (limits.timeoutMs < 1 || limits.timeoutMs > 30_000 || limits.maxListings < 1 || limits.maxListings > 100 || limits.maxTextChars < 1 || limits.maxTextChars > 1_000_000 || limits.maxTurns < 1 || limits.maxTurns > 4 || limits.maxToolCalls < 1 || limits.maxToolCalls > 4) throw new RangeError('Workflow limits exceed supported bounds');
  return limits;
}
function validateTask(task: TrustedTask) {
  const identifier = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!identifier(task.ownerId, 256) || !identifier(task.intentId, 256) || !Number.isSafeInteger(task.intentVersion) || task.intentVersion < 1 || !['qatom', 'goat'].includes(task.platform) || !identifier(task.chain, 128) || !identifier(task.task, 2_000) || !/^(0|[1-9][0-9]*)$/.test(task.maxAmount) || task.maxAmount.length > 80 || !Number.isSafeInteger(task.maxScale) || task.maxScale < 0 || task.maxScale > 255 || !identifier(task.asset, 64)) throw new TypeError('Invalid trusted task');
}
export function validateBoundedPayload(value: unknown, label: string) {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, 'utf8') > 200_000) throw new RangeError(`${label} payload limit exceeded`);
}
export function validateListings(value: unknown, maxListings = 100): Listing[] {
  validateBoundedPayload(value, 'Discovery');
  if (!Array.isArray(value) || value.length > maxListings) throw new RangeError('Discovery result limit exceeded');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Invalid discovery listing');
    const item = entry as Record<string, unknown>;
    const allowed = ['itemId', 'sellerId', 'title', 'amount', 'scale', 'asset', 'description', 'sourceRef'];
    if (Object.keys(item).some((key) => !allowed.includes(key)) || !['itemId', 'sellerId', 'title', 'amount', 'scale', 'asset'].every((key) => Object.hasOwn(item, key)) || typeof item.itemId !== 'string' || item.itemId.length < 1 || item.itemId.length > 512 || typeof item.sellerId !== 'string' || item.sellerId.length < 1 || item.sellerId.length > 512 || typeof item.title !== 'string' || item.title.length < 1 || item.title.length > 2_000 || typeof item.asset !== 'string' || item.asset.length < 1 || item.asset.length > 64 || typeof item.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(item.amount) || item.amount.length > 80 || !Number.isSafeInteger(item.scale) || (item.scale as number) < 0 || (item.scale as number) > 255 || (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 20_000)) || (item.sourceRef !== undefined && (typeof item.sourceRef !== 'string' || item.sourceRef.length > 2_048))) throw new TypeError('Invalid discovery listing');
    return item as Listing;
  });
}

export async function runPurchaseWorkflow(input: { task: TrustedTask; query: string; discovery: Discovery; model: Model; source: 'scripted' | 'model'; limits?: Limits }): Promise<WorkflowResult> {
  const limits = validateLimits(input.limits ?? {});
  validateTask(input.task);
  if (typeof input.query !== 'string' || input.query.length > 500) throw new TypeError('Invalid discovery query');
  const controller = new AbortController();
  let rejectTimeout: (error: Error) => void = () => {};
  const timedOut = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const onAbort = () => rejectTimeout(new Error('Workflow timed out'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  const race = <T>(promise: Promise<T>) => Promise.race([promise, timedOut]);
  try {
    const listings = validateListings(await race(input.discovery.search(input.query, controller.signal)), limits.maxListings);
    if (controller.signal.aborted) throw new Error('Workflow timed out');
    const raw = await race(input.model.propose({ task: input.task.task, listings, signal: controller.signal, maxTurns: limits.maxTurns, maxToolCalls: limits.maxToolCalls }));
    if (controller.signal.aborted) throw new Error('Workflow timed out');
    validateBoundedPayload(raw, 'Proposal');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Proposal is not an object');
    const candidate = raw as Record<string, unknown>;
    const allowedCandidate = ['itemId', 'sellerId', 'money', 'asset', 'providerArgs'];
    if (Object.keys(candidate).some((key) => !allowedCandidate.includes(key))) throw new TypeError('Proposal contains unsupported fields');
    const proposal = PurchaseProposalSchema.parse({ ...candidate, version: 1, ownerId: input.task.ownerId, intentId: input.task.intentId, intentVersion: input.task.intentVersion, platform: input.task.platform, chain: input.task.chain });
    if (proposal.asset !== input.task.asset || proposal.money.scale !== input.task.maxScale || BigInt(proposal.money.amount) > BigInt(input.task.maxAmount)) throw new Error('Proposal exceeds trusted task constraints');
    const selected = listings.find((entry) => entry.itemId === proposal.itemId && entry.sellerId === proposal.sellerId);
    if (!selected || selected.amount !== proposal.money.amount || selected.asset !== proposal.asset || selected.scale !== proposal.money.scale) throw new Error('Proposal does not match discovered listing');
    let text = '';
    const sources = listings.map(({ itemId, sellerId, sourceRef, title, description }) => {
      if (text) text += '\n';
      const start = text.length;
      text += `${title}\n${description ?? ''}`;
      return { itemId, sellerId, start, end: text.length, ...(sourceRef === undefined ? {} : { sourceRef }) };
    });
    const inspected = inspectText(text, limits.maxTextChars);
    if (inspected.truncated) throw new RangeError('Inspection source exceeds configured text limit');
    return { proposal, inspection: { ...inspected, sources }, source: input.source };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Workflow timed out');
    if (error instanceof TypeError && /Proposal/.test(error.message)) throw error;
    throw new Error(error instanceof RangeError ? 'Workflow resource limit exceeded' : 'Workflow failed');
  } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort); }
}

export { createGeminiModel, type GeminiModelOptions } from './gemini.js';
export { createBackboardModel, BACKBOARD_ENDPOINT, type BackboardModelOptions } from './backboard.js';

