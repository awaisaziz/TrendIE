import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const optionalSecret = z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional());

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  CORS_ORIGINS: z.string().min(1, 'CORS_ORIGINS is required'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APPROVAL_HMAC_SECRET: z.string().min(32, 'APPROVAL_HMAC_SECRET must be at least 32 characters'),
  APPROVAL_KEY_ID: z.string().min(1, 'APPROVAL_KEY_ID is required').max(32).regex(/^[A-Za-z0-9_.-]+$/, 'APPROVAL_KEY_ID has invalid characters'),
  // Retired signing keys kept only to verify approvals issued before a rotation: "keyId:secret,keyId:secret".
  APPROVAL_HMAC_PREVIOUS_KEYS: optionalSecret,
  APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  API_KEY_AGENT: z.string().min(1, 'API_KEY_AGENT is required'),
  API_KEY_ADAPTER_GOAT: z.string().min(1, 'API_KEY_ADAPTER_GOAT is required'),
  API_KEY_ADAPTER_QATOM: z.string().min(1, 'API_KEY_ADAPTER_QATOM is required'),
  API_KEY_DASHBOARD: z.string().min(1, 'API_KEY_DASHBOARD is required'),
  API_KEY_ADMIN: z.string().min(1, 'API_KEY_ADMIN is required'),
  // Human review approver. Optional: when unset only `admin` can resolve reviews.
  API_KEY_APPROVER: optionalSecret,
  // Comma-separated keys still accepted while callers move to the new key.
  API_KEY_AGENT_PREVIOUS: optionalSecret,
  API_KEY_ADAPTER_GOAT_PREVIOUS: optionalSecret,
  API_KEY_ADAPTER_QATOM_PREVIOUS: optionalSecret,
  API_KEY_DASHBOARD_PREVIOUS: optionalSecret,
  API_KEY_ADMIN_PREVIOUS: optionalSecret,
  API_KEY_APPROVER_PREVIOUS: optionalSecret,
  // Comma-separated SHA-256 hex fingerprints of keys that must be refused even if still configured.
  API_KEYS_REVOKED_SHA256: optionalSecret,
  // Owner principal bound to each service key (current and previous keys share it). A key with
  // no bound owner cannot use owner-scoped GOAT authority routes. Never read owner from a request.
  API_KEY_AGENT_OWNER_ID: optionalSecret,
  API_KEY_ADAPTER_GOAT_OWNER_ID: optionalSecret,
  API_KEY_ADAPTER_QATOM_OWNER_ID: optionalSecret,
  API_KEY_DASHBOARD_OWNER_ID: optionalSecret,
  API_KEY_ADMIN_OWNER_ID: optionalSecret,
  API_KEY_APPROVER_OWNER_ID: optionalSecret,
  // Server-recorded GOAT spend authorization. A ceiling of 0 (the default) blocks every GOAT claim.
  GOAT_SPEND_AUTHORIZATION_ID: optionalSecret,
  // Rolling 24-hour GOAT spend limit per owner, in wei. Empty means no daily limit beyond the ceiling.
  // Pending and unknown executions count as spent until they resolve.
  GOAT_DAILY_LIMIT_WEI: z.preprocess((value) => (value === '' ? undefined : value), z.string().regex(/^[1-9][0-9]{0,37}$/, 'GOAT_DAILY_LIMIT_WEI must be a positive integer').optional()),
  GOAT_SPEND_CEILING_WEI: z.string().regex(/^(0|[1-9][0-9]{0,37})$/, 'GOAT_SPEND_CEILING_WEI must be a non-negative integer').default('0'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_FAILURE_MAX: z.coerce.number().int().positive().default(20),
});

export type Config = z.infer<typeof envSchema>;

export const SERVICE_KEY_SLOTS = [
  { role: 'agent', current: 'API_KEY_AGENT', previous: 'API_KEY_AGENT_PREVIOUS', owner: 'API_KEY_AGENT_OWNER_ID' },
  { role: 'adapter-goat', current: 'API_KEY_ADAPTER_GOAT', previous: 'API_KEY_ADAPTER_GOAT_PREVIOUS', owner: 'API_KEY_ADAPTER_GOAT_OWNER_ID' },
  { role: 'adapter-qatom', current: 'API_KEY_ADAPTER_QATOM', previous: 'API_KEY_ADAPTER_QATOM_PREVIOUS', owner: 'API_KEY_ADAPTER_QATOM_OWNER_ID' },
  { role: 'dashboard', current: 'API_KEY_DASHBOARD', previous: 'API_KEY_DASHBOARD_PREVIOUS', owner: 'API_KEY_DASHBOARD_OWNER_ID' },
  { role: 'admin', current: 'API_KEY_ADMIN', previous: 'API_KEY_ADMIN_PREVIOUS', owner: 'API_KEY_ADMIN_OWNER_ID' },
  { role: 'approver', current: 'API_KEY_APPROVER', previous: 'API_KEY_APPROVER_PREVIOUS', owner: 'API_KEY_APPROVER_OWNER_ID' },
] as const;

const MIN_PRODUCTION_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRET = /^(replace-with|dev-|unit-|changeme|example)/i;

export function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** Every configured service key (current and previous) with the env name it came from. Never log the values. */
export function serviceKeyEntries(env: Record<string, string | undefined>): { name: string; value: string }[] {
  const entries: { name: string; value: string }[] = [];
  for (const slot of SERVICE_KEY_SLOTS) {
    const current = env[slot.current];
    if (current) entries.push({ name: slot.current, value: current });
    for (const value of splitList(env[slot.previous])) entries.push({ name: slot.previous, value });
  }
  return entries;
}

