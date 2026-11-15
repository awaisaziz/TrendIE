import { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { pool, withTransaction } from '../db/client.js';
import { requireRole } from '../auth/plugin.js';
import { appendAuditLog } from '../audit/hashChain.js';
import { isIntentActive } from '../approvals/expiry.js';
import { config as defaultConfig, type Config } from '../config.js';
import { AuthorityError, errorBody } from '../authority/goat.js';
import {
  QatomProposalV1Schema,
  QatomResultSchema,
  qatomFingerprint,
  qatomOutcomeChange,
  storedQatomProposal,
  type QatomProposalV1,
  type QatomResult,
} from '../authority/qatom.js';
import { epochMs, iso, lockOwnedExecution, principalOwner, sendError, verifyApprovalSignature, type Row } from '../authority/routeHelpers.js';
import { canonicalJson } from '../schemas/canonical.js';

const boundedId = z.string().min(1).max(256);
const reference = z.string().min(1).max(512).refine((v) => !/[\r\n]/.test(v));

const ClaimBodySchema = z
  .object({ version: z.literal(1), kind: z.literal('claim'), callerOwnerId: boundedId, proposal: QatomProposalV1Schema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const OutcomeBodySchema = z.object({ version: z.literal(1), kind: z.literal('outcome'), result: QatomResultSchema }).strict();
const ContinuationBodySchema = z
  .object({ version: z.literal(1), kind: z.literal('continuation'), callerOwnerId: boundedId, approvalReference: boundedId, providerReference: reference })
  .strict();

type Querier = Pick<pg.PoolClient, 'query'>;

async function loadStoredProposal(client: Querier, decisionId: unknown, proposalHash: unknown): Promise<QatomProposalV1> {
  const res = await client.query('SELECT p.raw_payload FROM proposals p JOIN decisions d ON d.proposal_id = p.id WHERE d.id = $1', [decisionId]);
  if (res.rows.length === 0) throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
  return storedQatomProposal(res.rows[0].raw_payload, proposalHash);
}

/** The binding shape the Qatom adapter (`packages/qatom` `ApprovedBinding`) validates. */
function bindingFor(proposal: QatomProposalV1, executionId: string, expiresAt: unknown, providerReference?: string) {
  return {
    executionId,
    ownerId: proposal.ownerId,
    intentId: proposal.intentId,
    intentVersion: proposal.intentVersion,
    proposalFingerprint: qatomFingerprint(proposal),
    ...(providerReference ? { providerReference } : {}),
    platform: 'qatom' as const,
    itemId: proposal.itemId,
    sellerId: proposal.sellerId,
    money: proposal.money,
    asset: proposal.asset,
    chain: proposal.chain,
    providerArgs: proposal.providerArgs,
    expiresAt: iso(expiresAt),
  };
}

function storedResult(evidence: unknown): QatomResult | null {
  const value = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>).qatomResult : undefined;
  const parsed = QatomResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Ceiling and optional rolling daily limit. Ceiling 0 blocks before any lock or write. */
function assertCeiling(cfg: QatomConfig, amount: string) {
  const ceiling = BigInt(cfg.QATOM_SPEND_CEILING);
  if (ceiling === 0n) throw new AuthorityError(403, 'SPEND_CEILING_ZERO');
  if (BigInt(amount) > ceiling) throw new AuthorityError(403, 'SPEND_CEILING_EXCEEDED');
}

type QatomConfig = Pick<Config, 'QATOM_SPEND_CEILING' | 'QATOM_DAILY_LIMIT'>;

export function createQatomAuthorityRoutes(cfg: QatomConfig = defaultConfig): FastifyPluginAsync {
  return async (fastify) => {
    // POST /v1/qatom/approvals/:approvalReference/claim
    fastify.post('/v1/qatom/approvals/:approvalReference/claim', { preHandler: [requireRole('adapter-qatom')] }, async (req, reply) => {
      const { approvalReference } = req.params as { approvalReference: string };
      const parsed = ClaimBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(errorBody('SCHEMA_INVALID'));
      const { callerOwnerId, proposal, fingerprint } = parsed.data;

      try {
        const ownerId = principalOwner(req);
        if (callerOwnerId !== ownerId || proposal.ownerId !== ownerId) throw new AuthorityError(403, 'OWNER_MISMATCH');
        assertCeiling(cfg, proposal.money.amount);
        if (qatomFingerprint(proposal) !== fingerprint) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');

        const result = await withTransaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`qatom:${ownerId}`]);
          const aprRes = await client.query('SELECT * FROM approvals WHERE id = $1 FOR UPDATE', [approvalReference]);
          const approval = aprRes.rows[0] as Row | undefined;
          if (!approval || approval.owner_id !== ownerId) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
          if (approval.consumed_at) throw new AuthorityError(409, 'ALREADY_CLAIMED');
          const now = new Date();
          if (epochMs(approval.expires_at) <= now.getTime()) throw new AuthorityError(403, 'APPROVAL_EXPIRED');
          if (approval.bound_platform !== 'qatom') throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          if (!verifyApprovalSignature(approval)) throw new AuthorityError(409, 'APPROVAL_SIGNATURE_INVALID');

          const stored = await loadStoredProposal(client, approval.decision_id, approval.proposal_hash);
          if (canonicalJson(stored) !== canonicalJson(proposal)) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');

          const intentRes = await client.query('SELECT * FROM intents WHERE id = $1 FOR UPDATE', [approval.intent_id]);
          const intent = intentRes.rows[0] as Row | undefined;
          if (!intent || intent.owner !== ownerId) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
          if (intent.id !== stored.intentId || Number(intent.intent_version ?? 1) !== stored.intentVersion) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          if (intent.platform && intent.platform !== 'qatom') throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          if (!isIntentActive(iso(intent.expiry), now)) throw new AuthorityError(403, 'INTENT_EXPIRED');
          if (Number(intent.remaining_uses) <= 0) throw new AuthorityError(403, 'INTENT_EXHAUSTED');

          if (cfg.QATOM_DAILY_LIMIT) {
            const spentRes = await client.query(
              `SELECT COALESCE(SUM(p.amount), 0)::text AS spent
                 FROM executions e
                 JOIN approvals a ON a.id = e.approval_id
                 JOIN decisions d ON d.id = a.decision_id
                 JOIN proposals p ON p.id = d.proposal_id
                WHERE e.owner_id = $1 AND e.platform = 'qatom'
                  AND e.created_at > NOW() - INTERVAL '24 hours'
                  AND e.status NOT IN ('failed', 'blocked')`,
              [ownerId]
            );
            const spent = BigInt(String(spentRes.rows[0]?.spent ?? '0'));
            if (spent + BigInt(stored.money.amount) > BigInt(cfg.QATOM_DAILY_LIMIT)) throw new AuthorityError(403, 'DAILY_LIMIT_EXCEEDED');
          }

          const existing = await client.query('SELECT 1 FROM executions WHERE execution_id = $1', [approval.execution_id]);
          if (existing.rows.length > 0) throw new AuthorityError(409, 'ALREADY_CLAIMED');

          // Every check passed. Mutate under the locks; any later failure rolls all of it back.
          const consumed = await client.query(
            `UPDATE approvals SET consumed_at = NOW(), consumed_platform = 'qatom', spend_ceiling = $2
              WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW()
              RETURNING id`,
            [approvalReference, cfg.QATOM_SPEND_CEILING]
          );
          if (consumed.rows.length !== 1) throw new AuthorityError(409, 'ALREADY_CLAIMED');
          const decremented = await client.query('UPDATE intents SET remaining_uses = remaining_uses - 1 WHERE id = $1 AND remaining_uses > 0 RETURNING id', [intent.id]);
          if (decremented.rows.length !== 1) throw new AuthorityError(403, 'INTENT_EXHAUSTED');
          await client.query(
            `INSERT INTO executions (id, execution_id, approval_id, status, platform, owner_id, created_at, updated_at)
             VALUES (gen_random_uuid()::text, $1, $2, 'submitting', 'qatom', $3, NOW(), NOW())`,
            [approval.execution_id, approval.id, ownerId]
          );
          await appendAuditLog(client, {
            eventType: 'QATOM_CLAIM_RECORDED',
            entityType: 'approval',
            entityId: approvalReference,
            callerRole: req.callerRole!,
            payload: { executionId: approval.execution_id, ownerId, intentId: stored.intentId, fingerprint },
          });
          return bindingFor(stored, String(approval.execution_id), approval.expires_at);
        });

        // Sent only after COMMIT succeeded.
        return reply.status(200).send({ version: 1, kind: 'claim', status: 'claimed', binding: result });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });

    // PUT /v1/qatom/executions/:executionId/outcome
    fastify.put('/v1/qatom/executions/:executionId/outcome', { preHandler: [requireRole('adapter-qatom')] }, async (req, reply) => {
      const { executionId } = req.params as { executionId: string };
      const parsed = OutcomeBodySchema.safeParse(req.body);
      if (!parsed.success || parsed.data.result.executionId !== executionId) return reply.status(400).send(errorBody('SCHEMA_INVALID'));
      const next = parsed.data.result;

      try {
        const ownerId = principalOwner(req);
        await withTransaction(async (client) => {
          const row = await lockOwnedExecution(client, executionId, ownerId, 'qatom');
          const approved = await loadStoredProposal(client, row.approval_decision_id, row.approval_proposal_hash);
          const write = qatomOutcomeChange(
            { status: String(row.status), providerReference: (row.tx_hash_or_checkout_ref as string | null) ?? null, result: storedResult(row.evidence) },
            next,
            approved
          );
          if (!write) return;
          const updated = await client.query(
            `UPDATE executions
                SET status = $2, tx_hash_or_checkout_ref = COALESCE(tx_hash_or_checkout_ref, $3),
                    error = $4, evidence = $5, updated_at = NOW()
              WHERE execution_id = $1 AND owner_id = $6 AND status = $7
              RETURNING execution_id`,
            [executionId, next.status, next.providerReference ?? null, next.reason ?? null, JSON.stringify({ qatomResult: next }), ownerId, row.status]
          );
          if (updated.rows.length !== 1) throw new AuthorityError(409, 'OUTCOME_CONFLICT');
          await appendAuditLog(client, {
            eventType: 'QATOM_OUTCOME_RECORDED',
            entityType: 'execution',
            entityId: executionId,
            callerRole: req.callerRole!,
            payload: { from: row.status, status: next.status, providerReference: next.providerReference ?? null, receiptId: next.actual?.receiptId ?? null },
          });
        });
        return reply.status(200).send({ version: 1, kind: 'outcome_ack', status: 'persisted', executionId, resultStatus: next.status });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });

    // POST /v1/qatom/executions/:executionId/continuation — one atomic claim per provider approval.
    // It never decrements intent uses again; it moves pending_approval → submitting.
    fastify.post('/v1/qatom/executions/:executionId/continuation', { preHandler: [requireRole('adapter-qatom')] }, async (req, reply) => {
      const { executionId } = req.params as { executionId: string };
      const parsed = ContinuationBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(errorBody('SCHEMA_INVALID'));
      const { callerOwnerId, approvalReference, providerReference } = parsed.data;

      try {
        const ownerId = principalOwner(req);
        if (callerOwnerId !== ownerId) throw new AuthorityError(403, 'OWNER_MISMATCH');
        const binding = await withTransaction(async (client) => {
          const row = await lockOwnedExecution(client, executionId, ownerId, 'qatom');
          if (row.approval_id_ref !== approvalReference) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
          if (row.status !== 'pending_approval') throw new AuthorityError(409, 'ALREADY_CLAIMED');
          if (row.tx_hash_or_checkout_ref !== providerReference) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          if (epochMs(row.approval_expires_at) <= Date.now()) throw new AuthorityError(403, 'APPROVAL_EXPIRED');
          const approved = await loadStoredProposal(client, row.approval_decision_id, row.approval_proposal_hash);
          assertCeiling(cfg, approved.money.amount);
          const moved = await client.query(
            `UPDATE executions SET status = 'submitting', updated_at = NOW()
              WHERE execution_id = $1 AND owner_id = $2 AND status = 'pending_approval'
              RETURNING execution_id`,
            [executionId, ownerId]
          );
          if (moved.rows.length !== 1) throw new AuthorityError(409, 'ALREADY_CLAIMED');
          await appendAuditLog(client, {
            eventType: 'QATOM_CONTINUATION_CLAIMED',
            entityType: 'execution',
            entityId: executionId,
            callerRole: req.callerRole!,
            payload: { ownerId, approvalReference, providerReference },
          });
          return bindingFor(approved, executionId, row.approval_expires_at, providerReference);
        });
        return reply.status(200).send({ version: 1, kind: 'continuation', status: 'claimed', binding });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });

    // GET /v1/qatom/approvals/:approvalReference/execution — read-only recovery.
    fastify.get('/v1/qatom/approvals/:approvalReference/execution', { preHandler: [requireRole('adapter-qatom', 'dashboard', 'admin')] }, async (req, reply) => {
      const { approvalReference } = req.params as { approvalReference: string };
      try {
        const ownerId = principalOwner(req);
        const res = await pool.query(
          `SELECT e.execution_id, e.status, e.tx_hash_or_checkout_ref, e.evidence, a.decision_id, a.proposal_hash, a.expires_at
             FROM executions e JOIN approvals a ON a.id = e.approval_id
            WHERE a.id = $1 AND e.owner_id = $2 AND e.platform = 'qatom'`,
          [approvalReference, ownerId]
        );
        const row = res.rows[0] as Row | undefined;
        if (!row) {
          // Observation only: an in-flight claim can still commit after this response.
          const approval = await pool.query('SELECT id FROM approvals WHERE id = $1 AND owner_id = $2', [approvalReference, ownerId]);
          if (approval.rows.length === 0) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
          return reply.status(200).send({ version: 1, kind: 'unclaimed_observation', approvalReference });
        }
        const proposal = await loadStoredProposal(pool, row.decision_id, row.proposal_hash);
        return reply.status(200).send({
          version: 1,
          kind: 'execution_record',
          approvalReference,
          executionId: row.execution_id,
          ownerId,
          proposal,
          binding: bindingFor(proposal, String(row.execution_id), row.expires_at, (row.tx_hash_or_checkout_ref as string | null) ?? undefined),
          status: row.status,
          result: storedResult(row.evidence),
        });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });
  };
}

export const qatomAuthorityRoutes = createQatomAuthorityRoutes();
