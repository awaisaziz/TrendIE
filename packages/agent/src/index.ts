import { PurchaseProposalSchema, canonicalJson, parseProposal, proposalFingerprint, type PurchaseProposal } from '@trendie/contracts';
import { inspectText, type InspectionResult } from '@trendie/inspection';
import { createHash, randomUUID } from 'node:crypto';

export type Listing = { itemId: string; sellerId: string; title: string; amount: string; scale: number; asset: string; description?: string; sourceRef?: string };
export type Discovery = { search(query: string, signal: AbortSignal): Promise<unknown> };
export type Model = { propose(input: { task: string; listings: Listing[]; signal: AbortSignal; maxTurns: number; maxToolCalls: number }): Promise<unknown> };
export type TrustedTask = { ownerId: string; intentId: string; intentVersion: number; platform: 'qatom' | 'goat'; chain: string; task: string; maxAmount: string; maxScale: number; asset: string };
export type WorkflowResult = { proposal: PurchaseProposal; inspection: InspectionResult & { sources: Array<{ itemId: string; sellerId: string; start: number; end: number; sourceRef?: string }> }; source: 'scripted' | 'model' };
export type Limits = { timeoutMs?: number; maxListings?: number; maxTextChars?: number; maxTurns?: number; maxToolCalls?: number };

