import { readHealthSnapshot, type HealthSnapshot } from '../shared/health.ts';
import { button, byId, element } from './dom.ts';
import type { Modal } from './modal.ts';
import { request } from './transport.ts';

type HealthDialog = Pick<Modal, 'open' | 'token' | 'owns' | 'actions' | 'close'>;
type HealthRead = (signal: AbortSignal) => Promise<unknown>;
const read: HealthRead = signal => request('/api/health', 'GET', undefined, undefined, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));

/** Health is one explicit snapshot, independent of connection recovery and conversation focus. */
export class HealthStatus {
  readonly node: HTMLButtonElement;
  private token?: number;
  private modal: HealthDialog;
  private read: HealthRead;
  constructor(modal: HealthDialog, before: HTMLElement = byId('workbench-version'), readHealth: HealthRead = read) {
    this.modal = modal; this.read = readHealth;
    this.node = button('Health', () => this.open(), 'workbench-health');
    this.node.id = 'workbench-health'; this.node.setAttribute('aria-label', 'Read backend health');
    this.node.title = 'Read backend health on demand';
    const parent = before.parentElement;
    if (!parent) throw new Error('Missing workbench status line.');
    parent.insertBefore(this.node, before);
  }
  open(): void {
    if (this.token !== undefined && this.modal.owns(this.token)) return;
    const controller = new AbortController();
    const body = this.modal.open('Backend health', undefined, () => controller.abort()), token = this.modal.token;
    this.token = token;
    const content = element('div', 'health-details'); content.setAttribute('aria-live', 'polite'); body.append(content);
    let busy = false;
    const refresh = button('Refresh health', () => {void load();});
    const load = async () => {
      if (busy || !this.modal.owns(token)) return;
      busy = true; refresh.disabled = true; content.replaceChildren(element('p', undefined, 'Read backend health…'));
      try {
        const snapshot = readHealthSnapshot(await this.read(controller.signal));
        if (this.modal.owns(token)) renderHealth(content, snapshot);
      } catch {
        if (this.modal.owns(token)) content.replaceChildren(element('p', undefined, 'Backend health is unavailable. Select Refresh health to retry.'));
      } finally {busy = false; if (this.modal.owns(token)) refresh.disabled = false;}
    };
    this.modal.actions(refresh, button('Close', () => this.modal.close()));
    void load();
  }
}
function renderHealth(content: HTMLElement, snapshot: HealthSnapshot): void {
  const facts = element('dl', 'health-facts');
  const row = (name: string, value: string) => facts.append(element('dt', undefined, name), element('dd', undefined, value));
  row('Process', String(snapshot.process.pid)); row('Started', snapshot.startedAt);
  row('Uptime', `${Math.floor(snapshot.process.uptimeMs / 1000)} s`); row('Supervisor restarts', String(snapshot.supervisorRestarts));
  row('UI', snapshot.identity.iteration);
  if (snapshot.identity.commit) row('Commit', snapshot.identity.commit);
  if (snapshot.identity.assetDigest) row('Assets', snapshot.identity.assetDigest);
  row('User stylesheet', {none: 'Not configured', applied: 'Applied', missing: 'File not found', 'too-large': 'File too large', unreadable: 'File not readable', invalid: 'Setting invalid'}[snapshot.userStylesheet.state]);
  for (const service of snapshot.services) row({files: 'File worker', agents: 'Agent worker', rpc: 'Primary RPC'}[service.name],
    service.state === 'stopped' && service.name === 'rpc' ? 'idle (no primary running)' : service.reason ? `${service.state}: ${service.reason}` : service.state);
  row('Build', snapshot.build.state); row('Memory RSS', `${Math.round(snapshot.process.rssBytes / (1024 * 1024))} MiB`);
  row('Active API requests', `${snapshot.requests.active} / ${snapshot.requests.limit}`);
  content.replaceChildren(element('p', undefined, 'This snapshot changes only when you select Refresh health.'), facts);
}
