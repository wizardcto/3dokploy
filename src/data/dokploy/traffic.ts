/**
 * Per-domain traffic from Traefik's access log. Dokploy only keeps the newest few hundred
 * requests, so every refresh re-reads the whole log and recomputes the stats: no cursor, nothing
 * to lose when a poll is missed. When the log covers less than the window (a busy server), rates
 * are taken over the time it does cover.
 */
import type { DomainTraffic } from '../types';
import type { DomainConfig, RequestEntry } from './api';

/** The stats describe the last 15 minutes. */
export const TRAFFIC_WINDOW_MS = 15 * 60_000;
const HIST = 30;

const STRAY = 'host:';
/** Id for a host no Dokploy domain claims (scanners on the bare IP, stale DNS…). */
export const strayHostId = (host: string) => `${STRAY}${host}`;
/** The host behind a stray id; undefined for a Dokploy domain id. */
export const strayHost = (id: string) => (id.startsWith(STRAY) ? id.slice(STRAY.length) : undefined);

/**
 * Domain id per request. A host shared by several domains (different paths, or services) is
 * split by Traefik's router name, which starts with the service's appName.
 */
export function assign(entries: RequestEntry[], domains: DomainConfig[], appNameOf: (serviceId: string) => string | undefined) {
  const byHost = new Map<string, DomainConfig[]>();
  for (const d of domains) byHost.set(d.host, [...(byHost.get(d.host) ?? []), d]);
  const out = new Map<string, RequestEntry[]>();
  for (const e of entries) {
    const claims = byHost.get(e.host);
    const owner =
      !claims ? undefined : claims.length === 1 ? claims[0] : (claims.find((d) => e.router && e.router.startsWith(appNameOf(d.serviceId) ?? '\0')) ?? claims[0]);
    const id = owner?.id ?? strayHostId(e.host);
    out.set(id, [...(out.get(id) ?? []), e]);
  }
  return out;
}

/** Stats of one domain's requests. `since` is where the log (or the window) starts. */
export function trafficOf(entries: RequestEntry[], since: number, now: number, hist: number[] = []): DomainTraffic {
  const recent = entries.filter((e) => e.at >= since);
  const minutes = Math.max(1, (now - since) / 60_000);
  const n = recent.length;
  const ms = recent.map((e) => e.ms).sort((a, b) => a - b);
  const rpm = Math.round((n / minutes) * 100) / 100;
  return {
    rpm,
    requests: n,
    clientErr: n ? recent.filter((e) => e.status >= 400 && e.status < 500).length / n : 0,
    serverErr: n ? recent.filter((e) => e.status >= 500).length / n : 0,
    p95Ms: n ? Math.round(ms[Math.ceil(n * 0.95) - 1]) : 0,
    bytesPerMin: Math.round(recent.reduce((a, e) => a + e.bytes, 0) / minutes),
    lastAt: entries.reduce<number | undefined>((a, e) => (a === undefined || e.at > a ? e.at : a), undefined),
    hist: [...hist.slice(-(HIST - 1)), rpm],
  };
}

/** Start of what the stats can cover: the window, or the oldest logged request if that is newer. */
export function coverageStart(entries: RequestEntry[], now: number) {
  const oldest = entries.reduce((a, e) => Math.min(a, e.at), Infinity);
  return Math.max(now - TRAFFIC_WINDOW_MS, Number.isFinite(oldest) ? oldest : now - TRAFFIC_WINDOW_MS);
}
