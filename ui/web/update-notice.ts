import type { UiIdentity } from '../shared/version.ts';
import { button, element } from './dom.ts';
import { changesSince, changesText, nextUpdateRecord, readUpdateRecord, UPDATE_KEY, type UpdateRecord } from './update-record.ts';

export type UpdateNoticeHooks = {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  /** The footer item goes before this node, beside the version it describes. */
  before: HTMLElement;
  /** Opens the details dialog with these nodes as its body. */
  details(title: string, body: HTMLElement[]): void;
  copy(text: string, anchor: HTMLElement): void;
};
const short = (commit: string): string => commit.slice(0, 8);

/** After the page shows a different release than this tab showed before, one footer line says so, with what changed. */
export class UpdateNotice {
  readonly node = element('span', 'secondary workbench-updated');
  private record?: UpdateRecord;
  private suppressed = false;
  private readonly identity: UiIdentity;
  private readonly hooks: UpdateNoticeHooks;
  constructor(identity: UiIdentity, hooks: UpdateNoticeHooks) {
    this.identity = identity; this.hooks = hooks;
    this.node.setAttribute('role', 'status'); this.node.hidden = true;
    const commit = identity.git?.commit; if (!commit) return;
    try { this.record = nextUpdateRecord(readUpdateRecord(hooks.storage.getItem(UPDATE_KEY)), commit); hooks.storage.setItem(UPDATE_KEY, JSON.stringify(this.record)); }
    catch { this.record = undefined; return; }
    this.paint();
    hooks.before.before(this.node);
  }
  /** A newer served release takes precedence without changing this tab's update record. */
  suppress(value: boolean): void {
    if (this.suppressed === value) return;
    this.suppressed = value; this.paint();
  }
  private paint(): void {
    const record = this.record; this.node.replaceChildren();
    this.node.hidden = this.suppressed || !record || record.dismissed || !record.from;
    if (!record || this.node.hidden || !record.from) return;
    this.node.title = `Updated from ${short(record.from)} to ${short(record.to)}`;
    this.node.append(element('span', undefined, `Updated to ${short(record.to)}`), button('Details', () => this.open()), button('Dismiss', () => this.dismiss()));
  }
  private dismiss(): void {
    const record = this.record; if (!record) return;
    this.record = {...record, dismissed: true};
    try { this.hooks.storage.setItem(UPDATE_KEY, JSON.stringify(this.record)); } catch { /* The notice still closes for this page. */ }
    this.paint();
  }
  private open(): void {
    const record = this.record; if (!record?.from) return;
    const changes = changesSince(this.identity.recent, record.from), body: HTMLElement[] = [];
    if (changes.known && changes.subjects.length) {
      const list = element('ul', 'update-changes');
      for (const item of changes.subjects) list.append(element('li', undefined, `${short(item.commit)} ${item.subject}`));
      body.push(list);
      if (changes.more > 0) body.push(element('p', 'secondary', `${changes.more} more`));
      const all = changesText(this.identity.recent, record.from), copier = button('Copy changes', () => this.hooks.copy(all, copier));
      body.push(copier);
    } else if (changes.known) body.push(element('p', undefined, 'No commit subjects are listed between these two releases.'));
    else body.push(element('p', undefined, 'The earlier version is not in this release\u2019s history list.'));
    body.push(element('p', 'secondary', `From ${record.from}`), element('p', 'secondary', `To ${record.to}`));
    this.hooks.details(`Updated from ${short(record.from)} to ${short(record.to)}`, body);
  }
}
