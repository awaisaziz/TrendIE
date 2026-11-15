import { FastifyPluginAsync } from 'fastify';
import { IntentSchema } from '../schemas/index.js';
import { pool, withTransaction } from '../db/client.js';
import { requireRole } from '../auth/plugin.js';
import { ownerOf, requireOwner } from '../auth/owner.js';
import { appendAuditLog } from '../audit/hashChain.js';

export const intentRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /intents — Register a trusted intent (dashboard / admin only)
  fastify.post(
    '/intents',
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const parseResult = IntentSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'SCHEMA_INVALID',
          message: 'Invalid intent payload',
          details: parseResult.error.format(),
        });
      }

      const intent = parseResult.data;
      if (intent.owner !== ownerOf(req)) {
        return reply.status(403).send({ error: 'OWNER_MISMATCH', message: 'Intent owner does not match the API key' });
      }

      try {
        await withTransaction(async (client) => {
          await client.query(
            `INSERT INTO intents (
              id, owner, seller, product, max_amount, currency, allowed_destinations, expiry, remaining_uses, created_at,
              intent_version, platform, chain, asset, scale, sender
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [
              intent.id,
              intent.owner,
              intent.seller,
              intent.product,
              intent.maxAmount,
              intent.currency,
              JSON.stringify(intent.allowedDestinations),
              intent.expiry,
              intent.remainingUses,
              intent.createdAt,
              intent.intentVersion ?? 1,
              intent.platform ?? null,
              intent.chain ?? null,
              intent.asset ?? null,
              intent.scale ?? 0,
              intent.sender ?? null,
            ]
          );

          await appendAuditLog(client, {
            eventType: 'INTENT_CREATED',
            entityType: 'intent',
            entityId: intent.id,
            callerRole: req.callerRole!,
            payload: intent,
          });
        });

        return reply.status(201).send(intent);
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error.code === '23505') {
          return reply.status(409).send({ error: 'INTENT_EXISTS', message: 'Intent already exists' });
        }
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to create intent' });
      }
    }
  );

  // GET /intents/:id — Read an intent (dashboard / admin only)
  fastify.get(
    '/intents/:id',
    {
      preHandler: [requireRole('dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await pool.query('SELECT * FROM intents WHERE id = $1 AND owner = $2', [id, ownerOf(req)]);
      if (res.rows.length === 0) {
        return reply.status(404).send({ error: 'INTENT_NOT_FOUND', message: 'Intent not found' });
      }

      const row = res.rows[0];
      return reply.status(200).send({
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
      });
    }
  );
};
