import {byId, setText} from './dom.ts';

export const navigationViews = ['sessions', 'agents', 'threads', 'files', 'settings'] as const;
export type NavigationView = typeof navigationViews[number];
export function validNavigationView(value: unknown): value is NavigationView {
  return typeof value === 'string' && navigationViews.some(view => view === value);
}
const destinations: Record<NavigationView, string> = {sessions:'primary-section', agents:'roster-section', threads:'threads-section', files:'files-section', settings:'settings-section'};
/** Navigation owns only this page's destination, never the workspace's pane layout. */
export class NavigationViews {
  view: NavigationView = 'sessions';
  constructor(){
    const actions = byId('navigation-view-actions');
    for (const view of ['agents', 'threads', 'files']) actions.append(byId(`${view}-view-actions`));
    this.render();
  }
  show(view: NavigationView): void { this.view = view; this.render(); }
  restore(value: unknown): void { this.show(validNavigationView(value) ? value : 'sessions'); }
  render(): void {
    for (const [view, id] of Object.entries(destinations)) {
      const node = byId(id); node.hidden = view !== this.view; node.inert = node.hidden;
    }
    setText(byId('navigation-title'), this.view === 'sessions' ? 'Sessions' : this.view.charAt(0).toUpperCase() + this.view.slice(1));
    for (const view of ['agents', 'threads', 'files']) {
      const actions = byId(`${view}-view-actions`); actions.hidden = view !== this.view; actions.inert = actions.hidden;
    }
    byId('navigation-back').hidden = this.view === 'sessions';
    byId('session-entry-actions').hidden = this.view !== 'sessions';
    byId('sidebar-tools').hidden = this.view !== 'sessions';
    for (const view of ['agents', 'threads', 'files']) {
      const control = byId(`navigate-${view}`);control.setAttribute('aria-current',this.view===view?'page':'false');
    }
    byId('sidebar').dataset.view = this.view;
    const message=byId('agent-message-region');message.hidden=this.view!=='agents';message.inert=message.hidden;
  }
}