/** Parses "keyId:secret,..." into entries. Error messages name the variable only, never a value. */
function parsePreviousHmacKeys(value: string | undefined, currentKeyId: string | undefined): { keyId: string; secret: string }[] {
  const seen = new Set<string>(currentKeyId ? [currentKeyId] : []);
  return splitList(value).map((entry) => {
    const separator = entry.indexOf(':');
    const keyId = separator > 0 ? entry.slice(0, separator) : '';
    const secret = separator > 0 ? entry.slice(separator + 1) : '';
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(keyId)) throw new Error('Invalid configuration: APPROVAL_HMAC_PREVIOUS_KEYS entries must be keyId:secret');
    if (secret.length < 32) throw new Error('Invalid configuration: APPROVAL_HMAC_PREVIOUS_KEYS secrets must be at least 32 characters');
    if (seen.has(keyId)) throw new Error('Invalid configuration: APPROVAL_HMAC_PREVIOUS_KEYS key ids must be unique and differ from APPROVAL_KEY_ID');
    seen.add(keyId);
    return { keyId, secret };
  });
}

/** Signing keys by key id: the current key plus retired keys kept for verification only. */
export function buildHmacKeyRing(cfg: Pick<Config, 'APPROVAL_HMAC_SECRET' | 'APPROVAL_KEY_ID' | 'APPROVAL_HMAC_PREVIOUS_KEYS'>): Map<string, string> {
  const ring = new Map<string, string>([[cfg.APPROVAL_KEY_ID, cfg.APPROVAL_HMAC_SECRET]]);
  for (const { keyId, secret } of parsePreviousHmacKeys(cfg.APPROVAL_HMAC_PREVIOUS_KEYS, cfg.APPROVAL_KEY_ID)) ring.set(keyId, secret);
  return ring;
}

function assertProductionSecretStrength(env: Record<string, string | undefined>): void {
  const weak: string[] = [];
  const check = (name: string, value: string | undefined) => {
    if (value && (value.length < MIN_PRODUCTION_SECRET_LENGTH || PLACEHOLDER_SECRET.test(value))) weak.push(name);
  };
  for (const { name, value } of serviceKeyEntries(env)) check(name, value);
  check('APPROVAL_HMAC_SECRET', env.APPROVAL_HMAC_SECRET);
  for (const { secret } of parsePreviousHmacKeys(env.APPROVAL_HMAC_PREVIOUS_KEYS, env.APPROVAL_KEY_ID)) check('APPROVAL_HMAC_PREVIOUS_KEYS', secret);
  if (weak.length > 0) {
    throw new Error(`Invalid configuration: production secrets must be at least ${MIN_PRODUCTION_SECRET_LENGTH} random characters and not placeholders (${[...new Set(weak)].join(', ')})`);
  }
}

export function guardedTestDatabaseUrl(env: Record<string, string | undefined>): string {
  if (env.NODE_ENV !== 'test') {
    throw new Error('Database tests require NODE_ENV=test');
  }
  const value = env.TEST_DATABASE_URL;
  if (!value) throw new Error('Database tests require TEST_DATABASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  let databasePath: string;
  try { databasePath = decodeURIComponent(parsed.pathname); }
  catch { throw new Error('TEST_DATABASE_URL has an invalid database name'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !/^\/[A-Za-z0-9_-]+_test$/.test(databasePath) || parsed.search || parsed.hash) {
    throw new Error('TEST_DATABASE_URL database name must end in _test');
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const serviceKeys = serviceKeyEntries(env).map(({ value }) => value);
  if (new Set(serviceKeys).size !== serviceKeys.length) throw new Error('API key values must be unique');
  if (splitList(env.API_KEYS_REVOKED_SHA256).some((entry) => !/^[0-9a-fA-F]{64}$/.test(entry))) {
    throw new Error('Invalid configuration: API_KEYS_REVOKED_SHA256 must be comma-separated SHA-256 hex fingerprints');
  }
  const previousHmacKeys = parsePreviousHmacKeys(env.APPROVAL_HMAC_PREVIOUS_KEYS, env.APPROVAL_KEY_ID);
  const signingSecrets = [env.APPROVAL_HMAC_SECRET, ...previousHmacKeys.map(({ secret }) => secret)].filter((value): value is string => Boolean(value));
  if (signingSecrets.some((secret) => serviceKeys.includes(secret))) {
    throw new Error(`Invalid configuration: approval signing secrets must not be reused as API keys${env.NODE_ENV === 'production' ? ' in production' : ''}`);
  }
  if (env.NODE_ENV === 'production') assertProductionSecretStrength(env);
  const runtimeEnv = env.NODE_ENV === 'test' || env.VITEST === 'true' || env.TEST_SUITE === 'integration'
    ? { ...env, DATABASE_URL: guardedTestDatabaseUrl(env) }
    : env;
  const parsed = envSchema.safeParse(runtimeEnv);
  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map(
      (iss) => `${iss.path.join('.')}: ${iss.message}`
    ).join(', ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }
  return parsed.data;
}

export const config = loadConfig();

export function parseCorsOrigins(value: string): string[] {
  return value.split(',').map((origin) => origin.trim()).filter(Boolean);
}
