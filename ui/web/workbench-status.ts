import {byId, setText} from './dom.ts';

type Pane = 'primary' | 'agent';
/** Focus changes only status text and visibility, never editor or control ownership. */
export class WorkbenchStatus {
  readonly node: HTMLElement;
  private readonly scope: HTMLElement;
  private readonly activity: HTMLElement;
  private readonly groups = new Map<Pane, HTMLElement>();
  constructor(get: (id: string) => HTMLElement = byId) {
    this.node = get('workbench-status'); this.scope = get('workbench-scope'); this.activity = get('workbench-activity');
    for (const pane of ['primary', 'agent'] as const) this.groups.set(pane, get(`workbench-status-${pane}`));
  }
  update(pane: Pane, name: string, activity: string, identity?: string): void {
    setText(this.scope, name); this.scope.title = identity ?? name;
    this.scope.setAttribute('aria-label', identity ? `${name}: ${identity}` : name);
    setText(this.activity, activity); this.activity.hidden = !activity;
    this.node.dataset.pane = pane;
    for (const [owner, group] of this.groups) group.hidden = owner !== pane;
  }
}
