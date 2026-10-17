import type { Communication, CommunicationPresentation, MessageView } from '../shared/api.ts';
import type {ResultSelector} from '../shared/inspection.ts';
import { button, copy, element, rawText, setText } from './dom.ts';
import { cardAction, cardActionLabel } from './card-icons.ts';
import { markdownDom, sourceWrap } from './safe-markdown.ts';
import { isValidTimestamp, previewText } from './format.ts';
import { presentMessage } from './entry-presentation.ts';
import type { QualifiedReference, ReferenceField, ReferenceQuery } from './references.ts';
import type {NamedDestination} from './tool-sentences.ts';
import {conversationIdentityText} from './tabs.ts';

type Shell = {node: HTMLElement; header: HTMLElement; heading: HTMLElement; actions: HTMLElement; body: HTMLElement};
type Hooks = {inputContent?: (message:MessageView, root:HTMLElement)=>boolean; reply?: (message:MessageView)=>{text:string;open():void}|undefined; subject?: (identity:string)=>NamedDestination|undefined; result?: (identity:string,selector:ResultSelector)=>void; reference?: (query: ReferenceQuery, active: (node: HTMLElement) => boolean) => HTMLElement; active(): boolean; current(): MessageView; protected(node: HTMLElement): boolean; raw(message: MessageView): string; expanded(key: string): boolean; disclosure(key: string, open: boolean): void; layout(): void};
type Ready = Extract<CommunicationPresentation, {state: 'ready'}>;
type Row = [string, string, QualifiedReference?];
function qualified(label: string, text: string, owner: string, field: ReferenceField): Row { return [label, text, {text, owner, field}]; }
function bounded(value: string, chars: number): string {
  const shown = previewText(value, Number.MAX_SAFE_INTEGER, value.length > chars ? chars - 1 : chars); return shown.text + (shown.truncated ? '…' : '');
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
  private readonly text = element('div', 'communication-text');
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
  constructor(shell: Shell, hooks: Hooks, keys: readonly [string]) {
    this.shell = shell; this.hooks = hooks; this.key = keys[0];
    shell.node.classList.add('communication-card'); for (const name of ['user', 'tool-only', 'thinking-only']) shell.node.classList.remove(name);
    shell.header.classList.add('communication-header'); shell.heading.classList.add('communication-sender'); shell.body.classList.add('communication-body');
    this.unverified = cardAction('unknown', 'Source unverified', () => this.openSource(this.unverified), 'communication-unverified');
    this.unverified.setAttribute('aria-label', 'Source unverified'); this.unverified.title = 'Source unverified';
    this.unverified.querySelector('.card-action-label')?.classList.remove('sr-only'); shell.heading.after(this.unverified);
    this.close = cardAction('close', 'Close Source', () => { if (hooks.active()) this.setSourceOpen(false, true); }, 'message-source-close');
    this.close.setAttribute('aria-label', 'Close Source');
    const heading = element('div', 'message-source-header'); heading.append(element('h4', 'message-source-heading', 'Source'), this.close);
    this.inspection.append(heading); this.inspection.dataset.disclosure = this.key;
    this.inspection.setAttribute('role', 'region'); this.inspection.setAttribute('aria-label', 'Source');
    this.rawPre.append(this.rawFrame); this.detailsPre.append(this.detailsFrame);
    this.configureSource(hooks.expanded(this.key)); shell.body.replaceChildren(this.reply, this.text, this.resultActions, this.inspection);
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
    if(value&&message&&!this.hooks.protected(this.shell.heading))this.header(value,message);
  }
  private results(value:CommunicationPresentation):void {
    const result=value.state==='ready'&&value.value.kind==='result'?value.value:undefined;
    const signature=this.hooks.result&&result?JSON.stringify([result.sender.identity,result.metadata.references]):'';
    if(signature===this.resultSignature)return;this.resultSignature=signature;this.resultActions.replaceChildren();
    this.resultActions.hidden=!signature;if(!signature||!result)return;
    result.metadata.references.forEach((reference,index)=>{
      const action=cardAction('search',`${result.body.complete?'Open answer':'Show full answer'}${result.metadata.references.length>1?` ${index+1}`:''}`,()=>{
        const current=this.current()?.communication;
        if(current?.state!=='ready'||current.value.kind!=='result'||current.value.sender.identity!==result.sender.identity)return;
        const selected=current.value.metadata.references[index];if(!selected||selected.submissionId!==reference.submissionId||selected.requestId!==reference.requestId)return;
        this.hooks.result?.(current.value.sender.identity,{submissionId:selected.submissionId,...(selected.requestId?{requestId:selected.requestId}:{})});
      });action.querySelector('.card-action-label')?.classList.remove('sr-only');this.resultActions.append(action);
    });
  }
  private senderLabel(sender: Communication['sender']): string {
    const loaded=this.hooks.subject?.(sender.identity);
    if (loaded?.name && loaded.provenance) return loaded.name;
    const supplied=sender.name?.trim();
    return supplied && supplied!==sender.identity && !conversationIdentityText(supplied) ? supplied : sender.identity;
  }
  private header(value: CommunicationPresentation, message: MessageView): void {
    this.shell.node.dataset.state = value.state;
    this.shell.node.dataset.reason = value.state === 'unavailable' ? value.reason : '';
    const sender=value.state==='ready'?value.value.sender:undefined;
    const input=unassociatedInput(message); this.shell.node.classList.toggle('user',input);
    const heading=sender?this.senderLabel(sender):input?presentMessage(message).label:'';
    setText(this.shell.heading,heading);
    this.shell.heading.hidden = !sender && !input; this.shell.heading.title = sender?.identity ?? '';
    this.unverified.hidden = value.state === 'ready' || input;
    this.shell.node.setAttribute('aria-label', heading || 'Message with unverified source');
  }
  private content(value: CommunicationPresentation, message: MessageView): void {
    const ready = value.state === 'ready'; const original = ready ? value.value.body.text : this.hooks.raw(message);
    const formatted = ready || unassociatedInput(message);
    this.text.classList.toggle('communication-quoted', !formatted);
    if (unassociatedInput(message) && this.hooks.inputContent?.(message, this.text)) {
      this.bodyValue = original; this.bodyFormatted = formatted; this.bodyAttachments = true; this.text.removeAttribute('aria-label'); return;
    }
    if (this.bodyAttachments || original !== this.bodyValue || formatted !== this.bodyFormatted) {
      this.bodyValue = original; this.bodyFormatted = formatted; this.bodyAttachments = false; this.renderText(original, formatted);
    }
  }
  private renderText(original: string, formatted: boolean): void {
    if (formatted) { this.text.replaceChildren(...markdownDom(original).childNodes); this.text.removeAttribute('aria-label'); return; }
    setText(this.text, original || 'No retained text');
    this.text.removeAttribute('aria-label');
  }
  current(): MessageView | undefined { return this.hooks.active() && this.source === this.hooks.current() ? this.source : undefined; }
  openSource(opener: HTMLElement): void {
    if (!this.current()) return;
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
    this.unverified.remove(); this.inspection.remove(); this.shell.node.classList.remove('communication-card'); delete this.shell.node.dataset.state; delete this.shell.node.dataset.reason;
    this.shell.header.classList.remove('communication-header'); this.shell.heading.classList.remove('communication-sender'); this.shell.body.classList.remove('communication-body');
    this.shell.node.setAttribute('aria-label', `${presentMessage(this.hooks.current()).label} message`); this.shell.heading.title = ''; this.shell.heading.hidden = false;
    this.shell.body.replaceChildren(); this.source = undefined;
  }
}
