import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { Config, config as defaultConfig } from '../config.js';
import { createKeyRing, type UserRole } from './keyRing.js';
import { createRateLimiter } from './rateLimit.js';

export type { UserRole } from './keyRing.js';

declare module 'fastify' {
  interface FastifyRequest {
    callerRole?: UserRole;
    /** Owner principal bound to the presented key by server configuration. Never from the request. */
    callerOwnerId?: string;
  }
}

function presentedKey(req: FastifyRequest): string | undefined {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string') return headerKey;
  if (req.headers.authorization?.startsWith('Bearer ')) return req.headers.authorization.slice(7).trim();
  return undefined;
}

function tooManyRequests(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .header('retry-after', String(Math.max(1, retryAfterSeconds)))
    .status(429)
    .send({ error: 'RATE_LIMITED', message: 'Too many requests' });
}

const authPluginAsync: FastifyPluginAsync<{ config?: Config }> = async (fastify, options) => {
  const cfg = options.config ?? defaultConfig;
  const keyRing = createKeyRing(cfg);
  const windowMs = cfg.RATE_LIMIT_WINDOW_SECONDS * 1000;
  const requestLimiter = createRateLimiter({ max: cfg.RATE_LIMIT_MAX, windowMs });
  const failureLimiter = createRateLimiter({ max: cfg.AUTH_FAILURE_MAX, windowMs });

  fastify.decorateRequest('callerRole', undefined);
  fastify.decorateRequest('callerOwnerId', undefined);

  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/health' || req.method === 'OPTIONS') return;

    const client = `ip:${req.ip}`;
    const apiKey = presentedKey(req);

    // A client that keeps presenting invalid keys is refused before any further key is
    // evaluated, so guesses cannot continue at full speed during the lockout window.
    if (apiKey !== undefined && failureLimiter.isBlocked(client)) {
      return tooManyRequests(reply, failureLimiter.retryAfterSeconds(client));
    }

    const resolved = apiKey !== undefined ? keyRing.resolve(apiKey) : undefined;
    if (apiKey !== undefined && !resolved) {
      const failure = failureLimiter.hit(client);
      // Never log the presented value: it may be a real key with a typo.
      req.log.warn({ event: 'AUTH_INVALID_KEY', lockedOut: failureLimiter.isBlocked(client) }, 'Rejected invalid API key');
      if (!failure.allowed) return tooManyRequests(reply, failure.retryAfterSeconds);
    }

    const budget = requestLimiter.hit(resolved ? `key:${resolved.fingerprint}` : client);
    if (!budget.allowed) return tooManyRequests(reply, budget.retryAfterSeconds);

    if (resolved) {
      req.callerRole = resolved.role;
      if (resolved.ownerId) req.callerOwnerId = resolved.ownerId;
    }
  });
};

export const authPlugin = fp(authPluginAsync, { name: 'authPlugin' });

export function requireRole(...allowedRoles: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.callerRole) {
      return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Missing or invalid API key' });
    }
    if (!allowedRoles.includes(req.callerRole)) {
      return reply.status(403).send({ error: 'FORBIDDEN', message: 'Role not authorized for this resource' });
    }
  };
}
