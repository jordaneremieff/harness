import { readHealthSnapshot, type HealthSnapshot } from '../shared/health.ts';
import { identityText, type UiIdentity } from '../shared/version.ts';
import { button, byId, copy, details, element } from './dom.ts';
import { localDateTime } from './format.ts';
import type { Modal } from './modal.ts';
import { request } from './transport.ts';

type HealthDialog = Pick<Modal, 'open' | 'token' | 'owns' | 'actions' | 'close'>;
type HealthRead = (signal: AbortSignal) => Promise<unknown>;
const read: HealthRead = signal => request('/api/health', 'GET', undefined, undefined, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));

/** Health is one explicit snapshot, independent of connection recovery and conversation focus. The version control in the status line opens it. */
export class HealthStatus {
  private token?: number;
  private modal: HealthDialog;
  private identity: UiIdentity;
  private read: HealthRead;
  private generation: string | null;
  private sidebarDiagnostics:()=>readonly string[] = ()=>[];
  setSidebarDiagnostics(read:()=>readonly string[]):void {this.sidebarDiagnostics=read;}
  constructor(modal: HealthDialog, identity: UiIdentity, trigger: HTMLElement = byId('workbench-version'), readHealth: HealthRead = read,
    generation: string | null = document.querySelector('meta[name="ui-generation"]')?.getAttribute('content') ?? null) {
    this.modal = modal; this.identity = identity; this.read = readHealth; this.generation = generation;
    trigger.addEventListener('click', () => this.open());
  }
  open(): void {
    if (this.token !== undefined && this.modal.owns(this.token)) return;
    const controller = new AbortController();
    const body = this.modal.open('Version and health', undefined, () => controller.abort()), token = this.modal.token;
    this.token = token;
    const content = element('div', 'health-details'); content.setAttribute('aria-live', 'polite');
    const sidebar = element('section','health-sidebar'); body.append(content,sidebar);
    let busy = false;
    const copyVersion = button('Copy version', () => { void copy(identityText(this.identity)); });
    const refresh = button('Refresh health', () => {void load();});
    const load = async () => {
      if (busy || !this.modal.owns(token)) return;
      busy = true; refresh.disabled = true; content.replaceChildren(element('p', undefined, 'Read backend health…'));
      sidebar.replaceChildren(...this.sidebarDiagnostics().filter(Boolean).map(text=>details('Sidebar list details',text)));
      try {
        const snapshot = readHealthSnapshot(await this.read(controller.signal));
        if (this.modal.owns(token)) renderHealth(content, snapshot, this.identity, this.generation);
      } catch {
        if (this.modal.owns(token)) content.replaceChildren(element('p', undefined, 'Backend health is unavailable. Select Refresh health to retry.'));
      } finally {busy = false; if (this.modal.owns(token)) refresh.disabled = false;}
    };
    this.modal.actions(copyVersion, refresh);
    void load();
  }
}
const DURATION_UNITS: readonly (readonly [string, number])[] = [['d', 86400], ['h', 3600], ['min', 60], ['s', 1]];
/** The largest two units of a duration, for example "4 min 34 s"; a zero smaller unit is left out. */
export function uptimeText(milliseconds: number): string {
  let rest = Math.max(0, Math.floor(milliseconds / 1000));
  const counts = DURATION_UNITS.map(([unit, size]) => {const count = Math.floor(rest / size); rest -= count * size; return {unit, count};});
  const first = counts.findIndex(item => item.count > 0);
  if (first < 0) return '0 s';
  return counts.slice(first, first + 2).filter((item, index) => index === 0 || item.count > 0).map(item => `${item.count} ${item.unit}`).join(' ');
}
const ASSET_DIGEST_CHARS = 12;
function renderHealth(content: HTMLElement, snapshot: HealthSnapshot, loaded: UiIdentity, generation: string | null): void {
  const facts = element('dl', 'health-facts');
  const row = (name: string, value: string, title?: string) => {
    const field = element('dd', undefined, value); if (title) field.title = title;
    facts.append(element('dt', undefined, name), field);
  };
  row('Process', String(snapshot.process.pid)); row('Started', localDateTime(snapshot.startedAt) || snapshot.startedAt, snapshot.startedAt);
  row('Uptime', uptimeText(snapshot.process.uptimeMs)); row('Supervisor restarts', String(snapshot.supervisorRestarts));
  row('UI', snapshot.identity.iteration);
  if (snapshot.identity.commit) row('Commit', snapshot.identity.commit);
  const digest = snapshot.identity.assetDigest;
  if (digest) row('Assets', digest.length > ASSET_DIGEST_CHARS ? `${digest.slice(0, ASSET_DIGEST_CHARS)}…` : digest, digest);
  row('User stylesheet', {none: 'Not configured', applied: 'Applied', missing: 'File not found', 'too-large': 'File too large', unreadable: 'File not readable', invalid: 'Setting invalid'}[snapshot.userStylesheet.state]);
  for (const service of snapshot.services) row({files: 'File worker', agents: 'Agent worker', rpc: 'Primary RPC'}[service.name],
    service.state === 'stopped' && service.name === 'rpc' ? 'idle (no primary running)' : service.reason ? `${service.state}: ${service.reason}` : service.state);
  row('Build', snapshot.build.state); row('Memory RSS', `${Math.round(snapshot.process.rssBytes / (1024 * 1024))} MiB`);
  row('Active API requests', `${snapshot.requests.active} / ${snapshot.requests.limit}`);
  const identityFields = (name: string, commit: string | undefined, release: string | undefined, browserGeneration: string | undefined) => {
    const section = element('section', 'health-identity'), fields = element('dl', 'health-facts');
    for (const [label, value] of [['Commit', commit], ['Release id', release], ['Browser generation', browserGeneration]]) fields.append(element('dt', undefined, label), element('dd', undefined, value ?? 'Not provided'));
    section.append(element('h3', undefined, name), fields); return section;
  };
  content.replaceChildren(element('p', undefined, 'This snapshot changes only when you select Refresh health.'),
    identityFields('This tab', loaded.git?.commit, loaded.release, generation && /^[a-f0-9]{64}$/.test(generation) ? generation : undefined),
    identityFields('Served', snapshot.identity.commit, snapshot.backend?.release, snapshot.identity.assetDigest), facts);
}
