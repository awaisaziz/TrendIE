import 'server-only';

type GatewayRole = 'dashboard' | 'agent' | 'admin';
type GatewayPath = '/intents' | '/audit' | '/audit/chain/verify' | `/audit?intentId=${string}` | `/intents/${string}` | '/verify';

const REQUEST_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

export type GatewayResult = {
  ok: boolean;
  status: number;
  data?: unknown;
};

export class GatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigurationError';
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > REQUEST_LIMIT_BYTES) {
    throw new RequestBodyError(413, 'Request body is too large.');
  }

  const text = await readLimitedBody(request, REQUEST_LIMIT_BYTES, true);

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError(400, 'Request body must be valid JSON.');
  }
}

export class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

export function isSameOriginJsonWrite(request: Request): boolean {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const origin = request.headers.get('origin');
  if (contentType !== 'application/json' || !origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export async function callGateway(
  role: GatewayRole,
  path: GatewayPath,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {}
): Promise<GatewayResult> {
  const { baseUrl, apiKey } = getGatewayConfig(role);
  const url = new URL(path, baseUrl);
  if (url.hash || (url.search && !/^\?intentId=[^&]+$/.test(url.search)) ||
      (url.search && !path.startsWith('/audit?intentId='))) {
    throw new GatewayConfigurationError('Gateway route is not allowed.');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 503 };
  }

  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_LIMIT_BYTES) {
    return { ok: false, status: 502 };
  }

  let text: string;
  try {
    text = await readLimitedBody(response, RESPONSE_LIMIT_BYTES, false);
  } catch {
    return { ok: false, status: 502 };
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, status: 502 };
  }

  return { ok: response.ok, status: response.status, data };
}

async function readLimitedBody(message: Request | Response, limit: number, clientRequest: true): Promise<string>;
async function readLimitedBody(message: Response, limit: number, clientRequest: false): Promise<string>;
async function readLimitedBody(message: Request | Response, limit: number, clientRequest: boolean): Promise<string> {
  if (!message.body) return '';
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        if (clientRequest) throw new RequestBodyError(413, 'Request body is too large.');
        throw new Error('Gateway response is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export function getDemoOwnerId(): string {
  const value = process.env.DEMO_OWNER_ID?.trim();
  if (!value || value.length > 128) {
    throw new GatewayConfigurationError('Set a local DEMO_OWNER_ID before using gateway-backed features.');
  }
  return value;
}

function getGatewayConfig(role: GatewayRole): { baseUrl: URL; apiKey: string } {
  const configuredUrl = process.env.GATEWAY_BASE_URL?.trim() || 'http://127.0.0.1:3000';
  let baseUrl: URL;
  try {
    baseUrl = new URL(configuredUrl);
  } catch {
    throw new GatewayConfigurationError('GATEWAY_BASE_URL must be a valid local URL.');
  }

  // Loopback may use plain HTTP (local development). Any other host, such as a gateway deployed
  // for a Vercel build, must use HTTPS so service API keys are never sent in clear text.
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const isLoopback = loopbackHosts.has(baseUrl.hostname);
  if (
    (isLoopback ? baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:' : baseUrl.protocol !== 'https:') ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new GatewayConfigurationError('GATEWAY_BASE_URL must be a loopback URL or an HTTPS URL without credentials.');
  }
  // The default (unset) URL is loopback, which does not exist on Vercel: fail closed there.
  if (process.env.VERCEL && !process.env.GATEWAY_BASE_URL?.trim()) {
    throw new GatewayConfigurationError('Set GATEWAY_BASE_URL to the deployed gateway HTTPS URL.');
  }

  const dashboardKey = process.env.API_KEY_DASHBOARD?.trim();
  const agentKey = process.env.API_KEY_AGENT?.trim();
  const configuredAdminKey = process.env.API_KEY_ADMIN?.trim();
  // The well-known development key is only a local convenience; never fall back to it elsewhere.
  const adminKey = configuredAdminKey || (process.env.NODE_ENV === 'production' || process.env.VERCEL ? undefined : 'dev-admin-key-7890');
  if (!dashboardKey || !agentKey || dashboardKey === agentKey) {
    throw new GatewayConfigurationError('Set distinct dashboard and agent gateway keys.');
  }
  if (role === 'admin') {
    if (!adminKey) throw new GatewayConfigurationError('Set API_KEY_ADMIN to use audit verification.');
    return { baseUrl, apiKey: adminKey };
  }

  const apiKey = role === 'dashboard' ? dashboardKey : agentKey;
  return { baseUrl, apiKey };
}
