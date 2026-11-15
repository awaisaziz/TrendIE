import { FastifyPluginAsync } from 'fastify';
import { PurchaseProposalSchema, proposalHash } from '../schemas/index.js';
import { pool, withTransaction } from '../db/client.js';
import { requireRole } from '../auth/plugin.js';
import { ownerOf, requireOwner } from '../auth/owner.js';
import { appendAuditLog } from '../audit/hashChain.js';
import { isIntentActive } from '../approvals/expiry.js';
import { verifyHmacSignature } from '../approvals/token.js';

export const approvalRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /approvals/:id — Retrieve persisted approval binding (adapter-goat, adapter-qatom, dashboard, admin)
  fastify.get(
    '/approvals/:id',
    {
      preHandler: [requireRole('adapter-goat', 'adapter-qatom', 'dashboard', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      try {
        const res = await pool.query(
          `SELECT a.*, i.owner as intent_owner, i.seller as intent_seller, i.product as intent_product,
                  i.max_amount as intent_max_amount, i.currency as intent_currency,
                  i.intent_version as intent_intent_version, i.platform as intent_platform,
                  i.chain as intent_chain, i.asset as intent_asset, i.scale as intent_scale,
                  i.sender as intent_sender
           FROM approvals a
           LEFT JOIN intents i ON a.intent_id = i.id
           WHERE a.id = $1 AND COALESCE(a.owner_id, i.owner) = $2`,
          [id, ownerOf(req)]
        );

        if (res.rows.length === 0) {
          return reply.status(404).send({ error: 'APPROVAL_NOT_FOUND', message: 'Approval not found' });
        }

        const row = res.rows[0];

        // Check platform access if caller is an adapter role
        if (req.callerRole === 'adapter-goat' && row.bound_platform && row.bound_platform !== 'goat') {
          return reply.status(403).send({ error: 'PLATFORM_MISMATCH', message: 'Approval is not bound for GOAT platform' });
        }
        if (req.callerRole === 'adapter-qatom' && row.bound_platform && row.bound_platform !== 'qatom') {
          return reply.status(403).send({ error: 'PLATFORM_MISMATCH', message: 'Approval is not bound for Qatom platform' });
        }

        // Verify HMAC
        const hmacOk = verifyHmacSignature(
          {
            approvalId: row.id,
            executionId: row.execution_id,
            proposalHash: row.proposal_hash,
            intentId: row.intent_id,
            expiresAt: (row.expires_at as Date).toISOString(),
            ownerId: row.owner_id ?? row.intent_owner,
            intentVersion: row.intent_version ?? row.intent_intent_version ?? 1,
            platform: row.bound_platform ?? row.intent_platform,
            chain: row.bound_chain ?? row.intent_chain,
            asset: row.bound_asset ?? row.intent_asset ?? row.intent_currency,
            scale: row.bound_scale !== null ? Number(row.bound_scale) : (row.intent_scale ?? 0),
          },
          row.hmac_signature as string,
          row.key_id as string
        );

        if (!hmacOk) {
          return reply.status(403).send({ error: 'HMAC_INVALID', message: 'Approval HMAC signature verification failed' });
        }

        const binding = {
          id: row.id,
          executionId: row.execution_id,
          intentId: row.intent_id,
          proposalHash: row.proposal_hash,
          ownerId: row.owner_id ?? row.intent_owner,
          intentVersion: row.intent_version ?? row.intent_intent_version ?? 1,
          boundPlatform: row.bound_platform ?? row.intent_platform ?? null,
          boundAsset: row.bound_asset ?? row.intent_asset ?? row.intent_currency,
          boundChain: row.bound_chain ?? row.intent_chain ?? null,
          boundScale: row.bound_scale !== null ? Number(row.bound_scale) : (row.intent_scale ?? 0),
          boundSender: row.bound_sender ?? row.intent_sender ?? null,
          boundDestination: row.bound_destination ?? null,
          spendAuthorizationId: row.spend_authorization_id ?? null,
          spendCeiling: row.spend_ceiling ? row.spend_ceiling.toString() : (row.intent_max_amount ? row.intent_max_amount.toString() : null),
          expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : new Date(row.expires_at).toISOString(),
          consumed: !!row.consumed_at,
          consumedAt: row.consumed_at ? (row.consumed_at instanceof Date ? row.consumed_at.toISOString() : new Date(row.consumed_at).toISOString()) : null,
          consumedPlatform: row.consumed_platform ?? null,
          keyId: row.key_id,
        };

        return reply.status(200).send(binding);
      } catch (err) {
        req.log.error(err);
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve approval' });
      }
    }
  );

  // POST /approvals/:id/consume (adapter roles only: adapter-goat, adapter-qatom, admin)
  fastify.post(
    '/approvals/:id/consume',
    {
      preHandler: [requireRole('adapter-goat', 'adapter-qatom', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parseResult = PurchaseProposalSchema.safeParse(req.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'SCHEMA_INVALID',
          message: 'Invalid proposal payload for consumption',
          details: parseResult.error.format(),
        });
      }

      const proposal = parseResult.data;
      const computedHash = proposalHash(proposal);

      try {
        const result = await withTransaction(async (client) => {
          // 1. Check approval existence and lock
          const aprQuery = await client.query(
            'SELECT * FROM approvals WHERE id = $1',
            [id]
          );

          if (aprQuery.rows.length === 0) {
            return { ok: false, reason: 'APPROVAL_NOT_FOUND' };
          }

          const approval = aprQuery.rows[0];
          if ((approval.owner_id ?? null) !== ownerOf(req)) {
            return { ok: false, reason: 'APPROVAL_NOT_FOUND' };
          }
          const rolePlatform = req.callerRole === 'adapter-goat' ? 'goat' : req.callerRole === 'adapter-qatom' ? 'qatom' : null;
          if (!rolePlatform || (approval.consumed_platform && approval.consumed_platform !== rolePlatform)) {
            return { ok: false, reason: 'PLATFORM_BINDING_REQUIRED' };
          }

          // 1a. Verify HMAC integrity of the approval record to guard against
          //     forged or DB-layer-tampered rows (timing-safe comparison).
          const hmacOk = verifyHmacSignature(
            {
              approvalId: approval.id,
              executionId: approval.execution_id,
              proposalHash: approval.proposal_hash,
              intentId: approval.intent_id,
              expiresAt: (approval.expires_at as Date).toISOString(),
              ownerId: approval.owner_id ?? undefined,
              intentVersion: approval.intent_version ?? undefined,
              platform: approval.bound_platform ?? undefined,
              chain: approval.bound_chain ?? undefined,
              asset: approval.bound_asset ?? undefined,
              scale: approval.bound_scale !== null ? Number(approval.bound_scale) : undefined,
            },
            approval.hmac_signature as string,
            approval.key_id as string
          );
          if (!hmacOk) {
            return { ok: false, reason: 'HMAC_INVALID' };
          }

          // 2. Lock intent for update
          const intentQuery = await client.query(
            'SELECT * FROM intents WHERE id = $1 FOR UPDATE',
            [approval.intent_id]
          );

          if (intentQuery.rows.length === 0) {
            return { ok: false, reason: 'INTENT_NOT_FOUND' };
          }

          const intent = intentQuery.rows[0];
          const now = new Date();
          if (!isIntentActive(intent.expiry instanceof Date ? intent.expiry.toISOString() : String(intent.expiry), now)) {
            return { ok: false, reason: 'INTENT_EXPIRED' };
          }
          if (intent.remaining_uses <= 0) {
            return { ok: false, reason: 'INTENT_EXHAUSTED' };
          }

          // 3. Atomically consume approval
          const updateRes = await client.query(
            `UPDATE approvals
             SET consumed_at = NOW(), consumed_platform = $4
             WHERE id = $1
               AND consumed_at IS NULL
               AND expires_at > NOW()
               AND EXISTS (SELECT 1 FROM intents WHERE id = $3 AND expiry > NOW())
               AND proposal_hash = $2
             RETURNING *`,
            [id, computedHash, intent.id, rolePlatform]
          );

          if (updateRes.rows.length === 0) {
            return { ok: false, reason: 'CONSUME_FAILED_HASH_OR_EXPIRED_OR_USED' };
          }

          const consumedRow = updateRes.rows[0];

          // 4. Decrement remaining_uses on intent
          await client.query(
            'UPDATE intents SET remaining_uses = remaining_uses - 1 WHERE id = $1',
            [intent.id]
          );

          // 5. Append audit log
          await appendAuditLog(client, {
            eventType: 'APPROVAL_CONSUMED',
            entityType: 'approval',
            entityId: id,
            callerRole: req.callerRole!,
            payload: {
              executionId: approval.execution_id,
              proposalHash: computedHash,
              intentId: intent.id,
            },
          });

          const binding = {
            executionId: approval.execution_id,
            approvalId: approval.id,
            intentId: intent.id,
            ownerId: consumedRow.owner_id ?? intent.owner,
            intentVersion: consumedRow.intent_version ?? intent.intent_version ?? 1,
            platform: rolePlatform,
            asset: consumedRow.bound_asset ?? intent.asset ?? intent.currency,
            chain: consumedRow.bound_chain ?? intent.chain ?? null,
            scale: consumedRow.bound_scale !== null ? Number(consumedRow.bound_scale) : (intent.scale ?? 0),
            destination: consumedRow.bound_destination ?? proposal.destination,
            spendCeiling: consumedRow.spend_ceiling ? consumedRow.spend_ceiling.toString() : intent.max_amount.toString(),
            expiresAt: consumedRow.expires_at instanceof Date ? consumedRow.expires_at.toISOString() : new Date(consumedRow.expires_at).toISOString(),
          };

          return { ok: true, executionId: approval.execution_id, binding };
        });

        if (!result.ok) {
          return reply.status(403).send({
            error: 'FORBIDDEN',
            message: `Approval cannot be consumed: ${result.reason}`,
          });
        }

        return reply.status(200).send({
          executionId: result.executionId,
          binding: result.binding,
        });
      } catch (err) {
        req.log.error(err);
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to consume approval' });
      }
    }
  );
};
