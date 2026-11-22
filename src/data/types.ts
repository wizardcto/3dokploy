export type ServiceKind = 'app' | 'compose' | 'postgres' | 'redis' | 'mongo' | 'mysql' | 'mariadb' | 'libsql';
export type ServiceStatus = 'running' | 'idle' | 'deploying' | 'error';

export const DB_KINDS: readonly ServiceKind[] = ['postgres', 'redis', 'mongo', 'mysql', 'mariadb', 'libsql'];
export const isDb = (kind: ServiceKind) => DB_KINDS.includes(kind);

export interface Server {
  id: string;
  name: string;
  host?: string;
  vcpu?: number;
  ramGb?: number;
}

export interface Project {
  id: string;
  name: string;
  /** Building trim / zone tint in the scene, any CSS color. */
  color: string;
  description?: string;
}

/** Dokploy: project → environment (production, staging…) → services. */
export interface Environment {
  id: string;
  projectId: string;
  name: string;
}

export interface Service {
  id: string;
  projectId: string;
  environmentId: string;
  serverId: string;
  name: string;
  kind: ServiceKind;
  status: ServiceStatus;
  /** 0..1 of the service's CPU limit. 0 until container stats arrive. */
  cpu: number;
  memMb: number;
  memLimitMb: number;
  domain?: string;
  /** Human readable origin, e.g. "github · acme/api@main" or "postgres:16-alpine". */
  source?: string;
  /** Dokploy's internal (Docker service) name. */
  appName?: string;
  description?: string;
  replicas: number;
  /** Epoch ms of the last successful deploy. */
  lastDeploy: number | null;
  createdAt?: number;
  /** Last 30 CPU samples (0..1), oldest first. */
  cpuHist: number[];
  /** Network throughput in bytes/s (received by / sent from the service's containers). */
  net?: { rxBps: number; txBps: number };
  /** Running containers right now (from container stats). */
  containers?: number;
}

/** Traefik traffic of one host over the last few minutes (from Dokploy's request log). */
export interface DomainTraffic {
  /** Requests per minute. */
  rpm: number;
  /** Requests in the window the stats cover. */
  requests: number;
  /** Shares (0..1) of 4xx and 5xx responses. */
  clientErr: number;
  serverErr: number;
  /** 95th percentile response time, ms. */
  p95Ms: number;
  /** Bytes sent per minute. */
  bytesPerMin: number;
  /** Epoch ms of the newest request seen for this host. */
  lastAt?: number;
  /** Last requests-per-minute samples, oldest first. */
  hist: number[];
}

/** A host Traefik routes: a Dokploy domain, or (no serviceId) a host requests arrive for anyway. */
export interface Domain {
  id: string;
  host: string;
  /** Path prefix when it isn't "/". */
  path?: string;
  https?: boolean;
  serviceId?: string;
  /** Undefined while the request log is unavailable (request tracking off, or an older Dokploy). */
  traffic?: DomainTraffic;
}

export const STAGES = ['Clone', 'Build', 'Push', 'Start', 'Health'] as const;
export type StageName = (typeof STAGES)[number];
export type StageStatus = 'queued' | 'running' | 'done' | 'failed';

export type DeployTrigger = 'push' | 'manual';
/** `queued` = accepted, waiting for the build slot (in the scene: cart still en route). */
export type DeployStatus = 'queued' | 'running' | 'success' | 'failed';

export interface Commit {
  sha: string;
  message: string;
  author: string;
}

export interface Deployment {
  id: string;
  serviceId: string;
  trigger: DeployTrigger;
  status: DeployStatus;
  /** One entry per STAGES item. */
  stages: StageStatus[];
  log: string[];
  commit?: Commit;
  /** Robot cart number shown in the scene ("RC3"). */
  cart: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  id: string;
  serviceId: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface World {
  servers: Server[];
  projects: Project[];
  environments: Environment[];
  services: Service[];
  domains: Domain[];
  deployments: Deployment[];
  alerts: Alert[];
}

export type Collection = keyof World;

/** Incremental update. Arrays are upserts keyed by `id`; `removed` lists ids to drop. */
export type WorldPatch = { [K in Collection]?: World[K] } & {
  removed?: Partial<Record<Collection, string[]>>;
};

export const COLLECTIONS: readonly Collection[] = ['servers', 'projects', 'environments', 'services', 'domains', 'deployments', 'alerts'];

export type SourceState = 'connecting' | 'live' | 'error';

export interface SourceStatus {
  state: SourceState;
  /** Human readable reason when state is "error". */
  message?: string;
  /** Epoch ms of the last successful sync with the upstream API. */
  syncedAt?: number;
}

export const isActiveDeploy = (d: Deployment) => d.status === 'queued' || d.status === 'running';
