import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PaymentResultSchema } from '../schemas/index.js';
import { pool, withTransaction } from '../db/client.js';
import { requireRole } from '../auth/plugin.js';
import { ownerOf, requireOwner } from '../auth/owner.js';
import { appendAuditLog } from '../audit/hashChain.js';
import { canTransition, normalizeStatus, sameOutcome, validOutcome } from '../executions/state.js';

const ExecutionsQuerySchema = z.object({
  owner: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const executionRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /executions — List executions with optional owner filter and pagination
  fastify.get(
    '/executions',
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const parsed = ExecutionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'SCHEMA_INVALID',
          message: 'Invalid query parameters',
          details: parsed.error.format(),
        });
      }

      const { limit, offset } = parsed.data;
      const owner = ownerOf(req);

      try {
        let query = `
          SELECT e.*, a.owner_id as approval_owner, i.owner as intent_owner
          FROM executions e
          JOIN approvals a ON e.approval_id = a.id
          LEFT JOIN intents i ON a.intent_id = i.id
        `;
        const params: unknown[] = [];
        if (owner) {
          query += ` WHERE COALESCE(e.owner_id, a.owner_id, i.owner) = $1`;
          params.push(owner);
        }
        query += ` ORDER BY e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const res = await pool.query(query, params);

        const countQuery = owner
          ? await pool.query(
              `SELECT COUNT(*) as count
               FROM executions e
               JOIN approvals a ON e.approval_id = a.id
               LEFT JOIN intents i ON a.intent_id = i.id
               WHERE COALESCE(e.owner_id, a.owner_id, i.owner) = $1`,
              [owner]
            )
          : await pool.query('SELECT COUNT(*) as count FROM executions');
        const total = parseInt(countQuery.rows[0].count, 10);

        const executions = res.rows.map((row) => ({
          executionId: row.execution_id,
          approvalId: row.approval_id,
          status: normalizeStatus(row.status),
          platform: row.platform,
          txHashOrCheckoutRef: row.tx_hash_or_checkout_ref,
          checkpointPhase: row.checkpoint_phase ?? null,
          checkpointTxHash: row.checkpoint_tx_hash ?? null,
          error: row.error,
          evidence: row.evidence ?? {},
          ownerId: row.owner_id ?? row.approval_owner ?? row.intent_owner,
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        }));

        return reply.status(200).send({
          executions,
          total,
          limit,
          offset,
        });
      } catch (err) {
        req.log.error(err);
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to list executions' });
      }
    }
  );

  fastify.post('/executions/:id/result', { preHandler: [requireRole('adapter-goat', 'adapter-qatom', 'admin'), requireOwner] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PaymentResultSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'SCHEMA_INVALID', message: 'Invalid payment result payload', details: parsed.error.format() });
    const payment = parsed.data;
    if (payment.executionId !== id) return reply.status(400).send({ error: 'EXECUTION_ID_MISMATCH', message: 'Path executionId does not match body executionId' });
    const rolePlatform = req.callerRole === 'adapter-goat' ? 'goat' : req.callerRole === 'adapter-qatom' ? 'qatom' : null;
    try {
      const result = await withTransaction(async (client) => {
        const ar = await client.query('SELECT * FROM approvals WHERE execution_id = $1 FOR UPDATE', [id]);
        if (!ar.rows.length) return { code: 404, error: 'APPROVAL_NOT_FOUND' };
        const approval = ar.rows[0];
        if (approval.owner_id !== ownerOf(req)) return { code: 404, error: 'APPROVAL_NOT_FOUND' };
        if (!approval.consumed_at) return { code: 403, error: 'APPROVAL_NOT_CONSUMED' };
        if (!approval.consumed_platform || approval.consumed_platform !== payment.platform || (rolePlatform && rolePlatform !== approval.consumed_platform)) return { code: 403, error: 'PLATFORM_MISMATCH' };
        const er = await client.query('SELECT * FROM executions WHERE execution_id = $1 FOR UPDATE', [id]);
        if (er.rows.length) {
          const row = er.rows[0];
          const stored = { status: row.status, platform: row.platform, txHashOrCheckoutRef: row.tx_hash_or_checkout_ref, error: row.error, evidence: row.evidence ?? {} };
          if (sameOutcome(stored, payment)) return { code: 200, body: { ...payment, status: normalizeStatus(row.status) } };
          if (!canTransition(row.status, payment) || (row.tx_hash_or_checkout_ref && row.tx_hash_or_checkout_ref !== payment.txHashOrCheckoutRef)) return { code: 409, error: 'EXECUTION_CONFLICT' };
          await client.query('UPDATE executions SET status=$2, platform=$3, tx_hash_or_checkout_ref=$4, error=$5, evidence=$6, owner_id=COALESCE(owner_id, $7), updated_at=NOW() WHERE execution_id=$1', [id, normalizeStatus(payment.status), payment.platform, payment.txHashOrCheckoutRef, payment.error, JSON.stringify(payment.evidence), approval.owner_id ?? null]);
        } else {
          if (!validOutcome(payment)) return { code: 409, error: 'INVALID_INITIAL_OUTCOME' };
          await client.query('INSERT INTO executions (id, execution_id, approval_id, status, platform, tx_hash_or_checkout_ref, error, evidence, owner_id, created_at, updated_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())', [id, approval.id, normalizeStatus(payment.status), payment.platform, payment.txHashOrCheckoutRef, payment.error, JSON.stringify(payment.evidence), approval.owner_id ?? null]);
        }
        const persisted = { ...payment, status: normalizeStatus(payment.status) };
        await appendAuditLog(client, { eventType: 'PAYMENT_RESULT_RECORDED', entityType: 'execution', entityId: id, callerRole: req.callerRole!, payload: persisted });
        return { code: 200, body: persisted };
      });
      return reply.status(result.code).send(result.body ?? { error: result.error });
    } catch (err) {
      req.log.error(err);
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to record payment result' });
    }
  });

  fastify.get(
    '/executions/:id',
    {
      preHandler: [requireRole('adapter-goat', 'adapter-qatom', 'dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const res = await pool.query(
          `SELECT e.* FROM executions e
           JOIN approvals a ON a.id = e.approval_id
           LEFT JOIN intents i ON i.id = a.intent_id
           WHERE e.execution_id = $1 AND COALESCE(e.owner_id, a.owner_id, i.owner) = $2`,
          [id, ownerOf(req)]
        );
        if (!res.rows.length) {
          return reply.status(404).send({ error: 'EXECUTION_NOT_FOUND', message: 'Execution not found' });
        }
        const row = res.rows[0];
        return reply.status(200).send({
          executionId: row.execution_id,
          approvalId: row.approval_id,
          status: normalizeStatus(row.status),
          platform: row.platform,
          txHashOrCheckoutRef: row.tx_hash_or_checkout_ref,
          checkpointPhase: row.checkpoint_phase ?? null,
          checkpointTxHash: row.checkpoint_tx_hash ?? null,
          error: row.error,
          evidence: row.evidence ?? {},
          ownerId: row.owner_id ?? null,
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        });
      } catch (err) {
        req.log.error(err);
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to fetch execution' });
      }
    }
  );
};
