import { identityLabel, identityText, readIdentity, type UiIdentity } from '../shared/version.ts';
import { byId, setText } from './dom.ts';

/** This page's served identity stays independent of conversation focus and mutable checkout state. */
export class VersionStatus {
  readonly identity: UiIdentity;
  readonly node: HTMLButtonElement;
  constructor(node: HTMLButtonElement = byId('workbench-version') as HTMLButtonElement,
    identity: UiIdentity = readIdentity(document.querySelector('meta[name="ui-identity"]')?.getAttribute('content') ?? null)) {
    this.identity = identity; this.node = node;
    node.type = 'button'; node.tabIndex = 0;
    node.setAttribute('aria-label', `Version ${identityLabel(identity)}, open health`);
    node.title = identityText(identity); setText(node, identityLabel(identity));
  }
}
