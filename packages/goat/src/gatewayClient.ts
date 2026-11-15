import { canonicalJson, parseProposal, proposalFingerprint } from '@trendie/contracts';
import type { GoatBinding, GoatClaim, GoatGatewayAuthority, GoatReconciliationRecord } from './types.js';
import { GOAT_NATIVE_ASSET, GOAT_NATIVE_SCALE, GOAT_TESTNET_CHAIN_ID } from './types.js';
import { parseAddress, parseHash } from './verification.js';

export interface HttpGoatGatewayClientOptions {
  baseUrl: string;
  apiKey: string;
  mode?: 'fail-closed' | 'active';
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
const unsupported = 'GOAT HTTP gateway authority contract is unsupported';
const MAX_BYTES = 64_000;
const MAX_TIMEOUT_MS = 30_000;
const boundedId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const strict = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

export function createHttpGoatGatewayAuthority(options: HttpGoatGatewayClientOptions): GoatGatewayAuthority {
  const deny: GoatGatewayAuthority = {
    async claimExecution() { return { status: 'denied', reason: unsupported }; },
    async recordSubmissionCheckpoint() { throw new Error(unsupported); },
    async recordOutcome() { throw new Error(unsupported); },
    async getExecutionForReconciliation() { return undefined; },
  };
  if (options.mode !== 'active') return deny;
  let parsedBase: URL;
  try { parsedBase = new URL(options.baseUrl); } catch { throw new TypeError('Invalid GOAT gateway base URL'); }
  if (!['http:', 'https:'].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash || (parsedBase.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedBase.hostname))) throw new TypeError('Invalid GOAT gateway base URL');
  const base = options.baseUrl.replace(/\/$/, '');
  const fetcher = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxResponseBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new RangeError('Invalid GOAT gateway response bounds');
  const request = async (path: string, method: string, body?: unknown) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); if (activeReader) void activeReader.cancel().catch(() => undefined); reject(new Error('Gateway request timed out')); }, timeoutMs); });
    const operation = (async () => {
      const res = await fetcher(`${base}${path}`, { method, redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': options.apiKey }, ...(body === undefined ? {} : { body: canonicalJson(body) }) });
      const reader = res.body?.getReader();
      activeReader = reader;
      if (!reader) return { res, data: undefined as unknown };
      const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) { await reader.cancel(); throw new Error('Gateway response exceeded size limit'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let data: unknown;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { data = undefined; }
      return { res, data };
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const binding = (v: unknown): GoatBinding | undefined => {
    const keys = ['platform','fingerprint','ownerId','intentId','intentVersion','sender','destination','asset','chainId','amount','scale','expiresAt','spendAuthorizationId','spendCeilingWei'];
    if (!strict(v, keys)) return;
    const b = v as Record<string, unknown>;
    if (b.platform !== 'goat' || typeof b.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(b.fingerprint) || !boundedId(b.ownerId) || !boundedId(b.intentId) || !Number.isSafeInteger(b.intentVersion) || !parseAddress(b.sender) || !parseAddress(b.destination) || b.asset !== GOAT_NATIVE_ASSET || b.chainId !== GOAT_TESTNET_CHAIN_ID || typeof b.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(b.amount) || b.scale !== GOAT_NATIVE_SCALE || typeof b.expiresAt !== 'number' || !Number.isSafeInteger(b.expiresAt) || !boundedId(b.spendAuthorizationId) || typeof b.spendCeilingWei !== 'string' || !/^[1-9][0-9]*$/.test(b.spendCeilingWei)) return;
    return b as unknown as GoatBinding;
  };
  return {
    async claimExecution(input): Promise<GoatClaim> {
      try {
        const proposal = parseProposal(input.proposal);
        if (canonicalJson(proposal.providerArgs) !== canonicalJson({ recipient: proposal.providerArgs.recipient }) || proposal.platform !== 'goat' || proposal.chain !== 'goat-testnet' || proposal.asset !== GOAT_NATIVE_ASSET || proposal.money.scale !== GOAT_NATIVE_SCALE || proposalFingerprint(proposal) !== input.fingerprint || proposal.ownerId !== input.callerOwnerId || input.spendAuthorization.ownerId !== input.callerOwnerId || BigInt(proposal.money.amount) > BigInt(input.spendAuthorization.maxAmountWei)) return { status: 'denied', reason: 'Request proposal or owner is invalid' };
        const { res, data } = await request(`/v1/goat/approvals/${encodeURIComponent(input.approvalReference)}/claim`, 'POST', { version: 1, kind: 'claim', callerOwnerId: input.callerOwnerId, proposal, fingerprint: input.fingerprint, spendAuthorization: input.spendAuthorization });
        if (!res.ok || !strict(data, ['version','kind','status','executionId','proposal','binding']) || data.version !== 1 || data.kind !== 'claim' || data.status !== 'claimed' || !boundedId(data.executionId)) return { status: 'denied', reason: 'Gateway claim was not authoritative' };
        const serverProposal = parseProposal(data.proposal); const b = binding(data.binding);
        if (!b || canonicalJson(serverProposal) !== canonicalJson(proposal) || proposalFingerprint(serverProposal) !== input.fingerprint || b.fingerprint !== input.fingerprint || b.ownerId !== input.callerOwnerId || b.ownerId !== serverProposal.ownerId || b.intentId !== serverProposal.intentId || b.intentVersion !== serverProposal.intentVersion || b.platform !== serverProposal.platform || b.destination.toLowerCase() !== String(serverProposal.providerArgs.recipient).toLowerCase() || b.asset !== serverProposal.asset || b.scale !== serverProposal.money.scale || b.chainId !== GOAT_TESTNET_CHAIN_ID || b.amount !== serverProposal.money.amount || b.expiresAt <= input.now || b.spendAuthorizationId !== input.spendAuthorization.authorizationId || b.spendCeilingWei !== input.spendAuthorization.maxAmountWei || BigInt(serverProposal.money.amount) > BigInt(b.spendCeilingWei)) return { status: 'denied', reason: 'Gateway binding did not match the persisted proposal' };
        return { status: 'claimed', executionId: data.executionId, binding: b };
      } catch { return { status: 'denied', reason: 'Gateway claim could not be verified' }; }
    },
    async recordSubmissionCheckpoint(input) {
      const { res, data } = await request(`/v1/goat/executions/${encodeURIComponent(input.executionId)}/checkpoint`, 'PUT', { version: 1, kind: 'checkpoint', executionId: input.executionId, phase: input.phase, txHash: input.txHash });
      if (!res.ok || !strict(data, ['version','kind','status','executionId','phase','txHash']) || data.version !== 1 || data.kind !== 'checkpoint_ack' || data.status !== 'persisted' || data.executionId !== input.executionId || data.phase !== input.phase || parseHash(data.txHash)?.toLowerCase() !== input.txHash.toLowerCase()) throw new Error('Gateway checkpoint acknowledgement was not verified');
    },
    async recordOutcome(input) {
      const { res, data } = await request(`/v1/goat/executions/${encodeURIComponent(input.executionId)}/outcome`, 'PUT', { version: 1, kind: 'outcome', ...input });
      if (!res.ok || !strict(data, ['version','kind','status','executionId','resultStatus','providerReference']) || data.version !== 1 || data.kind !== 'outcome_ack' || data.status !== 'persisted' || data.executionId !== input.executionId || data.resultStatus !== input.status || (data.providerReference ?? undefined) !== input.providerReference) throw new Error('Gateway outcome acknowledgement was not verified');
    },
    async getExecutionForReconciliation(input): Promise<GoatReconciliationRecord | undefined> {
      try {
        const { res, data } = await request(`/v1/goat/executions/${encodeURIComponent(input.executionId)}?ownerId=${encodeURIComponent(input.callerOwnerId)}`, 'GET');
        if (!res.ok || !strict(data, ['version','kind','executionId','ownerId','proposal','binding','phase','txHash']) || data.version !== 1 || data.kind !== 'reconciliation' || data.executionId !== input.executionId || data.ownerId !== input.callerOwnerId || (data.phase !== 'signed' && data.phase !== 'broadcast') || !parseHash(data.txHash)) return;
        const proposal = parseProposal(data.proposal); const b = binding(data.binding);
        if (!b || proposal.ownerId !== input.callerOwnerId || proposal.platform !== 'goat' || proposal.chain !== 'goat-testnet' || proposal.asset !== GOAT_NATIVE_ASSET || proposal.money.scale !== GOAT_NATIVE_SCALE || canonicalJson(proposal.providerArgs) !== canonicalJson({ recipient: proposal.providerArgs.recipient }) || b.ownerId !== input.callerOwnerId || b.fingerprint !== proposalFingerprint(proposal) || b.platform !== proposal.platform || b.intentId !== proposal.intentId || b.intentVersion !== proposal.intentVersion || b.destination.toLowerCase() !== String(proposal.providerArgs.recipient).toLowerCase() || b.asset !== proposal.asset || b.scale !== proposal.money.scale || b.amount !== proposal.money.amount || BigInt(proposal.money.amount) > BigInt(b.spendCeilingWei)) return;
        return { executionId: input.executionId, ownerId: input.callerOwnerId, proposal, binding: b, phase: data.phase, txHash: data.txHash as `0x${string}` };
      } catch { return; }
    },
  };
}
