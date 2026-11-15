import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { verifyHmacSignature } from '../approvals/token.js';
import { AuthorityError, errorBody } from './goat.js';

/** Route helpers shared by the GOAT and Qatom authority routes. */

export type Row = Record<string, unknown>;

export function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function epochMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

/** The owner comes only from the server-configured key binding. */
export function principalOwner(req: FastifyRequest): string {
  if (!req.callerOwnerId) throw new AuthorityError(403, 'OWNER_UNBOUND');
  return req.callerOwnerId;
}

export function sendError(req: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (err instanceof AuthorityError) return reply.status(err.statusCode).send(errorBody(err.code));
  req.log.error({ err }, 'Payment authority persistence failed');
  return reply.status(503).send(errorBody('AUTHORITY_UNAVAILABLE'));
}

export function verifyApprovalSignature(approval: Row): boolean {
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


/** Locks a platform execution scoped in SQL to the authenticated owner; requires a consumed approval. */
export async function lockOwnedExecution(client: Pick<pg.PoolClient, 'query'>, executionId: string, ownerId: string, platform: 'goat' | 'qatom'): Promise<Row> {
  const res = await client.query(
    `SELECT e.*, a.consumed_at AS approval_consumed_at, a.consumed_platform AS approval_consumed_platform,
            a.id AS approval_id_ref, a.decision_id AS approval_decision_id, a.proposal_hash AS approval_proposal_hash,
            a.expires_at AS approval_expires_at, a.intent_id AS approval_intent_id
       FROM executions e
       JOIN approvals a ON a.id = e.approval_id
      WHERE e.execution_id = $1 AND e.owner_id = $2 AND e.platform = $3
      FOR UPDATE OF e`,
    [executionId, ownerId, platform]
  );
  if (res.rows.length === 0) throw new AuthorityError(404, 'AUTHORITY_NOT_FOUND');
  const row = res.rows[0] as Row;
  if (!row.approval_consumed_at || row.approval_consumed_platform !== platform) throw new AuthorityError(409, 'AUTHORITY_INCOMPLETE');
  return row;
}
