import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { pool, withTransaction } from '../db/client.js';
import { requireRole } from '../auth/plugin.js';
import { appendAuditLog } from '../audit/hashChain.js';
import { isIntentActive } from '../approvals/expiry.js';
import { verifyHmacSignature } from '../approvals/token.js';
import { config as defaultConfig, type Config } from '../config.js';
import {
  AuthorityError,
  GOAT_NATIVE_ASSET,
  GOAT_NATIVE_SCALE,
  GOAT_TESTNET_CHAIN_ID,
  GoatProposalV1Schema,
  OUTCOME_STATUSES,
  TX_HASH,
  checkpointChange,
  errorBody,
  isAddress,
  outcomeChange,
  sameProposal,
  storedV1Proposal,
  v1Fingerprint,
  type GoatProposalV1,
} from '../authority/goat.js';

const boundedId = z.string().min(1).max(128);

const ClaimBodySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('claim'),
    callerOwnerId: boundedId,
    proposal: GoatProposalV1Schema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    spendAuthorization: z
      .object({ ownerId: boundedId, authorizationId: boundedId, maxAmountWei: z.string().regex(/^(0|[1-9][0-9]{0,79})$/) })
      .strict(),
  })
  .strict();

const CheckpointBodySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('checkpoint'),
    executionId: boundedId,
    phase: z.enum(['signed', 'broadcast']),
    txHash: z.string().regex(TX_HASH),
  })
  .strict();

const OutcomeBodySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('outcome'),
    executionId: boundedId,
    status: z.enum(OUTCOME_STATUSES),
    providerReference: z.string().regex(TX_HASH).optional(),
    reason: z.string().max(2048).optional(),
    evidence: z.unknown().optional(),
  })
  .strict();

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function epochMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

/** The owner comes only from the server-configured key binding. */
function principalOwner(req: FastifyRequest): string {
  if (!req.callerOwnerId) throw new AuthorityError(403, 'OWNER_UNBOUND');
  return req.callerOwnerId;
}

function sendError(req: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (err instanceof AuthorityError) return reply.status(err.statusCode).send(errorBody(err.code));
  req.log.error({ err }, 'GOAT authority persistence failed');
  return reply.status(503).send(errorBody('AUTHORITY_UNAVAILABLE'));
}

function verifyApprovalSignature(approval: Row): boolean {
  return verifyHmacSignature(
    {
      approvalId: String(approval.id),
      executionId: String(approval.execution_id),
      proposalHash: String(approval.proposal_hash),
      intentId: String(approval.intent_id),
      expiresAt: iso(approval.expires_at),
      ownerId: (approval.owner_id as string | null) ?? undefined,
      intentVersion: (approval.intent_version as number | null) ?? undefined,
      platform: (approval.bound_platform as string | null) ?? undefined,
      chain: (approval.bound_chain as string | null) ?? undefined,
      asset: (approval.bound_asset as string | null) ?? undefined,
      scale: approval.bound_scale !== null && approval.bound_scale !== undefined ? Number(approval.bound_scale) : undefined,
    },
    String(approval.hmac_signature ?? ''),
    String(approval.key_id ?? '')
  );
}

async function loadStoredProposal(client: Pick<pg.PoolClient, 'query'>, approval: Row): Promise<GoatProposalV1> {
  const res = await client.query(
    'SELECT p.raw_payload FROM proposals p JOIN decisions d ON d.proposal_id = p.id WHERE d.id = $1',
    [approval.decision_id]
  );
  if (res.rows.length === 0) throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
  return storedV1Proposal(res.rows[0].raw_payload, approval.proposal_hash);
}

function bindingFor(proposal: GoatProposalV1, approval: Row, sender: string, spendAuthorizationId: string, spendCeilingWei: string) {
  return {
    platform: 'goat' as const,
    fingerprint: v1Fingerprint(proposal),
    ownerId: proposal.ownerId,
    intentId: proposal.intentId,
    intentVersion: proposal.intentVersion,
    sender,
    destination: proposal.providerArgs.recipient,
    asset: GOAT_NATIVE_ASSET,
    chainId: GOAT_TESTNET_CHAIN_ID,
    amount: proposal.money.amount,
    scale: GOAT_NATIVE_SCALE,
    expiresAt: epochMs(approval.expires_at),
    spendAuthorizationId,
    spendCeilingWei,
  };
}

