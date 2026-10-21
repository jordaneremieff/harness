import type {OperationView, PrimaryView, Target, TargetState} from '../shared/api.ts';
import {button, copy, element, input, setText} from './dom.ts';
import {absoluteTime, relativeTime} from './format.ts';
import {handoverPickup, pickupInput, pickupTerminal, type HandoverPickup} from './handover.ts';
import type {Modal} from './modal.ts';
import {operation, reserve} from './transport.ts';

type Hooks = {modal: Modal; workspace(): string | undefined; cwd(): string; primaries(): PrimaryView[];
  caption(primary: PrimaryView): string; savedAt(primary: PrimaryView): string | undefined;
  captureSelection(): (key: string) => Promise<void>; target(target: Target): TargetState | undefined; reload(): Promise<void>; result(value: OperationView): void};
type Attempt = {choice: string; command: string; openId?: string; primaryKey?: string; inputId?: string;
  input?: {target: Extract<Target, {kind: 'primary'}>; revision: number}};
export function handoverPrimary(primary: PrimaryView): boolean {
  return primary.lifecycle === 'ready' && primary.activity === 'idle' && !primary.pendingOperationIds.length && !primary.pendingDialogs.length;
}

/** A deliberate pickup uses the existing session and input operations without replacing a draft. */
export class HandoverDialog {
  private readonly hooks: Hooks;
  constructor(hooks: Hooks) {this.hooks = hooks;}
  open(): void {
    const hooks = this.hooks, modal = hooks.modal, workspace = hooks.workspace(), cwd = hooks.cwd();
    const body = modal.open('Continue a handover…'), token = modal.token;
    const current = () => modal.owns(token) && workspace === hooks.workspace();
    const selectOpened = hooks.captureSelection();
    const handover = input('Handover'), note = input('Note for this pickup (newer than the handover)', '', true);
    handover.field.id = 'handover-pickup'; handover.label.htmlFor = handover.field.id;
    note.field.id = 'handover-note'; note.label.htmlFor = note.field.id; (note.field as HTMLTextAreaElement).rows = 3;
    const hint = element('p', 'secondary handover-hint', 'Paste the pickup command or the handover id.'); hint.id = 'handover-hint';
    handover.field.setAttribute('aria-describedby', hint.id);
    const destination = element('select', 'handover-destination'); destination.id = 'handover-destination';
    const label = element('label', undefined, 'Continue in'); label.htmlFor = destination.id;
    const fresh = element('option', undefined, `New session in ${cwd.split('/').filter(Boolean).at(-1) ?? cwd}`); fresh.value = 'new'; fresh.title = cwd; destination.append(fresh);
    for (const primary of hooks.primaries().filter(handoverPrimary)) {
      const option = element('option', undefined, this.primaryLabel(primary)); option.value = `${primary.key}:${primary.epoch}`; destination.append(option);
    }
    destination.value = 'new';
    const boundary = element('div', 'secondary handover-boundary');
    boundary.append(element('p', undefined, 'Continuing runs /stash get in the chosen conversation and marks the handover active, as the terminal command does.'),
      element('p', undefined, 'The browser cannot show or control a session that runs in a terminal. A terminal session that holds this effort keeps running on its own.'));
    body.append(handover.label, handover.field, hint, note.label, note.field, label, destination, boundary);
    let pending = false, failed = false, attempt: Attempt | undefined;
    const pickup = (): HandoverPickup | undefined => {const parsed = handoverPickup(handover.field.value); return parsed ? {...parsed, note: note.field.value} : undefined;};
    const paint = () => {
      const valid = !!pickup(); next.disabled = pending || !valid || !workspace; terminal.disabled = pending || !valid;
      handover.field.disabled = note.field.disabled = destination.disabled = pending; cancel.disabled = pending;
      setText(next, failed ? 'Try again' : 'Continue'); hint.hidden = valid;
    };
    const showFailure = (error: unknown) => {if (current()) modal.error(error, 'The pickup did not return a confirmed input receipt.');};
    const settle = () => {pending = false; if (current()) paint();};
    const run = async () => {
      const parsed = pickup(); if (pending || !parsed || !workspace || !current()) return;
      const command = pickupInput(parsed), choice = destination.value;
      if (attempt && (attempt.choice !== choice || attempt.command !== command)) {
        modal.error(new Error('The earlier request still belongs to its exact text and destination.'), 'Restore the previous pickup before you retry.'); return;
      }
      attempt ??= {choice, command}; pending = true; failed = false; paint();
      try {
        await this.continue(attempt, workspace, cwd, current, selectOpened);
        if (current()) modal.close();
      } catch (error) {failed = true; showFailure(error);}
      finally {settle();}
    };
    const next = button('Continue', () => {void run();}, 'main-action'); next.id = 'handover-continue';
    const terminal = button('Copy terminal command', () => {const parsed = pickup(); if (parsed) void copy(pickupTerminal(parsed), body);}); terminal.id = 'handover-terminal';
    const cancel = button('Cancel', () => modal.close()); modal.actions(next, terminal, cancel);
    handover.field.addEventListener('input', () => {
      const parsed = handoverPickup(handover.field.value); if (parsed?.note) {note.field.value = parsed.note; handover.field.value = parsed.id;}
      paint();
    });
    note.field.addEventListener('input', paint); destination.addEventListener('change', paint); paint(); handover.field.focus();
  }
  private primaryLabel(primary: PrimaryView): string {
    const stamp = this.hooks.savedAt(primary), saved = stamp ? `session saved ${relativeTime(stamp, Date.now())}` : 'last activity unavailable';
    return `${this.hooks.caption(primary)} · Primary · ${saved}${stamp ? ` (${absoluteTime(stamp)})` : ''}`;
  }
  private async continue(attempt: Attempt, workspace: string, cwd: string, current: () => boolean, select: (key: string) => Promise<void>): Promise<void> {
    await this.openPrimary(attempt, workspace, cwd, current);
    if (!current()) return;
    const primary = this.hooks.primaries().find(primary => attempt.choice === 'new' ? primary.key === attempt.primaryKey : `${primary.key}:${primary.epoch}` === attempt.choice);
    if (!primary || !attempt.input && !handoverPrimary(primary)) throw new Error('The selected session is not ready and idle.');
    await select(primary.key); if (!current()) return;
    await this.send(attempt, {kind: 'primary', key: primary.key, epoch: primary.epoch}, workspace, current);
  }
  private async openPrimary(attempt: Attempt, workspace: string, cwd: string, current: () => boolean): Promise<void> {
    if (attempt.choice !== 'new' || attempt.primaryKey) return;
      attempt.openId ??= await reserve('primary.open'); if (!current()) return;
      const opened = await operation('primary.open', `/api/primaries?workspace=${encodeURIComponent(workspace)}`, {cwd}, undefined, attempt.openId) as unknown as {primaryKey?: string; operation?: OperationView};
      if (opened.operation?.state === 'rejected') attempt.openId = undefined;
      if (!opened.primaryKey || opened.operation?.error) throw new Error(opened.operation?.error?.message ?? 'The new session did not return its identity.');
      attempt.primaryKey = opened.primaryKey; await this.hooks.reload();
  }
  private async send(attempt: Attempt, target: Extract<Target, {kind: 'primary'}>, workspace: string, current: () => boolean): Promise<void> {
    if (!attempt.input) {
      let saved = this.hooks.target(target);
      if (!saved) {await this.hooks.reload(); saved = this.hooks.target(target);}
      if (!current()) return;
      if (!saved) throw new Error('The selected session draft is not available.');
      if (saved.target.kind !== 'primary' || saved.target.key !== target.key || saved.target.epoch !== target.epoch) throw new Error('The input target changed.');
      attempt.input = {target, revision: saved.draft.revision};
    }
    attempt.inputId ??= await reserve('primary.input', attempt.input.target); if (!current()) return;
    const captured = attempt.input;
    const result = await operation('primary.input', `/api/primaries/${encodeURIComponent(captured.target.key)}/inputs?workspace=${encodeURIComponent(workspace)}`,
      {epoch: captured.target.epoch, message: attempt.command, mode: 'prompt', draftRevision: captured.revision, images: []}, captured.target, attempt.inputId);
    this.hooks.result(result);
    if (result.state === 'rejected') {attempt.inputId = undefined; attempt.input = undefined;}
    if (result.state !== 'accepted') throw new Error(result.error?.message ?? 'The input outcome is not confirmed. Inspect its operation before another pickup.');
  }
}
