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

/**
 * Same-origin JSON write check. Behind a proxy (for example Vercel) `request.url` can carry an
 * internal host, so the public host comes from `x-forwarded-host` / `host`. The browser sets
 * `Origin` and a cross-site page cannot forge it, so this still blocks cross-site writes.
 */
export function isSameOriginJsonWrite(request: Request): boolean {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const origin = request.headers.get('origin');
  if (contentType !== 'application/json' || !origin) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    // ignore: fall back to forwarded headers
  }
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host'))?.split(',', 1)[0]?.trim();
  if (host) {
    const proto = request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim() || new URL(request.url).protocol.replace(':', '');
    if (proto === 'http' || proto === 'https') allowed.add(`${proto}://${host}`.toLowerCase());
  }
  return allowed.has(originUrl.origin.toLowerCase());
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
    throw new GatewayConfigurationError('GATEWAY_BASE_URL must be a valid URL.');
  }

  // Loopback HTTP is always allowed for local work. A deployed gateway must use HTTPS and be
  // listed by exact hostname in GATEWAY_ALLOWED_HOSTS (comma-separated).
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const allowedRemote = new Set(
    (process.env.GATEWAY_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  );
  const isLocal = baseUrl.protocol === 'http:' && localHosts.has(baseUrl.hostname);
  const isAllowedRemote = baseUrl.protocol === 'https:' && allowedRemote.has(baseUrl.hostname.toLowerCase());
  if (
    (!isLocal && !isAllowedRemote) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new GatewayConfigurationError('GATEWAY_BASE_URL must be loopback HTTP or an HTTPS host listed in GATEWAY_ALLOWED_HOSTS.');
  }
  // The default (unset) URL is loopback, which does not exist on Vercel: fail closed there.
  if (process.env.VERCEL && !process.env.GATEWAY_BASE_URL?.trim()) {
    throw new GatewayConfigurationError('Set GATEWAY_BASE_URL to the deployed gateway HTTPS URL.');
  }

  const dashboardKey = process.env.API_KEY_DASHBOARD?.trim();
  const agentKey = process.env.API_KEY_AGENT?.trim();
  const adminKey = process.env.API_KEY_ADMIN?.trim();
  if (!dashboardKey || !agentKey || dashboardKey === agentKey) {
    throw new GatewayConfigurationError('Set distinct dashboard and agent gateway keys.');
  }
  if (role === 'admin') {
    if (!adminKey) throw new GatewayConfigurationError('Set API_KEY_ADMIN before using admin gateway features.');
    return { baseUrl, apiKey: adminKey };
  }

  const apiKey = role === 'dashboard' ? dashboardKey : agentKey;
  return { baseUrl, apiKey };
}
