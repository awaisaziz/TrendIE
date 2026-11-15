import { PaymentResultSchema, canonicalJson, type PaymentResult } from '@trendie/contracts';
import type { ApprovedBinding, GatewayAuthority } from './execution.js';

export interface HttpGatewayClientOptions {
  baseUrl: string;
  apiKey: string;
  /** `active` calls the gateway. Default `disabled`: every claim is denied with no HTTP call. */
  mode?: 'disabled' | 'active';
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const UNSUPPORTED = 'Qatom gateway authority is disabled';
const MAX_BYTES = 65_536;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BINDING_KEYS = ['executionId', 'ownerId', 'intentId', 'intentVersion', 'proposalFingerprint', 'platform', 'itemId', 'sellerId', 'money', 'asset', 'chain', 'providerArgs', 'expiresAt'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Shape check only. The adapter compares every field with the proposal before it dispatches. */
function parseBinding(value: unknown, withReference: boolean): ApprovedBinding | undefined {
  if (!isRecord(value)) return undefined;
  const expected = withReference ? [...BINDING_KEYS, 'providerReference'] : BINDING_KEYS;
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) return undefined;
  const money = value.money;
  if (
    !boundedString(value.executionId, 256) || !boundedString(value.ownerId, 256) || !boundedString(value.intentId, 256) ||
    !Number.isSafeInteger(value.intentVersion) || typeof value.proposalFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.proposalFingerprint) ||
    value.platform !== 'qatom' || !boundedString(value.itemId) || !boundedString(value.sellerId) ||
    !isRecord(money) || typeof money.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(money.amount) || !Number.isSafeInteger(money.scale) ||
    !boundedString(value.asset, 64) || !boundedString(value.chain, 128) || !isRecord(value.providerArgs) ||
    typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
    (withReference && !boundedString(value.providerReference))
  ) return undefined;
  return value as unknown as ApprovedBinding;
}

function errorCode(data: unknown): string | undefined {
  return isRecord(data) && data.version === 1 && isRecord(data.error) && typeof data.error.code === 'string' ? data.error.code : undefined;
}

export function createHttpGatewayAuthority(options: HttpGatewayClientOptions): GatewayAuthority {
  if (options.mode !== 'active') {
    return {
      async claimExecution() { return { kind: 'denied', reason: UNSUPPORTED }; },
      async recordOutcome() { throw new Error('Gateway outcome persistence is unsupported while the Qatom authority is disabled'); },
      async claimContinuation(): Promise<{ kind: 'denied'; reason: string }> { return { kind: 'denied', reason: UNSUPPORTED }; },
    };
  }

  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new TypeError('Invalid Qatom gateway base URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || (base.protocol === 'http:' && !LOCAL_HOSTS.has(base.hostname))) {
    throw new TypeError('Invalid Qatom gateway base URL');
  }
  const root = options.baseUrl.replace(/\/$/, '');
  const fetcher = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  const request = async (path: string, method: 'POST' | 'PUT', body: unknown): Promise<{ ok: boolean; data: unknown }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher(`${root}${path}`, { method, redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': options.apiKey }, body: canonicalJson(body) });
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Gateway response exceeded size limit');
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = undefined; }
      return { ok: res.ok, data };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async claimExecution(input) {
      try {
        const { ok, data } = await request(`/v1/qatom/approvals/${encodeURIComponent(input.approvalReference)}/claim`, 'POST', {
          version: 1, kind: 'claim', callerOwnerId: input.caller.ownerId, proposal: input.proposal, fingerprint: input.fingerprint,
        });
        if (!ok) {
          return errorCode(data) === 'ALREADY_CLAIMED'
            ? { kind: 'denied', reason: 'Approval was already claimed; recover by approval reference before any retry' }
            : { kind: 'denied', reason: `Gateway denied the claim (${errorCode(data) ?? 'unverified response'})` };
        }
        if (!isRecord(data) || Object.keys(data).length !== 4 || data.version !== 1 || data.kind !== 'claim' || data.status !== 'claimed') {
          return { kind: 'denied', reason: 'Gateway claim was not authoritative' };
        }
        const binding = parseBinding(data.binding, false);
        return binding ? { kind: 'claimed', binding } : { kind: 'denied', reason: 'Gateway binding was malformed' };
      } catch {
        return { kind: 'denied', reason: 'Gateway claim could not be verified' };
      }
    },

    async recordOutcome(executionId: string, result: PaymentResult) {
      const checked = PaymentResultSchema.parse(result);
      if (checked.executionId !== executionId || checked.platform !== 'qatom') throw new Error('Outcome does not belong to this Qatom execution');
      const { ok, data } = await request(`/v1/qatom/executions/${encodeURIComponent(executionId)}/outcome`, 'PUT', { version: 1, kind: 'outcome', result: checked });
      if (!ok || !isRecord(data) || data.version !== 1 || data.kind !== 'outcome_ack' || data.status !== 'persisted' || data.executionId !== executionId || data.resultStatus !== checked.status) {
        throw new Error('Gateway outcome acknowledgement was not verified');
      }
    },

    async claimContinuation(input) {
      try {
        const { ok, data } = await request(`/v1/qatom/executions/${encodeURIComponent(input.executionId)}/continuation`, 'POST', {
          version: 1, kind: 'continuation', callerOwnerId: input.caller.ownerId, approvalReference: input.approvalReference, providerReference: input.providerReference,
        });
        if (!ok) return errorCode(data) === 'ALREADY_CLAIMED' ? { kind: 'already_claimed' } : { kind: 'denied', reason: `Gateway denied the continuation (${errorCode(data) ?? 'unverified response'})` };
        if (!isRecord(data) || Object.keys(data).length !== 4 || data.version !== 1 || data.kind !== 'continuation' || data.status !== 'claimed') {
          return { kind: 'denied', reason: 'Gateway continuation was not authoritative' };
        }
        const binding = parseBinding(data.binding, true);
        return binding ? { kind: 'claimed', binding } : { kind: 'denied', reason: 'Gateway continuation binding was malformed' };
      } catch {
        return { kind: 'denied', reason: 'Gateway continuation could not be verified' };
      }
    },
  };
}
