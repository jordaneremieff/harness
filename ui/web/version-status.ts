import { identityLabel, identityText, readIdentity, type UiIdentity } from '../shared/version.ts';
import { byId, copy, setText } from './dom.ts';

/** This page's served identity stays independent of conversation focus and mutable checkout state. */
export class VersionStatus {
  readonly identity: UiIdentity;
  constructor(fallback: () => HTMLElement, node: HTMLButtonElement = byId('workbench-version') as HTMLButtonElement,
    identity: UiIdentity = readIdentity(document.querySelector('meta[name="ui-identity"]')?.getAttribute('content') ?? null),
    writer: typeof copy = copy) {
    this.identity = identity;
    const full = identityText(identity);
    node.type = 'button'; node.tabIndex = 0;
    node.setAttribute('aria-label', 'Copy UI version identity');
    node.title = full; setText(node, identityLabel(identity));
    node.addEventListener('click', () => {void writer(full, fallback);});
  }
}