export type AttackEvidence = { version: 1; attemptId: string; sourceRefs: string[]; inspectionMaxChars: number; contentSha256: string; canonicalProposalFingerprint: string; ownerId: string; intentId: string; intentVersion: number; inspection: InspectionResult & { sources: Array<{ itemId: string; sellerId: string; start: number; end: number; sourceRef?: string }> }; modelMode: 'fixture' | 'injected'; modelInput: unknown; modelOutput: unknown };
export function validateEvidence(e: AttackEvidence, proposal: unknown): AttackEvidence {
  validateBoundedPayload(e, 'Evidence');
  const parsed = parseProposal(proposal);
  const fields = ['version', 'attemptId', 'sourceRefs', 'inspectionMaxChars', 'contentSha256', 'canonicalProposalFingerprint', 'ownerId', 'intentId', 'intentVersion', 'inspection', 'modelMode', 'modelInput', 'modelOutput'];
  if (Object.keys(e).some((key) => !fields.includes(key)) || !Number.isSafeInteger(e.inspectionMaxChars) || e.inspectionMaxChars < 1 || e.inspectionMaxChars > 1_000_000) throw new TypeError('Invalid evidence');
  const input = e.modelInput as { task?: unknown; listings?: unknown };
  const listings = validateListings(input?.listings);
  const textParts = listings.map((x) => `${x.title}\n${x.description ?? ''}`);
  let text = ''; const sources = textParts.map((part, i) => { if (i) text += '\n'; const start = text.length; text += part; const listing = listings[i]; if (!listing) throw new TypeError('Invalid evidence'); return { itemId: listing.itemId, sellerId: listing.sellerId, start, end: text.length, sourceRef: listing.sourceRef }; });
  if (text.length > e.inspectionMaxChars || !listings.length || listings.some((listing) => !listing.sourceRef)) throw new TypeError('Invalid evidence');
  const inspected = inspectText(text, e.inspectionMaxChars);
  const expected = { findings: inspected.findings, truncated: inspected.truncated, sourceChars: inspected.sourceChars, sources };
  const hash = createHash('sha256').update(canonicalJson(listings)).digest('hex');
  if (e.version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.attemptId) || !['fixture', 'injected'].includes(e.modelMode) || typeof input?.task !== 'string' || !input.task.length || input.task.length > 2_000 || Object.keys(input).some((key) => !['task', 'listings'].includes(key)) || !Array.isArray(input.listings) || e.contentSha256 !== hash || e.canonicalProposalFingerprint !== proposalFingerprint(parsed) || e.ownerId !== parsed.ownerId || e.intentId !== parsed.intentId || e.intentVersion !== parsed.intentVersion || canonicalJson(e.inspection) !== canonicalJson(expected) || canonicalJson(e.sourceRefs) !== canonicalJson(sources.map((s) => s.sourceRef))) throw new TypeError('Invalid evidence');
  const output = parseProposal(e.modelOutput);
  if (proposalFingerprint(output) !== proposalFingerprint(parsed)) throw new TypeError('Invalid evidence');
  return e;
}
export async function runControlledComparison(input: { task: TrustedTask; query: string; discovery: Discovery; model: Model; gateway: { verify(proposal: Readonly<PurchaseProposal>, evidence: Readonly<AttackEvidence>): Promise<{ decision: 'approve' | 'reject' | 'review'; reasons: string[] }> }; modelMode: 'fixture' | 'injected'; limits?: Limits }) {
  validateBoundedPayload(input.task, 'Task');
  const task = Object.freeze({ ...input.task });
  const modelMode = input.modelMode;
  if (!['fixture', 'injected'].includes(modelMode)) throw new TypeError('Invalid model mode');
  const limits = validateLimits(input.limits ?? {}); validateTask(task);
  if (typeof input.query !== 'string' || !input.query.length || input.query.length > 500) throw new TypeError('Invalid query');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Comparison timed out')); }, limits.timeoutMs); });
  const bounded = <T>(p: Promise<T>) => Promise.race([p, timedOut]);
  try {
    const listings = validateListings(await bounded(input.discovery.search(input.query, controller.signal)), limits.maxListings).map((x) => Object.freeze({ ...x }));
    if (!listings.length || listings.some(x => !x.sourceRef)) throw new TypeError('Missing source reference');
    let text = ''; const sources = listings.map((x, i) => { if (i) text += '\n'; const part = `${x.title}\n${x.description ?? ''}`; const start = text.length; text += part; return { itemId: x.itemId, sellerId: x.sellerId, start, end: text.length, sourceRef: x.sourceRef ?? '' }; });
    if (text.length > limits.maxTextChars) throw new RangeError('Inspection limit');
    const inspected = inspectText(text, limits.maxTextChars);
    const modelListings = Object.freeze(listings.map(x => Object.freeze({ ...x })));
    const raw = await bounded(input.model.propose({ task: task.task, listings: modelListings as Listing[], signal: controller.signal, maxTurns: limits.maxTurns, maxToolCalls: limits.maxToolCalls }));
    if (controller.signal.aborted) throw new Error('Comparison timed out');
    validateBoundedPayload(raw, 'Proposal'); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid proposal');
    const c = raw as Record<string, unknown>; if (Object.keys(c).some(k => !['itemId','sellerId','money','asset','providerArgs'].includes(k))) throw new TypeError('Invalid proposal keys');
    const proposal = parseProposal({ ...c, version: 1, ownerId: task.ownerId, intentId: task.intentId, intentVersion: task.intentVersion, platform: task.platform, chain: task.chain });
    const freeze = <T>(v:T):T => { if (v && typeof v === 'object') { Object.values(v as object).forEach(x => freeze(x)); Object.freeze(v); } return v; };
    const frozenProposal = freeze(parseProposal(proposal));
    const evidence = freeze({ version: 1 as const, attemptId: randomUUID(), sourceRefs: sources.map(s => s.sourceRef), inspectionMaxChars: limits.maxTextChars, contentSha256: createHash('sha256').update(canonicalJson(listings)).digest('hex'), canonicalProposalFingerprint: proposalFingerprint(frozenProposal), ownerId: task.ownerId, intentId: task.intentId, intentVersion: task.intentVersion, inspection: { ...inspected, sources }, modelMode, modelInput: { task: task.task, listings }, modelOutput: frozenProposal });
    validateEvidence(evidence, frozenProposal);
    const decision = await bounded(input.gateway.verify(frozenProposal, evidence));
    if (controller.signal.aborted) throw new Error('Comparison timed out');
    validateBoundedPayload(decision, 'Gateway decision');
    if (!decision || !['approve', 'reject', 'review'].includes(decision.decision) || !Array.isArray(decision.reasons) || decision.reasons.length < 1 || decision.reasons.length > 20 || decision.reasons.some(r => typeof r !== 'string' || !r.length || r.length > 128) || Object.keys(decision).some(k => !['decision', 'reasons'].includes(k)) || (decision.decision === 'approve' && decision.reasons.length === 0)) throw new Error('Malformed gateway decision');
    return { proposal: frozenProposal, evidence, vulnerable: { action: { simulation: true as const, recipient: typeof frozenProposal.providerArgs.recipient === 'string' ? frozenProposal.providerArgs.recipient : null, amount: frozenProposal.money.amount, scale: frozenProposal.money.scale, asset: frozenProposal.asset, proposalFingerprint: proposalFingerprint(frozenProposal) }, executed: false, providerDispatch: false }, protected: { decision: decision.decision, reasons: [...decision.reasons], providerDispatch: false as const, outcome: 'NOT_SETTLED' as const } };
  } catch { if (controller.signal.aborted) throw new Error('Comparison timed out'); throw new Error('Comparison failed'); } finally { if (timer) clearTimeout(timer); }
}

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

