import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, proposalHash } from '../schemas/canonical.js';

/**
 * GOAT authority V1 rules. Pure functions only: no I/O, no clock reads.
 * Routes in `routes/goatAuthority.ts` own transport and transactions.
 */

export const GOAT_TESTNET_CHAIN_ID = 48816;
export const GOAT_NATIVE_ASSET = 'BTC';
export const GOAT_NATIVE_SCALE = 18;
export const GOAT_CHAIN = 'goat-testnet';
export const CANONICALIZATION_VERSION = 'trendie-json-v1';

const integerString = z.string().regex(/^(0|[1-9][0-9]*)$/).max(80);
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const TX_HASH = /^0x[a-fA-F0-9]{64}$/;

/** Strict shared V1 proposal, restricted to the GOAT native-transfer profile. */
export const GoatProposalV1Schema = z
  .object({
    version: z.literal(1),
    ownerId: z.string().min(1).max(256),
    intentId: z.string().min(1).max(256),
    intentVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    platform: z.literal('goat'),
    itemId: z.string().min(1).max(512),
    sellerId: z.string().min(1).max(512),
    money: z.object({ amount: integerString, scale: z.literal(GOAT_NATIVE_SCALE) }).strict(),
    asset: z.literal(GOAT_NATIVE_ASSET),
    chain: z.literal(GOAT_CHAIN),
    providerArgs: z.object({ recipient: address }).strict(),
  })
  .strict();
export type GoatProposalV1 = z.infer<typeof GoatProposalV1Schema>;

const V1_KEYS = ['version', 'ownerId', 'intentId', 'intentVersion', 'platform', 'itemId', 'sellerId', 'money', 'asset', 'chain', 'providerArgs'] as const;

/** Same algorithm as `proposalFingerprint` in `@trendie/contracts`. */
export function v1Fingerprint(proposal: GoatProposalV1): string {
  return createHash('sha256').update(CANONICALIZATION_VERSION).update('\0').update(canonicalJson(proposal)).digest('hex');
}

export class AuthorityError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}

export function errorBody(code: string) {
  return { version: 1 as const, error: { code } };
}

/**
 * Reads the V1 proposal out of a persisted gateway proposal. The stored payload must hash to the
 * approval's signed `proposal_hash`, carry every V1 field, and its legacy policy fields
 * (`amount`, `destination`) must agree with the V1 fields. Otherwise the approval does not
 * authorize a V1 GOAT execution. Fails closed; never fills a missing value.
 */
export function storedV1Proposal(rawPayload: unknown, approvalProposalHash: unknown): GoatProposalV1 {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
  if (typeof approvalProposalHash !== 'string' || proposalHash(rawPayload) !== approvalProposalHash) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
  const raw = rawPayload as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of V1_KEYS) {
    if (raw[key] === undefined) throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
    projected[key] = raw[key];
  }
  const parsed = GoatProposalV1Schema.safeParse(projected);
  if (!parsed.success) throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
  const proposal = parsed.data;
  if (raw.amount !== undefined && String(raw.amount) !== proposal.money.amount) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
  if (raw.destination !== undefined && String(raw.destination).toLowerCase() !== proposal.providerArgs.recipient.toLowerCase()) {
    throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
  }
  return proposal;
}

export function sameProposal(a: GoatProposalV1, b: GoatProposalV1): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && address.safeParse(value).success;
}

// ---------------------------------------------------------------- checkpoints

export interface StoredCheckpoint {
  phase: 'signed' | 'broadcast' | null;
  txHash: string | null;
  providerReference: string | null;
}

/**
 * Monotonic checkpoint rule: null → signed(H) → broadcast(H). The first accepted hash is
 * immutable. Returns `true` for a write, `false` for an identical retry. Throws on conflict.
 */
export function checkpointChange(current: StoredCheckpoint, phase: 'signed' | 'broadcast', txHash: string): boolean {
  const existing = current.txHash ?? current.providerReference;
  if (existing && existing.toLowerCase() !== txHash.toLowerCase()) throw new AuthorityError(409, 'CHECKPOINT_CONFLICT');
  if (current.phase === phase) return false;
  if (current.phase === 'broadcast' && phase === 'signed') throw new AuthorityError(409, 'CHECKPOINT_CONFLICT');
  return true;
}

// ------------------------------------------------------------------- outcomes

export const OUTCOME_STATUSES = ['blocked', 'pending', 'succeeded', 'failed', 'unknown'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];
const TERMINAL = new Set(['succeeded', 'failed', 'blocked']);

export interface StoredOutcome {
  status: string;
  providerReference: string | null;
  checkpointTxHash: string | null;
  checkpointPhase: string | null;
  reason: string | null;
  evidence: unknown;
}

export interface OutcomeWrite {
  status: OutcomeStatus;
  providerReference?: string | undefined;
  reason?: string | undefined;
  evidence?: unknown;
}

function normalized(status: string): string {
  return status === 'pending_unknown' ? 'unknown' : status;
}

function emptyEvidence(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'object' && Object.keys(value as object).length === 0);
}

function sameEvidence(a: unknown, b: unknown): boolean {
  return canonicalJson(emptyEvidence(a) ? {} : a) === canonicalJson(emptyEvidence(b) ? {} : b);
}

/**
 * Outcome rule. Terminal outcomes are immutable; an exact retry returns `false` (no write).
 * A provider reference can never replace an earlier one. `unknown` never becomes `blocked`,
 * and `blocked` is permitted only before any signed or broadcast checkpoint.
 */
export function outcomeChange(current: StoredOutcome, next: OutcomeWrite): boolean {
  const from = normalized(current.status);
  const knownReference = current.checkpointTxHash ?? current.providerReference;
  if (next.providerReference !== undefined) {
    if (!TX_HASH.test(next.providerReference)) throw new AuthorityError(400, 'SCHEMA_INVALID');
    if (knownReference && knownReference.toLowerCase() !== next.providerReference.toLowerCase()) throw new AuthorityError(409, 'OUTCOME_CONFLICT');
  }

  if (TERMINAL.has(from)) {
    const identical = from === next.status
      && (next.providerReference ?? null)?.toLowerCase() === (current.providerReference ?? null)?.toLowerCase()
      && (next.reason ?? null) === (current.reason ?? null)
      && sameEvidence(current.evidence, next.evidence);
    if (identical) return false;
    throw new AuthorityError(409, 'OUTCOME_CONFLICT');
  }

  if (next.status === 'succeeded' && !next.providerReference) throw new AuthorityError(400, 'SCHEMA_INVALID');
  if (next.status === 'failed' && !next.reason && emptyEvidence(next.evidence)) throw new AuthorityError(400, 'SCHEMA_INVALID');

  const allowed: Record<string, readonly string[]> = {
    submitting: ['blocked', 'pending', 'unknown', 'succeeded', 'failed'],
    pending: ['pending', 'unknown', 'succeeded', 'failed'],
    unknown: ['unknown', 'pending', 'succeeded', 'failed'],
  };
  if (!allowed[from]?.includes(next.status)) throw new AuthorityError(409, 'OUTCOME_CONFLICT');
  if (next.status === 'blocked' && (current.checkpointPhase || knownReference)) throw new AuthorityError(409, 'OUTCOME_CONFLICT');
  return true;
}
