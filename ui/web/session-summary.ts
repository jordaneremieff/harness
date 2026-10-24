import {cardIcon, type CardIcon} from './card-icons.ts';
import {element} from './dom.ts';

/** The human-first head of the session details sheet: what the session is, then what the operator can do with it. */
export type SummaryFact = {label: string; value: string; title?: string};
export type SessionSummary = {title: string; chips: string[]; facts: SummaryFact[]};
export type SummaryAction = {label: string; icon: CardIcon; run: () => void; enabled?: boolean; reason?: string; note?: string};

function actionRow(action: SummaryAction): HTMLButtonElement {
  const node = element('button', 'session-summary-action') as HTMLButtonElement;
  node.type = 'button'; const text = element('span', 'session-summary-action-text', undefined);
  text.append(element('span', 'session-summary-action-label', action.label));
  if (action.note) text.append(element('span', 'session-summary-action-note', action.note));
  node.append(cardIcon(action.icon), text);
  if (action.enabled === false) { node.setAttribute('aria-disabled', 'true'); node.title = action.reason ?? ''; if (action.reason) node.setAttribute('aria-description', action.reason); }
  node.addEventListener('click', () => { if (node.getAttribute('aria-disabled') !== 'true') action.run(); });
  return node;
}

/** Facts and actions render from plain data, so every kind of session shares one layout. */
export function renderSessionSummary(summary: SessionSummary, actions: readonly SummaryAction[]): HTMLElement {
  const root = element('section', 'session-summary'); root.setAttribute('aria-label', 'Session summary');
  root.append(element('h3', 'session-summary-title', summary.title));
  if (summary.chips.length) { const chips = element('div', 'session-summary-chips'); for (const chip of summary.chips) chips.append(element('span', 'session-summary-chip', chip)); root.append(chips); }
  if (summary.facts.length) {
    const list = element('dl', 'session-summary-facts');
    for (const fact of summary.facts) { const value = element('dd', undefined, fact.value); if (fact.title) value.title = fact.title; list.append(element('dt', undefined, fact.label), value); }
    root.append(list);
  }
  root.append(element('div', 'session-summary-actions'));
  appendSummaryActions(root, actions);
  return root;
}

/** Later facts, such as saved-name rules read from the server, join the same list. */
export function appendSummaryActions(root: HTMLElement, actions: readonly SummaryAction[]): void {
  const host = root.querySelector('.session-summary-actions');
  if (host) for (const action of actions) host.append(actionRow(action));
}