/** Loads a GOAT execution scoped in SQL to the authenticated owner. */
async function lockOwnedExecution(client: pg.PoolClient, executionId: string, ownerId: string): Promise<Row> {
  const res = await client.query(
    `SELECT e.*, a.consumed_at AS approval_consumed_at, a.consumed_platform AS approval_consumed_platform
       FROM executions e
       JOIN approvals a ON a.id = e.approval_id
      WHERE e.execution_id = $1 AND e.owner_id = $2 AND e.platform = 'goat'
      FOR UPDATE OF e`,
    [executionId, ownerId]
  );
  if (res.rows.length === 0) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
  const row = res.rows[0];
  // A claimed execution without a consumed GOAT approval is invalid authority.
  if (!row.approval_consumed_at || row.approval_consumed_platform !== 'goat') throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
  return row;
}

const RECOVERY_SELECT = `
  SELECT e.execution_id, e.status, e.owner_id, e.checkpoint_phase, e.checkpoint_tx_hash,
         e.tx_hash_or_checkout_ref, e.error, e.evidence,
         a.id AS approval_id, a.decision_id, a.proposal_hash, a.expires_at, a.bound_sender,
         a.spend_authorization_id, a.spend_ceiling
    FROM executions e
    JOIN approvals a ON a.id = e.approval_id`;

async function recoveryRecord(row: Row) {
  const proposal = await loadStoredProposal(pool, { decision_id: row.decision_id, proposal_hash: row.proposal_hash });
  if (!isAddress(row.bound_sender) || !row.spend_authorization_id || row.spend_ceiling === null || row.spend_ceiling === undefined) {
    throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
  }
  const binding = bindingFor(proposal, row, String(row.bound_sender), String(row.spend_authorization_id), String(row.spend_ceiling));
  return { proposal, binding };
}

