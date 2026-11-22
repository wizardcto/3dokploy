/**
 * The one Dokploy this server shows, from DOKPLOY_URL and DOKPLOY_API_KEY, and the handler that
 * forwards the browser's reads to it.
 *
 * Why it exists: Dokploy's API sends no CORS headers, and the API key must stay off the page.
 * So the browser calls /api/<procedure> here, and this calls the same procedure on Dokploy with
 * the key added.
 *
 * What it guarantees:
 *  - only an allowlist of read-only GET endpoints is forwarded: nothing can be changed through it
 *  - the Traefik request log (see `requestLog`) is reduced to host, status, timing and size
 *  - secrets in responses (env vars, passwords, tokens…) are removed before they reach the browser
 *  - the key never leaves this process
 */
import type { Context } from 'hono';

const TIMEOUT_MS = 25_000;

/** "dokploy.example.com/" → "https://dokploy.example.com"; a pasted API/Swagger URL loses its path. */
function normalizeUrl(raw: string) {
  const s = raw.trim();
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  const path = u.pathname.replace(/\/(api|swagger)(\/.*)?$/i, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** Reads the target from the environment, or explains what is missing. */
export function loadTarget(): { url: string; key: string } {
  const raw = process.env.DOKPLOY_URL?.trim();
  const key = process.env.DOKPLOY_API_KEY?.trim();
  const missing = [!raw && 'DOKPLOY_URL', !key && 'DOKPLOY_API_KEY'].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'Put them in .env.local (see .env.example) or in the container environment.',
    );
  }
  try {
    return { url: normalizeUrl(raw!), key: key! };
  } catch {
    throw new Error(`DOKPLOY_URL is not a valid URL: ${raw}`);
  }
}

/** Everything 3Dokploy reads. Mutations are not on the list, so they can't pass. */
const READ_ONLY = new Set([
  'settings.getDokployVersion',
  'project.all',
  'project.one',
  'deployment.allCentralized',
  'deployment.all',
  'deployment.allByCompose',
  'deployment.readLogs',
  'swarm.getContainerStats',
  'docker.getContainersByAppNameMatch',
  'swarm.getNodes',
  'swarm.getNodeInfo',
  'application.one',
  'compose.one',
  'postgres.one',
  'mysql.one',
  'mariadb.one',
  'mongo.one',
  'redis.one',
  'libsql.one',
  'overview.domains',
]);

/** Field names that may hold secrets anywhere in a response. 3Dokploy never needs them. */
const SECRET = /password|secret|token|api[-_]?key|ssh[-_]?key|private[-_]?key|credential|certificate|env$|buildargs/i;

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET.test(k)) out[k] = redact(x);
    return out;
  }
  return v;
}

/** A network failure, in words that point at the fix. */
function describe(e: unknown, url: URL) {
  if ((e as Error).name === 'TimeoutError') return 'Dokploy did not answer in time.';
  const code = ((e as { cause?: { code?: string } }).cause?.code ?? '') as string;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Can't resolve ${url.hostname}. Check DOKPLOY_URL.`;
  if (code === 'ECONNREFUSED') return `${url.host} refused the connection. Check DOKPLOY_URL.`;
  if (code.startsWith('ERR_TLS') || code.includes('CERT')) return `TLS problem with ${url.host} (${code}).`;
  return `Can't reach ${url.host}${code ? ` (${code})` : ''}.`;
}

type Upstream = { ok: true; data: unknown } | { ok: false; status: 401 | 502; error: string };

/** One GET against Dokploy with the key added; failures come back as a message that points at the fix. */
async function upstream(target: { url: string; key: string }, url: URL, procedure: string): Promise<Upstream> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'x-api-key': target.key, accept: 'application/json', 'user-agent': '3dokploy' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 502, error: describe(e, url) };
  }

  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location');
    return { ok: false, status: 502, error: `Dokploy redirected to ${to ?? 'another address'}. Set DOKPLOY_URL to that address.` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: 401, error: 'Dokploy rejected DOKPLOY_API_KEY.' };
  if (!res.headers.get('content-type')?.includes('json')) {
    return { ok: false, status: 502, error: `DOKPLOY_URL doesn't answer like a Dokploy API (HTTP ${res.status}).` };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, status: 502, error: 'Dokploy sent malformed JSON.' };
  }
  if (!res.ok) {
    // REST errors carry `message`; tRPC errors carry `error.json.message`.
    const body = data as { message?: string; error?: { json?: { message?: string } } } | null;
    const message = body?.message ?? body?.error?.json?.message;
    return { ok: false, status: 502, error: `Dokploy ${procedure} → ${res.status}${message ? `: ${message}` : ''}` };
  }
  return { ok: true, data };
}

export function forward(target: { url: string; key: string }) {
  return async (c: Context) => {
    const procedure = c.req.param('procedure') ?? '';
    if (!READ_ONLY.has(procedure)) {
      return c.json({ error: `3Dokploy only reads from Dokploy; ${procedure || 'this'} is not an allowed endpoint.` }, 403);
    }
    const url = new URL(`${target.url}/api/${procedure}`);
    url.search = new URL(c.req.url).search;
    const r = await upstream(target, url, procedure);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    c.header('cache-control', 'no-store');
    return c.json(redact(r.data));
  };
}

/** Entries Dokploy keeps of Traefik's access log (it only reads the newest few hundred anyway). */
const REQUEST_LOG_SIZE = 1000;

/**
 * Traefik's access log, as Dokploy's "Requests" page reads it. Dokploy only offers this on its
 * internal tRPC route, not on the REST API, so it gets its own handler: the query is fixed here
 * (the browser can't pass one), and each entry is cut down to what 3Dokploy shows. Client IPs,
 * paths, user agents and headers never leave this process.
 */
export function requestLog(target: { url: string; key: string }) {
  return async (c: Context) => {
    const procedure = 'settings.readStatsLogs';
    const url = new URL(`${target.url}/api/trpc/${procedure}`);
    const input = { page: { pageIndex: 0, pageSize: REQUEST_LOG_SIZE }, sort: { id: 'StartUTC', desc: true }, search: '', status: [] };
    url.searchParams.set('input', JSON.stringify({ json: input }));
    const r = await upstream(target, url, procedure);
    if (!r.ok) return c.json({ error: r.error }, r.status);

    const rows = (r.data as { result?: { data?: { json?: { data?: unknown } } } })?.result?.data?.json?.data;
    if (!Array.isArray(rows)) return c.json({ error: `Dokploy ${procedure} answered in an unknown format.` }, 502);
    const entries = rows.flatMap((e: Record<string, unknown>) => {
      const at = typeof e.StartUTC === 'string' ? Date.parse(e.StartUTC) : NaN;
      if (!Number.isFinite(at) || typeof e.RequestHost !== 'string' || !e.RequestHost) return [];
      return [
        {
          at,
          host: e.RequestHost.toLowerCase(),
          status: Number(e.DownstreamStatus) || 0,
          ms: (Number(e.Duration) || 0) / 1e6,
          bytes: Number(e.DownstreamContentSize) || 0,
          router: typeof e.RouterName === 'string' ? e.RouterName : undefined,
        },
      ];
    });
    c.header('cache-control', 'no-store');
    return c.json(entries);
  };
}
