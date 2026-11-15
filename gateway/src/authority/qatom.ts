import { z } from 'zod';
import { canonicalJson } from '../schemas/canonical.js';
import { AuthorityError, CANONICALIZATION_VERSION, storedV1Fields } from './goat.js';
import { createHash } from 'node:crypto';

/**
 * Qatom authority V1 rules. Pure functions only: no I/O, no clock reads.
 * Routes in `routes/qatomAuthority.ts` own transport and transactions.
 */

export const QATOM_ASSET = 'USD-TDN';
export const QATOM_SCALE = 3;

const integerString = z.string().regex(/^(0|[1-9][0-9]*)$/).max(80);
const reference = z.string().min(1).max(512).refine((v) => !/[\r\n]/.test(v));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const JsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.string().max(20_000), z.number().finite(),
  z.array(JsonSchema).max(200),
  z.record(z.string().max(256), JsonSchema),
]));

const MoneySchema = z.object({ amount: integerString, scale: z.number().int().min(0).max(255) }).strict();

/** Strict shared V1 proposal, restricted to the Qatom USD-TDN profile. */
export const QatomProposalV1Schema = z
  .object({
    version: z.literal(1),
    ownerId: z.string().min(1).max(256),
    intentId: z.string().min(1).max(256),
    intentVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    platform: z.literal('qatom'),
    itemId: z.string().min(1).max(512),
    sellerId: z.string().min(1).max(512),
    money: z.object({ amount: integerString, scale: z.literal(QATOM_SCALE) }).strict(),
    asset: z.literal(QATOM_ASSET),
    chain: z.string().min(1).max(128),
    providerArgs: z.record(z.string().max(256), JsonSchema).refine((v) => Object.keys(v).length <= 100),
  })
  .strict();
export type QatomProposalV1 = z.infer<typeof QatomProposalV1Schema>;

/** Shared `PaymentResult` shape from `@trendie/contracts`, Qatom platform only. */
export const QatomResultSchema = z
  .object({
    executionId: z.string().min(1).max(256),
    status: z.enum(['pending_approval', 'submitting', 'pending', 'succeeded', 'failed', 'unknown', 'blocked']),
    platform: z.literal('qatom'),
    providerReference: reference.optional(),
    actual: z.object({ itemId: z.string().min(1).max(512), money: MoneySchema, receiptId: z.string().min(1).max(512).optional() }).strict().optional(),
    reason: z.string().max(2048).optional(),
    evidence: JsonSchema.optional(),
  })
  .strict();
export type QatomResult = z.infer<typeof QatomResultSchema>;

export function qatomFingerprint(proposal: QatomProposalV1): string {
  return createHash('sha256').update(CANONICALIZATION_VERSION).update('\0').update(canonicalJson(proposal)).digest('hex');
}

export function storedQatomProposal(rawPayload: unknown, approvalProposalHash: unknown): QatomProposalV1 {
  const parsed = QatomProposalV1Schema.safeParse(storedV1Fields(rawPayload, approvalProposalHash));
  if (!parsed.success) throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
  return parsed.data;
}

const TERMINAL = new Set(['succeeded', 'failed', 'blocked']);

export interface StoredQatomExecution {
  status: string;
  providerReference: string | null;
  /** The last persisted shared result, if any. */
  result: QatomResult | null;
}

/**
 * Outcome rule. Terminal outcomes are immutable; an exact retry returns `false` (no write).
 * The first provider reference is immutable. A success must carry a receipt that matches the
 * approved item and money. `pending_approval` needs a reference for the continuation. `blocked`
 * is allowed only before a provider reference exists, and `unknown` never becomes `blocked`.
 */
export function qatomOutcomeChange(current: StoredQatomExecution, next: QatomResult, approved: QatomProposalV1): boolean {
  const from = current.status === 'pending_unknown' ? 'unknown' : current.status;
  if (current.providerReference && next.providerReference && current.providerReference !== next.providerReference) {
    throw new AuthorityError(409, 'OUTCOME_CONFLICT');
  }
  if (TERMINAL.has(from)) {
    if (current.result && canonicalJson(current.result) === canonicalJson(next)) return false;
    throw new AuthorityError(409, 'OUTCOME_CONFLICT');
  }
  if (next.actual && (next.actual.itemId !== approved.itemId || canonicalJson(next.actual.money) !== canonicalJson(approved.money))) {
    throw new AuthorityError(409, 'RECEIPT_MISMATCH');
  }
  if (next.status === 'succeeded' && !next.actual?.receiptId) throw new AuthorityError(400, 'SCHEMA_INVALID');
  if (next.status === 'failed' && !next.reason && (next.evidence === undefined || next.evidence === null || typeof next.evidence !== 'object' || Object.keys(next.evidence).length === 0)) {
    throw new AuthorityError(400, 'SCHEMA_INVALID');
  }
  if (next.status === 'pending_approval' && !(next.providerReference ?? current.providerReference)) throw new AuthorityError(400, 'SCHEMA_INVALID');

  const allowed: Record<string, readonly string[]> = {
    submitting: ['blocked', 'pending_approval', 'pending', 'unknown', 'succeeded', 'failed'],
    pending_approval: ['pending_approval', 'failed', 'unknown'],
    pending: ['pending', 'unknown', 'succeeded', 'failed'],
    unknown: ['unknown', 'pending', 'pending_approval', 'succeeded', 'failed'],
  };
  if (!allowed[from]?.includes(next.status)) throw new AuthorityError(409, 'OUTCOME_CONFLICT');
  if (next.status === 'blocked' && current.providerReference) throw new AuthorityError(409, 'OUTCOME_CONFLICT');
  return true;
}
