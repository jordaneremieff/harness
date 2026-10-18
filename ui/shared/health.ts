export type BackendHealthFacts = {
  startedAt: string;
  supervisorRestarts: number;
  owner?: {pid: number; incarnation: string; protocol: string};
  backend?: {pid: number; release?: string};
  services: {name: 'files' | 'agents' | 'rpc'; state: 'ready' | 'unavailable' | 'stopped'}[];
  build: {state: 'static' | 'ready' | 'building' | 'failed' | 'held' | 'restart-required'};
};
/** Fixed words only: none means no stylesheet is configured; the others say whether the configured file is applied or why not. */
export const USER_STYLESHEET_STATES = ['none', 'applied', 'missing', 'too-large', 'unreadable', 'invalid'] as const;
export type UserStylesheetState = typeof USER_STYLESHEET_STATES[number];
export type HealthSnapshot = BackendHealthFacts & {
  userStylesheet: {state: UserStylesheetState};
  process: {pid: number; uptimeMs: number; rssBytes: number};
  requests: {active: number; limit: number};
  identity: {iteration: string; commit?: string; assetDigest?: string};
};
const failure = () => new Error('Backend health details are unavailable.');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw failure();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw failure();
  return value as T;
}
function ownerHealth(value:unknown):NonNullable<BackendHealthFacts['owner']> {
  const owner=record(value);
  if(typeof owner.incarnation!=='string'||owner.incarnation.length>128||typeof owner.protocol!=='string'||owner.protocol.length>128)throw failure();
  return {pid:integer(owner.pid),incarnation:owner.incarnation,protocol:owner.protocol};
}
function backendHealth(value:unknown):NonNullable<BackendHealthFacts['backend']> {
  const backend=record(value);
  if(backend.release!==undefined&&(typeof backend.release!=='string'||!/^[a-f0-9]{64}$/.test(backend.release)))throw failure();
  return {pid:integer(backend.pid),...(typeof backend.release==='string'?{release:backend.release}:{})};
}
/** Projection excludes diagnostic text, paths, session contents and arbitrary callback properties. */
export function readBackendHealth(value: unknown): BackendHealthFacts {
  const facts = record(value), build = record(facts.build);
  if (typeof facts.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(facts.startedAt) || !Number.isFinite(Date.parse(facts.startedAt))) throw failure();
  if (!Array.isArray(facts.services) || facts.services.length > 3) throw failure();
  const services = facts.services.map(value => {
    const service = record(value);
    return {name: choice(service.name, ['files', 'agents', 'rpc'] as const), state: choice(service.state, ['ready', 'unavailable', 'stopped'] as const)};
  });
  if (new Set(services.map(service => service.name)).size !== services.length) throw failure();
  const result: BackendHealthFacts = {startedAt: new Date(facts.startedAt).toISOString(), supervisorRestarts: integer(facts.supervisorRestarts), services,
    build: {state: choice(build.state, ['static', 'ready', 'building', 'failed', 'held', 'restart-required'] as const)}};
  if(facts.owner!==undefined)result.owner=ownerHealth(facts.owner);
  if(facts.backend!==undefined)result.backend=backendHealth(facts.backend);
  return result;
}
export function readHealthSnapshot(value: unknown): HealthSnapshot {
  const snapshot = record(value), process = record(snapshot.process), requests = record(snapshot.requests), identity = record(snapshot.identity);
  if (typeof identity.iteration !== 'string' || !/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(identity.iteration)) throw failure();
  const safeIdentity: HealthSnapshot['identity'] = {iteration: identity.iteration};
  if (identity.commit !== undefined) {
    if (typeof identity.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity.commit)) throw failure();
    safeIdentity.commit = identity.commit;
  }
  if (identity.assetDigest !== undefined) {
    if (typeof identity.assetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(identity.assetDigest)) throw failure();
    safeIdentity.assetDigest = identity.assetDigest;
  }
  const stylesheet = record(snapshot.userStylesheet);
  const limit = integer(requests.limit, 64), active = integer(requests.active, limit);
  return {...readBackendHealth(snapshot), process: {pid: integer(process.pid), uptimeMs: integer(process.uptimeMs), rssBytes: integer(process.rssBytes)},
    requests: {active, limit}, identity: safeIdentity,
    userStylesheet: {state: choice(stylesheet.state, USER_STYLESHEET_STATES)}};
}
