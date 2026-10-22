import type {PrimaryView, SavedSession} from '../shared/api.ts';
import {button, copy, element, setText} from './dom.ts';
import {savedPathValid} from './picker-state.ts';

export type SessionState = {word?: 'live'|'idle'|'closed'; terminal?: boolean; primary?: PrimaryView; project?: string; path?: string};
export function primarySessionState(primary?: PrimaryView): SessionState {
  if (!primary) return {};
  const word = primary.lifecycle === 'stopped' ? 'closed' : primary.lifecycle !== 'ready' ? undefined : primary.activity === 'idle' ? 'idle' : ['running','compacting','retrying'].includes(primary.activity) ? 'live' : undefined;
  return {word, primary, project: primary.cwd, path: primary.sessionFile};
}
function matchesSavedSession(primary: PrimaryView, saved: SavedSession): boolean {
  return primary.sessionFile === saved.path && primary.sessionId === saved.id && primary.cwd === saved.project;
}
function currentReadPrimary(primary: PrimaryView, saved: SavedSession|undefined, primaries: readonly PrimaryView[]): PrimaryView|undefined {
  const current=primaries.find(item=>item.key===primary.key&&item.epoch===primary.epoch&&item.sessionFile===primary.sessionFile&&item.sessionId===primary.sessionId&&item.cwd===primary.cwd);
  return current&&(!saved||matchesSavedSession(current,saved))?current:undefined;
}
/** A missing terminal writer proves release only after backend ownership is excluded. */
export function readSessionState(primary: PrimaryView|undefined, saved: SavedSession|undefined, primaries: readonly PrimaryView[]|undefined): SessionState {
  if (saved?.writer === 'live') return {word:'live',terminal:true};
  if (!primaries) return {};
  if (primary) return primarySessionState(currentReadPrimary(primary,saved,primaries));
  if (!saved) return {};
  if (primaries.some(item=>item.cwd===saved.project&&!item.sessionFile&&item.lifecycle!=='stopped')) return {};
  const owners = primaries.filter(item => item.sessionFile === saved.path);
  if (!owners.length) return {word:'closed',project:saved.project,path:saved.path};
  const owner = owners.length === 1 ? owners[0] : undefined;
  if (!owner || !matchesSavedSession(owner,saved)) return {};
  return primarySessionState(owner);
}
export function sessionResumeCommand(path?: string): string|undefined {
  return path && savedPathValid(path) ? `pi --session '${path.replaceAll("'", "'\\''")}'` : undefined;
}
/** Stable controls surround retained history without owning a transcript or draft. */
export class SessionStateBar {
  readonly node = element('div','session-state-bar');
  private label = element('span','session-state-label');
  private separator = element('span',undefined,' · ');
  private resume = button('Resume',()=>{},'quiet');
  private command = element('code','session-resume-command');
  private copy = button('Copy',()=>{},'quiet');
  private fallback = element('div','session-state-copy');
  private identity = '';
  constructor() {
    const actions = element('div','session-state-actions');
    actions.append(this.label,this.separator,this.resume);
    this.copy.setAttribute('aria-label','Copy resume command');
    this.node.append(actions,this.command,this.copy,this.fallback);this.node.hidden = true;
  }
  update(state: SessionState, current: ()=>boolean, resume: ()=>void, enabled = true): void {
    this.node.hidden = state.word !== 'closed' && !state.terminal;
    const command = state.terminal ? undefined : sessionResumeCommand(state.path);
    const identity = JSON.stringify([state.word,state.terminal,state.primary?.key,state.primary?.epoch,state.project,state.path]);
    if (this.identity !== identity) {const old=this.fallback;this.fallback=element('div','session-state-copy');old.replaceWith(this.fallback);this.identity = identity;}
    const valid = () => this.identity === identity && this.node.isConnected && !this.node.hidden && !this.node.closest('[hidden],[inert]') && current();
    setText(this.label,state.terminal ? 'Live in terminal' : 'Closed');
    this.resume.hidden = this.separator.hidden = !command || state.word !== 'closed';this.resume.disabled = !enabled;
    this.command.hidden = this.copy.hidden = !command;setText(this.command,command ?? '');
    this.resume.onclick = () => {if (!this.resume.disabled && valid()) resume();};
    const fallback = this.fallback;
    this.copy.onclick = () => {if (command && valid()) void copy(command,fallback);};
  }
}
