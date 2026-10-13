import {element} from './dom.ts';

type Projection = {slot: HTMLElement; parent: HTMLElement; hidden: boolean; inert: boolean; saved: {position: string; left: string; top: string; width: string; margin: string; clipPath: string}};
/** Layout slots move; native view trees stay under one connected host for their lifetime. */
export class StableViews {
  readonly host = element('div', 'stable-views');
  private readonly roots = new Map<HTMLElement, HTMLElement | undefined>();
  private readonly projections = new Map<HTMLElement, Projection>();
  private readonly observer: ResizeObserver;
  private frame = 0;
  private readonly parent: HTMLElement;
  constructor(parent: HTMLElement) {
    this.parent = parent; parent.append(this.host);
    this.observer = new ResizeObserver(() => this.request()); this.observer.observe(parent);
    window.addEventListener('resize', this.request);
    parent.addEventListener('scroll', this.request, true);
  }
  mount(node: HTMLElement): void {
    if (this.roots.has(node)) return;
    if (node.isConnected) throw new Error('Mount a native view before editing starts.');
    this.host.append(node); this.roots.set(node, undefined); this.observer.observe(node);
  }
  place(node: HTMLElement, slot?: HTMLElement): void {
    this.mount(node);
    const old = this.roots.get(node); if (old !== slot) {if (old) this.observer.unobserve(old); if (slot) this.observer.observe(slot); this.roots.set(node, slot);}
    node.hidden = !slot; node.inert = !slot; node.dataset.viewSlot = slot?.id ?? ''; this.request();
  }
  /** Project a nested part into a slot without changing any of its native ancestors. */
  project(node: HTMLElement, slot?: HTMLElement): void {
    const old = this.projections.get(node);
    if (old?.slot === slot) return;
    if (old) {Object.assign(node.style, old.saved); node.hidden = old.hidden; node.inert = old.inert; old.slot.style.removeProperty('height'); this.observer.unobserve(old.slot); this.observer.unobserve(node); this.projections.delete(node);}
    if (slot) {
      const parent = node.parentElement; if (this.roots.has(node) || !parent || !this.host.contains(parent)) throw new Error('Project a part of a mounted view.');
      const {position, left, top, width, margin, clipPath} = node.style;
      this.projections.set(node, {slot, parent, hidden: node.hidden, inert: node.inert, saved: {position, left, top, width, margin, clipPath}}); this.observer.observe(slot); this.observer.observe(node);
    }
    this.request();
  }
  slot(node: HTMLElement): HTMLElement | undefined {
    for (let current: HTMLElement | null = node; current && current !== this.host; current = current.parentElement) {
      const projected = this.projections.get(current); if (projected) return projected.slot;
      const slot = this.roots.get(current); if (slot) return slot;
    }
    return undefined;
  }
  height(node: HTMLElement): number | undefined {
    for (let current: HTMLElement | null = node; current && current !== this.host; current = current.parentElement) {
      const projected = this.projections.get(current); if (projected) return projected.slot.parentElement?.clientHeight;
      const slot = this.roots.get(current); if (slot) return slot.clientHeight;
    }
    return undefined;
  }
  forget(node: HTMLElement): void {
    for (const part of [...this.projections.keys()]) if (node.contains(part)) this.project(part);
    const slot = this.roots.get(node); if (slot) this.observer.unobserve(slot); this.observer.unobserve(node); this.roots.delete(node);
  }
  readonly request = (): void => { if (!this.frame) this.frame = requestAnimationFrame(() => {this.frame = 0; this.sync();}); };
  sync(): void {
    if (this.host.parentElement !== this.parent) throw new Error('A native view host changed its parent.');
    const origin = this.host.getBoundingClientRect();
    for (const [node, slot] of this.roots) {
      if (node.parentElement !== this.host) throw new Error('A native view changed its host.');
      const visible = slot?.isConnected && !slot.closest('[hidden],[inert]'); node.hidden = !visible; node.inert = !visible;
      if (!visible || !slot) continue;
      const box = slot.getBoundingClientRect();
      Object.assign(node.style, {position: 'absolute', left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px`, height: `${box.height}px`});
    }
    this.syncProjections();
  }
  private syncProjections(): void {
    for (const [node, projection] of this.projections) {
      if (node.parentElement !== projection.parent) throw new Error('A native view part changed its parent.');
      const box = projection.slot.getBoundingClientRect(), parent = projection.parent.getBoundingClientRect();
      const visible = projection.slot.isConnected && !projection.slot.closest('[hidden],[inert]') && box.width > 0;
      node.hidden = !visible; node.inert = !visible; if (!visible) continue;
      Object.assign(node.style, {position: 'absolute', margin: '0px', left: `${box.left - parent.left}px`, top: `${box.top - parent.top}px`, width: `${box.width}px`});
      const placed = node.getBoundingClientRect(), clip = projection.slot.parentElement?.getBoundingClientRect();
      if (clip) node.style.clipPath = `inset(${Math.max(0, clip.top - placed.top)}px ${Math.max(0, placed.right - clip.right)}px ${Math.max(0, placed.bottom - clip.bottom)}px ${Math.max(0, clip.left - placed.left)}px)`;
      const height = `${placed.height}px`; if (projection.slot.style.height !== height) projection.slot.style.height = height;
    }
  }
  destroy(): void {
    cancelAnimationFrame(this.frame); this.frame = 0; this.observer.disconnect(); window.removeEventListener('resize', this.request); this.parent.removeEventListener('scroll', this.request, true);
    for (const node of [...this.projections.keys()]) this.project(node);
    cancelAnimationFrame(this.frame); this.frame = 0; this.roots.clear(); this.host.remove();
  }
}
