/**
 * Traefik traffic per domain: the header's Domains list (every domain, plus hosts no domain
 * claims) and the inspector card for one service's domains. Stats come from Dokploy's request
 * log and cover the last 15 minutes.
 */
import { useMemo } from 'react';
import type { Domain, DomainTraffic } from '../data/types';
import { ago, latency, pct, perMin, rate } from '../format';
import { useStore, type Tone } from '../store';
import { Sparkline } from './bits';
import { ExternalIcon } from './icons';

const WINDOW_LABEL = 'Last 15 min · Traefik';
const NO_DATA = 'No request data. Turn on request tracking on Dokploy’s Requests page to see traffic per domain.';

function tone(t: DomainTraffic | undefined): Tone {
  if (!t?.requests) return 'muted';
  if (t.serverErr >= 0.05) return 'crit';
  if (t.serverErr > 0) return 'warn';
  return 'ok';
}

/** Sparkline wants 0..1: scale to the busiest sample. */
const relative = (xs: number[]) => {
  const max = Math.max(...xs);
  return max > 0 ? xs.map((x) => x / max) : xs;
};

const label = (d: Domain) => `${d.host}${d.path ?? ''}`;
const busiest = (a: Domain, b: Domain) => (b.traffic?.rpm ?? 0) - (a.traffic?.rpm ?? 0) || a.host.localeCompare(b.host);

/** p95 and error shares, compact. */
function Health({ t, now }: { t: DomainTraffic; now: number }) {
  if (!t.requests) return <span className="muted small">{t.lastAt ? `last request ${ago(t.lastAt, now)}` : 'no requests'}</span>;
  return (
    <span className="small domain-health">
      <span className="muted">p95 {latency(t.p95Ms)}</span>
      {t.serverErr > 0 && <span className={`pill pill-${tone(t) === 'crit' ? 'crit' : 'warn'}`}>{pct(t.serverErr)} 5xx</span>}
      {t.clientErr > 0 && <span className="muted">{pct(t.clientErr)} 4xx</span>}
    </span>
  );
}

export function DomainList() {
  const domains = useStore((s) => s.domains);
  const services = useStore((s) => s.services);
  const projects = useStore((s) => s.projects);
  const environments = useStore((s) => s.environments);
  const now = useStore((s) => s.now);

  const { owned, stray, live } = useMemo(() => {
    const all = Object.values(domains);
    return {
      owned: all.filter((d) => d.serviceId).sort(busiest),
      stray: all.filter((d) => !d.serviceId).sort(busiest).slice(0, 12),
      live: all.some((d) => d.traffic),
    };
  }, [domains]);

  if (!owned.length && !stray.length) return <p className="empty muted">No domains configured in Dokploy.</p>;

  const pick = (serviceId: string) => {
    const s = useStore.getState();
    s.select(serviceId);
    s.toggleMenu(null);
  };

  return (
    <>
      <p className="menu-note muted small">{live ? WINDOW_LABEL : NO_DATA}</p>
      <ul className="rows">
        {owned.map((d) => {
          const svc = services[d.serviceId!];
          return (
            <li key={d.id}>
              <button type="button" className="row" onClick={() => pick(d.serviceId!)}>
                <i className={`sev sev-${tone(d.traffic)}`} />
                <span className="row-main">
                  <strong className="mono">{label(d)}</strong>
                  <span className="muted small truncate">
                    {svc?.name ?? 'service'} · {projects[svc?.projectId ?? '']?.name} · {environments[svc?.environmentId ?? '']?.name}
                  </span>
                </span>
                {d.traffic && (
                  <span className="row-side">
                    <span className="num small">{perMin(d.traffic.rpm)}</span>
                    <Health t={d.traffic} now={now} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {stray.length > 0 && (
        <>
          <h3 className="section-title menu-group" title="Requests Traefik received for hosts that no Dokploy domain claims, such as scanners hitting the bare IP">
            Other hosts
          </h3>
          <ul className="rows">
            {stray.map((d) => (
              <li key={d.id} className="row is-static">
                <i className={`sev sev-${tone(d.traffic)}`} />
                <span className="row-main">
                  <strong className="mono">{d.host}</strong>
                </span>
                {d.traffic && (
                  <span className="row-side">
                    <span className="num small">{perMin(d.traffic.rpm)}</span>
                    <Health t={d.traffic} now={now} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** One service's domains with their traffic; falls back to the plain link without domain data. */
export function DomainCard({ serviceId, fallback }: { serviceId: string; fallback?: string }) {
  const domains = useStore((s) => s.domains);
  const now = useStore((s) => s.now);
  const own = useMemo(() => Object.values(domains).filter((d) => d.serviceId === serviceId).sort(busiest), [domains, serviceId]);

  if (!own.length) {
    return fallback ? <DomainLink host={fallback} /> : <span className="muted small">No public domain</span>;
  }
  return (
    <section className="insp-card domain-card">
      <div className="insp-card-head">
        <span className="label">Domains</span>
        <span className="muted small">{own.some((d) => d.traffic) ? WINDOW_LABEL : ''}</span>
      </div>
      <ul className="mini-list">
        {own.map((d) => (
          <li key={d.id}>
            <i className={`sev sev-${tone(d.traffic)}`} />
            <DomainLink host={d.host} path={d.path} https={d.https} />
            {d.traffic && <span className="num small">{perMin(d.traffic.rpm)}</span>}
            {d.traffic && (
              <div className="domain-stats">
                <Health t={d.traffic} now={now} />
                {d.traffic.requests > 0 && <span className="muted small">{rate(d.traffic.bytesPerMin / 60)} out</span>}
              </div>
            )}
            {d.traffic && d.traffic.hist.length > 1 && (
              <div className="domain-spark">
                <Sparkline values={relative(d.traffic.hist)} height={28} label={`Requests per minute, ${label(d)}`} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {!own.some((d) => d.traffic) && <p className="muted small">{NO_DATA}</p>}
    </section>
  );
}

function DomainLink({ host, path, https = true }: { host: string; path?: string; https?: boolean }) {
  const href = `${https ? 'https' : 'http'}://${host}${path ?? ''}`;
  return (
    <a className="domain mono truncate" href={href} title={href} target="_blank" rel="noreferrer noopener">
      {host}
      {path}
      <ExternalIcon />
    </a>
  );
}
