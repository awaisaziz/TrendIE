import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Owner scope for every owner-visible route. The owner comes only from the server-configured
 * key binding (`API_KEY_*_OWNER_ID`). An `owner` / `ownerId` query value is an assertion that
 * must match it; it never selects another owner's data. Run after `requireRole`.
 */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (!req.callerOwnerId) {
    return reply.status(403).send({ error: 'OWNER_UNBOUND', message: 'This API key has no bound owner' });
  }
  const query = (req.query ?? {}) as Record<string, unknown>;
  for (const key of ['owner', 'ownerId']) {
    if (query[key] !== undefined && query[key] !== req.callerOwnerId) {
      return reply.status(403).send({ error: 'OWNER_MISMATCH', message: 'Owner does not match the API key' });
    }
  }
}

/** The authenticated owner. Only call after `requireOwner` ran. */
export function ownerOf(req: FastifyRequest): string {
  if (!req.callerOwnerId) throw new Error('requireOwner did not run');
  return req.callerOwnerId;
}
