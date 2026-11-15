import { createHash } from 'node:crypto';
import { Config, SERVICE_KEY_SLOTS, splitList } from '../config.js';

export type UserRole = (typeof SERVICE_KEY_SLOTS)[number]['role'];

export interface ResolvedKey {
  role: UserRole;
  /** Owner principal bound to this key by server configuration, if any. */
  ownerId?: string;
  /** SHA-256 of the key. Safe to use as a rate-limit identity; never the key itself. */
  fingerprint: string;
}

export interface KeyRing {
  resolve(apiKey: string): ResolvedKey | undefined;
  fingerprints(): IterableIterator<string>;
}

const MAX_KEY_LENGTH = 512;

export function fingerprintKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/**
 * Builds the service-key lookup. Only SHA-256 fingerprints are kept in memory, so the
 * comparison is a digest lookup rather than a comparison against a stored secret, and a
 * heap dump or accidental log of the ring does not expose usable keys. Revoked
 * fingerprints are dropped even when the key is still present in the environment.
 */
export function createKeyRing(cfg: Config): KeyRing {
  const revoked = new Set(splitList(cfg.API_KEYS_REVOKED_SHA256).map((entry) => entry.toLowerCase()));
  const byFingerprint = new Map<string, { role: UserRole; ownerId?: string }>();
  for (const slot of SERVICE_KEY_SLOTS) {
    const keys = [cfg[slot.current], ...splitList(cfg[slot.previous])].filter((value): value is string => Boolean(value));
    const ownerId = cfg[slot.owner] || undefined;
    for (const key of keys) {
      const fingerprint = fingerprintKey(key);
      if (!revoked.has(fingerprint)) byFingerprint.set(fingerprint, ownerId ? { role: slot.role, ownerId } : { role: slot.role });
    }
  }
  return {
    resolve(apiKey) {
      if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > MAX_KEY_LENGTH) return undefined;
      const fingerprint = fingerprintKey(apiKey);
      const entry = byFingerprint.get(fingerprint);
      return entry ? { ...entry, fingerprint } : undefined;
    },
    fingerprints: () => byFingerprint.keys(),
  };
}
