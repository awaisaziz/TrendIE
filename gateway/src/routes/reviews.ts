import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db/client.js';
import { requireRole } from '../auth/plugin.js';
import { ownerOf, requireOwner } from '../auth/owner.js';
import { appendAuditLog } from '../audit/hashChain.js';
import { createApprovalId, createExecutionId, generateHmacSignature } from '../approvals/token.js';
import { config } from '../config.js';
import { IntentSchema, PurchaseProposalSchema, InspectionResultSchema } from '../schemas/index.js';
import { verifyPolicy } from '../policy/verify.js';
import { capApprovalExpiry } from '../approvals/expiry.js';

const ResolveBodySchema = z
  .object({
    resolution: z.enum(['approve', 'reject']),
    notes: z.string().min(1),
  })
  .strict();

export const reviewRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /reviews/:decisionId/resolve (human approver / admin).
  // The dashboard key registers intents, so it must not also approve reviews:
  // one leaked key would otherwise both delegate and approve a purchase.
  fastify.post(
    '/reviews/:decisionId/resolve',
    {
      preHandler: [requireRole('approver', 'admin'), requireOwner],
    },
    async (req, reply) => {
      const { decisionId } = req.params as { decisionId: string };
      const parseResult = ResolveBodySchema.safeParse(req.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'SCHEMA_INVALID',
          message: 'Invalid review resolution payload',
          details: parseResult.error.format(),
        });
      }

      const { resolution, notes } = parseResult.data;

      return await withTransaction(async (client) => {
        // Fetch decision
        const decRes = await client.query(
          `SELECT d.* FROM decisions d
           JOIN proposals p ON p.id = d.proposal_id
           JOIN intents i ON i.id = p.intent_id
           WHERE d.id = $1 AND i.owner = $2
           FOR UPDATE OF d`,
          [decisionId, ownerOf(req)]
        );
        if (decRes.rows.length === 0) {
          return reply.status(404).send({ error: 'DECISION_NOT_FOUND', message: 'Decision not found' });
        }

        const decision = decRes.rows[0];

        // Security rule: Only 'review' status can be resolved; hard 'reject' can NEVER be overridden
        if (decision.decision !== 'review') {
          return reply.status(400).send({
            error: 'INVALID_RESOLUTION_STATE',
            message: `Cannot resolve decision with status '${decision.decision}'. Only 'review' status can be resolved.`,
          });
        }

        let authorizationRef: string | null = null;
        if (resolution === 'approve') {
          // Fetch associated proposal to get intent and proposalHash
          const propRes = await client.query('SELECT * FROM proposals WHERE id = $1', [decision.proposal_id]);
          if (propRes.rows.length === 0 || !propRes.rows[0].intent_id) {
            return reply.status(409).send({ error: 'REVIEW_REVALIDATION_FAILED', message: 'Cannot approve proposal without valid intent' });
          }

          const proposalRow = propRes.rows[0];
          const proposalParsed = PurchaseProposalSchema.safeParse(proposalRow.raw_payload);
          if (!proposalParsed.success || proposalParsed.data.intentId !== proposalRow.intent_id) {
            return reply.status(409).send({ error: 'REVIEW_REVALIDATION_FAILED', message: 'Stored proposal is invalid' });
          }
          const intentRes = await client.query('SELECT * FROM intents WHERE id = $1 FOR UPDATE', [proposalRow.intent_id]);
          if (intentRes.rows.length === 0) {
            return reply.status(409).send({ error: 'REVIEW_REVALIDATION_FAILED', message: 'Intent is missing' });
          }
          const row = intentRes.rows[0];
          const intentParsed = IntentSchema.safeParse({
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
            platform: row.platform ?? undefined,
            chain: row.chain ?? undefined,
            asset: row.asset ?? undefined,
            scale: row.scale ?? undefined,
            sender: row.sender ?? undefined,
          });
          const inspectionRes = await client.query('SELECT * FROM inspections WHERE proposal_id = $1', [proposalRow.id]);
          let inspection;
          if (inspectionRes.rows.length > 0) {
            const ir = inspectionRes.rows[0];
            const parsed = InspectionResultSchema.safeParse({ source: ir.source, flags: ir.flags, evidence: ir.evidence, findings: ir.findings });
            if (!parsed.success) return reply.status(409).send({ error: 'REVIEW_REVALIDATION_FAILED', message: 'Stored inspection is invalid' });
            inspection = parsed.data;
          }
          const now = new Date();
          if (!intentParsed.success) {
            return reply.status(409).send({ error: 'REVIEW_REVALIDATION_FAILED', reasonCodes: ['SCHEMA_INVALID'] });
          }
          const evaluation = verifyPolicy(intentParsed.data, proposalParsed.data, inspection, now);
          if (evaluation.decision === 'reject' || evaluation.reasonCodes.includes('INTENT_EXPIRED') || evaluation.reasonCodes.includes('INTENT_EXHAUSTED')) {
            return reply.status(409).send({ error: 'REVIEW_REVALIDATION_FAILED', reasonCodes: evaluation.reasonCodes });
          }
          const approvalId = createApprovalId();
          const executionId = createExecutionId();
          const expiresAt = capApprovalExpiry(now, config.APPROVAL_TTL_SECONDS, intentParsed.data.expiry);
          const boundPlatform = intentParsed.data.platform ?? proposalParsed.data.platform ?? null;
          const boundAsset = intentParsed.data.asset ?? proposalParsed.data.asset ?? intentParsed.data.currency;
          const boundChain = intentParsed.data.chain ?? proposalParsed.data.chain ?? null;
          const boundScale = intentParsed.data.scale ?? proposalParsed.data.money?.scale ?? 0;
          const boundSender = intentParsed.data.sender ?? null;
          const boundDestination = proposalParsed.data.destination;
          const spendCeiling = intentParsed.data.maxAmount;

          const hmac = generateHmacSignature({
            approvalId,
            executionId,
            proposalHash: decision.proposal_hash,
            intentId: proposalRow.intent_id,
            expiresAt,
            ownerId: intentParsed.data.owner,
            intentVersion: intentParsed.data.intentVersion ?? 1,
            platform: boundPlatform ?? undefined,
            chain: boundChain ?? undefined,
            asset: boundAsset,
            scale: boundScale,
          });

          await client.query(
            `INSERT INTO approvals (
              id, decision_id, intent_id, proposal_hash, execution_id, hmac_signature, key_id, expires_at,
              owner_id, intent_version, bound_platform, bound_asset, bound_chain, bound_scale,
              bound_sender, bound_destination, spend_ceiling
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
              approvalId,
              decisionId,
              intentParsed.data.id,
              decision.proposal_hash,
              executionId,
              hmac,
              config.APPROVAL_KEY_ID,
              expiresAt,
              intentParsed.data.owner,
              intentParsed.data.intentVersion ?? 1,
              boundPlatform,
              boundAsset,
              boundChain,
              boundScale,
              boundSender,
              boundDestination,
              spendCeiling,
            ]
          );

          authorizationRef = approvalId;
        }

        // Update decision
        await client.query(
          `UPDATE decisions
           SET decision = $1, authorization_ref = $2
           WHERE id = $3`,
          [resolution, authorizationRef, decisionId]
        );

        // Append audit log
        await appendAuditLog(client, {
          eventType: 'REVIEW_RESOLVED',
          entityType: 'decision',
          entityId: decisionId,
          callerRole: req.callerRole!,
          payload: {
            previousDecision: 'review',
            newDecision: resolution,
            authorizationRef,
            notes,
          },
        });

        return reply.status(200).send({
          id: decisionId,
          decision: resolution,
          authorizationRef,
          notes,
        });
      });
    }
  );
};
