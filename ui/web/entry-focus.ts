/**
 * Keyboard reach for a long transcript: each entry is one Tab stop, and its
 * other controls are reached with the horizontal arrow keys. Every control
 * stays reachable; only the number of Tab presses between entries is bounded.
 */
const CANDIDATES = 'button, a[href], summary, [tabindex="0"], [data-entry-stop]';
const ACTIONS = 'button, a[href], summary';
const ROVED = 'entryStop';

function rendered(control: HTMLElement): boolean {
  if (control.closest('[hidden],[inert]')) return false;
  if (typeof control.checkVisibility === 'function') return control.checkVisibility();
  return true;
}

function controlsOf(entry: HTMLElement): HTMLElement[] {
  return [...entry.querySelectorAll<HTMLElement>(CANDIDATES)].filter(control => {
    if ((control as HTMLButtonElement).disabled) return false;
    if (control.closest('input, textarea, select, [contenteditable="true"]')) return false;
    return rendered(control);
  });
}

export class EntryFocus {
  private readonly stops = new WeakMap<HTMLElement, HTMLElement>();
  private readonly observer?: MutationObserver;
  private readonly pane?: MutationObserver;
  private readonly onFocusIn = (event: Event): void => this.focused(event);
  private readonly onKeyDown = (event: Event): void => this.key(event as KeyboardEvent);

  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    root.addEventListener('focusin', this.onFocusIn);
    root.addEventListener('keydown', this.onKeyDown);
    if (typeof MutationObserver === 'function') {
      this.observer = new MutationObserver(records => this.changed(records));
      this.observer.observe(root, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'disabled', 'open', 'class', 'aria-expanded']});
      const pane = root.closest('.conversation');
      if (pane) {
        this.pane = new MutationObserver(() => this.refreshAll());
        this.pane.observe(pane, {attributes: true, attributeFilter: ['hidden', 'inert']});
      }
    }
  }

  destroy(): void { this.root.removeEventListener('focusin', this.onFocusIn); this.root.removeEventListener('keydown', this.onKeyDown); this.observer?.disconnect(); this.pane?.disconnect(); }

  private refreshAll(): void { for (const entry of this.root.querySelectorAll<HTMLElement>('.entry')) this.refresh(entry); }

  private entryOf(node: Node | null): HTMLElement | undefined {
    const element = node instanceof HTMLElement ? node : node?.parentElement ?? undefined;
    const entry = element?.closest<HTMLElement>('.entry');
    return entry && this.root.contains(entry) ? entry : undefined;
  }

  private changed(records: MutationRecord[]): void {
    const entries = new Set<HTMLElement>();
    for (const record of records) {
      const owner = this.entryOf(record.target);
      if (owner) entries.add(owner);
      for (const added of record.addedNodes) {
        if (!(added instanceof HTMLElement)) continue;
        if (added.classList.contains('entry')) entries.add(added);
        for (const nested of added.querySelectorAll<HTMLElement>('.entry')) entries.add(nested);
      }
    }
    for (const entry of entries) this.refresh(entry);
  }

  /** Marks one control per entry as its Tab stop, preferring the focused or last used control. */
  refresh(entry: HTMLElement): void {
    const controls = controlsOf(entry);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const remembered = this.stops.get(entry);
    const stop = (active && controls.includes(active) ? active : undefined) ?? (remembered && controls.includes(remembered) ? remembered : undefined) ?? controls.find(control => control.matches(ACTIONS)) ?? controls[0];
    if (stop) this.stops.set(entry, stop);
    for (const control of controls) {
      control.dataset[ROVED] = '1';
      control.tabIndex = control === stop ? 0 : -1;
    }
  }

  private focused(event: Event): void {
    const control = event.target instanceof HTMLElement ? event.target : undefined;
    const entry = this.entryOf(control ?? null);
    if (!control || !entry) return;
    if (control.dataset[ROVED] !== '1') {this.refresh(entry); return;}
    const previous = this.stops.get(entry);
    if (previous === control) return;
    this.stops.set(entry, control);
    this.refresh(entry);
  }

  /** A scrollable region keeps the arrow key until it cannot scroll further that way. */
  private leaves(target: HTMLElement, key: string): boolean {
    if (target.matches(ACTIONS)) return true;
    return key === 'ArrowRight' ? target.scrollLeft + target.clientWidth >= target.scrollWidth - 1 : target.scrollLeft <= 0;
  }

  private key(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (target?.dataset[ROVED] !== '1') return;
    const entry = this.entryOf(target); if (!entry) return;
    const controls = controlsOf(entry);
    const next = controls[controls.indexOf(target) + (event.key === 'ArrowRight' ? 1 : -1)];
    if (!next || !this.leaves(target, event.key)) return;
    event.preventDefault();
    next.focus();
  }
}
