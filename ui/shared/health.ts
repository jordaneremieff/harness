export type BackendHealthFacts = {
  startedAt: string;
  supervisorRestarts: number;
  owner?: {pid: number; incarnation: string; protocol: string};
  backend?: {pid: number; release?: string};
  /** `stopped` on `rpc` means no primary is running (idle) or the backend is closing; `reason` is bounded text that only an `unavailable` service carries. */
  services: {name: 'files' | 'agents' | 'rpc'; state: 'ready' | 'unavailable' | 'stopped'; reason?: string}[];
  build: {state: 'static' | 'ready' | 'building' | 'failed' | 'held' | 'restart-required'};
};
/** Fixed words only: none means no stylesheet is configured; the others say whether the configured file is applied or why not. */
export const USER_STYLESHEET_STATES = ['none', 'applied', 'missing', 'too-large', 'unreadable', 'invalid'] as const;
export type UserStylesheetState = typeof USER_STYLESHEET_STATES[number];
export type PageEvidence = {scope:'registered-backend-pages';complete:false;pages:{client:string;generation:string;cssGeneration:string;family?:string;layoutVersion?:number}[]};
export type HealthSnapshot = BackendHealthFacts & {
  /** Registered leases only; disconnected or pre-switch pages are not an exhaustive inventory. */
  pages?: PageEvidence;
  userStylesheet: {state: UserStylesheetState};
  process: {pid: number; uptimeMs: number; rssBytes: number};
  requests: {active: number; limit: number};
  identity: {iteration: string; commit?: string; assetDigest?: string; moduleFamily?: string};
};
export const HEALTH_REASON_CHARACTERS = 160;
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
    const state = choice(service.state, ['ready', 'unavailable', 'stopped'] as const);
    if (service.reason !== undefined && (state !== 'unavailable' || typeof service.reason !== 'string' || !service.reason || service.reason.length > HEALTH_REASON_CHARACTERS || /[\u0000-\u001f\u007f]/.test(service.reason))) throw failure();
    return {name: choice(service.name, ['files', 'agents', 'rpc'] as const), state, ...(typeof service.reason === 'string' ? {reason: service.reason} : {})};
  });
  if (new Set(services.map(service => service.name)).size !== services.length) throw failure();
  const result: BackendHealthFacts = {startedAt: new Date(facts.startedAt).toISOString(), supervisorRestarts: integer(facts.supervisorRestarts), services,
    build: {state: choice(build.state, ['static', 'ready', 'building', 'failed', 'held', 'restart-required'] as const)}};
  if(facts.owner!==undefined)result.owner=ownerHealth(facts.owner);
  if(facts.backend!==undefined)result.backend=backendHealth(facts.backend);
  return result;
}
function readPageEvidence(value:unknown):PageEvidence {
  const facts=record(value);
  if(facts.scope!=='registered-backend-pages'||facts.complete!==false||!Array.isArray(facts.pages)||facts.pages.length>64)throw failure();
  const pages=facts.pages.map(value=>{
    const page=record(value);
    if(typeof page.client!=='string'||!/^[a-f0-9]{24}$/.test(page.client)||!['generation','cssGeneration'].every(key=>typeof page[key]==='string'&&/^[a-f0-9]{64}$/.test(page[key] as string))||page.family!==undefined&&(typeof page.family!=='string'||!/^[a-f0-9]{64}$/.test(page.family)))throw failure();
    const layoutVersion=page.layoutVersion===undefined?undefined:integer(page.layoutVersion,999999999);if(layoutVersion===0)throw failure();
    return {client:page.client,generation:page.generation as string,cssGeneration:page.cssGeneration as string,...(typeof page.family==='string'?{family:page.family}:{}),...(layoutVersion===undefined?{}:{layoutVersion})};
  });
  if(new Set(pages.map(page=>page.client)).size!==pages.length)throw failure();
  return {scope:'registered-backend-pages',complete:false,pages};
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
  if (identity.moduleFamily !== undefined) {
    if (typeof identity.moduleFamily !== 'string' || !/^[a-f0-9]{64}$/.test(identity.moduleFamily)) throw failure();
    safeIdentity.moduleFamily = identity.moduleFamily;
  }
  const stylesheet = record(snapshot.userStylesheet);
  const limit = integer(requests.limit, 64), active = integer(requests.active, limit);
  return {...readBackendHealth(snapshot), process: {pid: integer(process.pid), uptimeMs: integer(process.uptimeMs), rssBytes: integer(process.rssBytes)},
    requests: {active, limit}, identity: safeIdentity,...(snapshot.pages===undefined?{}:{pages:readPageEvidence(snapshot.pages)}),
    userStylesheet: {state: choice(stylesheet.state, USER_STYLESHEET_STATES)}};
}
