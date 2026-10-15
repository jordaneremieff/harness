import { LIMITS, draftHasContent, draftImageFingerprint, sameDraftTuple } from '../shared/api.ts';
import { ComposerAttachments, attachmentSummary, includedText, missingImageIndexes, previewAttachment } from './composer-attachments.ts';
import type { AttachmentItem } from './composer-attachments.ts';
import { insertNativeText } from './native-insertion.ts';
import { ComposerOverlay } from './composer-overlay.ts';
import type { DraftImage, DraftView, OperationView, RecoveryInput, Target, TargetIndex, TargetState, UnconfirmedInput } from '../shared/api.ts';
import { announce, button, copy, element, rawText, setText } from './dom.ts';
import { cardAction, controlIcon } from './card-icons.ts';
import { exactInput, recoveryLabel } from './recovery.ts';
import { targetReceipts } from './receipt.ts';
import { CommandMenu } from './command-menu.ts';
import type { CommandInventory } from './command-menu-state.ts';
import { clampSelection, draftPresentation, editorSelectionKey, readEditorSelection, SLOW_SAVE_MS } from './draft-presentation.ts';
import type { EditorSelection } from './draft-presentation.ts';
export type { CommandOption } from './command-menu-state.ts';
import { inputOperation, operationLabel } from './operation-label.ts';
import { acknowledgeDraft, beginDraftSave, captureSubmission, createDraft, draftSaved, editDraft, receiveDraft, rejectDraftSave, resolveDraftConflict, settleSubmission } from './draft-state.ts';
import type { DraftState, Submission } from './draft-state.ts';
import { ApiError, draftImageUrl, errorMessage, operation, request, reserve } from './transport.ts';

export type ComposerHooks = {prepareInput?: () => boolean; imageState?: (workspace: string, state: TargetState) => void; imageInput?: (target: Target) => {allowed: boolean; reason?: string}; recovery?: () => void; layoutHeight?: () => number | undefined; timing?: (start: number, end: number) => void; submitted: (operation: OperationView) => void; unknownCommand: (text: string, sendLiteral: () => void) => boolean; enterSends?: () => boolean; commands?: () => CommandInventory; moreCommands?: (target: Target) => Promise<void>; retained?: (workspace: string, target: Target, retained: boolean) => void};
export type ComposerElements = {root: HTMLFormElement; editor: HTMLTextAreaElement; recipient: HTMLElement; receipt: HTMLElement;
  receiptDetails: HTMLElement; modes: HTMLElement; send: HTMLButtonElement; save: HTMLElement; commandMenu?: HTMLElement; overlay?: HTMLElement; attachments?: HTMLElement; attach?: HTMLButtonElement; picker?: HTMLInputElement};
