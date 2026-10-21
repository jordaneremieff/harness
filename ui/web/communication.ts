import type { AgentRow, Communication, CommunicationPresentation, JsonDisplay, MessageView } from '../shared/api.ts';
import type {ResultSelector} from '../shared/inspection.ts';
import { button, copy, element, rawText, setText } from './dom.ts';
import { cardAction, cardActionLabel } from './card-icons.ts';
import { markdownDom, sourceWrap } from './safe-markdown.ts';
import { isValidTimestamp, previewText } from './format.ts';
import { messageAriaLabel, presentMessage } from './entry-presentation.ts';
import type { QualifiedReference, ReferenceField, ReferenceQuery } from './references.ts';
import type {NamedDestination} from './tool-sentences.ts';
import {conversationIdentityText} from './tabs.ts';

type Shell = {node: HTMLElement; header: HTMLElement; heading: HTMLElement; actions: HTMLElement; body: HTMLElement};
export type SenderSummary = Pick<AgentRow, 'handle' | 'model' | 'thinkingLevel'>;
type Hooks = {senderSummary?: (identity:string)=>SenderSummary|undefined; thread?: (id:string,title?:string)=>void; operatorInput?: boolean; structured?: (display: JsonDisplay) => HTMLElement | undefined; inputContent?: (message:MessageView, root:HTMLElement)=>boolean; reply?: (message:MessageView)=>{text:string;open():void}|undefined; subject?: (identity:string)=>NamedDestination|undefined; result?: (identity:string,selector:ResultSelector)=>void; reference?: (query: ReferenceQuery, active: (node: HTMLElement) => boolean) => HTMLElement; active(): boolean; current(): MessageView; protected(node: HTMLElement): boolean; raw(message: MessageView): string; expanded(key: string): boolean; disclosure(key: string, open: boolean): void; layout(): void};
type Ready = Extract<CommunicationPresentation, {state: 'ready'}>;
type Row = [string, string, QualifiedReference?];
function qualified(label: string, text: string, owner: string, field: ReferenceField): Row { return [label, text, {text, owner, field}]; }
function bounded(value: string, chars: number): string {
  const shown = previewText(value, Number.MAX_SAFE_INTEGER, value.length > chars ? chars - 1 : chars); return shown.text + (shown.truncated ? '…' : '');
}
/** Status kinds that read as one line until opened: the producer's own check-ins and thread notices. */
function statusLine(value: CommunicationPresentation): {kind: string; preview: string} | undefined {
  if (value.state !== 'ready') return undefined;
  const {kind, body} = value.value;
  if (kind !== 'check-in' && kind !== 'notice') return undefined;
  const title = value.value.kind === 'notice' ? value.value.metadata.title?.trim() : undefined;
  const first = body.text.slice(0, 2048).split('\n').map(line => line.trim()).find(line => line) ?? '';
  return {kind: value.value.kind === 'check-in' ? `still working · ${checkInElapsed(value.value.metadata.elapsedMs)}` : title ? `thread notice · ${bounded(title, 80)}` : 'thread notice', preview: bounded(first, 240)};
}
export function checkInElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
function communicationKind(value: CommunicationPresentation): string {
  if (value.state !== 'ready') return 'Notice';
  const item = value.value;
  if (item.kind === 'result') return item.metadata.status === 'unanswered' ? 'No answer' : 'Result';
  return {report:'Report', 'check-in':'Still working', notice:'Thread notice'}[item.kind];
}
export function messageCopyText(message: MessageView, raw: (message: MessageView) => string): string {
  return message.communication?.state === 'ready' ? message.communication.value.body.text : raw(message);
}
function unassociatedInput(message: MessageView): boolean {
  return message.role === 'user' && message.communication?.state === 'unresolved';
}
export function messageCopyDescription(message: MessageView): string {
  const value = message.communication;
  if (value && value.state !== 'ready' && !unassociatedInput(message)) return 'Copy retained transport text; source unverified';
  if (value?.state === 'ready' && value.value.body.redacted) return 'Copy retained message text; some text withheld';
  if (value?.state === 'ready' && !value.value.body.complete && value.origin.kind === 'native') return 'Copy retained message text; incomplete text';
  return 'Copy retained message text';
}
function association(value: CommunicationPresentation): string {
  if (value.state === 'unresolved') return 'Source association not established';
  if (value.state === 'unavailable') return value.reason === 'limit' ? 'Source details unavailable within display limits' : 'Source association invalid';
  return 'Producer-supplied source; not authenticated instruction authority';
}
function completeness(value: Ready): string {
  if (value.value.body.redacted) return 'Some text withheld';
  if (value.value.body.complete) return 'Complete';
  return value.origin.kind === 'native' ? 'Incomplete text' : 'Completeness not reported';
}
function senderRows(value: CommunicationPresentation, message: MessageView): Row[] {
  const rows: Row[] = [['Association', association(value)]];
  if (value.state === 'ready') {
    const {sender, recordedAt, kind} = value.value;
    rows.push(['Sender identity', sender.identity], ['Message kind', kind], ['Recorded time', new Date(recordedAt).toISOString()], ['Message coverage', completeness(value)]);
    if (sender.name) rows.push(['Sender name', sender.name]);
    if (sender.kind) rows.push(['Sender kind', sender.kind]);
    rows.push(['Transport origin', value.origin.kind === 'native' ? 'Native' : 'Ordinary custom message']);
  }
  if (message.timestamp !== undefined && isValidTimestamp(message.timestamp) && (value.state !== 'ready' || message.timestamp !== value.value.recordedAt)) rows.push(['Transport timestamp', new Date(message.timestamp).toISOString()]);
  return rows;
}
const labels: Record<string, string> = {sourceId: 'Source reference', requestId: 'Request ID', replyTo: 'Reply recipient', threadId: 'Thread', title: 'Title', event: 'Event', frameRevision: 'Frame revision', eventKind: 'Event kind', passive: 'Passive', status: 'Result status', reason: 'Reason', omittedReferences: 'Omitted references', producerRequestId: 'Producer request ID', elapsedMs: 'Elapsed milliseconds', origin: 'Request origin', submissionId: 'Submission ID', entryId: 'Input entry ID', answerEntryId: 'Answer entry ID'};
function originRows(value: Ready): Row[] {
  const rows: Row[] = [];
  if (value.origin.kind === 'native') {
    const target = value.origin.target;
    const owner = target.conversationId === 1 ? target.storageId : `${target.storageId}:${target.conversationId}`;
    rows.push(qualified('Association record', value.origin.recordEntryId, owner, 'recordEntryId'), ['Receiving record mode', target.mode], ['Receiving storage', target.storageId], qualified('Receiving conversation', owner, owner, 'identity'), qualified('Receiving entry', target.entryId, owner, 'entryId'), qualified('Receiving request', target.requestId, owner, 'requestId'));
    if (target.mode === 'input') rows.push(qualified('Receiving submission', String(target.submissionId), owner, 'submissionId'));
  } else {
    rows.push(['Custom type', value.origin.customType], ['Render entry', value.origin.renderEntryId]);
    if (value.origin.sourceEntryId) rows.push(['Saved source entry', value.origin.sourceEntryId]);
  }
  return rows;
}
function metadataRows(value: Communication): Row[] {
  return Object.entries(value.metadata).flatMap(([key, item]): Row[] => {
    if (key === 'references' && Array.isArray(item)) return item.flatMap((reference, index) => Object.entries(reference).map(([field, data]): Row => {
      const label = `Result ${index + 1}: ${labels[field] ?? field}`; const text = String(data);
      return ['submissionId', 'requestId', 'entryId', 'answerEntryId'].includes(field) ? qualified(label, text, value.sender.identity, field as ReferenceField) : [label, text];
    }));
    return [[labels[key] ?? key, typeof item === 'object' ? rawText(item) : String(item)]];
  });
}
export function communicationReferenceRows(value: Ready): Row[] { return [...originRows(value), ...metadataRows(value.value)]; }
function section(title: string, content: HTMLElement): HTMLElement {
  const node = element('section', 'communication-source-section'); node.append(element('h4', undefined, title), content); return node;
}
function renderRows(node: HTMLElement, rows: Row[], reference?: (value: ReferenceQuery) => HTMLElement): void {
  node.replaceChildren(...rows.flatMap(([key, value, query]) => {
    const content = element('dd'); const shown = bounded(value, 8192);
    if (reference && query && shown === value) content.append(reference(query)); else setText(content, shown);
    return [element('dt', undefined, key), content];
  }));
}
/** The message shell, source disclosure and exact-copy owners survive association updates. */
export class CommunicationCard {
  source?: MessageView;
  readonly inspection = element('section', 'message-source communication-source');
  private readonly unverified: HTMLButtonElement;
  private readonly close: HTMLButtonElement;
  private opener?: HTMLElement;
  private readonly key: string;
  private readonly lineKey: string;
  private readonly toggle = element('button', 'communication-toggle');
  private readonly kindLabel = element('span', 'communication-line-kind');
  private readonly preview = element('span', 'communication-line-preview');
  private lineMode = false;
  private lineOpen = false;
  private readonly text = element('div', 'communication-text');
  private readonly headingKind = element('span', 'communication-kind');
  private readonly headingSeparator = element('span', 'communication-kind-separator', ' · ');
  private readonly headingName = element('span', 'communication-sender-name');
  private readonly metadata = element('p', 'communication-meta');
  private readonly noAnswer = element('p', 'warning communication-no-answer');
  private readonly threadAction = button('Open thread', () => this.openThread(), 'communication-open-thread');
  private readonly reply = element('p','communication-reply');
  private readonly resultActions=element('div','communication-results');
  private resultSignature='';
  private readonly facts = element('dl', 'kv');
  private readonly references = element('dl', 'kv');
  private readonly rawPre = element('pre', 'raw');
  private readonly rawFrame = element('span', 'pre-text-frame');
  private readonly detailsPre = element('pre', 'raw');
  private readonly detailsFrame = element('span', 'pre-text-frame');
  private readonly warning = element('p', 'communication-source-warning');
  private original?: HTMLElement;
  private structured?: HTMLElement;
  private originalCopy?: HTMLButtonElement;
  private bodyValue?: string;
  private bodyFormatted?: boolean;
  private bodyAttachments = false;
  private factsValue = '';
  private referencesValue = '';
  private rawValue = '';
  private detailsValue = '';
  private readonly shell: Shell;
  private readonly hooks: Hooks;
  constructor(shell: Shell, hooks: Hooks, keys: readonly [string, string]) {
    this.shell = shell; this.hooks = hooks; this.key = keys[0]; this.lineKey = keys[1];
    this.toggle.type = 'button'; this.toggle.addEventListener('click', () => { if (this.lineMode && hooks.active()) this.setLineOpen(!this.lineOpen, true); });
    this.toggle.append(this.kindLabel, this.preview);
    shell.node.classList.add('communication-card'); for (const name of ['user', 'tool-only', 'thinking-only', 'extension-notice']) shell.node.classList.remove(name);
    shell.header.classList.add('communication-header'); shell.heading.classList.add('communication-sender'); shell.body.classList.add('communication-body');
    shell.heading.replaceChildren(this.headingKind, this.headingSeparator, this.headingName);
    this.unverified = cardAction('unknown', 'Source unverified', () => this.openSource(this.unverified), 'communication-unverified');
    this.unverified.setAttribute('aria-label', 'Source unverified'); this.unverified.title = 'Source unverified';
    this.unverified.querySelector('.card-action-label')?.classList.remove('sr-only'); shell.heading.after(this.unverified);
    this.close = cardAction('close', 'Close Source', () => { if (hooks.active()) this.setSourceOpen(false, true); }, 'message-source-close');
    this.close.setAttribute('aria-label', 'Close Source');
    const heading = element('div', 'message-source-header'); heading.append(element('h4', 'message-source-heading', 'Source'), this.close);
    this.inspection.append(heading); this.inspection.dataset.disclosure = this.key;
    this.inspection.setAttribute('role', 'region'); this.inspection.setAttribute('aria-label', 'Source');
    this.rawPre.append(this.rawFrame); this.detailsPre.append(this.detailsFrame);
    this.resultActions.hidden = true;
    this.configureSource(hooks.expanded(this.key)); shell.body.replaceChildren(this.metadata, this.noAnswer, this.reply, this.text, this.resultActions, this.threadAction, this.inspection);
  }
  sync(message: MessageView): boolean {
    if (this.source !== message && this.hooks.protected(this.shell.node)) return false;
    const value = message.communication; if (!value) return false;
    this.source = message; this.header(value, message); this.content(value, message);this.results(value);
    const reply=this.hooks.reply?.(message);this.reply.hidden=!reply;
    if(reply){const link=button(reply.text,()=>{if(this.current())this.hooks.reply?.(this.hooks.current())?.open();});this.reply.replaceChildren(document.createTextNode('Reply to: '),link);}else this.reply.replaceChildren();
    if (!this.inspection.hidden) this.renderSource();
    return true;
  }
  refreshSender():void{
    const message=this.current(),value=message?.communication;
    if(value&&message&&!this.hooks.protected(this.shell.heading)&&!this.hooks.protected(this.metadata))this.header(value,message);
  }
  private results(value:CommunicationPresentation):void {
    const result=value.state==='ready'&&value.value.kind==='result'?value.value:undefined;
    const signature=this.hooks.result&&result?.metadata.references.length?JSON.stringify([result.sender.identity,result.body.complete,result.metadata.references]):'';
    if(signature===this.resultSignature)return;this.resultSignature=signature;this.resultActions.replaceChildren();
    this.resultActions.hidden=!signature;if(!signature||!result)return;
    const multiple=result.metadata.references.length>1;
    if(!result.body.complete)this.resultActions.append(document.createTextNode(`Shortened · ${multiple?'full text: ':''}`));
    else if(multiple)this.resultActions.append(document.createTextNode('Result records: '));
    result.metadata.references.forEach((reference,index)=>{
      if(index)this.resultActions.append(document.createTextNode(' · '));
      const label=`${result.body.complete?'Result record':'Full text of result'} ${index+1}`;
      const action=button(multiple?String(index+1):result.body.complete?'Result record':'full text',()=>{
        const current=this.current()?.communication;
        if(current?.state!=='ready'||current.value.kind!=='result'||current.value.sender.identity!==result.sender.identity)return;
        const selected=current.value.metadata.references[index];if(!selected||selected.submissionId!==reference.submissionId||selected.requestId!==reference.requestId)return;
        this.hooks.result?.(current.value.sender.identity,{submissionId:selected.submissionId,...(selected.requestId?{requestId:selected.requestId}:{})});
      },'communication-result-link');action.setAttribute('aria-label',label);action.title=label;this.resultActions.append(action);
    });
  }
  private senderLabel(sender: Communication['sender']): string {
    const loaded=this.hooks.subject?.(sender.identity);
    if (loaded?.name && loaded.provenance) return loaded.name;
    const supplied=sender.name?.trim();
    if (supplied && supplied!==sender.identity && !conversationIdentityText(supplied)) return supplied;
    if (loaded?.derived) return loaded.text;
    if (loaded?.open && loaded.text && !loaded.text.startsWith('Unnamed')) return loaded.text;
    return loaded?.fallback ?? `Conversation ${sender.identity.slice(0, 8)}`;
  }
  private header(value: CommunicationPresentation, message: MessageView): void {
    this.shell.node.dataset.state = value.state;
    this.shell.node.dataset.reason = value.state === 'unavailable' ? value.reason : '';
    const sender=value.state==='ready'?value.value.sender:undefined;
    const input=unassociatedInput(message); this.shell.node.classList.toggle('user',input);
    const heading=sender?this.senderLabel(sender):input?presentMessage(message,this.hooks.operatorInput).label:'';
    setText(this.headingKind, sender ? communicationKind(value) : ''); setText(this.headingName,heading);
    this.paintMetadata(sender?.identity);
    this.paintStatus(value);
    this.arrangeLine(value, heading);
    if (input) {this.headingKind.hidden = true; this.headingSeparator.hidden = true;}
    this.shell.heading.hidden = !sender && !(input && heading); this.shell.heading.title = sender?.identity ?? '';
    this.unverified.hidden = value.state === 'ready' || input;
    const accessible = heading || (input ? messageAriaLabel(message, this.hooks.operatorInput) : 'Message with unverified source');
    this.shell.node.setAttribute('aria-label', input ? accessible : `${communicationKind(value)} · ${accessible}`);
  }
  private paintStatus(value: CommunicationPresentation): void {
    const unanswered = value.state === 'ready' && value.value.kind === 'result' && value.value.metadata.status === 'unanswered' ? value.value.metadata : undefined;
    this.noAnswer.hidden = !unanswered;
    const reason = unanswered?.reason?.replace(/[_-]+/g, ' ');
    setText(this.noAnswer, unanswered ? `No answer${reason ? `: ${reason}` : ''}` : '');
    this.threadAction.hidden = !(value.state === 'ready' && value.value.kind === 'notice' && this.hooks.thread);
  }
  private paintMetadata(identity?: string): void {
    const summary = identity ? this.hooks.senderSummary?.(identity) : undefined;
    const model = summary?.model;
    const line = [summary?.handle, model ? `${model.provider}/${model.modelId}` : undefined, model?.thinkingLevel ?? summary?.thinkingLevel].filter(Boolean).join(' · ');
    setText(this.metadata, line); this.metadata.hidden = !line;
  }
  private openThread(): void {
    const value = this.current()?.communication;
    if (value?.state === 'ready' && value.value.kind === 'notice') this.hooks.thread?.(value.value.metadata.threadId, value.value.metadata.title);
  }
  private paintHeading(full: boolean): void {
    setText(this.headingSeparator, this.headingKind.textContent && this.headingName.textContent ? ' · ' : '');
    this.headingKind.hidden = !full; this.headingSeparator.hidden = !full || !this.headingName.textContent;
    this.kindLabel.hidden = full; this.preview.hidden = full;
  }
  /** A check-in or thread notice takes one row whose button discloses the full card; other kinds keep the card as is. */
  private arrangeLine(value: CommunicationPresentation, heading: string): void {
    const line = statusLine(value), node = this.shell.node;
    if (!line) {
      if (!this.lineMode) {this.paintHeading(true); return;}
      this.lineMode = false; this.unverified.before(this.shell.heading); this.toggle.remove();
      node.classList.remove('communication-line'); delete node.dataset.open; this.shell.body.hidden = false; this.paintHeading(true); return;
    }
    if (!this.lineMode) {
      this.lineMode = true; this.unverified.before(this.toggle); this.toggle.prepend(this.shell.heading);
      node.classList.add('communication-line');
    }
    setText(this.kindLabel, line.kind); setText(this.preview, line.preview);
    this.toggle.setAttribute('aria-label', [heading, line.kind, line.preview].filter(Boolean).join(', '));
    this.paintLine(this.hooks.expanded(this.lineKey));
  }
  private paintLine(open: boolean): void {
    this.lineOpen = open; this.paintHeading(open); this.toggle.setAttribute('aria-expanded', String(open)); this.shell.node.dataset.open = String(open); this.shell.body.hidden = !open;
  }
  private setLineOpen(open: boolean, notify: boolean): void {
    this.hooks.layout(); this.paintLine(open);
    if (notify) this.hooks.disclosure(this.lineKey, open);
  }
  private content(value: CommunicationPresentation, message: MessageView): void {
    const ready = value.state === 'ready'; const original = ready ? value.value.body.text : this.hooks.raw(message);
    const formatted = ready || unassociatedInput(message);
    this.text.hidden = ready && value.value.kind === 'result' && !original.trim();
    this.shell.node.classList.toggle('communication-input', unassociatedInput(message));
    this.text.classList.toggle('communication-quoted', !formatted);
    if (unassociatedInput(message) && this.hooks.inputContent?.(message, this.text)) {
      this.bodyValue = original; this.bodyFormatted = formatted; this.bodyAttachments = true; this.text.removeAttribute('aria-label'); return;
    }
    if (this.bodyAttachments || original !== this.bodyValue || formatted !== this.bodyFormatted) {
      this.bodyValue = original; this.bodyFormatted = formatted; this.bodyAttachments = false; this.renderText(original, formatted);
    }
  }
  /** A body that is one JSON object reads as labeled fields; the exact text stays in Copy and Source. */
  private fields(original: string): HTMLElement | undefined {
    const text = original.trim();
    if (!this.hooks.structured || text.length > 32768 || !text.startsWith('{') || !text.endsWith('}')) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? this.hooks.structured({value, truncated: false}) : undefined;
    } catch { return undefined; }
  }
  private renderText(original: string, formatted: boolean): void {
    const fields = formatted ? this.fields(original) : undefined;
    this.text.classList.toggle('communication-fields', !!fields);
    if (fields) { this.text.replaceChildren(fields); this.text.removeAttribute('aria-label'); return; }
    if (formatted) { this.text.replaceChildren(...markdownDom(original).childNodes); this.text.removeAttribute('aria-label'); return; }
    setText(this.text, original || 'No retained text');
    this.text.removeAttribute('aria-label');
  }
  current(): MessageView | undefined { return this.hooks.active() && this.source === this.hooks.current() ? this.source : undefined; }
  openSource(opener: HTMLElement): void {
    if (!this.current()) return;
    if (this.lineMode && !this.lineOpen) this.setLineOpen(true, true);
    this.opener = opener; this.setSourceOpen(true, true); this.close.focus({preventScroll: true});
  }
  configureSource(open: boolean): void { this.inspection.hidden = !open; this.inspection.inert = !open; }
  private setSourceOpen(open: boolean, notify: boolean): void {
    this.hooks.layout(); this.configureSource(open);
    if (open) this.renderSource();
    if (notify) this.hooks.disclosure(this.key, open);
    if (!open && this.opener?.isConnected) this.opener.focus({preventScroll: true});
  }
  private renderSource(): void {
    const source = this.source, value = source?.communication; if (!source || !value) return;
    const rows = senderRows(value, source), signature = JSON.stringify(rows);
    if (signature !== this.factsValue) { this.factsValue = signature; renderRows(this.facts, rows); }
    const references = value.state === 'ready' ? communicationReferenceRows(value) : []; const referenceSignature = JSON.stringify(references);
    if (referenceSignature !== this.referencesValue) { this.referencesValue = referenceSignature; renderRows(this.references, references, this.hooks.reference ? text => this.hooks.reference?.(text, node => !!this.current() && !this.inspection.hidden && this.inspection.contains(node)) ?? element('span', undefined, typeof text === 'string' ? text : text.text) : undefined); }
    if (!this.facts.parentNode) this.inspection.append(section('Sender and association', this.facts), section('References', this.references));
    if (this.references.parentElement) this.references.parentElement.hidden = !references.length;
    this.renderOriginal(source);
  }
  private renderOriginal(source: MessageView): void {
    const retained = this.hooks.raw(source), text = bounded(retained, 65536);
    if (this.rawValue !== text && !this.hooks.protected(this.rawPre)) { this.rawValue = text; setText(this.rawFrame, text); }
    if (!this.original) {
      this.originalCopy = cardAction('copy', 'Copy original', () => { const current = this.current(); if (current && !this.inspection.hidden) void copy(this.hooks.raw(current), this.shell.node); }, 'copy');
      const toolbar = element('div', 'tool-source-header communication-original-toolbar'); toolbar.append(this.originalCopy, sourceWrap(this.rawPre));
      const heading = element('div', 'communication-original-heading'); heading.append(element('h4', undefined, 'Original text'), toolbar);
      this.original = element('section', 'communication-source-section'); this.original.append(heading, this.warning, this.rawPre); this.inspection.append(this.original);
    }
    const incomplete = !source.coverage.complete || source.coverage.truncated || source.coverage.omitted > 0;
    if (this.originalCopy) cardActionLabel(this.originalCopy, 'Copy original', incomplete ? 'Copy only available transport text' : 'Copy retained transport text');
    const warnings = [incomplete ? 'Only available transport text is retained.' : '', retained.length > 65536 ? 'Display shortened; Copy original includes all retained text.' : ''];
    this.renderStructured(source, warnings);
    const warning = warnings.filter(Boolean).join(' '); setText(this.warning, warning); this.warning.hidden = !warning;
  }
  private renderStructured(source: MessageView, warnings: string[]): void {
    const value = source.communication, display = value?.state === 'ready' ? value.rawDetails : undefined;
    const structured = display ? rawText(display.value) : '', details = bounded(structured, 8192);
    if (details !== this.detailsValue && !this.hooks.protected(this.detailsPre)) { this.detailsValue = details; setText(this.detailsFrame, details); }
    if (display && !this.structured) {
      this.structured = element('div', 'communication-structured'); const toolbar = element('div', 'tool-source-header communication-original-toolbar'); toolbar.append(sourceWrap(this.detailsPre));
      const heading = element('div', 'communication-original-heading'); heading.append(element('h4', undefined, 'Structured source details'), toolbar);
      this.structured.append(heading, this.detailsPre); this.original?.append(this.structured);
    }
    if (this.structured) this.structured.hidden = !display;
    if (display?.truncated) warnings.push('Structured source details are incomplete.');
    if (display?.omittedBytes) warnings.push(`${display.omittedBytes} structured source bytes omitted.`);
    if (structured.length > 8192) warnings.push('Structured source display shortened.');
  }
  dispose(): void {
    if (this.lineMode) { this.lineMode = false; this.unverified.before(this.shell.heading); this.toggle.remove(); this.shell.node.classList.remove('communication-line'); delete this.shell.node.dataset.open; this.shell.body.hidden = false; }
    this.unverified.remove(); this.inspection.remove(); this.shell.node.classList.remove('communication-card', 'communication-input'); delete this.shell.node.dataset.state; delete this.shell.node.dataset.reason;
    this.shell.header.classList.remove('communication-header'); this.shell.heading.classList.remove('communication-sender'); this.shell.body.classList.remove('communication-body');
    this.shell.node.setAttribute('aria-label', messageAriaLabel(this.hooks.current(), this.hooks.operatorInput)); this.shell.heading.title = ''; this.shell.heading.hidden = false;
    this.shell.body.replaceChildren(); this.source = undefined;
  }
}
