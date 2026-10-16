import {byId, setText} from './dom.ts';

type Pane = 'primary' | 'agent' | 'file';
const geometryProperties = ['height', 'min-height', 'max-height', 'overflow-x', 'overflow-y'] as const;
type GeometryHold = {pointerId: number; styles: {name: string; value: string; priority: string}[]; frame?: number};
/** Focus changes only status text and visibility, never editor or control ownership. */
export class WorkbenchStatus {
  readonly node: HTMLElement;
  private readonly scope: HTMLElement;
  private readonly activity: HTMLElement;
  private readonly groups = new Map<Pane, HTMLElement>();
  private readonly summaries: HTMLElement[];
  private geometry?: GeometryHold;
  constructor(get: (id: string) => HTMLElement = byId) {
    this.node = get('workbench-status'); this.scope = get('workbench-scope'); this.activity = get('workbench-activity');
    for (const pane of ['primary', 'agent'] as const) this.groups.set(pane, get(`workbench-status-${pane}`));
    this.summaries = ['primary', 'agent'].map(owner => get(`${owner}-status-summary`));
    const matching = (event: Event): GeometryHold | undefined => this.geometry?.pointerId === (event as PointerEvent).pointerId ? this.geometry : undefined;
    document.addEventListener('click', event => this.releaseGeometry(matching(event)));
    document.addEventListener('pointerup', event => {
      const hold = matching(event);
      if (hold && hold.frame === undefined) hold.frame = requestAnimationFrame(() => this.releaseGeometry(hold));
    }, true);
    document.addEventListener('pointercancel', event => this.releaseGeometry(matching(event)), true);
    window.addEventListener('blur', () => this.releaseGeometry(this.geometry));
    this.node.addEventListener('focusin', () => this.releaseGeometry(this.geometry));
  }
  /** Keep the pressed pane control in place while focused facts change their wrapping. */
  holdGeometry(event: Pick<PointerEvent, 'pointerId' | 'button' | 'isPrimary'>): void {
    if (!event.isPrimary || event.button !== 0) return;
    if (this.geometry?.pointerId === event.pointerId && this.geometry.frame === undefined) return;
    this.releaseGeometry(this.geometry);
    const height = this.node.getBoundingClientRect().height;
    if (!Number.isFinite(height) || height <= 0) return;
    const styles = geometryProperties.map(name => ({name, value: this.node.style.getPropertyValue(name), priority: this.node.style.getPropertyPriority(name)}));
    this.geometry = {pointerId: event.pointerId, styles};
    for (const name of geometryProperties) this.node.style.setProperty(name, name.startsWith('overflow-') ? 'hidden' : `${height}px`, 'important');
  }
  private releaseGeometry(hold: GeometryHold | undefined): void {
    if (!hold || this.geometry !== hold) return;
    this.geometry = undefined;
    if (hold.frame !== undefined) cancelAnimationFrame(hold.frame);
    for (const {name, value, priority} of hold.styles) {
      if (value) this.node.style.setProperty(name, value, priority);
      else this.node.style.removeProperty(name);
    }
  }
  update(pane: Pane, name: string, activity: string, identity?: string): void {
    setText(this.scope, name); this.scope.title = identity ?? name;
    this.scope.setAttribute('aria-label', identity ? `${name}: ${identity}` : name);
    setText(this.activity, activity); this.activity.hidden = !activity;
    for (const summary of this.summaries) setText(summary, [name, activity].filter(Boolean).join(' · '));
    this.node.dataset.pane = pane;
    for (const [owner, group] of this.groups) group.hidden = owner !== pane;
  }
}