/** Creates one editor; the detached save/receipt-detail nodes belong in the shared footer. */
export function createComposerElements(instanceId: string): ComposerElements {
  const id = `composer-${encodeURIComponent(instanceId)}`;
  const root = element('form', 'composer'); root.id = id; root.hidden = true;
  const editor = element('textarea'); editor.id = `${id}-editor`; editor.rows = 1; editor.placeholder = 'Write a message…'; editor.spellcheck = false;
  const recipient = element('label', 'sr-only', 'Message'); recipient.id = `${id}-recipient`; recipient.htmlFor = editor.id;
  const resize = element('div', 'resizer'); resize.id = `${id}-resizer`; resize.dataset.axis = 'y'; resize.tabIndex = 0;
  resize.setAttribute('role', 'separator'); resize.setAttribute('aria-orientation', 'horizontal'); resize.setAttribute('aria-label', 'Resize message box'); resize.setAttribute('aria-controls', editor.id);
  const receipt = element('div', 'receipt'); receipt.id = `${id}-receipt`; receipt.setAttribute('role', 'status');
  const commandMenu = element('div', 'command-menu'); commandMenu.id = `${id}-commands`; commandMenu.hidden = true;
  const overlay = element('div', 'composer-overlay'); overlay.setAttribute('aria-hidden', 'true'); overlay.hidden = true;
  const surface = element('div', 'composer-surface'); surface.append(overlay, editor);
  const attachments = element('div', 'composer-attachments'); attachments.hidden = true; attachments.setAttribute('aria-label', 'Attachments');
  const input = element('div', 'composer-input'); input.append(commandMenu, recipient, surface, attachments);
  const modes = element('div', 'modes'); modes.id = `${id}-modes`; modes.hidden = true; modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Delivery while working');
  const delivery = element('select'); delivery.setAttribute('aria-label', 'Delivery while working'); delivery.title = 'Delivery while working';
  for (const [mode, text] of [['steer', 'Next step'], ['followUp', 'After response']] as const) {
    const choice = element('option', undefined, text); choice.value = mode; delivery.append(choice);
  }
  modes.append(delivery);
  const stop = element('button', 'stop', 'Stop'); stop.id = `${id}-stop`; stop.type = 'button'; stop.hidden = true;
  const send = element('button', 'send'); send.id = `${id}-send`; send.type = 'submit'; send.disabled = true;
  controlIcon(send, 'send', 'Send'); controlIcon(stop, 'stop', 'Stop');
  const attach = element('button', 'attach'); attach.type = 'button'; controlIcon(attach, 'plus', 'Attach');
  const picker = element('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.tabIndex = -1; picker.setAttribute('aria-label', 'Choose attachments');
  const bar = element('div', 'composer-bar'); bar.append(attach, picker, modes, stop, send); const line = element('div', 'composer-line'); line.append(bar); root.append(resize, receipt, input, line);
  const save = element('span', 'draft-state'); save.id = `${id}-save`;
  const receiptDetails = element('span', 'receipt-details'); receiptDetails.id = `${id}-receipt-details`;
  return {root, editor, recipient, receipt, receiptDetails, modes, send, save, commandMenu, overlay, attachments, attach, picker};
}
type Edit = {text: string; mode: string; images: DraftImage[]; edit: number};
type InsertionCapture = {buffer: Buffer; edit: number; text: string; start: number; end: number; direction: 'forward' | 'backward' | 'none'};
type SendConsent = {buffer: Buffer; edit: number; revision: number; tuple: Edit; operations: Set<string>; used?: true; differentMessage?: true};
type Pending = {submission: Submission; original?: UnconfirmedInput; uncertain: boolean; cleanup?: DraftView; settling?: Promise<void>};
type Buffer = {selection?: EditorSelection; workspace: string; state: TargetState; data: DraftState; saving?: Promise<DraftView>; submitting: boolean;
  attachments?: ComposerAttachments; inclusions?: Map<number, InsertionCapture>; imageErrors?: Set<string>; imageReview?: boolean; review: boolean; insertionCopy?: string; saveError?: string; outstandingSince?: number; slowTimer?: ReturnType<typeof setTimeout>; localCopy?: string; reservation?: {promise: Promise<string>; at: number}; pending: Map<string, Pending>; resolved: Set<string>; notice: string; noticeDetails?: string; lastOperation?: OperationView; retained?: boolean};
const encoded = encodeURIComponent;
const sameTarget = (a: Target, b?: Target): boolean => JSON.stringify(a) === JSON.stringify(b);

export class Composer {
  readonly editor: HTMLTextAreaElement;
  private buffers = new Map<string, Buffer>();
  private current?: Buffer;
  private connected = false;
  private gated = false;
  private get admissionBlocked(): boolean { return !this.connected || this.gated; }
  private ready = false;
  private recipientGuidance = 'Connect this agent to send.';
  private busy = false;
  private operations: OperationView[] = [];
  private sizePending = false;
  private manualHeight?: number;
  private sizedHeight = 0;
  private elements: ComposerElements;
  private cleanup: (() => void)[] = [];
  private destroyed = false;
  private hooks: ComposerHooks;
  private commandMenu?: CommandMenu;
  private composing = false;
  private suppressEnter = false;
  private compositionTurn?: ReturnType<typeof setTimeout>;
  private overlay?: ComposerOverlay;
  private textLimit = false;
  private focusRequest?: {origin: Element | null};
  private attachmentPaint = '';
  private pickerCapture?: InsertionCapture;
  constructor(elements: ComposerElements, hooks: ComposerHooks) {
    this.elements = elements; this.hooks = hooks; this.editor = elements.editor;
    if (elements.overlay) this.overlay = new ComposerOverlay(this.editor, elements.overlay);
    this.listen(this.editor, 'input', () => {
      const start = performance.now(), buffer = this.current; this.overlay?.invalidate(); this.change(this.editor.value);
      if (this.hooks.timing) requestAnimationFrame(() => {
        if (this.destroyed || this.current !== buffer) return;
        try {this.hooks.timing?.(start, performance.now());} catch { /* Diagnostics do not interrupt editor work. */ }
      });
    });
    this.listen(this.editor, 'keydown', event => this.key(event));
    this.bindAttachments();
    for (const event of ['select', 'keyup', 'blur', 'scroll'] as const) this.listen(this.editor, event, () => this.rememberSelection());
    this.listen(this.editor, 'focus', () => this.restoreSelection(this.current));
    this.listen(this.editor, 'compositionstart', () => { this.releaseEnter(); this.composing = true; });
    this.listen(this.editor, 'compositionend', () => {
      this.composing = false;
      if (this.suppressEnter) return;
      // Cover compositionend-before-keydown ordering within the commit task.
      this.suppressEnter = true;
      this.compositionTurn = setTimeout(() => this.releaseEnter(), 0);
    });
    this.cleanup.push(() => this.releaseEnter());
    this.listen(this.editor, 'keyup', event => { if (event.key === 'Enter' || event.code === 'Enter') this.releaseEnter(); });
    this.listen(this.editor, 'beforeinput', event => { if (!this.composing && !event.isComposing && event.inputType !== 'insertLineBreak' && event.inputType !== 'insertParagraph' && event.inputType !== 'insertCompositionText' && event.inputType !== 'insertFromComposition') this.releaseEnter(); });
    const moreCommands = hooks.moreCommands;
    if (elements.commandMenu && hooks.commands) this.commandMenu = new CommandMenu(this.editor, elements.commandMenu, hooks.commands, (text, error, prepared) => {
      this.change(text);
      if (error && this.current) {
        this.current.notice = error; this.current.insertionCopy = prepared; this.receipt(this.current);
      }
    }, moreCommands ? () => {
      const target = this.current?.state.target;
      return target ? moreCommands(target) : Promise.reject(new Error('No message recipient is selected.'));
    } : undefined);
    this.listen(this.editor, 'pointerup', () => {
      this.rememberSelection();
      if (this.editor.offsetHeight !== this.sizedHeight) this.setManualHeight(this.editor.offsetHeight);
    });
    this.listen(elements.root, 'submit', event => { event.preventDefault(); void this.send(); });
    this.editor.placeholder = 'Write a message…';
    const delivery = this.delivery();
    if (delivery) this.listen(delivery, 'change', () => {
      if (delivery.value !== 'steer' && delivery.value !== 'followUp') return;
      this.rememberSelection(); this.change(this.editor.value, delivery.value);
    });
  }
  private listen<K extends keyof HTMLElementEventMap>(node: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void): void {
    const listener = handler as EventListener; node.addEventListener(type, listener); this.cleanup.push(() => node.removeEventListener(type, listener));
  }
  /** Removes DOM work without cancelling captured saves or receipt settlement. */
  destroy(): void {
    if (this.destroyed) return; this.rememberSelection(); this.destroyed = true;
    for (const cleanup of this.cleanup) cleanup(); this.cleanup = []; this.commandMenu?.destroy(); this.overlay?.destroy();
    for (const buffer of this.buffers.values()) {clearTimeout(buffer.slowTimer); buffer.slowTimer = undefined; buffer.attachments?.destroy();}
    this.elements.receipt.replaceChildren(); this.elements.receiptDetails.replaceChildren();
  }
  recipient(label: string, guidance = 'Connect this agent to send.'): void {
    setText(this.elements.recipient, label);
    this.editor.setAttribute('aria-label', label);
    this.recipientGuidance = guidance; this.renderControls();
  }
  placement(_sidebar: boolean): void { this.resize(); this.renderControls(); }
  commandsChanged(): void { this.commandMenu?.update(); }
  /** Undefined restores automatic growth; explicit sizes retain their preferred pixel height. */
  setManualHeight(px: number | undefined): void {
    if (px !== undefined && (!Number.isFinite(px) || px < 0)) throw new RangeError('Invalid composer height');
    this.manualHeight = px === undefined ? undefined : Math.round(px); this.resize();
  }
  attach(workspace: string, state?: TargetState): void {
    // Hidden layout can reset native offsets without changing the owned draft.
    if (document.activeElement === this.editor) this.rememberSelection();
    const previousTarget = this.current?.state.target;
    this.overlay?.invalidate();
    if (!state) { this.commandMenu?.reset(); }
    if (!state) { this.current = undefined; this.editor.value = ''; this.slot().replaceChildren(); this.elements.receiptDetails.replaceChildren(); this.render(); return; }
    const key = JSON.stringify([workspace, state.targetKey, state.target]);
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = {workspace, state: {...state}, data: createDraft(state.draft), submitting: false, review: false, pending: new Map(), resolved: new Set(), notice: ''};
      try { buffer.selection = readEditorSelection(sessionStorage.getItem(editorSelectionKey(workspace, state.target)), state.draft); } catch { /* Editor continuity still works in memory when storage is unavailable. */ }
      this.buffers.set(key, buffer);
    } else {
      buffer.state = {...state, draft: buffer.data.server}; this.receive(buffer, state.draft);
    }
    const switched = this.current !== buffer; this.current = buffer;
    if (switched || !sameTarget(state.target, previousTarget)) this.commandMenu?.reset();
    this.hydrate(buffer, state);
    if (switched) { this.editor.value = buffer.data.text; this.editor.scrollTop = 0; this.editor.scrollLeft = 0; this.restoreSelection(buffer); }
    this.paint(buffer); this.prepare(buffer);
    this.receipt(buffer); this.flush(buffer);
  }
  updateDraft(draft: DraftView): void { if (this.current) { this.receive(this.current, draft); this.paint(this.current); this.receipt(this.current); } }
  availability(connected: boolean, ready: boolean, busy: boolean, gated = false): void {
    this.connected = connected; this.ready = ready; this.busy = busy; this.gated = gated;
    if (!connected) for (const buffer of this.buffers.values()) buffer.attachments?.suspend();
    const buffer = this.current;
    if (buffer) {
      if (this.hooks.prepareInput?.() !== false && buffer.state.target.kind === 'primary' && busy && buffer.data.mode === 'prompt' && !buffer.submitting) this.change(buffer.data.text, 'steer');
      this.prepare(buffer);
    }
    this.resize(); this.render(); if (buffer) {this.paintAttachments(buffer); this.receipt(buffer);} this.commandMenu?.update(); if (!this.admissionBlocked) for (const item of this.buffers.values()) this.flush(item);
  }
  receipts(operations: Iterable<OperationView>): void { this.operations = [...operations]; this.receipt(this.current); this.render(); }
  get serverDraftRevision(): number | undefined { return this.current?.data.server.revision; }
  get reloadHold(): 'ime' | 'conflict' | 'uncertain' | undefined {
    if (this.composing) return 'ime';
    if ([...this.buffers.values()].some(buffer => buffer.review || buffer.saveError || buffer.attachments?.pending || buffer.insertionCopy !== undefined)) return 'conflict';
    if ([...this.buffers.values()].some(buffer => buffer.submitting || buffer.pending.size > 0 || buffer.state.unconfirmed.some(item => !buffer.resolved.has(item.operationId)))) return 'uncertain';
    return undefined;
  }
  /** Flushes retained drafts only; captured delivery operations are never replayed. */
  async drain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.reloadHold) throw new Error('Retained draft work is not safe to drain.');
    if (!this.unsaved && ![...this.buffers.values()].some(buffer => buffer.saving)) return;
    if (this.admissionBlocked) throw new Error('Retained draft work is not safe to drain.');
    while (this.unsaved || [...this.buffers.values()].some(buffer => buffer.saving)) {
      signal.throwIfAborted();
      if (this.reloadHold) throw new Error('Retained draft work needs review.');
      for (const buffer of this.buffers.values()) this.flush(buffer);
      const saves = [...this.buffers.values()].flatMap(buffer => buffer.saving ? [buffer.saving] : []);
      if (!saves.length) throw new Error('Retained draft work did not settle.');
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {abort = () => reject(signal.reason); signal.addEventListener('abort', abort, {once: true}); if (signal.aborted) abort();});
      try {await Promise.race([Promise.all(saves), cancelled]);} finally {signal.removeEventListener('abort', abort);}
    }
    signal.throwIfAborted();
  }
  get unsaved(): boolean { return [...this.buffers.values()].some(item => !draftSaved(item.data) || item.review || item.attachments?.pending || item.insertionCopy !== undefined); }
  /** Saved text remains durable; only unsettled ownership prevents permanent disposal. */
  get canDispose(): boolean {
    return !this.unsaved && ![...this.buffers.values()].some(buffer => buffer.saving || buffer.submitting || buffer.pending.size > 0 || buffer.state.unconfirmed.some(item => !buffer.resolved.has(item.operationId)));
  }
  private retainedBuffer(workspace: string, target: Target): Buffer | undefined {
    return [...this.buffers.values()].find(item => item.workspace === workspace && sameTarget(item.state.target, target));
  }
  attachRetained(workspace: string, target: Target): boolean {
    const buffer = this.retainedBuffer(workspace, target); this.attach(workspace, buffer?.state); return !!buffer;
  }
  retained(workspace: string, target: Target, index?: TargetIndex): boolean | undefined {
    const buffer = this.retainedBuffer(workspace, target);
    if (index && !sameTarget(index.target, target)) index = undefined;
    if (!buffer) return index ? index.hasDraft || index.unconfirmedOperationIds.length > 0 || index.retainedInputOperationIds.length > 0 : undefined;
    if (this.hasRetained(buffer)) return true;
    if (index?.unconfirmedOperationIds.some(id => !buffer.resolved.has(id)) || index?.retainedInputOperationIds.length) return true;
    return !!index && index.draftRevision > buffer.data.server.revision && index.hasDraft;
  }
  private hasRetained(buffer: Buffer): boolean { return draftHasContent(buffer.data) || !!buffer.attachments?.pending || buffer.insertionCopy !== undefined || !draftSaved(buffer.data) || buffer.review || buffer.submitting || buffer.pending.size > 0 || !!buffer.state.retainedInputs.length || buffer.state.unconfirmed.some(item => !buffer.resolved.has(item.operationId)); }
  private notifyRetained(buffer: Buffer): void {
    const retained = this.hasRetained(buffer); if (buffer.retained === retained) return;
    buffer.retained = retained; this.hooks.retained?.(buffer.workspace, buffer.state.target, retained);
  }
  get target(): Target | undefined { return this.current?.state.target; }
  get state(): TargetState | undefined { return this.current?.state; }
  /** New supplied text starts at its end; restoring an existing draft retains its range. */
  setText(text: string): void {
    this.overlay?.invalidate(); this.editor.value = text; this.change(text); this.editor.setSelectionRange(text.length, text.length); this.rememberSelection();
  }
  focus(): void {
    if (this.destroyed) return;
    if (this.editor.disabled) { this.focusRequest = {origin: document.activeElement}; return; }
    this.focusRequest = undefined; this.editor.focus({preventScroll: true}); this.restoreSelection(this.current);
  }
  private finishFocusRequest(): void {
    const request = this.focusRequest; if (!request || this.editor.disabled) return;
    this.focusRequest = undefined;
    if (!this.elements.root.closest('[hidden],[inert]') && (document.activeElement === request.origin || document.activeElement === document.body)) this.focus();
  }
  suggest(text: string): void {
    if (!this.editor.value && this.current && draftSaved(this.current.data)) { this.setText(text); return; }
    this.slot().replaceChildren(element('p', 'warning', 'Suggested text is available. Your draft is unchanged.'), button('Use suggested text', () => this.setText(text)), button('Keep draft', () => this.receipt(this.current)));
  }
  private delivery(): HTMLSelectElement | null { return this.elements.modes.querySelector<HTMLSelectElement>('select'); }
  private slot(): HTMLElement { return this.elements.receipt; }
  private base(buffer: Buffer): string { return `/api/workspaces/${encoded(buffer.workspace)}/targets/${encoded(buffer.state.targetKey)}`; }
  private change(text: string, mode = this.current?.data.mode): void {
    const buffer = this.current; if (!buffer) return;
    const previous = buffer.data;
    buffer.data = editDraft(buffer.data, text, mode);
    if (buffer.data === previous) {this.rememberSelection(); return;}
    if (text === previous.text) this.rebaseSelection(buffer, previous);
    this.textLimit = new TextEncoder().encode(text).length > LIMITS.textBytes;
    if (this.textLimit) buffer.saveError = 'Text exceeds the saved text limit. The saved draft is unchanged. Shorten the text to save and send.';
    else if (buffer.saveError === 'Text exceeds the saved text limit. The saved draft is unchanged. Shorten the text to save and send.') buffer.saveError = undefined;
    this.rememberSelection(); this.notifyRetained(buffer); this.resize(); this.render(); if (this.textLimit) this.receipt(buffer); this.commandMenu?.update(); this.flush(buffer);
  }
  private insertionCapture(buffer = this.current): InsertionCapture | undefined {
    if (!buffer) return;
    return {buffer, edit: buffer.data.edit, text: buffer.data.text, start: this.editor.selectionStart, end: this.editor.selectionEnd, direction: this.editor.selectionDirection};
  }
  private bindAttachments(): void {
    const {attach, picker, root} = this.elements;
    if (attach && picker) {
      this.listen(attach, 'click', () => {this.pickerCapture = this.insertionCapture(); picker.value = ''; picker.click();});
      this.listen(picker, 'change', () => {
        const captured = this.pickerCapture; this.pickerCapture = undefined;
        if (captured) this.addFiles(Array.from(picker.files ?? []), captured);
      });
      this.listen(picker, 'cancel', () => {
        const captured = this.pickerCapture; this.pickerCapture = undefined;
        if (captured && this.current === captured.buffer && (document.activeElement === attach || document.activeElement === picker || document.activeElement === document.body)) this.focus();
      });
    }
    this.listen(this.editor, 'paste', event => {
      const files = Array.from(event.clipboardData?.files ?? []); if (!files.length) return;
      const captured = this.insertionCapture(); if (!captured) return;
      event.preventDefault(); const text = event.clipboardData?.getData('text/plain');
      if (text) this.insertPrepared(captured, text);
      this.addFiles(files, captured);
    });
    this.listen(root, 'dragover', event => {if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); root.dataset.fileDrop = 'true';});
    this.listen(root, 'dragleave', event => {if (!root.contains(event.relatedTarget as Node | null)) delete root.dataset.fileDrop;});
    this.listen(root, 'drop', event => {
      delete root.dataset.fileDrop; const files = Array.from(event.dataTransfer?.files ?? []); if (!files.length) return;
      const captured = this.insertionCapture(); if (!captured) return;
      event.preventDefault(); const text = event.dataTransfer?.getData('text/plain');
      if (text) this.insertPrepared(captured, text);
      this.addFiles(files, captured);
    });
  }
  addFiles(files: readonly File[], captured = this.insertionCapture()): void {
    if (!captured || this.destroyed) return;
    const buffer = captured.buffer, attachments = this.fileOwner(buffer), before = new Set(attachments.items);
    try {attachments.add(files);} catch (error) {this.failureNotice(buffer, 'Files were not added.', error);}
    buffer.inclusions ??= new Map();
    for (const item of attachments.items) if (!before.has(item)) buffer.inclusions.set(item.id, captured);
    this.paintAttachments(buffer); this.receipt(buffer);
  }
  private fileOwner(buffer: Buffer): ComposerAttachments {
    buffer.attachments ??= new ComposerAttachments({workspace: buffer.workspace, targetKey: buffer.state.targetKey, target: buffer.state.target}, {
      images: () => buffer.data.images,
      refusal: () => {
        if (this.destroyed || this.admissionBlocked) return 'Reconnect before uploading. The file stays in this tab.';
        const policy = this.hooks.imageInput?.(buffer.state.target);
        return policy?.allowed ? undefined : policy?.reason ?? 'Image input is not confirmed for this connection.';
      },
      add: image => {
        const previous = buffer.data; buffer.data = editDraft(buffer.data, buffer.data.text, buffer.data.mode, [...buffer.data.images, image]);
        buffer.imageErrors?.delete(image.digest);
        if (buffer.state.imageStorageError || buffer.state.imageAvailability.some(item => item.digest === image.digest && item.state === 'unavailable')) void this.refreshImageState(buffer);
        this.rebaseSelection(buffer, previous); announce(`Attached ${image.name}`);
      },
      changed: () => {
        if (this.destroyed) return;
        const pending = new Set(buffer.attachments?.items.map(item => item.id));
        for (const id of buffer.inclusions?.keys() ?? []) if (!pending.has(id)) buffer.inclusions?.delete(id);
        this.paint(buffer); this.receipt(buffer); this.flush(buffer);
      },
    });
    return buffer.attachments;
  }
  private async refreshImageState(buffer: Buffer): Promise<void> {
    try {
      const state = await request<TargetState>(this.base(buffer));
      if (state.targetKey !== buffer.state.targetKey || !sameTarget(state.target, buffer.state.target)) throw new Error('The image recipient changed.');
      buffer.state = {...buffer.state, imageAvailability: state.imageAvailability, imageStorageError: state.imageStorageError};
      this.hooks.imageState?.(buffer.workspace, state); this.attachmentPaint = ''; this.paint(buffer);
    } catch (error) {this.failureNotice(buffer, 'Image state could not be refreshed.', error);}
  }
  private imageRefusal(buffer: Buffer, tuple: Pick<Edit, 'text' | 'images'> = buffer.data): string {
    if (tuple === buffer.data && buffer.attachments?.pending) return 'Finish or remove the unfinished attachments before sending.';
    if (!tuple.images.length) return '';
    if (buffer.state.imageStorageError) return buffer.state.imageStorageError.message;
    if (tuple.images.some(image => buffer.imageErrors?.has(image.digest) || buffer.state.imageAvailability.some(item => item.digest === image.digest && item.state === 'unavailable'))) return 'An image is unavailable. Remove its reference and attach the original file again.';
    if (buffer.state.target.kind === 'primary' && /^\s*\//.test(tuple.text)) return 'Send the command and images as separate messages. This draft is unchanged.';
    const policy = this.hooks.imageInput?.(buffer.state.target);
    return policy?.allowed ? '' : policy?.reason ?? 'Image input is not confirmed for this connection.';
  }
  private paintAttachments(buffer: Buffer): void {
    const slot = this.elements.attachments; if (!slot || this.destroyed || this.current !== buffer) return;
    const items = buffer.attachments?.items ?? [], refusal = this.imageRefusal(buffer);
    const key = JSON.stringify([buffer.workspace, buffer.state.targetKey, draftImageFingerprint(buffer.data.images), draftImageFingerprint(buffer.data.server.images), items.map(item => [item.id, item.state, item.error, item.prepared !== undefined]), [...buffer.imageErrors ?? []], refusal]);
    if (key === this.attachmentPaint) return; this.attachmentPaint = key;
    slot.replaceChildren(); slot.hidden = !buffer.data.images.length && !items.length;
    for (const image of buffer.data.images) slot.append(this.attachmentRow(buffer, image));
    for (const item of items) slot.append(this.preparationRow(buffer, item));
    if (refusal && !items.length) slot.append(element('p', 'warning', refusal));
    else if (buffer.data.images.length && buffer.state.target.kind === 'agent') slot.append(element('p', 'secondary', 'This host accepts image input. Provider acceptance is not confirmed.'));
    this.resize();
  }
  private attachmentRow(buffer: Buffer, image: DraftImage): HTMLElement {
    const row = element('div', 'attachment-row'), thumbnail = element('img');
    const preview = button('', () => previewAttachment(buffer.workspace, buffer.state.targetKey, image, preview), 'attachment-preview');
    preview.setAttribute('aria-label', `Preview ${image.name}`); thumbnail.alt = ''; thumbnail.loading = 'lazy'; thumbnail.decoding = 'async'; thumbnail.width = 40; thumbnail.height = 40;
    const unavailable = buffer.imageErrors?.has(image.digest) || buffer.state.imageAvailability.some(item => item.digest === image.digest && item.state === 'unavailable');
    if (!unavailable) {
      thumbnail.addEventListener('error', () => {buffer.imageErrors ??= new Set(); buffer.imageErrors.add(image.digest); this.paint(buffer);});
      thumbnail.src = draftImageUrl(buffer.workspace, buffer.state.targetKey, image.digest); preview.append(thumbnail);
    } else preview.textContent = 'Preview';
    row.append(preview, element('span', 'attachment-name', image.name), cardAction('close', `Remove ${image.name}`, () => {
      const previous = buffer.data; buffer.data = editDraft(buffer.data, buffer.data.text, buffer.data.mode, buffer.data.images.filter(item => item.digest !== image.digest));
      buffer.attachments?.forget(image.digest); buffer.imageErrors?.delete(image.digest); this.rebaseSelection(buffer, previous); this.paint(buffer); this.receipt(buffer); this.flush(buffer); announce(`Removed ${image.name}`);
    }));
    if (unavailable) row.append(element('span', 'warning', 'Image unavailable'), button(`Retry preview ${image.name}`, () => {buffer.imageErrors?.delete(image.digest); this.attachmentPaint = ''; this.paint(buffer); void this.refreshImageState(buffer);}));
    return row;
  }
  private preparationRow(buffer: Buffer, item: AttachmentItem): HTMLElement {
    const row = element('div', 'attachment-row'); row.append(element('span', 'attachment-name', item.name));
    row.append(element('span', item.state === 'failed' ? 'warning' : 'secondary', item.error ?? (item.state === 'text' ? 'File text is not included.' : 'Preparing…')));
    if (item.state === 'text') {
      row.append(button(`${item.prepared === undefined ? 'Include text from' : 'Insert prepared text from'} ${item.name}`, () => {void this.includeFile(buffer, item);}));
      if (item.prepared !== undefined) row.append(button(`Copy prepared text from ${item.name}`, () => {void copy(item.prepared ?? '', row);}));
    }
    if (item.state === 'failed' && item.file) row.append(button(`Retry ${item.name}`, () => buffer.attachments?.retry(item)));
    row.append(cardAction('close', `Remove ${item.name}`, () => {buffer.inclusions?.delete(item.id); buffer.attachments?.remove(item); announce(`Removed ${item.name}`);}));
    return row;
  }
  private async includeFile(buffer: Buffer, item: AttachmentItem): Promise<void> {
    const file = item.file, owner = buffer.attachments, captured = buffer.inclusions?.get(item.id);
    if (!file || !owner || !captured || item.state !== 'text') return;
    const attempt = item.abort; item.state = 'including'; this.paintAttachments(buffer);
    try {
      const prepared = item.prepared ?? includedText(new Uint8Array(await file.arrayBuffer()), item.name);
      if (attempt.signal.aborted || !owner.items.includes(item) || item.abort !== attempt) return;
      const insertion = item.prepared !== undefined && this.current === buffer ? this.insertionCapture() : captured;
      if (insertion && this.insertPrepared(insertion, prepared, false)) {buffer.inclusions?.delete(item.id); owner.remove(item);}
      else {item.prepared = prepared; item.state = 'text'; this.paintAttachments(buffer);}
    } catch (error) {
      if (owner.items.includes(item) && item.abort === attempt) {item.state = 'failed'; item.error = errorMessage(error); this.paintAttachments(buffer);}
    }
  }
  private insertPrepared(captured: InsertionCapture, prepared: string, retain = true): boolean {
    const buffer = captured.buffer;
    const current = this.current === buffer && !this.destroyed && !this.composing && !this.elements.root.closest('[hidden],[inert]') && buffer.data.edit === captured.edit && this.editor.value === captured.text && this.editor.selectionStart === captured.start && this.editor.selectionEnd === captured.end && this.editor.selectionDirection === captured.direction;
    const finalText = captured.text.slice(0, captured.start) + prepared + captured.text.slice(captured.end);
    if (!current || new TextEncoder().encode(finalText).length > LIMITS.textBytes) {
      if (retain) buffer.insertionCopy = prepared;
      buffer.notice = 'Prepared text is available. Your draft is unchanged.'; this.receipt(buffer); return false;
    }
    const inserted = insertNativeText(this.editor, prepared, captured.start, captured.end); this.change(inserted.text);
    if (inserted.status !== 'inserted') {if (retain) buffer.insertionCopy = prepared; buffer.notice = 'Native insertion did not complete. Your prepared text remains available.';}
    else {if (buffer.insertionCopy === prepared) buffer.insertionCopy = undefined; buffer.notice = '';}
    this.receipt(buffer); return inserted.status === 'inserted';
  }
  private releaseEnter(): void {
    clearTimeout(this.compositionTurn); this.compositionTurn = undefined; this.suppressEnter = false;
  }
  private compositionKey(event: KeyboardEvent): boolean {
    const enter = event.key === 'Enter' || event.code === 'Enter';
    if (enter && (this.composing || event.isComposing || event.keyCode === 229 || this.suppressEnter)) {
      clearTimeout(this.compositionTurn); this.compositionTurn = undefined; this.suppressEnter = true;
      if (!this.composing && !event.isComposing && event.keyCode !== 229) event.preventDefault();
      return true;
    }
    return this.composing || event.isComposing || event.keyCode === 229;
  }
  private key(event: KeyboardEvent): void {
    if (this.compositionKey(event)) return;
    if (event.defaultPrevented) return;
    if (this.commandMenu?.key(event)) return;
    const modifierSend = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
    const ordinarySend = this.hooks.enterSends?.() && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === 'Enter' && (modifierSend || ordinarySend)) {
      event.preventDefault(); if (!event.repeat && this.current && draftSaved(this.current.data) && !this.textLimit) void this.send();
    }
  }
  private prepare(buffer: Buffer): void {
    if (this.destroyed || this.admissionBlocked || !this.ready || this.hooks.prepareInput?.() === false || buffer !== this.current || buffer.reservation || buffer.submitting) return;
    const reservation = {promise: reserve(buffer.state.target.kind === 'primary' ? 'primary.input' : 'agent.input', buffer.state.target), at: Date.now()};
    buffer.reservation = reservation;
    void reservation.promise.catch(error => {
      if (buffer.reservation !== reservation) return;
      buffer.reservation = undefined; this.failureNotice(buffer, 'Message preparation failed.', error);
    });
  }
  private rememberSelection(): void {
    const buffer = this.current; if (!buffer || this.elements.root.closest('[hidden],[inert]') || this.editor.value !== buffer.data.text) return;
    buffer.selection = {start: this.editor.selectionStart, end: this.editor.selectionEnd, direction: this.editor.selectionDirection ?? 'none',
      text: buffer.data.text, revision: buffer.data.server.revision, edit: buffer.data.edit, imageFingerprint: draftImageFingerprint(buffer.data.images), scrollTop: this.editor.scrollTop, scrollLeft: this.editor.scrollLeft};
    this.persistSelection(buffer);
  }
  private restoreSelection(buffer?: Buffer): void {
    const saved = buffer?.selection;
    if (!buffer || !saved || this.elements.root.closest('[hidden],[inert]') || saved.text !== buffer.data.text || this.editor.value !== saved.text || saved.revision !== buffer.data.server.revision || saved.edit !== buffer.data.edit || saved.imageFingerprint !== draftImageFingerprint(buffer.data.images)) return;
    this.editor.setSelectionRange(saved.start, saved.end, saved.direction);
    this.editor.scrollTop = saved.scrollTop; this.editor.scrollLeft = saved.scrollLeft;
  }
  private persistSelection(buffer: Buffer): void {
    const saved = buffer.selection;
    if (!saved || !draftSaved(buffer.data) || saved.text !== buffer.data.text || saved.revision !== buffer.data.server.revision || saved.edit !== buffer.data.edit) return;
    try { sessionStorage.setItem(editorSelectionKey(buffer.workspace, buffer.state.target), JSON.stringify({...saved, mode: buffer.data.server.mode, imageFingerprint: draftImageFingerprint(buffer.data.server.images)})); } catch { /* A storage quota or policy does not interrupt editing. */ }
  }
  private rebaseSelection(buffer: Buffer, previous: DraftState, replace = false): void {
    const saved = buffer.selection;
    if (!saved || saved.text !== previous.text || saved.revision !== previous.server.revision || saved.edit !== previous.edit || (!replace && previous.text !== buffer.data.text)) return;
    buffer.selection = clampSelection(saved, buffer.data.text, buffer.data.server.revision, buffer.data.edit, buffer.data.images); this.persistSelection(buffer);
  }
  private returnFocus(buffer: Buffer, origin: Element | null): void {
    if (this.current !== buffer || this.destroyed || this.elements.root.closest('[hidden],[inert]') || (origin && origin !== document.body && !this.elements.root.contains(origin))) return;
    if (document.activeElement === origin || document.activeElement === this.editor || document.activeElement === document.body) this.focus();
  }
  private paint(buffer: Buffer): void {
    buffer.state.draft = buffer.data.server;
    if (this.current !== buffer) return;
    if (this.editor.value !== buffer.data.text) { this.overlay?.invalidate(); this.editor.value = buffer.data.text; this.restoreSelection(buffer); }
    else if (document.activeElement !== this.editor) this.restoreSelection(buffer);
    this.textLimit = new TextEncoder().encode(buffer.data.text).length > LIMITS.textBytes;
    this.resize(); this.render(); this.paintAttachments(buffer); this.finishFocusRequest();
  }
  resize(): void {
    if (this.destroyed || this.sizePending) return; this.sizePending = true;
    requestAnimationFrame(() => {
      this.sizePending = false;
      if (this.destroyed || !this.editor.isConnected || this.elements.root.closest('[hidden],[inert]')) return;
      const scrollTop = this.editor.scrollTop, scrollLeft = this.editor.scrollLeft;
      const style = getComputedStyle(this.editor); const line = Number.parseFloat(style.lineHeight);
      const extra = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
      const short = matchMedia('(max-height: 599px)').matches;
      const baseline = line + extra;
      const available = this.hooks.layoutHeight?.() ?? this.elements.root.parentElement?.clientHeight ?? this.elements.root.clientHeight;
      const autoCap = Math.min(10 * line + extra, available * (short ? 0.25 : 0.3));
      const cap = Math.max(baseline, this.manualHeight === undefined ? autoCap : available * 0.6);
      this.editor.style.maxHeight = `${cap}px`;
      this.editor.style.height = this.manualHeight === undefined ? '0px' : `${Math.min(cap, Math.max(baseline, this.manualHeight))}px`;
      if (this.manualHeight === undefined) this.editor.style.height = `${Math.min(cap, Math.max(baseline, this.editor.scrollHeight + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)))}px`;
      this.editor.scrollTop = scrollTop; this.editor.scrollLeft = scrollLeft;
      this.sizedHeight = this.editor.offsetHeight; this.overlay?.invalidate();
    });
  }
  private render(): void {
    if (this.destroyed) return;
    const buffer = this.current; const mode = buffer?.data.mode;
    this.elements.root.hidden = !buffer; this.editor.disabled = !buffer;
    this.renderControls();
    this.elements.send.disabled = !buffer || !this.ready || this.admissionBlocked || buffer.submitting || buffer.review || this.textLimit || !draftSaved(buffer.data) || this.pendingBlocks(buffer) || !!this.imageRefusal(buffer) || buffer.data.server.recoverySendGuard?.state === 'blocked' || buffer.data.server.recoverySendGuard?.state === 'unavailable' || !draftHasContent({text: buffer.data.text.trim(), images: buffer.data.images});
    const active = this.deliveryMode(mode);
    const delivery = this.delivery(); if (delivery) delivery.value = active === 'followUp' ? 'followUp' : 'steer';
    setText(this.elements.save, this.saveSummary(buffer));
  }
  private renderControls(): void {
    if (this.destroyed) return;
    this.elements.modes.hidden = !this.ready || !this.connected || !this.busy;
    this.elements.send.hidden = false;
    const reason = this.sendGuidance();
    const send = this.elements.send; send.setAttribute('aria-description', reason); send.title = reason || 'Send';
  }
  private sendGuidance(): string {
    if (!this.connected) return 'Connection lost. Reconnect before sending.';
    if (this.gated) return 'Selecting this conversation…';
    if (!this.ready) return this.current?.state.target.kind === 'agent' ? this.recipientGuidance : 'This conversation is not ready for messages.';
    return this.current ? this.imageRefusal(this.current) : '';
  }
  /** A primary prompt draft is delivered as steer while work runs; the saved mode changes on the next edit or send. */
  private deliveryMode(mode?: string): string | undefined {
    return this.current?.state.target.kind === 'primary' && this.busy && mode === 'prompt' ? 'steer' : mode;
  }
  private records(buffer?: Buffer): OperationView[] {
    const operations = this.operations.length ? this.operations : buffer?.lastOperation ? [buffer.lastOperation] : [];
    return targetReceipts(operations, buffer?.state.target);
  }
  private saveSummary(buffer?: Buffer): string {
    if (!buffer) return '';
    if (buffer.attachments?.pending) return buffer.attachments.busy ? 'Preparing attachments…' : 'Attachment needs attention';
    return draftPresentation({connected: this.connected, unsaved: !draftSaved(buffer.data), text: buffer.data.text, images: buffer.data.images,
      failed: !!buffer.saveError, conflict: buffer.review, outstandingSince: buffer.outstandingSince}, Date.now());
  }
  private receive(buffer: Buffer, draft: DraftView): void {
    for (const pending of buffer.pending.values()) {
      if (draft.revision === pending.submission.draftRevision + 1 && !draftHasContent(draft) && draft.mode === pending.submission.mode) { pending.cleanup = draft; return; }
    }
    const previous = buffer.data, save = previous.inFlight;
    const ownSave = save && draft.revision === save.expectedRevision + 1 && sameDraftTuple(draft, save);
    buffer.data = receiveDraft(buffer.data, draft); if (ownSave) this.rebaseSelection(buffer, previous); buffer.state.draft = buffer.data.server;
    if (buffer.data.conflict) this.conflict(buffer);
    else if (draftSaved(buffer.data)) buffer.saveError = undefined;
  }
  private flush(buffer: Buffer): void {
    if (this.admissionBlocked || buffer.submitting || buffer.review || buffer.saving || buffer.saveError || buffer.attachments?.busy || draftSaved(buffer.data)) return;
    if (new TextEncoder().encode(buffer.data.text).length > LIMITS.textBytes) {buffer.saveError = 'Text exceeds the saved text limit. The saved draft is unchanged. Shorten the text to save and send.'; this.receipt(buffer); return;}
    void this.save(buffer, buffer.data).then(() => this.flush(buffer), () => {});
  }
  private async save(buffer: Buffer, edit: Edit): Promise<DraftView> {
    if (this.admissionBlocked) throw new Error('Draft save is unavailable. Wait for the current view.');
    const begun = beginDraftSave({...buffer.data, ...edit}); const sent = begun.request;
    if (!sent) throw new Error('Review this draft before sending.');
    buffer.data = {...buffer.data, inFlight: sent}; buffer.saveError = undefined;
    buffer.outstandingSince = Date.now();
    buffer.slowTimer = setTimeout(() => {
      if (buffer.data.inFlight !== sent || !buffer.saving || this.current !== buffer) return;
      this.render();
    }, SLOW_SAVE_MS);
    const saving = (async () => {
      try {
        const draft = await this.putDraft(buffer, sent);
        const previous = buffer.data;
        buffer.data = acknowledgeDraft(buffer.data, sent, draft); this.rebaseSelection(buffer, previous);
        if (draft.revision <= sent.expectedRevision || !sameDraftTuple(draft, sent)) throw new Error('The saved draft did not match your input.');
        for (const image of sent.images) buffer.attachments?.forget(image.digest);
        if (buffer.data.conflict) this.conflict(buffer);
        return draft;
      } catch (error) {
        buffer.data = rejectDraftSave(buffer.data, sent);
        this.saveFailure(buffer, error); throw error;
      } finally { clearTimeout(buffer.slowTimer); buffer.slowTimer = undefined; buffer.outstandingSince = undefined; buffer.saving = undefined; this.paint(buffer); this.receipt(buffer); }
    })();
    buffer.saving = saving; this.render(); return saving;
  }
  private async putDraft(buffer: Buffer, sent: NonNullable<DraftState['inFlight']>): Promise<DraftView> {
    const body = {expectedRevision: sent.expectedRevision, text: sent.text, mode: sent.mode, images: sent.images, ...(sent.recoverySource ? {recoverySource: sent.recoverySource} : {})};
    try {return await request<DraftView>(`${this.base(buffer)}/draft`, 'PUT', body);} catch (error) {
      const indexes = missingImageIndexes(error, buffer.state.targetKey, sent.images);
      if (!indexes || !buffer.attachments || this.admissionBlocked) throw error;
      await buffer.attachments.reacquire(sent.images, indexes);
      if (this.admissionBlocked) throw error;
      return request<DraftView>(`${this.base(buffer)}/draft`, 'PUT', body);
    }
  }
  private saveFailure(buffer: Buffer, error: unknown): void {
    if (error instanceof ApiError && error.view.code === 'stale_revision') this.stale(buffer, error);
    else { buffer.saveError = draftSaved(buffer.data) ? undefined : errorMessage(error); this.receipt(buffer); }
  }
  private stale(buffer: Buffer, error: ApiError): void {
    const value = error.view.details?.value;
    if (!error.view.details?.truncated && value && typeof value === 'object' && 'revision' in value && 'text' in value && 'mode' in value && 'persisted' in value &&
      Number.isSafeInteger(value.revision) && typeof value.text === 'string' && typeof value.mode === 'string' && value.persisted === true) {
      buffer.data = receiveDraft(buffer.data, value as DraftView, true);
    }
    this.conflict(buffer);
  }
  private conflict(buffer: Buffer): void {
    buffer.review = true; buffer.localCopy ??= buffer.data.text; this.receipt(buffer); this.render();
  }
  private async review(buffer: Buffer): Promise<void> {
    try {
      const state = await request<TargetState>(this.base(buffer));
      buffer.data = {...buffer.data, server: state.draft, conflict: state.draft}; buffer.state.draft = state.draft;
      this.receipt(buffer);
    } catch (error) { this.failureNotice(buffer, 'Draft could not be loaded.', error); }
  }
  private choose(buffer: Buffer, choice: 'local' | 'server'): void {
    if (buffer.saving) return;
    this.rememberSelection(); const previous = buffer.data;
    if (choice === 'server') {buffer.attachments?.clear(); buffer.inclusions?.clear();}
    buffer.data = resolveDraftConflict(buffer.data, choice); this.rebaseSelection(buffer, previous, true); buffer.review = false; buffer.localCopy = undefined; buffer.notice = ''; buffer.noticeDetails = undefined; buffer.saveError = undefined;
    this.paint(buffer); this.receipt(buffer); this.flush(buffer); if (this.current === buffer) this.focus();
  }
  private receipt(buffer?: Buffer): void {
    if (buffer) this.notifyRetained(buffer);
    if (this.destroyed || !buffer || this.current !== buffer) return;
    const slot = this.slot(); slot.replaceChildren();
    const records = this.records(buffer); this.receiptDetails(records);
    this.controlExceptions(buffer, records, slot);
    this.receiptNotices(buffer, records, slot);
    if (buffer.review) {
      slot.append(element('p', 'warning', 'This draft changed in another tab.'), element('pre', undefined, buffer.localCopy ?? buffer.data.text), attachmentSummary(buffer.workspace, buffer.state.targetKey, buffer.data.images), button('Review', () => { void this.review(buffer); }));
      if (buffer.data.conflict) slot.append(element('p', undefined, 'Draft on the Mac'), element('pre', undefined, buffer.data.conflict.text), attachmentSummary(buffer.workspace, buffer.state.targetKey, buffer.data.conflict.images), button('Use Mac draft', () => this.choose(buffer, 'server')), button('Keep my copy', () => this.choose(buffer, 'local')));
    }
    this.recoveryGuard(buffer, slot);
    for (const pending of buffer.pending.values()) if (pending.uncertain) this.recovery(buffer, pending, slot);
    for (const retained of buffer.state.retainedInputs) this.retainedCopy(buffer, retained, slot);
    if (buffer.state.recoveryPreviewTruncated && this.hooks.recovery) slot.append(button('Review all saved copies', this.hooks.recovery));
  }
  private recoveryGuard(buffer: Buffer, slot: HTMLElement): void {
    const guard = buffer.data.server.recoverySendGuard;
    if (!guard || guard.state === 'clear') return;
    if (guard.state === 'unavailable') {slot.append(element('p', 'warning', 'Queue recovery information is unavailable. Sending is blocked; confirmation does not override it.')); return;}
    slot.append(element('p', 'warning', 'Image copies remain from this queue clear. This text is not an image-free replacement for those copies.'));
    const ask = button('Send a different message…', () => {
      const consent = this.consent(buffer, true);
      slot.append(element('p', 'warning', 'Confirm that this exact draft is a different message, not a resend of a retained image copy.'), button('Confirm different message', () => {if (this.consentMatches(buffer, consent)) void this.send(false, consent);}));
    });
    ask.disabled = !draftSaved(buffer.data) || !!this.imageRefusal(buffer) || this.admissionBlocked || !this.ready;
    slot.append(ask);
  }
  private retainedCopy(buffer: Buffer, item: RecoveryInput, slot: HTMLElement): void {
    const label = recoveryLabel(item), row = element('section', 'send-recovery');
    row.append(element('p', 'warning', label.title), element('p', 'secondary', label.warning), this.details(item.text, 'Review message'), attachmentSummary(buffer.workspace, buffer.state.targetKey, item.images));
    if (item.textTruncated) row.append(element('p', 'secondary', 'The preview is shortened. Copy and Restore use the complete saved copy.'));
    row.append(cardAction('copy', 'Copy text only', () => {void exactInput(buffer.workspace, item).then(exact => copy(exact.text, row)).catch(error => this.recoveryError(buffer, error));}), button('Restore complete copy', () => {
      const origin = document.activeElement;
      void exactInput(buffer.workspace, item).then(exact => this.restore(buffer, exact, origin)).catch(error => this.recoveryError(buffer, error));
    }));
    slot.append(row);
  }
  private receiptNotices(buffer: Buffer, records: OperationView[], slot: HTMLElement): void {
    const ordinary = buffer.lastOperation?.state === 'accepted' && buffer.notice === 'Message sent';
    if (buffer.notice && !ordinary && buffer.notice !== buffer.saveError) slot.append(element('p', 'warning', buffer.notice));
    if (buffer.noticeDetails && !buffer.saveError) slot.append(this.details(buffer.noticeDetails));
    if (buffer.insertionCopy !== undefined) slot.append(button('Insert prepared text', () => {
      const captured = this.insertionCapture(); if (captured?.buffer === buffer && buffer.insertionCopy !== undefined) this.insertPrepared(captured, buffer.insertionCopy);
    }), button('Copy prepared text', () => { void copy(buffer.insertionCopy ?? '', slot); }), button('Discard prepared text', () => {buffer.insertionCopy = undefined; buffer.notice = ''; this.receipt(buffer);}));
    this.inputReceiptNotice(buffer, records.find(inputOperation), slot);
    if (!buffer.saveError || buffer.review) return;
    const retry = cardAction('restart', 'Retry draft save', () => { if (this.current !== buffer || this.admissionBlocked || buffer.saving) return; if (buffer.notice === buffer.saveError || buffer.noticeDetails === buffer.saveError) { buffer.notice = ''; buffer.noticeDetails = undefined; } buffer.saveError = undefined; this.render(); this.receipt(buffer); this.flush(buffer); });
    retry.disabled = this.admissionBlocked || !!buffer.saving || new TextEncoder().encode(buffer.data.text).length > LIMITS.textBytes;
    slot.append(this.details(buffer.saveError), retry);
  }
  private inputReceiptNotice(buffer: Buffer, record: OperationView | undefined, slot: HTMLElement): void {
    if (!record || buffer.pending.has(record.id)) return;
    const queued = record.state === 'accepted' && record.receipt?.kind === 'rpc' && record.receipt.disposition === 'queued';
    const label = queued ? 'Message queued' : ['uncertain', 'rejected'].includes(record.state) ? operationLabel(record) : '';
    if (label && buffer.notice !== label) slot.append(element('p', queued ? 'secondary' : 'warning', label));
  }
  private receiptDetails(records: OperationView[]): void {
    const disclosure = this.elements.receiptDetails;
    const key = this.current?.state.targetKey ?? '';
    const expanded = disclosure.dataset.targetKey === key && disclosure.querySelector<HTMLDetailsElement>('details')?.open;
    disclosure.replaceChildren(); disclosure.dataset.targetKey = key;
    if (!records.length) return;
    const latest = [records.find(inputOperation), records.find(item => !inputOperation(item))].filter((item): item is OperationView => !!item);
    const node = element('details'); const pre = element('pre'); node.open = !!expanded;
    const paint = (): void => {
      if (!node.open) return;
      setText(pre, latest.map(item => {
        const raw = rawText(item); return `${inputOperation(item) ? 'Input receipt' : 'Action receipt'}\n${raw.slice(0, 65536)}${raw.length > 65536 ? '\nReceipt preview shortened.' : ''}`;
      }).join('\n\n'));
    };
    node.append(element('summary', undefined, 'Delivery details'), pre); node.addEventListener('toggle', paint); paint(); disclosure.append(node);
  }
  private controlExceptions(buffer: Buffer, records: OperationView[], slot: HTMLElement): void {
    for (const item of records) {
      if (inputOperation(item) || !['uncertain', 'rejected'].includes(item.state)) continue;
      slot.append(element('p', 'warning', operationLabel(item)));
      if (item.state === 'uncertain') slot.append(cardAction('restart', 'Check action', () => {
        void request<OperationView>(`/api/operations/${encoded(item.id)}/reconcile`, 'POST', {}).then(result => this.hooks.submitted(result)).catch(error => this.failureNotice(buffer, 'Action not confirmed.', error));
      }));
    }
  }
  private details(text: string, title = 'Details'): HTMLDetailsElement {
    const node = element('details', 'receipt-disclosure');
    node.append(element('summary', undefined, title), element('pre', undefined, text)); return node;
  }
  private recovery(buffer: Buffer, pending: Pending, slot: HTMLElement): void {
    const captured = pending.submission; const row = element('div', 'send-recovery');
    row.append(element('p', 'warning', 'Send not confirmed. Check before you send again.'),
      this.details(`${JSON.stringify(captured.target)}\n${captured.operationId}\n${captured.mode} · revision ${captured.draftRevision}`), this.details(captured.text, 'Review message'), attachmentSummary(buffer.workspace, buffer.state.targetKey, captured.images));
    if (pending.original?.textTruncated) row.append(element('p', 'secondary', 'Preview shortened. Copy or restore the full message.'));
    row.append(cardAction('restart', 'Check delivery', () => { void this.check(buffer, pending); }), cardAction('copy', 'Copy original text only', () => { void this.exact(buffer, pending).then(item => copy(item.text, row)).catch(error => this.recoveryError(buffer, error)); }), button('Restore to draft', () => {
      const origin = document.activeElement;
      void this.exact(buffer, pending).then(item => {
        if (draftHasContent(buffer.data) && !sameDraftTuple(buffer.data, item)) row.append(element('p', undefined, 'Your newer draft is unchanged. Copy the original message or replace this draft.'), button('Replace draft with original', () => {void this.restore(buffer, item, document.activeElement);} ));
        else void this.restore(buffer, item, origin);
      }).catch(error => this.recoveryError(buffer, error));
    }));
    if (!pending.original?.queueRecovery && captured.target.kind === 'primary') row.append(button('Send again…', () => {
      const consent = this.consent(buffer);
      row.append(element('p', 'warning', 'The message might already be sent. Sending again risks duplicate work.'), button('Send again', () => {
        if (this.current !== buffer || buffer.submitting || !this.consentMatches(buffer, consent)) return;
        void this.send(false, consent);
      }));
    }));
    if (pending.original?.sendGuard?.state === 'blocked') row.append(element('p', 'warning', 'Image copies remain from this queue clear. Restore the copy before an explicit different-message confirmation.'));
    if (pending.original?.sendGuard?.state === 'unavailable') row.append(element('p', 'warning', 'Queue recovery information is unavailable. Sending is blocked.'));
    slot.append(row);
  }
  private failureNotice(buffer: Buffer, notice: string, error: unknown): void {
    buffer.notice = notice; buffer.noticeDetails = errorMessage(error); this.receipt(buffer);
  }
  private recoveryError(buffer: Buffer, error: unknown): void { this.failureNotice(buffer, 'The saved message could not be loaded.', error); }
  private async exact(buffer: Buffer, pending: Pending): Promise<Submission> {
    if (!pending.original?.textTruncated) return pending.submission;
    const item = await exactInput(buffer.workspace, pending.original); const previous = pending.submission;
    if (item.textTruncated || item.operationId !== previous.operationId || !sameTarget(previous.target, item.target) || item.mode !== previous.mode || item.submittedDraftRevision !== previous.draftRevision || draftImageFingerprint(item.images) !== draftImageFingerprint(previous.images)) throw new Error('The saved copy does not match this message.');
    pending.submission = {...previous, text: item.text, images: item.images.map(image => ({...image}))}; pending.original = item;
    if (buffer.data.submissions.get(previous.operationId) === previous) buffer.data = {...buffer.data, submissions: new Map(buffer.data.submissions).set(previous.operationId, pending.submission)};
    return pending.submission;
  }
  private async restore(buffer: Buffer, captured: Pick<Submission, 'operationId' | 'target' | 'text' | 'mode' | 'images'>, origin: Element | null): Promise<void> {
    if (!sameTarget(buffer.state.target, captured.target)) {this.recoveryError(buffer, new Error('The saved copy has a different recipient.')); return;}
    if (buffer.saving || this.admissionBlocked) {this.recoveryError(buffer, new Error('Wait for draft access and the current save before restoring.')); return;}
    if (this.current === buffer) this.rememberSelection();
    const edit = buffer.data.edit, files = buffer.attachments?.items.map(item => item.id).join(',');
    try {
      const draft = await request<DraftView>(`/api/workspaces/${encoded(buffer.workspace)}/unconfirmed/${encoded(captured.operationId)}/restore`, 'POST', {expectedDraftRevision: buffer.data.server.revision});
      if (!sameDraftTuple(draft, captured)) throw new Error('The restored draft does not match the saved copy.');
      const previous = buffer.data;
      // Resolve the action's focus before its receipt controls are replaced.
      this.returnFocus(buffer, origin);
      if (buffer.data.edit !== edit || files !== buffer.attachments?.items.map(item => item.id).join(',')) {
        buffer.data = receiveDraft(buffer.data, draft, true); this.conflict(buffer);
      } else {
        buffer.data = resolveDraftConflict({...buffer.data, server: draft, conflict: draft}, 'server');
        buffer.attachments?.clear(); buffer.inclusions?.clear(); buffer.insertionCopy = undefined; buffer.review = false;
        this.rebaseSelection(buffer, previous, true); buffer.notice = 'The complete copy was restored. No message was sent.';
      }
      this.paint(buffer); this.receipt(buffer);
    } catch (error) {this.recoveryError(buffer, error);}
  }
  private async check(buffer: Buffer, pending: Pending): Promise<void> {
    try {
      const result = await request<OperationView>(`/api/operations/${encoded(pending.submission.operationId)}/reconcile`, 'POST', {});
      if (!this.updateOperation(result)) throw new Error('The receipt does not match the original operation.');
      this.hooks.submitted(result);
    } catch (error) { buffer.noticeDetails = `${errorMessage(error)} The original admission remains unknown.`; buffer.notice = ''; this.receipt(buffer); }
  }
  private hydrate(buffer: Buffer, state: TargetState): void {
    for (const item of state.unconfirmed) {
      if (buffer.pending.has(item.operationId) || buffer.resolved.has(item.operationId)) continue;
      const matches = !item.textTruncated && sameDraftTuple(buffer.data, item) && buffer.data.server.revision === item.submittedDraftRevision;
      const submission: Submission = {operationId: item.operationId, target: {...item.target}, text: item.textTruncated && matches ? buffer.data.server.text : item.text, mode: item.mode, images: item.images.map(image => ({...image})), draftRevision: item.submittedDraftRevision, edit: matches ? buffer.data.edit : -1};
      buffer.pending.set(item.operationId, {submission, original: item, uncertain: true});
      buffer.data = {...buffer.data, submissions: new Map(buffer.data.submissions).set(item.operationId, submission)};
    }
  }
  updateOperation(result: OperationView): boolean {
    for (const buffer of this.buffers.values()) {
      const pending = buffer.pending.get(result.id);
      if (!pending || !sameTarget(pending.submission.target, result.target)) continue;
      void this.finish(buffer, pending, result); return true;
    }
    return false;
  }
  private finish(buffer: Buffer, pending: Pending, result: OperationView): Promise<void> {
    if (pending.settling) return pending.settling;
    buffer.lastOperation = result;
    if (result.state !== 'accepted' && result.state !== 'rejected') {
      pending.uncertain = true; buffer.notice = ''; this.receipt(buffer); return Promise.resolve();
    }
    const outcome = result.state;
    pending.settling = Promise.resolve().then(async () => {
      pending.uncertain = false;
      if (this.current === buffer) this.rememberSelection(); const previous = buffer.data;
      const clearAccepted = pending.submission.images.length === 0 || result.receipt?.kind === 'durable' || result.receipt?.kind === 'rpc' && (result.receipt.disposition === 'started' || result.receipt.disposition === 'queued');
      buffer.data = settleSubmission(buffer.data, pending.submission, outcome, undefined, clearAccepted); this.rebaseSelection(buffer, previous, outcome === 'accepted' && clearAccepted);
      buffer.notice = this.admissionNotice(result, pending.submission.images.length > 0); buffer.noticeDetails = undefined;
      this.paint(buffer); this.receipt(buffer); announce(buffer.notice);
      if (outcome === 'accepted' || result.retainedInput) await this.refreshAccepted(buffer, pending);
      buffer.pending.delete(result.id); buffer.resolved.add(result.id);
      if (buffer.resolved.size > LIMITS.operations) buffer.resolved.delete(buffer.resolved.values().next().value as string);
      this.paint(buffer); this.receipt(buffer); this.flush(buffer);
    });
    return pending.settling;
  }
  private async refreshAccepted(buffer: Buffer, pending: Pending): Promise<void> {
    try {
      const saved = pending.cleanup && !buffer.lastOperation?.retainedInput ? {...buffer.state, draft: pending.cleanup} : await request<TargetState>(this.base(buffer)); buffer.state = {...saved, draft: buffer.data.server};
      const draft = pending.cleanup ?? saved.draft;
      if (!draftHasContent(draft) && draft.mode === pending.submission.mode && draft.revision === pending.submission.draftRevision + 1 && draft.revision >= buffer.data.server.revision) {
        const savedEdit = !draftHasContent(buffer.data) ? buffer.data.edit : buffer.data.savedEdit === buffer.data.edit ? -1 : buffer.data.savedEdit;
        const previous = buffer.data; buffer.data = {...buffer.data, server: draft, savedEdit}; this.rebaseSelection(buffer, previous);
      } else this.receive(buffer, draft);
    } catch (error) { this.failureNotice(buffer, 'Draft could not be refreshed.', error); }
  }
  private admissionNotice(result: OperationView, images = false): string {
    if (result.state !== 'accepted') return 'Message not sent';
    if (images && result.receipt?.kind === 'rpc' && result.receipt.disposition === 'handled') return 'Input handled; images not confirmed';
    if (result.receipt?.kind === 'rpc' && result.receipt.disposition === 'queued') return 'Message queued';
    return 'Message sent';
  }
  private pendingBlocks(buffer: Buffer): boolean {
    return [...buffer.pending.values()].some(item => buffer.state.target.kind === 'primary' || sameDraftTuple(item.submission, buffer.data));
  }
  private consent(buffer: Buffer, differentMessage?: true): SendConsent {
    return {buffer, edit: buffer.data.edit, revision: buffer.data.server.revision, operations: new Set(buffer.pending.keys()), tuple: {text: buffer.data.text, mode: buffer.data.mode, images: buffer.data.images.map(image => ({...image})), edit: buffer.data.edit}, ...(differentMessage ? {differentMessage} : {})};
  }
  private consentMatches(buffer: Buffer, consent?: SendConsent): boolean {
    return !!consent && !consent.used && consent.buffer === buffer && consent.edit === buffer.data.edit && consent.revision === buffer.data.server.revision && sameDraftTuple(consent.tuple, buffer.data);
  }
  private blocked(buffer: Buffer, consent?: SendConsent): boolean {
    if (this.admissionBlocked || !this.ready || buffer.submitting || buffer.review || !draftHasContent({text: buffer.data.text.trim(), images: buffer.data.images}) || this.imageRefusal(buffer)) return true;
    const guard = buffer.data.server.recoverySendGuard;
    if (guard?.state === 'unavailable' || guard?.state === 'blocked' && (!consent?.differentMessage || !this.consentMatches(buffer, consent))) return true;
    if (this.pendingBlocks(buffer) && !this.consentMatches(buffer, consent)) { this.receipt(buffer); return true; }
    return false;
  }
  async send(literal = false, consent?: SendConsent): Promise<void> {
    const buffer = this.current; if (this.composing || this.suppressEnter || this.textLimit || !buffer || this.blocked(buffer, consent)) return;
    if (consent && !this.consentMatches(buffer, consent)) return;
    if (consent) consent.used = true;
    this.rememberSelection(); const focusOrigin = document.activeElement;
    this.commandMenu?.close();
    const snapshot: Edit = {text: buffer.data.text, mode: buffer.state.target.kind === 'primary' && !this.busy ? 'prompt' : this.deliveryMode(buffer.data.mode) ?? buffer.data.mode, images: buffer.data.images.map(image => ({...image})), edit: buffer.data.edit};
    const confirmation = {target: {...buffer.state.target}, revision: buffer.data.server.revision, mode: buffer.data.mode};
    if (!literal && buffer.state.target.kind === 'primary' && this.hooks.unknownCommand(snapshot.text, () => {
      if (this.current === buffer && sameTarget(confirmation.target, buffer.state.target) && buffer.data.text === snapshot.text &&
        buffer.data.edit === snapshot.edit && buffer.data.server.revision === confirmation.revision && buffer.data.mode === confirmation.mode) void this.send(true);
    })) return;
    // Mode is part of the saved payload, including an idle primary's prompt mode.
    if (snapshot.mode !== buffer.data.mode) { const previous = buffer.data; buffer.data = editDraft(buffer.data, snapshot.text, snapshot.mode); this.rebaseSelection(buffer, previous); snapshot.edit = buffer.data.edit; }
    buffer.submitting = true; buffer.lastOperation = undefined; buffer.notice = 'Sending…'; buffer.noticeDetails = undefined; this.render(); this.receipt(buffer);
    const reservation = buffer.reservation;
    let pending: Pending | undefined;
    try {
      await this.confirmSaved(buffer, snapshot);
      this.assertSendReady(buffer, snapshot, consent);
      pending = await this.capture(buffer, snapshot, reservation, consent);
      const result = await this.dispatch(pending.submission, literal);
      if (result.id !== pending.submission.operationId || !sameTarget(pending.submission.target, result.target)) throw new Error('The response did not match the submitted operation.');
      await this.finish(buffer, pending, result); this.hooks.submitted(result);
    } catch (error) { this.sendError(buffer, pending, error); }
    finally { buffer.submitting = false; this.paint(buffer); this.receipt(buffer); this.prepare(buffer); this.flush(buffer); this.returnFocus(buffer, focusOrigin); }
  }
  private assertSendReady(buffer: Buffer, snapshot: Edit, consent?: SendConsent): void {
    if (this.admissionBlocked || this.current === buffer && !this.ready || this.imageRefusal(buffer, snapshot)) throw new Error('The recipient or image capability changed. Your draft is unchanged.');
    if (!consent) return;
    if (buffer.data.server.revision !== consent.revision || buffer.data.edit !== snapshot.edit || !sameDraftTuple(snapshot, buffer.data) || [...buffer.pending.keys()].some(id => !consent.operations.has(id))) throw new Error('The confirmed draft changed. Confirm this message again.');
  }
  private async confirmSaved(buffer: Buffer, snapshot: Edit): Promise<void> {
    if (buffer.saving) await buffer.saving;
    if (buffer.review) throw new Error('Review this draft before sending.');
    if (!sameDraftTuple(buffer.data.server, snapshot) || buffer.data.savedEdit < snapshot.edit) await this.save(buffer, snapshot);
    if (buffer.review) throw new Error('Review this draft before sending.');
  }
  private async capture(buffer: Buffer, snapshot: Edit, reservation?: Buffer['reservation'], consent?: SendConsent): Promise<Pending> {
    buffer.reservation = undefined;
    if (reservation && Date.now() - reservation.at >= LIMITS.reservationMs) throw new Error('Input reservation expired. Your text was not sent. Send again with a new reservation.');
    const target = {...buffer.state.target};
    const id = reservation ? await reservation.promise : await reserve(target.kind === 'primary' ? 'primary.input' : 'agent.input', target);
    this.assertSendReady(buffer, snapshot, consent);
    // A confirmed retry permits this capture only; older uncertain operations still own their receipts.
    const submissions = consent ? new Map([...buffer.data.submissions].filter(([id, item]) => !consent.operations.has(id) || item.edit !== snapshot.edit || !sameDraftTuple(item, snapshot))) : buffer.data.submissions;
    const captured = captureSubmission({...buffer.data, ...snapshot, submissions, savedEdit: snapshot.edit}, target, id, consent?.differentMessage);
    if (!captured.submission) throw new Error('This draft already has a pending submission.');
    buffer.data = {...buffer.data, submissions: new Map(buffer.data.submissions).set(id, captured.submission)};
    const pending = {submission: captured.submission, uncertain: false}; buffer.pending.set(id, pending); return pending;
  }
  private dispatch(submission: Submission, literal: boolean): Promise<OperationView> {
    const target = submission.target;
    const path = target.kind === 'primary' ? `/api/primaries/${encoded(target.key)}/inputs` : `/api/agents/${encoded(target.identity)}/inputs`;
    const input = {message: submission.text, mode: submission.mode, draftRevision: submission.draftRevision, images: submission.images};
    const body = target.kind === 'primary' ? {...input, epoch: target.epoch, literal, ...(submission.differentMessage ? {differentMessage: true} : {})} : input;
    return operation(target.kind === 'primary' ? 'primary.input' : 'agent.input', path, body, target, submission.operationId);
  }
  private sendError(buffer: Buffer, pending: Pending | undefined, error: unknown): void {
    buffer.notice = errorMessage(error);
    if (pending && (!(error instanceof ApiError) || ['delivery_uncertain', 'internal'].includes(error.view.code))) pending.uncertain = true;
    else if (pending) {
      buffer.data = settleSubmission(buffer.data, pending.submission, 'rejected'); buffer.pending.delete(pending.submission.operationId);
      if (pending.cleanup) this.receive(buffer, pending.cleanup);
    }
    if (error instanceof ApiError && error.view.code === 'stale_revision') this.stale(buffer, error);
    if (error instanceof ApiError && error.view.code === 'unknown_operation') buffer.notice = 'Input reservation expired or unknown. Your text was not sent. Send again with a new reservation.';
    buffer.noticeDetails = buffer.notice;
    buffer.notice = [...buffer.pending.values()].some(item => item.uncertain) ? '' : 'Message not sent';
    this.receipt(buffer); announce(buffer.notice || 'Send not confirmed. Check before you send again.');
  }
}
