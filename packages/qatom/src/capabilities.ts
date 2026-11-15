import { createHash } from 'node:crypto';
import { canonicalJson } from '@trendie/contracts';
import { QATOM_ENDPOINT, createQatomClient, type ToolDescription } from './client.js';

export interface CapabilityEvidence {
  endpoint: string;
  observedAt: string;
  tokenPresent: boolean;
  accessVerified: boolean;
  status: number | null;
  authChallenge: boolean;
  toolInventory: 'available' | 'unavailable' | 'malformed' | 'oversized';
  tools: Array<{ name: string; schemaFingerprint: string; readOnly: boolean | null }>;
  checkout: { toolPresent: boolean; atomicPriceCurrencyBinding: 'unknown'; receiptGuarantee: 'unknown' };
}

export async function collectCapabilities(options: { token?: string; endpoint?: string; observedAt?: string; clientFactory?: typeof createQatomClient } = {}): Promise<CapabilityEvidence> {
  const configuredEndpoint = options.endpoint ?? QATOM_ENDPOINT;
  const endpoint = safeEndpoint(configuredEndpoint);
  const tokenPresent = Boolean(options.token);
  const evidence: CapabilityEvidence = {
    endpoint, observedAt: options.observedAt ?? new Date().toISOString(), tokenPresent, accessVerified: false,
    status: null, authChallenge: false, toolInventory: 'unavailable', tools: [],
    checkout: { toolPresent: false, atomicPriceCurrencyBinding: 'unknown', receiptGuarantee: 'unknown' },
  };
  let client;
  try {
    client = await (options.clientFactory ?? createQatomClient)(options.token ? { token: options.token, endpoint: configuredEndpoint } : { endpoint: configuredEndpoint });
    const tools = await client.listTools();
    evidence.accessVerified = true;
    if (!Array.isArray(tools)) { evidence.toolInventory = 'malformed'; return evidence; }
    if (tools.length > 200) { evidence.toolInventory = 'oversized'; return evidence; }
    try {
      evidence.tools = tools.map((tool) => safeToolEvidence(tool));
      if (Buffer.byteLength(JSON.stringify(evidence.tools), 'utf8') > 256_000) throw new OversizedSchemaError();
    }
    catch (error) {
      evidence.toolInventory = error instanceof OversizedSchemaError || (error instanceof TypeError && /exceeds/.test(error.message)) ? 'oversized' : 'malformed';
      evidence.tools = [];
      return evidence;
    }
    evidence.toolInventory = 'available';
    evidence.checkout.toolPresent = evidence.tools.some((tool) => tool.name === 'agent_checkout');
  } catch (error) {
    const candidate = error && typeof error === 'object' ? ('status' in error && typeof error.status === 'number' ? error.status : 'code' in error && typeof error.code === 'number' ? error.code : null) : null;
    const status = candidate !== null && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599 ? candidate : null;
    evidence.status = status;
    evidence.authChallenge = status === 401 || status === 403;
  } finally { await client?.close().catch(() => undefined); }
  return evidence;
}

function safeToolEvidence(tool: ToolDescription) {
  if (!tool || typeof tool !== 'object') throw new Error('Malformed tool schema');
  const descriptors = Object.getOwnPropertyDescriptors(tool);
  if (!descriptors.name || !('value' in descriptors.name) || typeof descriptors.name.value !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(descriptors.name.value)) throw new Error('Malformed tool name');
  if (!descriptors.inputSchema || !('value' in descriptors.inputSchema)) throw new Error('Malformed tool schema');
  const annotationDescriptor = descriptors.annotations;
  const annotations = annotationDescriptor && 'value' in annotationDescriptor && annotationDescriptor.value && typeof annotationDescriptor.value === 'object' ? Object.getOwnPropertyDescriptor(annotationDescriptor.value, 'readOnlyHint') : undefined;
  const schema = canonicalJson(descriptors.inputSchema.value);
  if (Buffer.byteLength(schema, 'utf8') > 128_000) throw new OversizedSchemaError();
  return { name: descriptors.name.value, schemaFingerprint: createHash('sha256').update(schema).digest('hex'), readOnly: annotations && 'value' in annotations && typeof annotations.value === 'boolean' ? annotations.value : null };
}

class OversizedSchemaError extends Error {}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) return 'invalid-endpoint';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return 'invalid-endpoint'; }
}
