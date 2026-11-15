import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { requireRole } from '../auth/plugin.js';
import { ownerOf, requireOwner } from '../auth/owner.js';
import { normalizeStatus } from '../executions/state.js';

const HistoryQuerySchema = z.object({
  owner: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const ReviewQueueQuerySchema = z.object({
  owner: z.string().min(1).max(128).optional(),
});

export const historyRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /history/decisions — Owner-scoped decision history
  for (const path of ['/history/decisions', '/decisions']) fastify.get(
    path,
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const parsed = HistoryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'SCHEMA_INVALID',
          message: 'Invalid query parameters.',
          details: parsed.error.format(),
        });
      }

      const { limit, offset } = parsed.data;
      const owner = ownerOf(req);

      try {
        const query = `
          SELECT d.id, d.decision, d.reason_codes, d.authorization_ref, d.created_at,
                 p.id as proposal_id, p.seller, p.product, p.amount, p.currency, p.destination,
                 p.source_ref, p.intent_id, p.raw_payload,
                 i.owner as intent_owner, i.intent_version,
                 insp.source as inspection_source, insp.flags, insp.evidence, insp.findings
          FROM decisions d
          JOIN proposals p ON d.proposal_id = p.id
          JOIN intents i ON p.intent_id = i.id
          LEFT JOIN inspections insp ON insp.proposal_id = p.id
          WHERE i.owner = $1
          ORDER BY d.created_at DESC
          LIMIT $2 OFFSET $3
        `;

        const res = await pool.query(query, [owner, limit, offset]);

        const countRes = await pool.query(
          `SELECT COUNT(*) as count
           FROM decisions d
           JOIN proposals p ON d.proposal_id = p.id
           JOIN intents i ON p.intent_id = i.id
           WHERE i.owner = $1`,
          [owner]
        );
        const total = parseInt(countRes.rows[0].count, 10);

        const decisions = res.rows.map((row) => ({
          id: row.id,
          decision: row.decision,
          reasonCodes: row.reason_codes,
          authorizationRef: row.authorization_ref,
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          proposal: {
            id: row.proposal_id,
            intentId: row.intent_id,
            seller: row.seller,
            product: row.product,
            amount: row.amount.toString(),
            currency: row.currency,
            destination: row.destination,
            sourceRef: row.source_ref,
            rawPayload: row.raw_payload,
          },
          intent: {
            id: row.intent_id,
            owner: row.intent_owner,
            intentVersion: row.intent_version ?? 1,
          },
          inspection: row.inspection_source
            ? {
                source: row.inspection_source,
                flags: row.flags ?? [],
                evidence: row.evidence ?? [],
                findings: row.findings ?? {},
              }
            : null,
        }));

        return reply.status(200).send({
          decisions,
          total,
          limit,
          offset,
        });
      } catch (err) {
        req.log.error(err);
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve decision history' });
      }
    }
  );


  // GET /history/executions — Owner-scoped execution history
  fastify.get(
    '/history/executions',
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const parsed = HistoryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'SCHEMA_INVALID',
          message: 'Invalid query parameters.',
          details: parsed.error.format(),
        });
      }

      const { limit, offset } = parsed.data;
      const owner = ownerOf(req);

      try {
        const query = `
          SELECT e.execution_id, e.status, e.platform, e.tx_hash_or_checkout_ref, e.error, e.evidence,
                 e.checkpoint_phase, e.checkpoint_tx_hash,
                 e.created_at, e.updated_at,
                 a.id as approval_id, a.intent_id, a.bound_platform, a.bound_asset, a.bound_chain,
                 a.bound_scale, a.owner_id as approval_owner, a.expires_at, a.consumed_at,
                 i.owner as intent_owner
          FROM executions e
          JOIN approvals a ON e.approval_id = a.id
          LEFT JOIN intents i ON a.intent_id = i.id
          WHERE COALESCE(e.owner_id, a.owner_id, i.owner) = $1
          ORDER BY e.created_at DESC
          LIMIT $2 OFFSET $3
        `;

        const res = await pool.query(query, [owner, limit, offset]);

        const countRes = await pool.query(
          `SELECT COUNT(*) as count
           FROM executions e
           JOIN approvals a ON e.approval_id = a.id
           LEFT JOIN intents i ON a.intent_id = i.id
           WHERE COALESCE(e.owner_id, a.owner_id, i.owner) = $1`,
          [owner]
        );
        const total = parseInt(countRes.rows[0].count, 10);

        const executions = res.rows.map((row) => ({
          executionId: row.execution_id,
          approvalId: row.approval_id,
          intentId: row.intent_id,
          status: normalizeStatus(row.status),
          platform: row.platform,
          txHashOrCheckoutRef: row.tx_hash_or_checkout_ref,
          checkpointPhase: row.checkpoint_phase ?? null,
          checkpointTxHash: row.checkpoint_tx_hash ?? null,
          error: row.error,
          evidence: row.evidence ?? {},
          boundAsset: row.bound_asset,
          boundChain: row.bound_chain,
          boundScale: row.bound_scale,
          ownerId: row.approval_owner ?? row.intent_owner,
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
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve execution history' });
      }
    }
  );

  // GET /history/review-queue — Human review queue filtered by owner
  for (const path of ['/history/review-queue', '/reviews']) fastify.get(
    path,
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const parsed = ReviewQueueQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'SCHEMA_INVALID',
          message: 'Invalid query parameters.',
          details: parsed.error.format(),
        });
      }

      const owner = ownerOf(req);

      try {
        const query = `
          SELECT d.id, d.proposal_hash, d.reason_codes, d.created_at,
                 p.id as proposal_id, p.seller, p.product, p.amount, p.currency, p.destination,
                 p.source_ref, p.raw_payload,
                 i.id as intent_id, i.owner as intent_owner, i.intent_version,
                 insp.source as inspection_source, insp.flags, insp.evidence, insp.findings
          FROM decisions d
          JOIN proposals p ON d.proposal_id = p.id
          JOIN intents i ON p.intent_id = i.id
          LEFT JOIN inspections insp ON insp.proposal_id = p.id
          WHERE d.decision = 'review' AND i.owner = $1
          ORDER BY d.created_at ASC
        `;

        const res = await pool.query(query, [owner]);

        const queue = res.rows.map((row) => ({
          decisionId: row.id,
          proposalHash: row.proposal_hash,
          reasonCodes: row.reason_codes,
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          proposal: {
            id: row.proposal_id,
            seller: row.seller,
            product: row.product,
            amount: row.amount.toString(),
            currency: row.currency,
            destination: row.destination,
            sourceRef: row.source_ref,
            rawPayload: row.raw_payload,
          },
          intent: {
            id: row.intent_id,
            owner: row.intent_owner,
            intentVersion: row.intent_version ?? 1,
          },
          inspection: row.inspection_source
            ? {
                source: row.inspection_source,
                flags: row.flags ?? [],
                evidence: row.evidence ?? [],
                findings: row.findings ?? {},
              }
            : null,
        }));

        return reply.status(200).send({
          queue,
          total: queue.length,
        });
      } catch (err) {
        req.log.error(err);
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve review queue' });
      }
    }
  );

};
