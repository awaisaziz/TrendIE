import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { requireRole } from '../auth/plugin.js';
import { ownerOf, requireOwner } from '../auth/owner.js';
import { verifyAuditChain } from '../audit/verifyChain.js';

export const auditRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /audit?intentId= (dashboard/admin only)
  fastify.get(
    '/audit',
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const { intentId } = req.query as { intentId?: string };
      const owner = ownerOf(req);

      if (intentId) {
        // Only entries for an intent this owner holds.
        const res = await pool.query(
          `SELECT a.* FROM audit_log a
           WHERE EXISTS (SELECT 1 FROM intents i WHERE i.id = $1 AND i.owner = $2)
             AND ((a.entity_type = 'intent' AND a.entity_id = $1) OR (a.payload->>'intentId' = $1))
           ORDER BY a.id ASC`,
          [intentId, owner]
        );
        return reply.status(200).send(res.rows);
      }

      const res = await pool.query(
        `SELECT a.* FROM audit_log a
         WHERE a.payload->>'ownerId' = $1
            OR (a.entity_type = 'intent' AND a.entity_id IN (SELECT id FROM intents WHERE owner = $1))
            OR (a.payload->>'intentId' IN (SELECT id FROM intents WHERE owner = $1))
         ORDER BY a.id ASC LIMIT 100`,
        [owner]
      );
      return reply.status(200).send(res.rows);
    }
  );

  // GET /audit/chain/verify — admin only; verifies the append-only hash chain
  fastify.get(
    '/audit/chain/verify',
    {
      preHandler: [requireRole('admin')],
    },
    async (_req, reply) => {
      const result = await verifyAuditChain(pool);
      // Always 200; the `valid` field inside the body communicates the outcome.
      return reply.status(200).send(result);
    }
  );

  // GET /intents — paginated list of intents (dashboard/admin only, max 100)
  fastify.get(
    '/intents',
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const parsed = z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(2147483647).default(0),
        owner: z.string().min(1).max(128).optional(),
      }).strict().safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: 'SCHEMA_INVALID', message: 'Invalid pagination' });
      const { limit, offset } = parsed.data;
      const res = await pool.query(
        'SELECT * FROM intents WHERE owner = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [ownerOf(req), limit, offset]
      );

      const intents = res.rows.map((row) => ({
        id: row.id,
        owner: row.owner,
        seller: row.seller,
        product: row.product,
        maxAmount: row.max_amount.toString(),
        currency: row.currency,
        allowedDestinations: row.allowed_destinations,
        expiry: row.expiry instanceof Date ? row.expiry.toISOString() : new Date(row.expiry).toISOString(),
        remainingUses: row.remaining_uses,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
        intentVersion: row.intent_version ?? 1,
        platform: row.platform ?? null,
        chain: row.chain ?? null,
        asset: row.asset ?? null,
        scale: row.scale ?? 0,
        sender: row.sender ?? null,
      }));

      return reply.status(200).send({ intents, limit, offset, count: intents.length });
    }
  );

  // GET /decisions/:id (dashboard/admin only)
  fastify.get(
    '/decisions/:id',
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await pool.query(
        `SELECT d.* FROM decisions d
         JOIN proposals p ON p.id = d.proposal_id
         JOIN intents i ON i.id = p.intent_id
         WHERE d.id = $1 AND i.owner = $2`,
        [id, ownerOf(req)]
      );

      if (res.rows.length === 0) {
        return reply.status(404).send({ error: 'DECISION_NOT_FOUND', message: 'Decision not found' });
      }

      const row = res.rows[0];
      return reply.status(200).send({
        id: row.id,
        proposalId: row.proposal_id,
        proposalHash: row.proposal_hash,
        decision: row.decision,
        reasonCodes: row.reason_codes,
        authorizationRef: row.authorization_ref,
        timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      });
    }
  );
};