export function createGoatAuthorityRoutes(cfg: Pick<Config, 'GOAT_SPEND_AUTHORIZATION_ID' | 'GOAT_SPEND_CEILING_WEI' | 'GOAT_DAILY_LIMIT_WEI'> = defaultConfig): FastifyPluginAsync {
  return async (fastify) => {
    // POST /v1/goat/approvals/:approvalReference/claim
    fastify.post('/v1/goat/approvals/:approvalReference/claim', { preHandler: [requireRole('adapter-goat')] }, async (req, reply) => {
      const { approvalReference } = req.params as { approvalReference: string };
      const parsed = ClaimBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(errorBody('SCHEMA_INVALID'));
      const { callerOwnerId, proposal, fingerprint, spendAuthorization } = parsed.data;

      try {
        const ownerId = principalOwner(req);
        if (callerOwnerId !== ownerId || spendAuthorization.ownerId !== ownerId || proposal.ownerId !== ownerId) {
          throw new AuthorityError(403, 'OWNER_MISMATCH');
        }

        // The spend authorization is a server-recorded fact. The request can only name it.
        const ceiling = BigInt(cfg.GOAT_SPEND_CEILING_WEI);
        const spendAuthorizationId = cfg.GOAT_SPEND_AUTHORIZATION_ID;
        if (ceiling === 0n || !spendAuthorizationId) throw new AuthorityError(403, 'SPEND_CEILING_ZERO');
        if (spendAuthorization.authorizationId !== spendAuthorizationId || spendAuthorization.maxAmountWei !== cfg.GOAT_SPEND_CEILING_WEI) {
          throw new AuthorityError(403, 'SPEND_AUTHORIZATION_INVALID');
        }
        if (BigInt(proposal.money.amount) > ceiling) throw new AuthorityError(403, 'SPEND_CEILING_EXCEEDED');
        if (v1Fingerprint(proposal) !== fingerprint) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');

        const result = await withTransaction(async (client) => {
          // Serialize claims per owner so the daily total cannot be raced.
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ownerId]);
          const aprRes = await client.query('SELECT * FROM approvals WHERE id = $1 FOR UPDATE', [approvalReference]);
          const approval = aprRes.rows[0] as Row | undefined;
          if (!approval || approval.owner_id !== ownerId) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
          if (approval.consumed_at) throw new AuthorityError(409, 'ALREADY_CLAIMED');
          const now = new Date();
          if (epochMs(approval.expires_at) <= now.getTime()) throw new AuthorityError(403, 'APPROVAL_EXPIRED');
          if (approval.bound_platform !== 'goat') throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          if (!verifyApprovalSignature(approval)) throw new AuthorityError(409, 'APPROVAL_SIGNATURE_INVALID');

          const stored = await loadStoredProposal(client, approval);
          if (!sameProposal(stored, proposal)) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          if (approval.bound_destination && String(approval.bound_destination).toLowerCase() !== stored.providerArgs.recipient.toLowerCase()) {
            throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          }

          const intentRes = await client.query('SELECT * FROM intents WHERE id = $1 FOR UPDATE', [approval.intent_id]);
          const intent = intentRes.rows[0] as Row | undefined;
          if (!intent || intent.owner !== ownerId) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
          if (intent.id !== stored.intentId || Number(intent.intent_version ?? 1) !== stored.intentVersion) throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          if (intent.platform && intent.platform !== 'goat') throw new AuthorityError(409, 'PROPOSAL_MISMATCH');
          if (!isIntentActive(iso(intent.expiry), now)) throw new AuthorityError(403, 'INTENT_EXPIRED');
          if (Number(intent.remaining_uses) <= 0) throw new AuthorityError(403, 'INTENT_EXHAUSTED');

          const sender = approval.bound_sender ?? intent.sender;
          if (!isAddress(sender)) throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');

          if (cfg.GOAT_DAILY_LIMIT_WEI) {
            const spentRes = await client.query(
              `SELECT COALESCE(SUM(p.amount), 0)::text AS spent
                 FROM executions e
                 JOIN approvals a ON a.id = e.approval_id
                 JOIN decisions d ON d.id = a.decision_id
                 JOIN proposals p ON p.id = d.proposal_id
                WHERE e.owner_id = $1 AND e.platform = 'goat'
                  AND e.created_at > NOW() - INTERVAL '24 hours'
                  AND e.status NOT IN ('failed', 'blocked')`,
              [ownerId]
            );
            const spent = BigInt(String(spentRes.rows[0]?.spent ?? '0'));
            if (spent + BigInt(stored.money.amount) > BigInt(cfg.GOAT_DAILY_LIMIT_WEI)) throw new AuthorityError(403, 'DAILY_LIMIT_EXCEEDED');
          }

          const existing = await client.query('SELECT 1 FROM executions WHERE execution_id = $1', [approval.execution_id]);
          if (existing.rows.length > 0) throw new AuthorityError(409, 'ALREADY_CLAIMED');

          // Every check passed. Mutate under the locks; any later failure rolls all of it back.
          const consumed = await client.query(
            `UPDATE approvals
                SET consumed_at = NOW(), consumed_platform = 'goat',
                    spend_authorization_id = $2, spend_ceiling = $3, bound_sender = $4
              WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW()
              RETURNING id`,
            [approvalReference, spendAuthorizationId, cfg.GOAT_SPEND_CEILING_WEI, sender]
          );
          if (consumed.rows.length !== 1) throw new AuthorityError(409, 'ALREADY_CLAIMED');
          const decremented = await client.query(
            'UPDATE intents SET remaining_uses = remaining_uses - 1 WHERE id = $1 AND remaining_uses > 0 RETURNING id',
            [intent.id]
          );
          if (decremented.rows.length !== 1) throw new AuthorityError(403, 'INTENT_EXHAUSTED');
          await client.query(
            `INSERT INTO executions (id, execution_id, approval_id, status, platform, owner_id, created_at, updated_at)
             VALUES (gen_random_uuid()::text, $1, $2, 'submitting', 'goat', $3, NOW(), NOW())`,
            [approval.execution_id, approval.id, ownerId]
          );
          await appendAuditLog(client, {
            eventType: 'GOAT_CLAIM_RECORDED',
            entityType: 'approval',
            entityId: approvalReference,
            callerRole: req.callerRole!,
            payload: { executionId: approval.execution_id, ownerId, fingerprint, spendAuthorizationId },
          });

          return {
            executionId: String(approval.execution_id),
            proposal: stored,
            binding: bindingFor(stored, approval, sender, spendAuthorizationId, cfg.GOAT_SPEND_CEILING_WEI),
          };
        });

        // Sent only after COMMIT succeeded.
        return reply.status(200).send({ version: 1, kind: 'claim', status: 'claimed', ...result });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });

    // PUT /v1/goat/executions/:executionId/checkpoint
    fastify.put('/v1/goat/executions/:executionId/checkpoint', { preHandler: [requireRole('adapter-goat')] }, async (req, reply) => {
      const { executionId } = req.params as { executionId: string };
      const parsed = CheckpointBodySchema.safeParse(req.body);
      if (!parsed.success || parsed.data.executionId !== executionId) return reply.status(400).send(errorBody('SCHEMA_INVALID'));
      const { phase, txHash } = parsed.data;

      try {
        const ownerId = principalOwner(req);
        await withTransaction(async (client) => {
          const row = await lockOwnedExecution(client, executionId, ownerId);
          const write = checkpointChange(
            {
              phase: (row.checkpoint_phase as 'signed' | 'broadcast' | null) ?? null,
              txHash: (row.checkpoint_tx_hash as string | null) ?? null,
              providerReference: (row.tx_hash_or_checkout_ref as string | null) ?? null,
            },
            phase,
            txHash
          );
          if (!write) return;
          const updated = await client.query(
            `UPDATE executions
                SET checkpoint_phase = $2, checkpoint_tx_hash = $3,
                    tx_hash_or_checkout_ref = COALESCE(tx_hash_or_checkout_ref, $3),
                    status = CASE WHEN $2 = 'broadcast' AND status = 'submitting' THEN 'pending' ELSE status END,
                    updated_at = NOW()
              WHERE execution_id = $1 AND owner_id = $4
              RETURNING execution_id`,
            [executionId, phase, txHash, ownerId]
          );
          if (updated.rows.length !== 1) throw new AuthorityError(503, 'AUTHORITY_UNAVAILABLE');
          await appendAuditLog(client, {
            eventType: 'GOAT_CHECKPOINT_RECORDED',
            entityType: 'execution',
            entityId: executionId,
            callerRole: req.callerRole!,
            payload: { phase, txHash },
          });
        });
        return reply.status(200).send({ version: 1, kind: 'checkpoint_ack', status: 'persisted', executionId, phase, txHash });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });

    // PUT /v1/goat/executions/:executionId/outcome
    fastify.put('/v1/goat/executions/:executionId/outcome', { preHandler: [requireRole('adapter-goat')] }, async (req, reply) => {
      const { executionId } = req.params as { executionId: string };
      const parsed = OutcomeBodySchema.safeParse(req.body);
      if (!parsed.success || parsed.data.executionId !== executionId) return reply.status(400).send(errorBody('SCHEMA_INVALID'));
      const { status, providerReference, reason, evidence } = parsed.data;

      try {
        const ownerId = principalOwner(req);
        await withTransaction(async (client) => {
          const row = await lockOwnedExecution(client, executionId, ownerId);
          const write = outcomeChange(
            {
              status: String(row.status),
              providerReference: (row.tx_hash_or_checkout_ref as string | null) ?? null,
              checkpointTxHash: (row.checkpoint_tx_hash as string | null) ?? null,
              checkpointPhase: (row.checkpoint_phase as string | null) ?? null,
              reason: (row.error as string | null) ?? null,
              evidence: row.evidence,
            },
            { status, providerReference, reason, evidence }
          );
          if (!write) return;
          const updated = await client.query(
            `UPDATE executions
                SET status = $2, tx_hash_or_checkout_ref = COALESCE(tx_hash_or_checkout_ref, $3),
                    error = $4, evidence = $5, updated_at = NOW()
              WHERE execution_id = $1 AND owner_id = $6 AND status = $7
              RETURNING execution_id`,
            [executionId, status, providerReference ?? null, reason ?? null, JSON.stringify(evidence ?? {}), ownerId, row.status]
          );
          if (updated.rows.length !== 1) throw new AuthorityError(409, 'OUTCOME_CONFLICT');
          await appendAuditLog(client, {
            eventType: 'GOAT_OUTCOME_RECORDED',
            entityType: 'execution',
            entityId: executionId,
            callerRole: req.callerRole!,
            payload: { from: row.status, status, providerReference: providerReference ?? null, reason: reason ?? null },
          });
        });
        return reply.status(200).send({
          version: 1,
          kind: 'outcome_ack',
          status: 'persisted',
          executionId,
          resultStatus: status,
          providerReference: providerReference ?? null,
        });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });

    // GET /v1/goat/executions/:executionId — reconciliation by execution identity (read-only).
    fastify.get('/v1/goat/executions/:executionId', { preHandler: [requireRole('adapter-goat', 'dashboard', 'admin')] }, async (req, reply) => {
      const { executionId } = req.params as { executionId: string };
      const { ownerId: asserted } = req.query as { ownerId?: string };
      try {
        const ownerId = principalOwner(req);
        if (asserted !== undefined && asserted !== ownerId) throw new AuthorityError(403, 'OWNER_MISMATCH');
        const res = await pool.query(`${RECOVERY_SELECT} WHERE e.execution_id = $1 AND e.owner_id = $2 AND e.platform = 'goat'`, [executionId, ownerId]);
        const row = res.rows[0] as Row | undefined;
        if (!row) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
        const txHash = (row.checkpoint_tx_hash as string | null) ?? (row.tx_hash_or_checkout_ref as string | null);
        if (!txHash || !row.checkpoint_phase) throw new AuthorityError(404, 'NO_CHECKPOINT');
        const { proposal, binding } = await recoveryRecord(row);
        return reply.status(200).send({ version: 1, kind: 'reconciliation', executionId, ownerId, proposal, binding, phase: row.checkpoint_phase, txHash });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });

    // GET /v1/goat/approvals/:approvalReference/execution — recovery after a lost claim response.
    // Read-only. It grants no permission to retry a claim, sign, or broadcast.
    fastify.get('/v1/goat/approvals/:approvalReference/execution', { preHandler: [requireRole('adapter-goat', 'dashboard', 'admin')] }, async (req, reply) => {
      const { approvalReference } = req.params as { approvalReference: string };
      try {
        const ownerId = principalOwner(req);
        const res = await pool.query(`${RECOVERY_SELECT} WHERE a.id = $1 AND e.owner_id = $2 AND e.platform = 'goat'`, [approvalReference, ownerId]);
        const row = res.rows[0] as Row | undefined;
        if (!row) {
          // Observation only: an in-flight claim can still commit after this response.
          const approval = await pool.query('SELECT id FROM approvals WHERE id = $1 AND owner_id = $2', [approvalReference, ownerId]);
          if (approval.rows.length === 0) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
          return reply.status(200).send({ version: 1, kind: 'unclaimed_observation', approvalReference });
        }
        const { proposal, binding } = await recoveryRecord(row);
        const checkpointHash = row.checkpoint_tx_hash as string | null;
        const terminal = ['succeeded', 'failed', 'blocked'].includes(String(row.status));
        return reply.status(200).send({
          version: 1,
          kind: 'execution_record',
          approvalReference,
          executionId: row.execution_id,
          ownerId,
          proposal,
          binding,
          status: row.status,
          checkpoint: row.checkpoint_phase && checkpointHash ? { phase: row.checkpoint_phase, txHash: checkpointHash } : null,
          result: terminal
            ? { status: row.status, providerReference: row.tx_hash_or_checkout_ref ?? null, reason: row.error ?? null, evidence: row.evidence ?? {} }
            : null,
        });
      } catch (err) {
        return sendError(req, reply, err);
      }
    });
  };
}

export const goatAuthorityRoutes = createGoatAuthorityRoutes();
