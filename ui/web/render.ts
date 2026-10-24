import type { EntryView, ImageView, JsonDisplay, MessageView, PartView, PresentationView, ReadingView, ThinkingChoice, TranscriptView, CommunicationSender } from '../shared/api.ts';
import { EntryFocus } from './entry-focus.ts';
import type {ResultInspection, ResultSelector} from '../shared/inspection.ts';
import { announce, button, copy, details, element, rawText, setText } from './dom.ts';
import { ArrivalCounter, latestLabel } from './arrivals.ts';
import { cardAction, cardActionLabel, cardDisclosure, cardIcon, type CardIcon } from './card-icons.ts';
import { contextMenu, nativeEditingTarget, type ContextItem } from './context-menu.ts';
import { markdownDom, sourceHeader, sourceWrap } from './safe-markdown.ts';
import { highlight, languageFromPath } from './highlight.ts';
import { numberedRead, readLineStart, readSourcePart } from './read-lines.ts';
import { transcriptImage } from './image.ts';
import { pairedTimestamp, thinkingKey, type ThinkingTime, type ToolState } from './state.ts';
import { clockTime, formatDate, isValidTimestamp, previewText, timestampDetails } from './format.ts';
import { entryVisible, initialSettings, inputDelivery, messageAriaLabel, presentEntry, presentMessage, sessionEventsSummary, taskSenderHeading } from './entry-presentation.ts';
import { cardPreviewLimits, readRange, presentResultPreview, presentToolPreview, resultPreview } from './cards.ts';
import { thinkingExpanded } from './transcript-presentation.ts';
import { TranscriptIndex, ToolElapsedClock, toolTime, thinkingLabel, thinkingPreview, slot, communicationDisclosureKeys } from './transcript-tools.ts';
import { CommunicationCard, messageCopyText, messageCopyDescription, type SenderSummary } from './communication.ts';
import {NoticeBlocks, type NoticeChild} from './notice-blocks.ts';
import {ResponseFailure} from './response-failure.ts';
import type { TranscriptGroups } from './transcript-groups.ts';
import {TranscriptRows, type StepRun, type TranscriptRow} from './transcript-rows.ts';
import {toolSentence,toolLabelParts,quietTextResult, type NamedDestination, type ToolLabelPart} from './tool-sentences.ts';
import {ConversationTasks, type ConversationTask, type TaskReference} from './conversation-tasks.ts';
import { loadedReference, type FileReferenceDestination, type ReferenceQuery, type ReferenceResolver } from './references.ts';
import type { JoinedTool } from './transcript-tools.ts';
import { outputPages } from './transcript-output.ts';
import { awaitedAnswers, awaitedFieldsFromParts, awaitedFromParts, awaitedToolState, stillWaitingSentence } from './awaited-answers.ts';
import { appendKey, presentArguments, presentAwaited, presentResult, previewLimits, PreviewBudget } from './generic-content.ts';
import type { PreviewActions } from './generic-content.ts';
import type { SessionGroup } from './transcript-tools.ts';
import {attachmentParts} from './attachment-parts.ts';
import {selectionWithin, type PrimaryDraftSource, type TranscriptDraftActions} from './primary-draft-actions.ts';
import type { OutputContinuation, OutputPage } from '../shared/api.ts';
import { captureAnchor, layoutItems, restoreAnchor, visibleWindow, updateHeights } from './virtual.ts';
import type { LayoutItem, VirtualLayout } from './virtual.ts';

export type TranscriptElements = {transcript: HTMLElement; latest: HTMLElement; earlier?: HTMLElement};
export type ToolSubjectCaption = NamedDestination;
/** A thinking summary is its label, then the first line of the thinking text; the line hides while the block is open. */
function thinkingSpans(summary: Element): {label: HTMLElement; preview: HTMLElement} {
  const label = summary.querySelector<HTMLElement>('.thinking-label'), preview = summary.querySelector<HTMLElement>('.thinking-preview');
  if (label && preview) return {label, preview};
  const made = {label: element('span', 'thinking-label', 'Thinking'), preview: element('span', 'thinking-preview')};
  summary.replaceChildren(made.label, made.preview); return made;
}
const previewSuffix = (line: string): string => line ? ` · ${line}` : '';
export type ViewHooks = {openFile?:(destination:FileReferenceDestination)=>void;unread?: () => void; primaryDraft?:TranscriptDraftActions;owner?:string;sourceOrder?:boolean;senderCaption?: (sender:CommunicationSender)=>string; senderSummary?: (identity:string)=>SenderSummary|undefined; thread?: (id:string,title?:string)=>void; earlier?: () => void; operatorInput?: boolean; readTaskResult?: (reference:TaskReference,signal:AbortSignal)=>Promise<ResultInspection>;stopTask?: (reference:TaskReference)=>Promise<void>;tasksChanged?: () => void; activity?: (text:string)=>void; cwd?: () => string | undefined; subject?: (value: string) => ToolSubjectCaption | undefined; result?: (identity:string,selector:ResultSelector)=>void; references?: ReferenceResolver; presentation: (expanded: string[], showThinking: boolean, transcriptView?: TranscriptView, thinking?: ThinkingChoice) => void; reading: (anchor: ReadingView) => void; fork?: (message: MessageView, entryId: string) => void; output?: (more: OutputContinuation) => Promise<OutputPage>; image?: (part: ImageView) => string | undefined; preview?: (part: ImageView, url: string, invoker: HTMLElement) => () => void; timing?: (metric: 'render' | 'stream-to-render', start: number, end: number) => void};
const RAW_LIMIT = 65536;
/** Scrolling up within this many pixels of the first loaded row reads the next older page. */
const EARLIER_ZONE_PX = 240;
/** After an older page lands, the anchor is held in place this long while rows around it settle. */
const ANCHOR_HOLD_MS = 500;
/** A viewport resize can return the scroller toward its pre-resize content position without a gesture; within this window that move is not reading intent. */
const RESIZE_RETURN_MS = 500;
/** The resize return lands within this distance of the pre-resize position of the same content, adjusted for later growth. */
const RESIZE_RETURN_PX = 2;
/** A scroll this soon after a wheel, touch, key or pointer event on the scroller belongs to that gesture, never to a resize return. */
const GESTURE_MARK_MS = 100;
const TASK_READ_CONCURRENCY = 4;
/** The newest unanswered requests are read even off screen, so Stop knows about work that the conversation still waits for. */
const RECENT_TASK_READS = 3;
const toolStateLabels:Record<JoinedTool['status'],string>={success:'',preparing:'Preparing call',working:'Working',pending:'Queued',error:'Failed',ended:'Ended without result',available:'Result available',missing:'No result recorded'};
const toolStateIcons: Record<string, CardIcon> = {preparing: 'working', working: 'working', pending: 'history', error: 'error', ended: 'unknown', available: 'info', missing: 'unknown'};
function selectionCopy(origin: HTMLElement): ContextItem[] {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !origin.contains(selection.anchorNode) || !origin.contains(selection.focusNode)) return [];
  const selectedText = selection.toString();
  return [{label: 'Copy selection', run: () => { void copy(selectedText, origin); }}];
}
function menuText(tool?: ToolNode, message?: MessageNode, entry?: EntryNode): string {
  if (tool?.source) return partText(tool.source.result ?? []);
  if (message?.source) return messageCopyText(message.source, source => partText(source.parts));
  return rawText(entry?.source?.data?.value ?? entry?.source);
}
function partText(parts: PartView[]): string {
  return parts.map(part => {
    if (part.type === 'text' || part.type === 'thinking') return part.redacted ? 'Thinking not available' : part.text;
    if (part.type === 'omitted') return part.label;
    if (part.type === 'image') return part.alt;
    return part.type === 'toolResult' ? partText(part.parts) : '';
  }).join('\n');
}
function hasSavedText(parts: readonly PartView[]): boolean {
  return parts.some(part => part.type === 'toolResult' ? hasSavedText(part.parts) : (part.type === 'text' || part.type === 'thinking') && !part.redacted && !!part.text);
}
function hasStructuredResult(parts: readonly PartView[]): boolean {
  return parts.some(part => part.type === 'text' ? !!part.structured : part.type === 'toolResult' && hasStructuredResult(part.parts));
}
function imageParts(parts: readonly PartView[], images: ImageView[] = []): ImageView[] {
  for (const part of parts) {
    if (part.type === 'image') images.push(part);
    else if (part.type === 'toolResult') imageParts(part.parts, images);
  }
  return images;
}
function bounded(text: string, limit = RAW_LIMIT, lines = Number.MAX_SAFE_INTEGER): string {
  const value = previewText(text, lines, limit);
  return value.text;
}
/** The error line of the person's own message states its own failure; the generic phrases belong to agent replies. An unconfirmed copy is an unknown state, so its line uses the warning tone. */
function errorPresentation(message: MessageView): {summary: string; diagnostic?: string; warning: boolean} {
  if (message.role === 'user') return {summary: message.error ?? '', warning: message.error === 'Delivery not confirmed'};
  const warning = message.stopReason === 'aborted';
  if (message.error) return {summary: warning ? 'The response stopped.' : 'The response failed.', diagnostic: message.error, warning};
  if (message.stopReason === 'error') return {summary: 'The response failed.', warning: false};
  if (warning) return {summary: 'The response stopped.', warning: true};
  return {summary: '', warning: false};
}
function failedResponse(message:MessageView,shown=errorPresentation(message)):boolean {
  return message.role==='assistant'&&!!shown.summary&&!shown.warning;
}
function record(display?: JsonDisplay): Record<string, unknown> {
  const value = display?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function subject(source: JoinedTool, limit = 4096, lines = 1): string {
  const args = record(source.args);
  if (source.name === 'bash' && typeof args.command === 'string') return `$ ${bounded(args.command, limit, lines)}`;
  const path = args.file_path ?? args.path;
  if (source.name === 'read' && typeof path === 'string') return bounded(path, limit, lines);
  for (const key of ['path', 'file_path', 'command', 'sessionId', 'target', 'name', 'code']) {
    if (typeof args[key] === 'string') return bounded(args[key], limit, lines);
  }
  return '';
}
function metadata(source: JoinedTool): string {
  const args = record(source.args); const facts: string[] = source.argumentsError ? [`Invalid arguments: ${source.argumentsError}`] : [];
  const range = source.name === 'read' ? readRange(args) : '';
  if (source.name === 'bash' && typeof args.timeout === 'number' && Number.isFinite(args.timeout) && args.timeout >= 0) facts.push(`(timeout ${args.timeout}s)`);
  for (const key of range ? ['cwd'] : ['cwd', 'offset', 'limit']) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number') facts.push(`${key} ${bounded(String(value), 4096)}`);
  }
  return facts.join(' · ');
}
function truncationFacts(cut: NonNullable<NonNullable<JoinedTool['output']>['truncation']>): string[] {
  const facts = ['Some output was not retained.'];
  if (cut.truncatedBy) facts.push(`${cut.truncatedBy === 'lines' ? 'line' : 'byte'} limit`);
  if (cut.outputLines !== undefined && cut.totalLines !== undefined) facts.push(`${cut.outputLines}/${cut.totalLines} lines`);
  if (cut.outputBytes !== undefined && cut.totalBytes !== undefined) facts.push(`${cut.outputBytes}/${cut.totalBytes} bytes`);
  if (cut.firstLineExceedsLimit) facts.push('first line exceeds byte limit');
  if (cut.lastLinePartial) facts.push('partial tail line');
  return facts;
}
function outputSummary(source: JoinedTool): string {
  const info = source.output; if (!info) return '';
  const facts = info.truncation ? truncationFacts(info.truncation) : [];
  if (info.fullOutputPath) facts.push('full output reference supplied');
  return facts.join(' · ');
}
function outputExplanation(source: JoinedTool): string {
  if (!source.output) return '';
  const cut = source.output.truncation; const limits = [cut?.maxLines === undefined ? '' : `${cut.maxLines} lines`, cut?.maxBytes === undefined ? '' : `${cut.maxBytes} bytes`].filter(Boolean);
  return [outputSummary(source), limits.length ? `Applied limits: ${limits.join(', ')}.` : '',
    source.output.fullOutputPath ? `Full output reference (text only): ${source.output.fullOutputPath}` : 'Full output reference not supplied.'].filter(Boolean).join('\n');
}
function preTextFrame(pre: HTMLElement): HTMLElement {
  const retained = [...pre.children].find(child => child.classList.contains('pre-text-frame')) as HTMLElement | undefined;
  if (retained) return retained;
  const frame = element('span', 'pre-text-frame');
  frame.append(...pre.childNodes); pre.append(frame); return frame;
}
function inspection(title: string, source: () => string): HTMLDetailsElement {
  const node = element('details'); const pre = element('pre'); const text = preTextFrame(pre);
  node.append(element('summary', undefined, title));
  node.addEventListener('toggle', () => {
    if (!node.open) return;
    setText(text, bounded(source()));
    if (!pre.parentNode) node.append(pre);
  });
  return node;
}
export function structured(display: JsonDisplay): HTMLElement {
  const node = element('div', 'structured'); const value = display.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) node.append(structuredObject(value as Record<string, unknown>));
  else node.append(element('pre', undefined, bounded(rawText(value), 8192)));
  node.append(inspection('Structured data', () => rawText(value)));
  if (display.truncated) node.append(element('p', 'warning', `Some output was not retained.${display.omittedBytes !== undefined ? ` · ${display.omittedBytes} bytes` : ''}`));
  return node;
}
function structuredObject(value: Record<string, unknown>): HTMLElement {
  const node = element('div'); const grid = element('dl', 'kv'); node.append(grid);
  let bytes = 0; let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (++count > 64 || bytes >= 8192) { node.append(element('p', 'secondary', 'Initial structured preview limited.')); break; }
    const label = bounded(key, 512);
    if (item !== null && typeof item === 'object') node.append(inspection(label, () => rawText(item)));
    else {
      const text = bounded(rawText(item), Math.max(0, 8192 - bytes)); bytes += text.length + label.length;
      const term = element('dt'); appendKey(term, label);
      grid.append(term, element('dd', undefined, text));
    }
  }
  return node;
}
export function reconcileChildren(parent: HTMLElement, wanted: HTMLElement[]): void {
  const keep = new Set(wanted);
  for (const child of [...parent.children]) if (!keep.has(child as HTMLElement)) child.remove();
  let previous: HTMLElement | undefined;
  for (const child of wanted) {
    const next = previous ? previous.nextSibling : parent.firstChild;
    if (next !== child) { if (previous) previous.after(child); else parent.prepend(child); }
    previous = child;
  }
}
function setEntryRhythm(node: HTMLElement, children: readonly HTMLElement[], session: boolean): void {
  const compact = session || children.length > 0 && children.every(child => ['tool-only', 'thinking-only', 'transcript-event'].some(name => child.classList.contains(name)));
  if (compact) node.classList.add('compact-entry'); else node.classList.remove('compact-entry');
}
type PartNode = {node: HTMLElement; source: PartView; partial: boolean};
type OperatorFold = {content: HTMLElement; viewport: HTMLElement; toggle: HTMLButtonElement; key: string; source?: MessageView; width?: number; lines?: number};
type MessageNode = {inputFold?: OperatorFold; inputTime?: HTMLElement; communication?: CommunicationCard; node: HTMLElement; header: HTMLElement; heading: HTMLElement; delivery: HTMLElement; actions: HTMLElement; body: HTMLElement; error: HTMLElement; failure?:ResponseFailure; parts: Map<string, PartNode>; source: MessageView; menu: HTMLButtonElement; forkRevision: number; inspection?: HTMLElement; inspectionSource?: MessageView; sourceOpener?: HTMLElement; thinkingGroups?: Map<string, {node: HTMLDetailsElement; body: HTMLElement}>};
type EventPage = {node: HTMLElement; rows: HTMLElement; page: number; previous: HTMLButtonElement; next: HTMLButtonElement; cache: Map<string, {source: EntryView; node: HTMLElement}>};
type SessionNode = {source?: SessionGroup; details: HTMLDetailsElement; events: EventPage; notices: EventPage};
type TurnMessage = {entry: EntryView; message: MessageView};
type AssistantTurn = {key: string; input?: TurnMessage; copy?: TurnMessage; assistant: boolean; end?: string};
type TurnSource = {turn:AssistantTurn;generation:number;node?:HTMLElement};
type MessageMenuActions = {items:ContextItem[];ask?:ContextItem;valid:()=>boolean};
type TurnActions = TurnSource & {node: HTMLElement; copy: HTMLButtonElement; fork: HTMLButtonElement; ask:HTMLButtonElement; more:HTMLButtonElement; askAction?:{item:ContextItem;valid:()=>boolean}};
type FailedStep = {entryId:string;rowId:string;callId?:string};
type ReceivedResult = {entryId:string;messageId:string;rowId:string;entryAt:number;messageAt:number};
type EntryNode = {node: HTMLElement; messages: Map<string, MessageNode>; dayDivider?: HTMLTimeElement; turnActions?: TurnActions; source?: EntryView; custom?: HTMLElement; session?: SessionNode; groupHeader?: HTMLElement};
type ToolPathCopy = {path:string;run:()=>void};
type ToolFileOpen = {source:JoinedTool;generation:number;path:string;destination:FileReferenceDestination;run:(control:HTMLElement)=>void};
type ToolNode = {fileOpen?:ToolFileOpen;filePath?:string;filePathSource?:JoinedTool;pathCopySource?: JoinedTool; previewMore?: HTMLButtonElement; previewSource?: JoinedTool; previewSubjectRevision?: number; answerText?: string; subject?: ToolSubjectCaption; card: HTMLElement; node: HTMLDetailsElement; copy: HTMLButtonElement; title: HTMLElement; target: HTMLElement; glyph: HTMLElement; stateWord: HTMLElement; meta: HTMLElement; preview: HTMLElement; qualification: HTMLElement; expanded: HTMLElement; resultArea: HTMLElement; technical: HTMLDetailsElement; actions: HTMLElement; info: HTMLElement; source?: JoinedTool; inspectionSources?: Map<HTMLDetailsElement, JoinedTool>; presentation?: HTMLElement; argumentsDocument?: HTMLElement; argumentsSource?: JoinedTool; output?: HTMLElement; contentSource?: JoinedTool; viewport?: HTMLElement; pageViewports?: Set<HTMLElement>; resultDocument?: HTMLElement; documentSource?: JoinedTool; previewBudget?: PreviewBudget; outputNotice?: {node: HTMLElement; source: JoinedTool}; inspections?: {arguments: HTMLDetailsElement; output: HTMLDetailsElement; details: HTMLDetailsElement}};
export type TranscriptGeometry = {generation: number; followTail: boolean; anchor: {id: string; offsetPx: number} | null; scrollTop: number};
export type FindStatus = {total: number; position: number; moved: boolean; end: 'none' | 'first' | 'last' | 'unavailable' | null};
export type FindSession = {next: (query: string) => FindStatus; previous: (query: string) => FindStatus; reset: () => void; close: () => void};
export class Transcript {
  private entries: EntryView[] = [];
  private displayed: EntryView[] = [];
  private chronological: EntryView[] = [];
  /** Keeps repeated jumps in source order when the bottom boundary prevents top alignment. */
  private ownMessageCursor?:{id:string;anchorId:string|null;offsetPx:number};
  private ownMessageMarker?:{node:HTMLElement;timer:ReturnType<typeof setTimeout>};
  private failedStepCursor?:{id:string;anchorId:string|null;offsetPx:number};
  private receivedResultCursor?:{entryId:string;messageId:string;anchorId:string|null;offsetPx:number};
  private rows = new TranscriptRows();
  private noticeBlocks:NoticeBlocks;
  private tasks = new ConversationTasks();
  private turnRows = new Map<string,AssistantTurn>();
  private taskReads=new Map<string,AbortController>();
  private taskReadStamps=new Map<string,string>();
  private get groups(): TranscriptGroups { return this.index.groups; }
  private view: TranscriptView = 'chronological';
  private pendingView?: TranscriptView;
  private cache = new Map<string, EntryNode>();
  private tools = new Map<string, ToolNode>();
  private subjectRevision = 0;
  private referenceNamesPending = false;
  private thinkingTimes: ReadonlyMap<string, ThinkingTime> = new Map();
  private liveThinking = new Map<string, HTMLElement>();
  private elapsed = new ToolElapsedClock(() => this.paintElapsed());
  private index = new TranscriptIndex();
  private joined = this.index.joined;
  private visible = new Map<string, boolean>();
  private initialSettings = new Set<string>();
  private historyBeginning = true;
  private toolStates: ReadonlyMap<string, ToolState> = new Map();
  private indexedFindId?: string;
  private visibilityPredicate = (entry: EntryView) => this.visibleEntry(entry);
  private dirtyLayout = true;
  private generation = 0;
  private expanded = new Set<string>();
  private showThinking = false;
  /** The reader's saved Show thinking or Hide thinking choice, sent with every save so a coalesced save cannot drop it. */
  private thinkingChoice?: ThinkingChoice;
  /** Thinking that streamed in this view stays open here after it finishes; it is never saved, so a reload closes it like the rest. */
  private streamedThinking = new Set<string>();
  private follow = true;
  private readingRevision = 0;
  private pending = false;
  private renderFrame?: number;
  private renderTask?: ReturnType<typeof setTimeout>;
  private inputFrame?: number;
  private streamPending = false;
  private scheduledAt?: number;
  private receivedAt?: number;
  private deferred?: () => void;
  private pins = new Set<string>();
  private findRevision = 0;
  private findId?: string;
  private findNode?: HTMLElement;
  private heights = new Map<string, number>();
  private gaps = new Map<string, HTMLElement>();
  private timeGaps = new Map<string,number>();
  private layout: VirtualLayout = layoutItems([], new Map(), 140);
  private restoring?: ReadingView;
  private resize?: ResizeObserver;
  private geometryTimer?: ReturnType<typeof setTimeout>;
  private geometryDirty = new Set<HTMLElement>();
  private outputNodes = new Set<HTMLElement>();
  private outputListeners = new WeakSet<HTMLElement>();
  private disclosureListeners = new WeakSet<HTMLElement>();
  private scrolling = new WeakSet<HTMLElement>();
  private sizes = new WeakMap<Element, string>();
  private reflowAnchor?: {id: string; offsetPx: number} | null;
  private writtenScrollTop?: number;
  readonly node: HTMLElement;
  private readonly latest: HTMLElement;
  private hooks: ViewHooks;
  private destroyed = false;
  private closePreview?: () => void;
  private listenerAbort = new AbortController();
  private listenerCleanup: (() => void)[] = [];
  private frames = new Set<number>();
  private observers: MutationObserver[] = [];
  /** The earlier-history control is the first line inside the scroller, above the virtual window. */
  private lead?: HTMLElement;
  private earlierAvailable = false;
  private hold?: {anchor: {id: string; offsetPx: number}; until: number; queued: boolean};
  private lastScrollTop = 0;
  private resizeReturn?: {at: number; scrollTop: number; scrollHeight: number};
  private gestureAt = 0;
  private readingDirty = false;
  private readonly arrivals = new ArrivalCounter();
  private unreadCount = 0;
  private activitySignature: string | undefined;
  private activityAt: number | undefined;
  /** When this page last saw the conversation change; unknown until a change is seen after the first load. */
  get lastActivityAt(): number | undefined { return this.activityAt; }
  /** Messages that arrived while this transcript was not shown; cleared when it is shown again. */
  get unread(): number { return this.unreadCount; }
  constructor(elements: TranscriptElements, hooks: ViewHooks) {
    this.hooks = {...hooks, presentation: (expanded, showThinking) => hooks.presentation(expanded, showThinking, this.view, this.thinkingChoice)};
    this.node = elements.transcript; this.latest = elements.latest;
    this.noticeBlocks=new NoticeBlocks({owner:hooks.owner,toggle:id=>this.toggleReceived(id),retained:id=>{const node=this.cache.get(id)?.node;return !!node&&!node.classList.contains('received-notice-summary')&&this.protectedNode(node);},subject:hooks.subject,senderCaption:hooks.senderCaption,thread:hooks.thread,source:id=>this.cache.get(id)?.messages.values().next().value?.communication,
      protected:id=>{const node=this.cache.get(id)?.node;return this.hasSelection() || !!node&&this.protectedNode(node);},reconcile:reconcileChildren});
    this.node.dataset.view = this.view;
    const visibilityChange = () => {
      if (this.destroyed) return;
      if (this.hidden() || document.hidden) this.clearTiming();
      this.elapsed.sync();
    };
    this.listen(document, 'visibilitychange', visibilityChange);
    this.listen(document, 'beforeinput', event => {
      if (!nativeEditingTarget(event.target) || this.hidden() || document.hidden) return;
      const pending = this.pending; this.cancelRender(); this.pending = pending;
      if (this.inputFrame !== undefined) return;
      // A posted task after this frame leaves every editor RAF callback ahead of stream work.
      this.inputFrame = this.frame(() => {
        this.inputFrame = undefined;
        if (!this.pending) return;
        this.pending = false; this.schedule();
      });
    }, {capture: true});
    if (typeof MutationObserver === 'function') {
      const visibility = new MutationObserver(visibilityChange);
      const pane = this.node.closest('.conversation');
      if (pane) visibility.observe(pane, {attributes: true, attributeFilter: ['hidden', 'inert']});
      this.observers.push(visibility);
    }
    if (typeof MutationObserver === 'function' && typeof HTMLElement === 'function') {
      const focus = new EntryFocus(this.node);
      this.listenerCleanup.push(() => focus.destroy());
    }
    this.listen(this.node, 'contextmenu', event => this.itemMenu(event as MouseEvent));
    this.listen(this.node, 'source-wrap', () => {
      const anchor = this.follow ? null : this.anchor();
      this.restoring = undefined; this.reflowAnchor = anchor;
      this.frame(() => { if (!this.hidden()) { this.paint(anchor); this.saveReading(); } });
    });
    this.lead = elements.earlier;
    this.listen(this.node, 'scroll', () => {
      if (this.hidden()) return;
      if (this.node.scrollTop === this.writtenScrollTop) {this.writtenScrollTop = undefined; this.lastScrollTop = this.node.scrollTop; return;}
      this.writtenScrollTop = undefined;
      this.scrolling.add(this.node); this.reflowAnchor = undefined; this.restoring = undefined;
      const upward = this.node.scrollTop < this.lastScrollTop, maximum = Math.max(0, this.node.scrollHeight - this.node.clientHeight);
      const clampedTail = this.follow && upward && this.lastScrollTop > maximum && Math.abs(this.node.scrollTop - maximum) <= 1;
      const returned = this.resizeReturn, position = this.node.scrollTop, now = performance.now();
      const resizeReturn = this.follow && upward && !this.hasSelection() && returned !== undefined && now - returned.at <= RESIZE_RETURN_MS && now - this.gestureAt > GESTURE_MARK_MS
        && Math.abs(position - (returned.scrollTop + this.node.scrollHeight - returned.scrollHeight)) <= RESIZE_RETURN_PX;
      if (resizeReturn) {
        // The resize return is not a scroll gesture: keep the tail intent and let the next paint restore the tail.
        this.follow = true; this.scrolling.delete(this.node);
      } else {
        this.follow = (!upward || clampedTail) && maximum - position < 48 && !this.hasSelection();
      }
      this.syncLatest();
      this.readEarlier(upward && !clampedTail && !resizeReturn);
      this.lastScrollTop = this.node.scrollTop;
      this.readingDirty = true; this.schedule();
    }, {passive: true});
    const gesture = () => { this.gestureAt = performance.now(); };
    this.listen(this.node, 'wheel', event => { gesture(); this.readEarlier((event as WheelEvent).deltaY < 0); }, {passive: true});
    this.listen(this.node, 'touchstart', gesture, {passive: true});
    this.listen(this.node, 'touchmove', gesture, {passive: true});
    this.listen(this.node, 'pointerdown', gesture, {passive: true});
    this.listen(this.node, 'keydown', gesture);
    this.listen(this.node, 'scrollend', event => {
      if (event.target !== this.node) return;
      this.writtenScrollTop = undefined; this.scrolling.delete(this.node); this.readingDirty = false; this.queueGeometry(); this.schedule(); this.saveReading();
    });
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(entries => {
        if (this.destroyed) return;
        for (const entry of entries) this.resizeGeometry(entry);
        if (this.geometryDirty.size) this.queueGeometry();
      });
      this.resize.observe(this.node);
    }
    this.listen(this.latest, 'click', () => { this.scrolling.delete(this.node); this.readingDirty = false; this.follow = true; this.pins.clear(); this.paint(); this.queueGeometry(); this.saveReading(); });
    this.listen(document, 'selectionchange', () => {
      if (!this.hidden() && this.hasSelection()) { this.follow = false; this.schedule(); }
      else { this.queueGeometry(); if (!this.hidden()) this.schedule(); }
    });
    this.listen(this.node, 'focusout', () => { this.queueGeometry(); this.schedule(); });
    const fontChange = () => { if (this.destroyed) return; this.geometryDirty.add(this.node); this.queueGeometry(); };
    if (document.fonts) { this.listen(document.fonts, 'loading', fontChange); this.listen(document.fonts, 'loadingdone', fontChange); }
    if (typeof matchMedia === 'function') {
      this.listen(matchMedia('(forced-colors: active)'), 'change', fontChange);
      this.listen(matchMedia('(prefers-color-scheme: dark)'), 'change', fontChange);
    }
    if (typeof MutationObserver === 'function') {
      const appearance = new MutationObserver(fontChange);
      appearance.observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'style', 'data-appearance']});
      this.observers.push(appearance);
    }
  }
  private listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): void {
    const listener: EventListener = event => { if (!this.destroyed) handler(event); };
    target.addEventListener(type, listener, {...options, signal: this.listenerAbort.signal});
    this.listenerCleanup.push(() => target.removeEventListener(type, listener, options?.capture));
  }
  private frame(callback: () => void): number {
    const id = requestAnimationFrame(() => { if (this.frames.delete(id) && !this.destroyed) callback(); });
    this.frames.add(id); return id;
  }
  private cancelRender(): void {
    if (this.renderFrame === undefined && this.renderTask === undefined) return;
    if (this.renderFrame !== undefined) {
      this.frames.delete(this.renderFrame);
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.renderFrame);
    }
    if (this.renderTask !== undefined) clearTimeout(this.renderTask);
    this.renderFrame = undefined; this.renderTask = undefined; this.pending = false;
  }
  destroy(): void {
    this.cancelTaskReads();
    if (this.destroyed) return;
    this.destroyed = true; this.listenerAbort.abort(); this.cancelRender(); this.dismissPreview();
    for (const remove of this.listenerCleanup) remove(); this.listenerCleanup = [];
    for (const id of this.frames) if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    this.frames.clear(); this.pending = false;
    for (const observer of this.observers) observer.disconnect(); this.observers = [];
    this.reset(); this.resize = undefined;
  }
  visibilityChanged(): void {
    if(this.hidden())this.cancelTaskReads();
    if (this.destroyed) return;
    if (this.hidden() || document.hidden) this.clearTiming();
    this.elapsed.sync(); if (!this.hidden()) this.schedule();
    if (!this.hidden() && this.unreadCount) { this.unreadCount = 0; this.hooks.unread?.(); }
  }
  private clearTiming(): void { this.scheduledAt = undefined; this.receivedAt = undefined; }
  selectionSource(selection: Selection): PrimaryDraftSource|undefined {
    for (const tool of this.tools.values()) if (selectionWithin(selection, tool.card) && tool.source) return this.toolDraftSource(tool, tool.source, true);
    for (const entry of this.cache.values()) for (const message of entry.messages.values()) {
      const carrier = message.source.communication;
      if ((message.source.role === 'assistant' || carrier?.state === 'ready') && selectionWithin(selection, message.body)) return this.messageDraftSource(entry, message, true);
    }
    return undefined;
  }
  private selectedMessageCurrent(entry:EntryNode,message:MessageNode,source:MessageView,entryId:string,generation:number):boolean {
    return generation===this.generation&&!this.hidden()&&this.node.contains(message.node)&&entry.source?.id===entryId&&this.index.entries.has(entryId)&&entry.messages.get(source.id)===message&&message.source===source;
  }
  private messageDraftSource(entry: EntryNode, message: MessageNode, selected=false): PrimaryDraftSource|undefined {
    const hooks = this.hooks.primaryDraft, source = message.source, retained = entry.source, generation = this.generation;
    if (!hooks || !retained) return;
    const carrier = source.communication?.state === 'ready' ? source.communication.value : undefined;
    return {caption: () => carrier ? `${this.hooks.senderCaption?.(carrier.sender) ?? hooks.caption()} · ${carrier.kind}` : hooks.caption(),
      href: () => hooks.reference?.(retained.id), current: () => hooks.current() && (selected ? this.selectedMessageCurrent(entry,message,source,retained.id,generation) : this.currentMessage(entry,source.id,message.node,generation)?.source === source && (!message.communication || !!message.communication.current()))};
  }
  private selectedToolCurrent(tool:ToolNode,source:JoinedTool,generation:number):boolean {
    return generation===this.generation&&!this.hidden()&&this.node.contains(tool.card)&&this.tools.get(source.callId)===tool&&tool.source?.owner===source.owner&&tool.source.slot===source.slot&&tool.source.name===source.name&&this.index.entries.has(source.owner);
  }
  private toolDraftSource(tool: ToolNode, source: JoinedTool, selected=false): PrimaryDraftSource|undefined {
    const hooks = this.hooks.primaryDraft, entry = this.index.entries.get(source.owner), generation = this.generation;
    if (!hooks || !entry) return;
    return {caption: () => `${hooks.caption()} · ${tool.title.textContent || source.name}`, href: () => hooks.reference?.(entry.id),
      current: () => hooks.current() && (selected ? this.selectedToolCurrent(tool,source,generation) : !this.hidden() && this.currentToolSource(tool,source,generation) && this.index.entries.get(entry.id) === entry)};
  }
  private primaryAskItems(source: PrimaryDraftSource|undefined): ContextItem[] {
    const actions = this.hooks.primaryDraft; if (!actions || !source) return [];
    const reason = actions.reason();
    return [{label:'Ask in Primary',enabled:!reason,description:reason,run:()=>actions.append(source)}];
  }
  private toolPathItems(tool?:ToolNode):ContextItem[] {
    const pathCopy=tool?.source?this.toolPathCopy(tool,tool.source):undefined;
    return pathCopy?[{label:'Copy path',run:pathCopy.run}]:[];
  }
  private itemMenu(event: MouseEvent): void {
    if (nativeEditingTarget(event.target)) return;
    const target = event.target as HTMLElement | null;
    const origin = target?.closest<HTMLElement>('.tool-shell, .message, .entry'); if (!origin || !this.node.contains(origin)) return;
    const generation = this.generation;
    const tool = [...this.tools.values()].find(item => item.card === origin);
    const entryNode = origin.closest<HTMLElement>('.entry'); const entry = entryNode ? this.cache.get(entryNode.dataset.entryId ?? '') : undefined;
    const message = entry && [...entry.messages.values()].find(item => item.node === origin);
    const source = tool?.source ?? message?.source ?? entry?.source;
    if (message && entry) { this.messageMenu(entry, message.source.id, origin, {x: event.clientX, y: event.clientY}); event.preventDefault(); event.stopPropagation(); return; }
    const text = menuText(tool, message, entry);
    const items: ContextItem[] = [...selectionCopy(origin), {label: 'Copy', run: () => { void copy(text, origin); }}, ...this.toolPathItems(tool), ...this.primaryAskItems(tool?.source ? this.toolDraftSource(tool,tool.source) : undefined),...this.toolFileItems(tool)];
    const disclosure = target?.closest<HTMLDetailsElement>('details') ?? origin.querySelector<HTMLDetailsElement>('details');
    if (disclosure && origin.contains(disclosure)) items.push({label: disclosure.open ? 'Collapse details' : 'Expand details', run: () => { disclosure.open = !disclosure.open; }});
    origin.tabIndex = -1;
    event.preventDefault(); event.stopPropagation();
    contextMenu.open(origin, {x: event.clientX, y: event.clientY}, 'Transcript item actions', items,
      () => !this.deferred && generation === this.generation && origin.isConnected && !this.hidden() && source === (tool?.source ?? message?.source ?? entry?.source));
  }
  private hidden(): boolean {
    const conversation = this.node.closest<HTMLElement>('.conversation'), pane = this.node.closest<HTMLElement>('.pane-leaf');
    return this.destroyed || this.node.hidden || this.node.inert || conversation?.hidden === true || conversation?.inert === true || pane?.hidden === true || pane?.inert === true;
  }
  private hasSelection(): boolean {
    const selection = document.getSelection();
    return !!selection && !selection.isCollapsed && (this.node.contains(selection.anchorNode) || this.node.contains(selection.focusNode));
  }
  configure(presentation?: PresentationView, reading?: ReadingView): void {
    this.view = presentation?.transcriptView ?? 'chronological'; this.pendingView = undefined;
    this.node.dataset.view = this.view;
    this.expanded = new Set(presentation?.expanded ?? []); this.showThinking = thinkingExpanded(presentation); this.thinkingChoice = presentation?.thinking;
    if(!this.hooks.owner)this.deriveRows();
    if (reading) {
      this.follow = reading.followTail; this.readingRevision = reading.revision; this.restoring = reading.followTail ? undefined : reading;
      this.reflowAnchor = reading.anchorId ? {id: this.displayId(reading.anchorId), offsetPx: reading.offsetPx} : null;
    }
    if(this.hooks.owner)this.deriveRows();
    this.applyPreferences();
  }
  isExpanded(key:string):boolean {return this.expanded.has(key);}
  disclosure(key:string,open:boolean):void {this.sourcePreference(key,open);}
  capturePresentation(revision:number):PresentationView {return {revision,expanded:[...this.expanded],showThinking:this.showThinking,transcriptView:this.view,...(this.thinkingChoice?{thinking:this.thinkingChoice}:{})};}
  private toggleReceived(id:string):void {
    const anchor=this.anchor();if(!this.noticeBlocks.toggle(id,this.expanded))return;
    this.follow=false;this.restoring=undefined;this.reflowAnchor=anchor;
    this.heights.clear();this.dirtyLayout=true;this.deriveRows();
    this.hooks.presentation([...this.expanded],this.showThinking,this.view,this.thinkingChoice);this.paint(anchor);this.noticeBlocks.focus(id);this.saveReading();
  }
  setView(view: TranscriptView): void {
    if (view === this.view) return;
    if (this.hasSelection()) { this.pendingView = view; return; }
    const anchor = this.anchor();
    this.view = view; this.pendingView = undefined; this.node.dataset.view = view;
    this.deriveRows();
    this.dirtyLayout = true; this.restoring = undefined;
    if (anchor) this.follow = false;
    this.paint(anchor); this.hooks.presentation([...this.expanded], this.showThinking, this.view); this.saveReading();
  }
  reset(): void {
    this.clearOwnMessageMarker();this.ownMessageCursor=undefined;this.failedStepCursor=undefined;this.receivedResultCursor=undefined;
    this.cancelTaskReads();this.taskReadStamps.clear();this.dismissPreview();
    this.cancelRender(); if (this.inputFrame !== undefined) this.pending = false;
    this.clearTiming(); this.streamPending = false; this.readingDirty = false; this.deferred = undefined; this.chronological = []; this.view = 'chronological'; this.pendingView = undefined;
    this.node.dataset.view = this.view;
    this.elapsed.stop();
    if (this.geometryTimer !== undefined) clearTimeout(this.geometryTimer);
    this.geometryTimer = undefined; this.geometryDirty.clear(); this.outputNodes.clear(); this.resizeReturn = undefined;
    this.resize?.disconnect(); if (!this.destroyed) this.resize?.observe(this.node); this.sizes = new WeakMap(); this.scrolling = new WeakSet(); this.reflowAnchor = undefined; this.writtenScrollTop = undefined;
    this.clearFind(false); this.findRevision++;
    this.initialSettings.clear(); this.toolStates = new Map(); this.indexedFindId = undefined;
    this.generation++; this.entries = []; this.displayed = []; this.turnRows.clear(); this.cache.clear(); this.tools.clear(); this.liveThinking.clear(); this.thinkingTimes = new Map(); this.index = new TranscriptIndex(); this.joined = this.index.joined; this.rows = new TranscriptRows(); this.noticeBlocks.clear(); this.tasks = new ConversationTasks(); this.visible.clear(); this.dirtyLayout = true; this.pins.clear(); this.heights.clear(); this.gaps.clear(); this.timeGaps.clear();
    this.expanded.clear(); this.streamedThinking.clear(); this.showThinking = false; this.thinkingChoice = undefined; this.follow = true; this.readingRevision = 0;
    this.layout = layoutItems([], this.heights, 140); this.restoring = undefined; this.node.replaceChildren(...(this.lead ? [this.lead] : [])); this.scrollTo(0); this.hold = undefined; this.arrivals.reset(); this.unreadCount = 0; this.activitySignature = undefined; this.activityAt = undefined; this.referenceNamesPending = false; this.syncLatest();
  }
  defer(refresh: () => void, receivedAt?: number): void {
    if (this.destroyed) return;
    this.deferred = refresh;
    if (this.hidden() || document.hidden || !this.node.isConnected) this.clearTiming();
    else if (receivedAt !== undefined && Number.isFinite(receivedAt) && receivedAt >= 0 && receivedAt <= performance.now()) {
      this.streamPending = true;
      if (this.hooks.timing && this.receivedAt === undefined) this.receivedAt = receivedAt;
    }
    this.schedule();
  }
  set(entries: EntryView[], tools: ReadonlyMap<string, ToolState> = new Map(), thinking: ReadonlyMap<string, ThinkingTime> = new Map(), historyBeginning = true): void {
    this.thinkingTimes = thinking; this.toolStates = tools; this.historyBeginning = historyBeginning;
    const hidden = initialSettings(entries, historyBeginning);
    const visibilityChanged = this.indexedFindId !== this.findId || hidden.size !== this.initialSettings.size || [...hidden].some(id => !this.initialSettings.has(id));
    this.initialSettings = hidden; this.indexedFindId = this.findId;
    this.receivedAt = undefined; this.streamPending = false; this.deferred = undefined;
    const sessions = new Map(this.index.sessions);
    const prepended = this.entries.length > 0 && entries[0]?.id !== this.entries[0]?.id && entries.some(candidate => candidate.id === this.entries[0]?.id);
    if (prepended && !this.follow) this.holdAnchor(this.geometryAnchor());
    this.entries = entries; this.index.update(entries, tools, this.visibilityPredicate, {incrementalVisibility: !visibilityChanged}); this.retireForks(); this.reconcileSessions(sessions);
    for (const id of this.index.changed) {
      const entry = this.index.entries.get(id);
      if (entry) this.visible.set(id, this.visibleEntry(entry)); else this.visible.delete(id);
    }
    this.chronological = entries;
    this.tasks.update(entries,this.joined);
    this.noteArrivals(entries);
    this.deriveRows(); this.prune(); this.schedule();
  }
  /** Records activity time, counts new messages while the transcript is shown elsewhere, and announces those below the view. */
  private noteArrivals(entries: EntryView[]): void {
    const tail = entries.at(-1), signature = tail ? `${tail.id}:${(tail.messages ?? []).map(message => message.parts.length).join(',')}` : '';
    if (this.activitySignature !== undefined && signature !== this.activitySignature) this.activityAt = Date.now();
    this.activitySignature = signature;
    const away = this.hidden(), arrived = this.arrivals.observe(entries, !this.follow || away, this.hooks.operatorInput === true);
    if (arrived > 0 && away) { this.unreadCount += arrived; if (this.follow) this.arrivals.clear(); this.hooks.unread?.(); }
    else if (arrived > 0) { this.syncLatest(); if (this.arrivals.count === arrived) announce('New messages below'); }
  }
  taskRows(): readonly ConversationTask[] {return [...this.tasks.sent,...this.tasks.asked];}
  /** Requests that this conversation sent and a result read reports as still placed or queued. */
  outstandingTasks(): readonly TaskReference[] {return this.tasks.outstanding();}
  /** Read the open requests again, for example after Stop. */
  refreshTasks(): void {this.taskReadStamps.clear();this.schedule();}
  acceptTaskResult(value:ResultInspection):void {let changed=false;for(const row of this.tasks.sent)if(row.tool&&this.tasks.recordResult(row.tool.callId,value))changed=true;if(changed){this.schedule();this.hooks.tasksChanged?.();}}
  activitySentence(): string {
    const active=[...this.joined.values()].findLast(tool=>tool.status==='working');
    return active?[`Using ${active.name.replace(/[_-]+/g,' ')}`,toolTime(active).replace(/ elapsed$/,'')].filter(Boolean).join(' · '):'';
  }
  private openTaskAnswer(task: ConversationTask): void {
    if(!task.tool)return;this.expanded.add(`tool:${task.tool.callId}`);
    const tool=this.tools.get(task.tool.callId);if(tool){tool.node.open=true;tool.expanded.hidden=false;}
    this.expanded.add(`answer:${task.tool.callId}`);this.hooks.presentation([...this.expanded],this.showThinking);
    this.revealEntry(task.entryId,true,task.tool.callId);
  }
  private deriveRows(): void {
    const previous = new Map(this.rows.runs);
    const visible = this.chronological.filter(entry => !this.initialSettings.has(entry.id) || entry.id === this.findId);
    const ordered = this.view === 'grouped' && !this.hooks.sourceOrder ? this.groups.rows(visible) : visible;
    const retained = new Set([...this.cache].filter(([id, cached]) => cached.messages.size > 0 && (this.rows.byId.get(id)?.actionsOnly || this.protectedNode(cached.node))).map(([id]) => id));
    const all = this.noticeBlocks.rebuild(this.rows.derive(ordered, this.joined, this.index.sessionOwners, this.showThinking,this.index.sessions,retained),this.rows.byId,this.chronological);
    const reading=this.restoring?.anchorId??this.reflowAnchor?.id,before=this.expanded.size;
    const displayed=this.noticeBlocks.project(all,this.expanded,reading?this.rows.owners.get(reading)??reading:undefined);
    if(this.expanded.size!==before)this.hooks.presentation([...this.expanded],this.showThinking,this.view,this.thinkingChoice);
    this.migrateStepRows(previous);
    for (const [id, run] of this.rows.runs) this.index.disclosures.set(run.key,id);
    if (displayed.length !== this.displayed.length || displayed.some((entry, at) => entry.id !== this.displayed[at]?.id)) this.dirtyLayout = true;
    this.displayed = displayed;
    this.deriveTimeGaps();this.deriveTurns();
  }
  /** Gap evidence comes from adjacent raw records, including results omitted from the view. */
  private deriveTimeGaps():void {
    this.timeGaps.clear();if(!this.hooks.owner)return;
    const displayed=new Set(this.displayed.map(entry=>entry.id));let preceding:string|undefined;
    const stamp=(entry:EntryView|undefined,last=false):number|undefined=>{const messages=entry?.messages??[];for(const message of last?[...messages].reverse():messages)if(typeof message.timestamp==='number'&&isValidTimestamp(message.timestamp))return message.timestamp;return;};
    for(let index=1;index<this.chronological.length;index++){
      const prior=this.chronological[index-1],id=prior&&this.displayId(prior.id);if(id&&displayed.has(id))preceding=id;
      const before=stamp(prior,true),after=stamp(this.chronological[index]);
      if(preceding&&before!==undefined&&after!==undefined&&after-before>30*60_000)this.timeGaps.set(preceding,after);
    }
  }
  private textBearing(message: MessageView): boolean {
    if (message.communication?.state === 'ready') return !!message.communication.value.body.text.trim();
    return message.parts.some(part => part.type === 'text' && !!part.text.trim());
  }
  private extendTurn(entry: EntryView, message: MessageView, previous?: AssistantTurn): AssistantTurn | undefined {
    if (message.role === 'user') return {key:JSON.stringify([entry.id,message.id]),input:{entry,message},assistant:false};
    if (message.role !== 'assistant') return previous;
    const turn = previous ?? {key:JSON.stringify([entry.id,message.id]),assistant:false};
    turn.assistant = true;
    if (this.textBearing(message)) turn.copy = {entry,message};
    return turn;
  }
  private sourceTurns(): {messages: Map<MessageView,AssistantTurn>; tools: Map<string,AssistantTurn>} {
    const messages = new Map<MessageView,AssistantTurn>(), tools = new Map<string,AssistantTurn>(); let turn: AssistantTurn | undefined;
    for (const entry of this.chronological) {
      for (const message of entry.messages ?? []) {
        turn = this.extendTurn(entry,message,turn);
        if (message.role === 'assistant' && turn) messages.set(message,turn);
      }
      if (entry.tool && turn) tools.set(entry.id,turn);
    }
    return {messages,tools};
  }
  private rowTurn(row: TranscriptRow, messages: ReadonlyMap<MessageView,AssistantTurn>, tools: ReadonlyMap<string,AssistantTurn>): AssistantTurn | undefined {
    if (row.actionsOnly) return;
    for (const message of row.source.messages ?? []) {
      const turn = messages.get(message); if (!turn) continue;
      if (row.parts?.has(message.id)) return turn;
      if (row.steps?.tools.some(tool => message.parts.some((_part,at) => tool.slot === slot(row.source.id,message.id,at)))) return turn;
    }
    return tools.get(row.source.id);
  }
  private deriveTurns(): void {
    const {messages,tools} = this.sourceTurns(); this.turnRows.clear();
    for (const entry of this.displayed) {
      const row = this.rows.byId.get(entry.id), turn = row ? this.rowTurn(row,messages,tools) : undefined;
      if (!turn?.assistant) continue; this.turnRows.set(entry.id,turn); turn.end = entry.id;
    }
  }
  private migrateStepRows(previous:ReadonlyMap<string,StepRun>):void{
    for(const [id,run] of previous){
      const first=run.tools[0],next=first?this.rows.calls.get(first.callId):undefined,cached=this.cache.get(id);
      if(!next||next===id||!cached||this.cache.has(next))continue;
      this.cache.delete(id);this.cache.set(next,cached);cached.node.dataset.entryId=next;
      if(this.expanded.has(`events:${id}`))this.expanded.add(`events:${next}`);
      const height=this.heights.get(id);if(height!==undefined)this.heights.set(next,height);
    }
  }
  private reconcileSessions(previous: ReadonlyMap<string, SessionGroup>): void {
    for (const [id, group] of previous) {
      const open = this.expanded.has(`events:${id}`); const owner = this.index.sessionOwners.get(id);
      if (open) {
        this.expanded.delete(`events:${id}`);
        this.inheritSessionOpen(group);
      }
      const cached = this.cache.get(id);
      if (!owner || owner === id || !cached || this.cache.has(owner) && !this.protectedNode(cached.node)) continue;
      this.cache.delete(id); this.cache.set(owner, cached); cached.node.dataset.entryId = owner;
      const height = this.heights.get(id); if (height !== undefined) this.heights.set(owner, height);
    }
  }
  private inheritSessionOpen(group: SessionGroup): void {
    for (const member of group.entries) { const head = this.index.sessionOwners.get(member.id); if (head) this.expanded.add(`events:${head}`); }
  }
  historyAvailable(available: boolean): void {
    this.earlierAvailable = available;
    if (!this.lead || this.lead.hidden === !available) return;
    const anchor = !this.follow && !this.restoring ? this.anchor() : null;
    this.lead.hidden = !available;
    const node = anchor && this.cache.get(anchor.id)?.node;
    if (anchor && node?.isConnected) this.scrollTo(node.offsetTop - this.node.offsetTop + anchor.offsetPx);
  }
  restorationCurrent(reading?: ReadingView): boolean {
    return !!reading && !this.hidden() && !this.follow && this.restoring === reading;
  }
  abandonRestore(reading?: ReadingView): void {
    if (!this.restorationCurrent(reading)) return;
    this.restoring = undefined; this.reflowAnchor = undefined; this.schedule();
  }
  restore(reading?: ReadingView): void {
    if (this.hidden() || !reading || reading.followTail) return;
    this.follow = false; this.restoring = reading;
    this.reflowAnchor = reading.anchorId ? {id: this.displayId(reading.anchorId), offsetPx: reading.offsetPx} : null;
    this.schedule();
  }
  schedule(): void {
    if (this.destroyed) return;
    if (this.hidden() || document.hidden || !this.node.isConnected) this.clearTiming();
    else if (this.hooks.timing && this.scheduledAt === undefined) this.scheduledAt = performance.now();
    if (this.inputFrame !== undefined) { this.pending = true; return; }
    // Transport batches need no second frame after native input. Layout-only work stays frame-aligned.
    const task = this.streamPending && !this.hidden() && !document.hidden && this.node.isConnected;
    if (this.pending) {
      if (task ? this.renderFrame === undefined : this.renderTask === undefined) return;
      this.cancelRender();
    }
    this.pending = true;
    if (task) {
      const id = setTimeout(() => {
        if (this.renderTask !== id || this.destroyed) return;
        this.renderTask = undefined; this.flushRender();
      }, 0);
      this.renderTask = id;
    } else this.renderFrame = this.frame(() => { this.renderFrame = undefined; this.flushRender(); });
  }
  private flushRender(): void {
    const start = this.scheduledAt, receivedAt = this.receivedAt, generation = this.generation; this.clearTiming();
    const refresh = this.deferred; this.deferred = undefined; let updated = false; let end: number | undefined;
    try { refresh?.(); updated = this.paint(); if (updated && start !== undefined) end = performance.now(); }
    finally { this.pending = false; this.streamPending = false; this.clearTiming(); }
    if (this.readingDirty) { this.readingDirty = false; this.saveReading(); this.scrolling.delete(this.node); }
    if (!this.hidden()) this.queueGeometry();
    const current = () => !this.destroyed && generation === this.generation && !this.hidden() && !document.hidden && this.node.isConnected;
    if (!updated || start === undefined || end === undefined || !current()) return;
    this.hooks.timing?.('render', start, end);
    if (receivedAt !== undefined && receivedAt <= end && current()) this.hooks.timing?.('stream-to-render', receivedAt, end);
  }
  /** A notice row owns its leading header/margin, while its last row also owns the trailing margin. */
  private rowStart(node: HTMLElement, origin = this.node.getBoundingClientRect().top - this.node.scrollTop + this.node.clientTop): number {
    return node.getBoundingClientRect().top - origin - this.noticeBlocks.leading(node.dataset.entryId ?? '');
  }
  private anchor(): {id: string; offsetPx: number} | null {
    let first = Infinity, closest = -Infinity, anchor: {id: string; offsetPx: number} | null = null;
    const origin = this.node.getBoundingClientRect().top - this.node.scrollTop + this.node.clientTop;
    for (const [id, entry] of this.cache) {
      if (!this.node.contains(entry.node) || !this.layout.byId.has(id)) continue;
      const top = this.rowStart(entry.node,origin), bottom = top + entry.node.offsetHeight + this.noticeBlocks.overhead(id);
      first = Math.min(first, top);
      if (top <= this.node.scrollTop && bottom > this.node.scrollTop && top > closest) {
        closest = top; anchor = {id, offsetPx: this.node.scrollTop - top};
      }
    }
    if (anchor) return anchor;
    // Padding and the earlier-history control do not belong to a virtual row.
    if (this.node.scrollTop < first && this.node.scrollTop < this.layoutOrigin()) return null;
    return captureAnchor(this.layout, this.node.scrollTop - this.layoutOrigin());
  }
  private layoutOrigin(): number {
    const first = Array.from(this.node.children).find(child => child !== this.lead) as HTMLElement | undefined;
    if (!first) return 0;
    const margin = first.matches('.notice-block[data-start=true]') ? 12 : 0;
    return Math.max(0, first.getBoundingClientRect().top - this.node.getBoundingClientRect().top + this.node.scrollTop - this.node.clientTop - margin);
  }
  private geometryAnchor(override?: {id: string; offsetPx: number} | null): {id: string; offsetPx: number} | null {
    if (this.follow) return null;
    if (override !== undefined) return override;
    // DOM wrapping changes before resize observers run; it is not a new reading intent.
    return this.reflowAnchor === undefined ? this.anchor() : this.reflowAnchor;
  }
  private scrollTo(position: number): void {
    const before = this.node.scrollTop; this.node.scrollTop = position;
    if (this.node.scrollTop !== before) this.writtenScrollTop = this.node.scrollTop;
    this.lastScrollTop = this.node.scrollTop;
  }
  captureGeometry(): TranscriptGeometry {
    return {generation: this.generation, followTail: this.follow, anchor: this.follow ? null : this.geometryAnchor(), scrollTop: this.node.scrollTop};
  }
  /** Remeasures current cards without a reset or a change to reading intent. */
  applyGeometry(saved: TranscriptGeometry): void {
    if (this.destroyed || this.hidden() || saved.generation !== this.generation || this.geometryGuard()) return;
    this.heights.clear(); this.sizes = new WeakMap(); this.dirtyLayout = true; this.follow = saved.followTail;
    this.reflowAnchor = saved.anchor; this.paint(saved.anchor);
    if (saved.anchor) this.restorePosition(saved.anchor); else if (!saved.followTail) this.scrollTo(saved.scrollTop);
  }
  private geometryGuard(): boolean {
    return this.hidden() || !!this.restoring || this.hasSelection() || (document.activeElement !== this.node && this.node.contains(document.activeElement));
  }
  private resizeGeometry(entry: ResizeObserverEntry): void {
    const target = entry.target as HTMLElement;
    if (target !== this.node && !this.outputNodes.has(target)) return;
    const size = `${entry.contentRect.width}:${entry.contentRect.height}`;
    if (this.sizes.get(target) === size) return;
    this.sizes.set(target, size); this.geometryDirty.add(target);
    // The scroller still shows its pre-resize position here; a browser return to that position is measured against it.
    if (target === this.node) this.resizeReturn = {at: performance.now(), scrollTop: this.node.scrollTop, scrollHeight: this.node.scrollHeight};
  }
  private queueGeometry(): void {
    if (this.destroyed || !this.geometryDirty.size) return;
    if (this.geometryTimer !== undefined) clearTimeout(this.geometryTimer);
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = undefined; this.settleGeometry();
      this.scrolling.delete(this.node); for (const node of this.outputNodes) this.scrolling.delete(node);
    }, 120);
  }
  private settleGeometry(): void {
    if (!this.geometryDirty.size) return;
    if (this.geometryGuard()) {this.writtenScrollTop = undefined; return;}
    if (this.scrolling.has(this.node)) return;
    const anchor = this.follow ? null : this.reflowAnchor ?? this.anchor(); let reflow = false;
    for (const node of this.geometryDirty) {
      if (node === this.node) { reflow = true; this.geometryDirty.delete(node); continue; }
      if (this.scrolling.has(node)) continue;
      this.geometryDirty.delete(node);
      reflow = node.isConnected && this.outputNodes.has(node) || reflow;
    }
    if (reflow) {
      if (anchor) this.restorePosition(anchor);
      this.paint(anchor); this.saveReading();
    }
  }
  private registerOutput(node: HTMLElement): void {
    if (node.tagName.toLowerCase() === 'pre' && node.closest('.tool-expanded') && !node.dataset.wrap && !node.hidden) {
      const caption = node.previousElementSibling as HTMLElement | null;
      if (caption?.tagName.toLowerCase() === 'summary' && node.parentElement?.tagName.toLowerCase() === 'details') {
        node.parentElement.classList.add('source-disclosure'); caption.classList.add('source-header');
        caption.after(sourceWrap(node));
      } else {
        const label = caption?.classList.contains('tool-caption') && !caption.classList.contains('preview-omission') ? caption : node.dataset.language ?? '';
        node.before(sourceHeader(node, label));
      }
    }
    if (!this.outputNodes.has(node)) { this.outputNodes.add(node); this.resize?.observe(node); }
    if (this.outputListeners.has(node)) return;
    this.outputListeners.add(node);
    node.addEventListener('scroll', () => {
      if (!this.outputNodes.has(node)) return;
      this.scrolling.add(node); this.queueGeometry();
    }, {passive: true});
    node.addEventListener('scrollend', () => {
      if (this.destroyed) return;
      this.scrolling.delete(node);
      if (!this.outputNodes.has(node)) return;
      this.queueGeometry();
    });
  }
  private releaseOutput(node: HTMLElement): void {
    this.resize?.unobserve(node); this.outputNodes.delete(node); this.geometryDirty.delete(node);
    this.releaseFrames(node);
  }
  private releaseToolGeometry(tool: ToolNode): void {
    if (tool.viewport) this.releaseOutput(tool.viewport);
    for (const page of tool.pageViewports ?? []) this.releaseOutput(page);
  }
  refreshReferences(): void {
    this.registerContent(this.node);
    for (const tool of this.tools.values()) if (tool.source) {tool.argumentsSource = undefined;this.presentToolRegion(tool,tool.source);}
  }
  private registerContent(root: HTMLElement): void {
    this.hooks.references?.decorate(root, node => this.referenceCurrent(node), parent => {
      const content = (parent as HTMLElement).closest?.('.tool-content'); if (!content) return Infinity;
      const card = content.closest('.tool-shell'); const tool = [...this.tools.values()].find(item => item.card === card);
      return tool?.previewBudget?.room() ?? 0;
    }, node => this.protectedNode(node));
    const outputs = root.querySelectorAll<HTMLElement>('pre, table, .tool-result');
    for (const node of outputs) {
      this.registerOutput(node); node.tabIndex = 0;
      node.setAttribute('role', 'region'); node.setAttribute('aria-label', node.classList.contains('tool-result') ? 'Tool result' : 'Scrollable content');
    }
    if (root.tagName.toLowerCase() === 'pre') { this.registerOutput(root); root.tabIndex = 0; }
    for (const detail of root.querySelectorAll<HTMLDetailsElement>('details')) this.observeDisclosure(detail);
    if (root.tagName.toLowerCase() === 'details') this.observeDisclosure(root);
  }
  private observeDisclosure(node: HTMLElement): void {
    if (this.disclosureListeners.has(node)) return;
    this.disclosureListeners.add(node);
    const summary = node.querySelector<HTMLElement>('summary');
    if (summary && !summary.classList.contains('card-disclosure')) cardDisclosure(summary);
    node.addEventListener('toggle', () => { if (!this.destroyed && this.node.contains(node)) { this.registerContent(node); this.schedule(); } });
  }
  private referenceCurrent(node: HTMLElement): boolean {
    if (this.deferred || this.hidden() || !this.node.contains(node)) return false;
    const owner = node.closest<HTMLElement>('.entry'); const entry = owner && this.cache.get(owner.dataset.entryId ?? '');
    if (!entry || entry.node !== owner || entry.source !== this.index.entries.get(entry.source?.id ?? '')) return false;
    return this.messageReferenceCurrent(entry, node) && this.toolReferenceCurrent(node);
  }
  private messageReferenceCurrent(entry: EntryNode, node: HTMLElement): boolean {
    const shell = node.closest<HTMLElement>('.message');
    const message = shell && [...entry.messages.values()].find(item => item.node === shell);
    if (message) {
      if (!entry.source?.messages?.includes(message.source)) return false;
      if (message.communication && message.communication.source !== message.source) return false;
      for (const part of message.parts.values()) if (part.node.contains(node) && !message.source.parts.includes(part.source)) return false;
    }
    return true;
  }
  private toolReferenceCurrent(node: HTMLElement): boolean {
    const toolShell = node.closest<HTMLElement>('.tool-shell');
    if (toolShell) {
      const tool = [...this.tools.values()].find(item => item.card === toolShell);
      if (!tool?.source || this.joined.get(tool.source.callId) !== tool.source) return false;
      for (const [inspection, source] of tool.inspectionSources ?? []) if (inspection.contains(node) && source !== tool.source) return false;
      if (tool.argumentsDocument?.contains(node) && tool.argumentsSource !== tool.source) return false;
    }
    return true;
  }
  hasLoadedEntry(entryId:string):boolean {return this.index.entries.has(entryId);}
  loadedReference(query: ReferenceQuery, owner?: string): string | undefined {
    return loadedReference(this.entries, query, typeof query === 'string' ? this.groups.reference(query) : undefined, owner);
  }
  /** Reveal the newest message error even when its entry is outside the virtual window. */
  revealLatestError(): boolean {
    const entry = this.entries.findLast(entry => entry.messages?.some(message => !!errorPresentation(message).summary));
    if (!entry) return false;
    this.revealEntry(entry.id, false);
    const errors = this.cache.get(this.displayId(entry.id))?.node.querySelectorAll<HTMLElement>('.message-error');
    const error = errors && [...errors].findLast(node => !node.hidden);
    if (!error) return false;
    error.scrollIntoView({block: 'center'});
    return true;
  }
  private isOwnMessage(entry:EntryView):boolean{
    return !entry.sender&&!entry.messages?.some(message=>!!message.communication)&&!!entry.messages?.some(message=>message.role==='user');
  }
  loadedOwnMessages():EntryView[]{
    return this.destroyed||this.hidden()?[]:this.chronological.filter(entry=>this.isOwnMessage(entry));
  }
  ownMessageEntry(direction:-1|1):string|undefined{
    if(this.destroyed||this.hidden())return;
    const reading=this.geometryAnchor(),cursor=this.ownMessageCursor;
    const anchored=cursor&&cursor.anchorId===(reading?.id??null)&&cursor.offsetPx===(reading?.offsetPx??0)?cursor.id:this.restoring?.anchorId??reading?.id;
    const source=anchored&&(this.rows.byId.get(anchored)?.source.id??anchored);
    const at=this.follow?this.chronological.length:this.chronological.findIndex(entry=>entry.id===source);
    for(let index=at+direction;index>=0&&index<this.chronological.length;index+=direction){
      const entry=this.chronological[index];
      if(entry&&this.isOwnMessage(entry))return entry.id;
    }
  }
  jumpOwnMessage(direction:-1|1):boolean{
    const id=this.ownMessageEntry(direction);return id?this.jumpToOwnMessage(id):false;
  }
  jumpToOwnMessage(id:string):boolean{
    if(this.destroyed||this.hidden()||!this.chronological.some(entry=>entry.id===id&&this.isOwnMessage(entry)))return false;
    this.revealEntry(id,false);
    const reading=this.geometryAnchor();this.ownMessageCursor={id,anchorId:reading?.id??null,offsetPx:reading?.offsetPx??0};
    return this.markNavigationEntry(this.displayId(id));
  }
  private failedToolResults():Map<string,boolean>{
    const results=new Map<string,boolean>();
    for(const entry of this.chronological){
      if(entry.tool?.status==='done'&&typeof entry.tool.isError==='boolean')results.set(entry.tool.callId,entry.tool.isError);
      for(const part of entry.messages?.flatMap(message=>message.parts)??[])if(part.type==='toolResult')results.set(part.callId,part.isError);
    }
    for(const [callId,state] of this.toolStates)if(state.phase==='end'&&typeof state.isError==='boolean')results.set(callId,state.isError);
    return results;
  }
  private failedStepAt(row:TranscriptRow|undefined,results:ReadonlyMap<string,boolean>):FailedStep|undefined{
    if(!row)return;
    const tool=row.steps?.tools[0];
    if(tool&&results.get(tool.callId)===true&&tool.owner===row.source.id&&this.rows.calls.get(tool.callId)===row.view.id)return {entryId:tool.owner,rowId:row.view.id,callId:tool.callId};
    if(!row.actionsOnly&&row.parts&&row.source.messages?.some(message=>this.rowMessageVisible(row.source.id,message,row.parts)&&failedResponse(message)))return {entryId:row.source.id,rowId:row.view.id};
    return undefined;
  }
  failedStep(direction:-1|1):FailedStep|undefined{
    if(this.destroyed||this.hidden()||this.deferred)return;
    const order=new Map(this.chronological.map((entry,at)=>[entry.id,at]));
    const rows=this.displayed.flatMap(entry=>{const row=this.rows.byId.get(entry.id);return row&&order.has(row.source.id)?[row]:[];})
      .sort((a,b)=>(order.get(a.source.id)??0)-(order.get(b.source.id)??0));
    const reading=this.geometryAnchor(),cursor=this.failedStepCursor;
    const anchored=cursor&&cursor.anchorId===(reading?.id??null)&&cursor.offsetPx===(reading?.offsetPx??0)?cursor.id:this.restoring?.anchorId??reading?.id;
    const rowId=anchored&&(this.rows.byId.has(anchored)?anchored:this.displayId(anchored));
    const at=this.follow?rows.length:rows.findIndex(row=>row.view.id===rowId),results=this.failedToolResults();
    for(let index=at+direction;index>=0&&index<rows.length;index+=direction){
      const step=this.failedStepAt(rows[index],results);if(step)return step;
    }
    return undefined;
  }
  jumpFailedStep(direction:-1|1):boolean{
    const step=this.failedStep(direction);if(!step)return false;
    this.revealEntry(step.entryId,false,step.callId,step.rowId);
    const reading=this.geometryAnchor();this.failedStepCursor={id:step.rowId,anchorId:reading?.id??null,offsetPx:reading?.offsetPx??0};
    return this.markNavigationEntry(step.rowId);
  }
  private loadedReceivedResults():ReceivedResult[]{
    const rows=new Map<string,string>();
    for(const entry of this.displayed){
      const row=this.rows.byId.get(entry.id);if(!row?.parts||row.actionsOnly)continue;
      for(const messageId of row.parts.keys())rows.set(JSON.stringify([row.source.id,messageId]),row.view.id);
    }
    return this.chronological.flatMap((entry,entryAt)=>(entry.messages??[]).flatMap((message,messageAt)=>{
      const carrier=message.communication;
      if(carrier?.state!=='ready'||(carrier.value.kind!=='report'&&carrier.value.kind!=='result'))return [];
      const rowId=rows.get(JSON.stringify([entry.id,message.id]));
      return rowId?[{entryId:entry.id,messageId:message.id,rowId,entryAt,messageAt}]:[];
    }));
  }
  private receivedRowMessageAt(row:TranscriptRow|undefined,entry:EntryView|undefined):number{
    if(!row||!entry||row.source.id!==entry.id)return -1;
    const messages=entry.messages??[];
    if(row.parts)return messages.findIndex(message=>row.parts?.has(message.id));
    const tool=row.steps?.tools[0];
    if(!tool||tool.owner!==entry.id||this.rows.calls.get(tool.callId)!==row.view.id)return -1;
    return messages.findIndex(message=>message.parts.some((part,at)=>(part.type==='toolCall'||part.type==='toolResult')&&part.callId===tool.callId&&tool.slot===slot(entry.id,message.id,at)));
  }
  receivedResult(direction:-1|1):ReceivedResult|undefined{
    if(this.destroyed||this.hidden()||this.deferred)return;
    const stops=this.loadedReceivedResults(),reading=this.geometryAnchor(),cursor=this.receivedResultCursor;
    if(!this.follow&&cursor&&cursor.anchorId===(reading?.id??null)&&cursor.offsetPx===(reading?.offsetPx??0)){
      const at=stops.findIndex(stop=>stop.entryId===cursor.entryId&&stop.messageId===cursor.messageId);
      if(at>=0)return stops[at+direction];
    }
    const anchored=this.restoring?.anchorId??reading?.id,row=anchored?this.rows.byId.get(anchored):undefined;
    const entryId=row?.source.id??anchored,entryAt=this.follow?this.chronological.length:this.chronological.findIndex(entry=>entry.id===entryId);
    const messageAt=this.receivedRowMessageAt(row,this.chronological[entryAt]);
    return direction<0?stops.findLast(stop=>stop.entryAt<entryAt||stop.entryAt===entryAt&&stop.messageAt<messageAt):stops.find(stop=>stop.entryAt>entryAt||stop.entryAt===entryAt&&stop.messageAt>messageAt);
  }
  jumpReceivedResult(direction:-1|1):boolean{
    const stop=this.receivedResult(direction);if(!stop)return false;
    this.revealEntry(stop.entryId,false,undefined,stop.rowId);
    const reading=this.geometryAnchor();this.receivedResultCursor={entryId:stop.entryId,messageId:stop.messageId,anchorId:reading?.id??null,offsetPx:reading?.offsetPx??0};
    return this.markNavigationEntry(stop.rowId);
  }
  private markNavigationEntry(id:string):boolean{
    const node=this.cache.get(id)?.node;if(!node)return false;
    this.clearOwnMessageMarker();node.classList.add('own-message-focus');
    this.ownMessageMarker={node,timer:setTimeout(()=>this.clearOwnMessageMarker(),1500)};
    return true;
  }
  private clearOwnMessageMarker():void{
    const marker=this.ownMessageMarker;if(!marker)return;
    clearTimeout(marker.timer);marker.node.classList.remove('own-message-focus');this.ownMessageMarker=undefined;
  }
  private revealRowId(entryId:string,callId?:string,rowId?:string):string|undefined{
    if(rowId===undefined)return callId?this.rows.calls.get(callId)??this.displayId(entryId):this.displayId(entryId);
    return this.rows.byId.get(rowId)?.source.id===entryId&&(callId===undefined||this.rows.calls.get(callId)===rowId)?rowId:undefined;
  }
  private expandedReferenceRow(entryId:string,callId?:string,rowId?:string):string|undefined {
    const id=this.revealRowId(entryId,callId,rowId);
    if(id===undefined||rowId!==undefined||!this.noticeBlocks.open(this.rows.owners.get(entryId)??entryId,this.expanded))return id;
    this.heights.clear();this.dirtyLayout=true;this.deriveRows();this.hooks.presentation([...this.expanded],this.showThinking,this.view,this.thinkingChoice);
    return this.revealRowId(entryId,callId,rowId);
  }
  revealEntry(entryId: string, focus = true, callId?: string, rowId?:string): void {
    this.ownMessageCursor=undefined;this.failedStepCursor=undefined;this.receivedResultCursor=undefined;
    if (!this.index.entries.has(entryId)) return;
    const id=this.expandedReferenceRow(entryId,callId,rowId);if(id===undefined)return;
    this.scrolling.delete(this.node);
    this.follow = false; this.pins.clear(); this.pins.add(entryId);
    const group=rowId===undefined?this.openEntryEvents(id,entryId):undefined;
    this.restoring = {revision: this.readingRevision, anchorId: callId || rowId ? id : entryId, offsetPx: 0, followTail: false}; this.paint();
    const session = this.cache.get(id)?.session;
    if (session && group) {
      session.events.page = Math.floor(group.entries.findIndex(member => member.id === entryId) / 32);
      this.renderEventPage(session.events, group.entries, 32); this.hooks.presentation([...this.expanded], this.showThinking);
      const member = session.events.cache.get(entryId)?.node ?? session.notices.cache.get(entryId)?.node;
      if (member) this.scrollTo(member.offsetTop - this.node.offsetTop);
    }
    this.refreshFind();
    const node = this.cache.get(id)?.node; if (focus && node) { node.tabIndex = -1; node.focus({preventScroll: true}); }
  }
  private openEntryEvents(id:string,entryId:string):SessionGroup|undefined{
    const group=this.entryEventGroup(id,entryId);if(!group)return;
    this.expanded.add(`events:${id}`);const run=this.rows.runs.get(id);
    if(run){this.expanded.add(run.key);const tool=run.tools[0]&&this.tools.get(run.tools[0].callId);if(tool){tool.node.open=true;tool.expanded.hidden=false;}}
    return group;
  }
  private entryEventGroup(id:string,entryId:string):SessionGroup|undefined{
    const run=this.rows.runs.get(id);
    return run?.events.some(entry=>entry.id===entryId)?{id,entries:run.events,notices:[]}:this.index.sessions.get(id);
  }
  private retireNode(node?: HTMLElement): void { if (node) { this.releaseFrames(node); node.remove(); } }
  private releaseFrames(root: HTMLElement): void {
    for (const node of this.outputNodes) if (root.contains(node)) {
      this.resize?.unobserve(node); this.outputNodes.delete(node); this.geometryDirty.delete(node);
    }
  }
  private replaceContent(root: HTMLElement, ...children: Node[]): void {
    this.releaseFrames(root); root.replaceChildren(...children); this.registerContent(root);
  }
  private inspection(title: string, source: () => string): HTMLDetailsElement {
    const node = inspection(title, source); this.registerContent(node); return node;
  }
  private presentationContext() {
    return {bounded, rawText, inspection: (title: string, source: () => string) => this.inspection(title, source),
      structured: (display: JsonDisplay) => { const node = structured(display); this.registerContent(node); return node; }};
  }
  preserveReading(): void { this.saveReading(); }
  private saveReading(): void {
    if (this.hidden() || this.restoring) return;
    const anchor = this.geometryAnchor(); this.reflowAnchor = anchor;
    this.hooks.reading({revision: this.readingRevision, anchorId: anchor?.id ?? null, offsetPx: anchor?.offsetPx ?? 0, followTail: this.follow});
  }
  private applyPendingView(): boolean {
    if (!this.pendingView || this.hasSelection()) return false;
    this.setView(this.pendingView); return true;
  }
  private refreshReferenceNames(): void {
    if (this.referenceNamesPending && !this.protectedNode(this.node)) { this.registerContent(this.node); this.referenceNamesPending = false; }
  }
  private paint(anchorOverride?: {id: string; offsetPx: number} | null): boolean {
    if (this.applyPendingView()) return !this.hidden();
    if (this.hidden()) { this.elapsed.stop(); return false; }
    // Current tail intent supersedes a saved reading position that has not reached the DOM yet.
    if (this.follow) this.restoring = undefined;
    // The reading being restored may not be loaded yet; what is on screen then is the anchor.
    const onScreen = this.restoring && !this.follow ? this.anchor() : null;
    if (this.dirtyLayout) { this.layout = layoutItems(this.displayed.map(entry => entry.id), this.heights, 140); this.dirtyLayout = false; }
    let anchor = this.geometryAnchor(anchorOverride);
    if (anchor && onScreen && !this.layout.byId.has(anchor.id)) anchor = onScreen;
    const scrollTop = this.prepareScroll();
    const pins = this.currentPins(); if (anchor) pins.add(anchor.id);
    const selected = visibleWindow(this.layout, scrollTop, this.node.clientHeight, {pins}).items;
    const children = this.children(selected); const mounted = new Set(children);
    for (const child of this.node.children) if (!mounted.has(child as HTMLElement)) this.releaseFrames(child as HTMLElement);
    reconcileChildren(this.node, children);
    this.refreshReferenceNames();
    this.refreshOperatorFolds();
    this.measure(selected);
    this.refreshGaps(selected);
    this.evict(new Set(selected.map(item => item.id)));
    this.refreshMountedTools();
    this.refreshMountedCommunications();
    this.refreshTurnActions();
    this.readVisibleTaskAnswers(new Set(selected.map(item=>item.id)));
    this.finishScroll(anchor);
    this.refreshFind();
    this.elapsed.sync();
    // Measurements and restored scroll positions can expose rows outside the window chosen above.
    const next = visibleWindow(this.layout, this.prepareScroll(), this.node.clientHeight, {pins}).items;
    if (next.length !== selected.length || next.some((item, index) => item.id !== selected[index]?.id)) this.schedule();
    return true;
  }
  private finishScroll(anchor: {id: string; offsetPx: number} | null): void {
    // A virtual-window paint must not compete with an active scroll gesture.
    if (this.scrolling.has(this.node)) { this.reflowAnchor = undefined; this.syncLatest(); return; }
    if (this.follow && !this.hasSelection()) this.scrollTo(this.node.scrollHeight);
    else this.restorePosition(anchor);
    if (!this.restoring) this.reflowAnchor = this.follow ? null : this.anchor();
    this.syncLatest();
  }
  /** The control that returns to the end shows what arrived while the reader was away; it hides at the end. */
  private syncLatest(): void {
    if (this.follow) this.arrivals.clear();
    this.latest.hidden = this.follow;
    const label = latestLabel(this.arrivals.count);
    const text = this.latest.querySelector('.latest-text') ?? this.latest;
    if (text.textContent !== label.text) text.textContent = label.text;
    this.latest.setAttribute('aria-label', label.accessible);
    this.latest.title = label.accessible;
  }
  /** An upward move that ends near the first loaded row asks for the next older page; the loader keeps its own one-page-at-a-time guard. */
  private readEarlier(upward: boolean): void {
    if (upward && this.earlierAvailable && !this.hidden() && this.node.scrollTop <= EARLIER_ZONE_PX) this.hooks.earlier?.();
  }
  /** Rows around the anchor can still change height for a moment after older entries land. Until the reader moves or the time passes, each frame puts the anchor back where it was. */
  private holdAnchor(anchor: {id: string; offsetPx: number} | null): void {
    if (!anchor) return;
    const queued = this.hold?.queued ?? false;
    this.hold = {anchor, until: performance.now() + ANCHOR_HOLD_MS, queued};
    if (!queued) this.stepHold();
  }
  private stepHold(): void {
    const hold = this.hold; if (!hold) return;
    hold.queued = true;
    this.frame(() => {
      hold.queued = false;
      if (this.hold !== hold) return;
      if (this.follow || this.scrolling.has(this.node) || performance.now() > hold.until) { this.hold = undefined; return; }
      if (!this.hidden()) this.restorePosition(hold.anchor);
      this.stepHold();
    });
  }
  entryForMessage(messageId: string): string | undefined {
    for (const entry of this.index.entries.values()) if (entry.messages?.some(message => message.id === messageId)) return entry.id;
    return;
  }
  /** Rows the reader can scroll through, for judging how much a page added. */
  rowCount(): number { return this.displayed.length; }
  private refreshMountedCommunications(): void {
    this.noticeBlocks.refresh();
    for (const entry of this.cache.values()) for (const message of entry.messages.values()) {
      if (this.protectedNode(message.node)) continue;
      if (message.source.communication) this.updateCommunication(message, message.source, entry.source?.id ?? '');
      else if (message.communication && entry.source) this.updateMessage(entry, message.source, entry.source);
    }
  }
  private updateCommunication(cached: MessageNode, message: MessageView, entryId: string): void {
    if (!cached.communication) {
      const generation = this.generation;
      cached.communication = new CommunicationCard(cached, {taskSender:()=>this.index.entries.get(entryId)?.sender,inputContent:(message,root)=>this.communicationInput(cached,message,root,entryId),subject:this.hooks.subject,senderCaption:this.hooks.senderCaption,senderSummary:this.hooks.senderSummary,thread:this.hooks.thread, operatorInput:this.hooks.operatorInput, structured:display=>presentResult(display,this.presentationContext()), reply:message=>{const task=this.tasks.replies.get(message);return task?.tool?{text:this.sentence(task.tool),open:()=>this.openTaskAnswer(task)}:undefined;}, active: () => !this.deferred && generation === this.generation && cached.node.isConnected && !this.hidden() && this.index.entries.get(entryId)?.messages?.includes(cached.source) === true, current: () => cached.source, result:this.hooks.result, protected: node => this.protectedNode(node), raw: source => partText(source.parts), expanded: key => this.expanded.has(key), disclosure: (key, open) => this.sourcePreference(key, open), layout: () => this.sourceLayout(entryId), reference: this.hooks.references ? (text, active) => this.hooks.references?.render(text, active) ?? element('span', undefined, typeof text === 'string' ? text : text.text) : undefined}, communicationDisclosureKeys(entryId, message.id));
    }
    if (cached.communication.sync(message)) {
      this.messageError(cached, message);
      const time = this.inputTimestamp(cached, message, this.index.entries.get(entryId));
      const root = cached.body.querySelector('.communication-text') ?? cached.body;
      if (time && !root.contains(time)) root.prepend(time);
      this.registerContent(cached.body);
    }
  }
  private communicationInput(cached: MessageNode, message: MessageView, root: HTMLElement, entryId: string): boolean {
    const supplied = message.parts.some((_part, index) => attachmentParts(message, index).some(part => part.type === 'image' && !!part.attachment));
    const retained = this.index.entries.get(entryId);
    if (!supplied && !this.operatorMessage(message,retained)) { this.pruneParts(cached, new Set()); return false; }
    const children = this.messagePartNodes(cached,message,entryId), time = this.inputTimestamp(cached,message,retained); if (time) children.unshift(time);
    this.reconcileContent(root,this.operatorContent(cached,message,retained,entryId,children)); return true;
  }
  private cancelTaskReads(): void {for(const [id,controller] of this.taskReads){controller.abort();this.taskReadStamps.delete(id);}this.taskReads.clear();}
  private readVisibleTaskAnswers(visible:ReadonlySet<string>):void {
    if(!this.hooks.readTaskResult)return;
    const shown=[...visible].flatMap(id=>this.rows.runs.get(id)?.tools??[]).reverse().flatMap(tool=>{const row=this.tasks.byCall.get(tool.callId);return row?.reference&&!row.answer?[row]:[];});
    const recent=this.tasks.sent.filter(row=>row.tool&&row.reference&&!row.answer).slice(0,RECENT_TASK_READS);
    const tasks=[...new Set([...recent,...shown])].slice(0,20);
    this.cancelOffscreenTaskReads(tasks);
    for(const task of tasks){if(this.taskReads.size>=TASK_READ_CONCURRENCY)break;this.startTaskRead(task);}
  }
  private cancelOffscreenTaskReads(tasks:readonly ConversationTask[]):void{
    const wanted=new Set(tasks.map(task=>task.tool?.callId));
    for(const [id,controller] of this.taskReads)if(!wanted.has(id)){controller.abort();this.taskReads.delete(id);this.taskReadStamps.delete(id);}
  }
  private rememberTaskRead(callId:string,stamp:string):void{
    this.taskReadStamps.set(callId,stamp);if(this.taskReadStamps.size>200){const first=this.taskReadStamps.keys().next().value;if(first)this.taskReadStamps.delete(first);}
  }
  private startTaskRead(task:ConversationTask):void{
    const tool=task.tool,reference=task.reference;if(!tool||!reference||this.taskReads.has(tool.callId)||!this.hooks.readTaskResult)return;
    const stamp=JSON.stringify([reference,this.tasks.incomingRevision]);if(this.taskReadStamps.get(tool.callId)===stamp)return;
    this.rememberTaskRead(tool.callId,stamp);
    const controller=new AbortController(),generation=this.generation;this.taskReads.set(tool.callId,controller);
    void this.hooks.readTaskResult(reference,controller.signal).then(value=>{if(!controller.signal.aborted&&!this.destroyed&&generation===this.generation&&this.tasks.recordResult(tool.callId,value)){this.schedule();this.hooks.tasksChanged?.();}}).catch(()=>{/* A failed read is not a failed recipient task; Refresh tasks retries the exact reference. */}).finally(()=>{if(this.taskReads.get(tool.callId)===controller){this.taskReads.delete(tool.callId);if(!this.destroyed&&generation===this.generation)this.schedule();}});
  }
  private refreshMountedTools(): void {
    for (const tool of this.tools.values()) if (tool.source && tool.node.open && this.node.contains(tool.card)) {
      if (tool.documentSource !== tool.source || tool.argumentsSource !== tool.source) this.expandTool(tool);
      else this.refreshToolInspections(tool, tool.source);
    }
  }
  private prepareScroll(): number {
    const saved = this.readingAnchor();
    if (this.restoring && (!saved || this.layout.byId.has(saved.id))) return restoreAnchor(this.layout, saved, this.node.clientHeight);
    return this.follow ? Math.max(0, this.layout.totalHeight - this.node.clientHeight) : this.node.scrollTop;
  }
  private readingAnchor(): {id: string; offsetPx: number} | null {
    const value = this.restoring;
    return value?.anchorId ? {id: this.displayId(value.anchorId), offsetPx: value.offsetPx} : null;
  }
  private restorePosition(anchor: {id: string; offsetPx: number} | null): void {
    const saved = this.readingAnchor();
    const original = saved && this.layout.byId.has(saved.id) ? saved : anchor ?? saved;
    const wanted = original ? {id: this.displayId(original.id), offsetPx: original.offsetPx} : null;
    const node = wanted && this.cache.get(wanted.id)?.node;
    const item = wanted && this.layout.byId.get(wanted.id);
    if (node?.isConnected && wanted && item) {
      const position = restoreAnchor(this.layout, wanted, 0);
      this.scrollTo(this.rowStart(node) + position - item.top);
    }
    if (this.restoring && (!this.restoring.anchorId || original === saved && node?.isConnected)) this.restoring = undefined;
  }
  private currentPins(): Set<string> {
    const pins = new Set([...this.pins].map(id => this.displayId(id))); const selection = document.getSelection();
    for (const [id, entry] of this.cache) {
      if (entry.node.contains(document.activeElement) || entry.node.contains(selection?.anchorNode ?? null) || entry.node.contains(selection?.focusNode ?? null)) pins.add(this.displayId(id));
      if ([...entry.node.querySelectorAll<HTMLDetailsElement>('details[open]')].some(node => !node.dataset.disclosure || node.classList.contains('tool-inspection'))) pins.add(id);
    }
    if (this.restoring?.anchorId) pins.add(this.displayId(this.restoring.anchorId));
    return pins;
  }
  private gap(key: string, height: number): HTMLElement {
    let node = this.gaps.get(key);
    if (!node) { node = element('div', 'spacer'); node.setAttribute('aria-hidden', 'true'); this.gaps.set(key, node); }
    node.style.height = `${height}px`; return node;
  }
  private children(items: LayoutItem[]): HTMLElement[] {
    const children:NoticeChild[]=this.lead ? [{node:this.lead}] : [];let offset=0;
    for(const item of items) {
      if(item.top > offset)children.push({node:this.gap(item.id,item.top-offset)});
      const entry=this.displayed[item.index];if(!entry)continue;
      const node=this.updateEntry(entry,item.index);
      for(const message of this.cache.get(entry.id)?.messages.values() ?? [])this.noticeBlocks.decorate(entry.id,message.communication);
      children.push({node,id:entry.id});offset=item.bottom;
    }
    if(offset < this.layout.totalHeight)children.push({node:this.gap('tail',this.layout.totalHeight-offset)});
    const keep=new Set(children.map(child=>child.node));for(const [key,node]of this.gaps)if(!keep.has(node))this.gaps.delete(key);
    return this.noticeBlocks.wrap(children);
  }
  private refreshGaps(items: LayoutItem[]): void {
    let offset = 0;
    for (const old of items) {
      const item = this.layout.byId.get(old.id); if (!item) continue;
      const gap = this.gaps.get(item.id); if (gap) gap.style.height = `${Math.max(0, item.top - offset)}px`;
      offset = item.bottom;
    }
    const tail = this.gaps.get('tail'); if (tail) tail.style.height = `${Math.max(0, this.layout.totalHeight - offset)}px`;
  }
  private measure(items: LayoutItem[]): void {
    const measurements = new Map<string, number>();
    for (const item of items) {
      const measured=this.cache.get(item.id)?.node.offsetHeight;
      const height=measured ? measured+this.noticeBlocks.overhead(item.id) : undefined;
      if (height && height > 0 && this.heights.get(item.id) !== height) { this.heights.set(item.id, height); measurements.set(item.id, height); }
    }
    updateHeights(this.layout, measurements);
  }
  private prune(): void {
    for (const [id, entry] of this.cache) if (!this.rows.byId.has(id)) { this.releaseFrames(entry.node); entry.node.remove(); this.cache.delete(id); this.pins.delete(id); }
    for (const id of this.index.changed) if (!this.index.entries.has(id)) this.heights.delete(id);
    for (const [id, tool] of this.tools) if (!this.joined.has(id)) { this.releaseToolGeometry(tool); tool.card.remove(); this.tools.delete(id); }
  }
  private evict(mounted: ReadonlySet<string>): void {
    const offscreen = [...this.cache.keys()].filter(id => !mounted.has(id));
    for (const id of offscreen.slice(0, Math.max(0, offscreen.length - 32))) { const entry = this.cache.get(id); if (entry) this.releaseFrames(entry.node); this.cache.delete(id); }
    for (const [id, tool] of this.tools) {
      const owner = this.rows.calls.get(id) ?? this.joined.get(id)?.owner;
      if (!owner || !this.cache.has(owner)) { this.releaseToolGeometry(tool); tool.card.remove(); this.tools.delete(id); }
    }
  }
  private entryCacheNode(id:string):EntryNode{
    let cached=this.cache.get(id);
    if(!cached){const node=element('div','entry');node.dataset.entryId=id;node.style.display='flow-root';cached={node,messages:new Map()};this.cache.set(id,cached);}
    return cached;
  }
  private turnMessageMenus(actions:TurnSource,origin:HTMLElement):MessageMenuActions[] {
    const turn=this.currentTurn(actions);if(!turn)return [];
    const owners:MessageMenuActions[]=[];
    for(const row of this.displayed){
      if(this.turnRows.get(row.id)!==turn)continue;
      const entry=this.cache.get(row.id);if(!entry)continue;
      for(const message of entry.messages.values())if(message.source.role==='assistant'){
        const menu=this.messageMenuActions(entry,message.source.id,origin,true);
        if(menu)owners.push(menu);
      }
    }
    return owners;
  }
  private turnAsk(actions:TurnSource,owners:MessageMenuActions[]):TurnActions['askAction'] {
    const menu=owners.findLast(owner=>owner.ask);
    if(menu?.ask)return {item:menu.ask,valid:menu.valid};
    const input=this.currentTurn(actions)?.input,entry=input&&this.cache.get(this.displayId(input.entry.id));
    if(!input||!entry||entry.messages.get(input.message.id)?.source!==input.message||!this.currentTurnMessage(input))return;
    const source=this.messageMenuActions(entry,input.message.id,actions.node??entry.node);
    return source?.ask?{item:source.ask,valid:source.valid}:undefined;
  }
  private refreshTurnActions():void {
    for(const cached of this.cache.values())if(cached.turnActions){
      const actions=cached.turnActions,owners=this.turnMessageMenus(actions,actions.more);
      actions.askAction=this.turnAsk(actions,owners);
      actions.ask.hidden=!actions.askAction;actions.ask.disabled=actions.askAction?.item.enabled===false;
      const reason=actions.askAction?.item.description;
      actions.ask.title=reason?`Ask in Primary: ${reason}`:'Ask in Primary';
      actions.more.disabled=!owners.some(owner=>owner.items.length);
    }
  }
  private turnMenu(actions:TurnActions):void {
    const snapshot:TurnSource={turn:actions.turn,generation:actions.generation,node:actions.node};
    const owners=this.turnMessageMenus(snapshot,actions.more),ask=this.turnAsk(snapshot,owners);
    const items=owners.flatMap((owner,at)=>owner.items.filter(item=>item!==ask?.item).map((item,index)=>({...item,
      heading:!index&&owners.length>1?`Message ${at+1}`:item.heading,separatorBefore:!index&&at>0||item.separatorBefore})));
    const valid=()=>snapshot.generation===this.generation&&this.currentTurn(actions)?.key===snapshot.turn.key&&owners.every(owner=>owner.valid());
    if(!valid())return;
    const box=actions.more.getBoundingClientRect();
    contextMenu.open(actions.more,{x:box.right,y:box.bottom},'Message actions',items,valid);
  }
  private currentTurn(actions: TurnSource): AssistantTurn | undefined {
    if (this.deferred || this.hidden() || actions.generation !== this.generation || actions.node && !this.node.contains(actions.node)) return;
    const turn = actions.turn;
    return turn.end && this.turnRows.get(turn.end) === turn ? turn : undefined;
  }
  private currentTurnMessage(source: TurnMessage): boolean {
    return this.index.entries.get(source.entry.id)?.messages?.find(message => message.id === source.message.id) === source.message;
  }
  private lastCopyTurn():AssistantTurn|undefined {
    if(this.destroyed||this.deferred||this.hidden())return;
    const turns=new Map<MessageView,AssistantTurn>();
    for(const turn of this.turnRows.values())if(turn.copy&&this.currentTurnMessage(turn.copy)&&this.currentTurn({turn,generation:this.generation}))turns.set(turn.copy.message,turn);
    const message=this.chronological.flatMap(entry=>entry.messages??[]).findLast(message=>turns.has(message)&&!!messageCopyText(message,value=>partText(value.parts)));
    return message?turns.get(message):undefined;
  }
  lastAnswerCopy():(()=>void)|undefined {
    const turn=this.lastCopyTurn(),source=turn?.copy,generation=this.generation;if(!turn||!source||!this.currentTurnMessage(source))return;
    return ()=>{
      const current=this.lastCopyTurn();
      if(generation!==this.generation||current?.key!==turn.key||current.copy?.message!==source.message||current.copy.entry.id!==source.entry.id)return;
      this.copyTurn({turn:current,generation});
    };
  }
  private copyTurn(actions: TurnSource, into:HTMLElement=this.node): void {
    const source = this.currentTurn(actions)?.copy; if (!source || !this.currentTurnMessage(source)) return;
    const text = messageCopyText(source.message,message => partText(message.parts)); if (text) void copy(text,into);
  }
  private forkTurn(actions: TurnActions): void {
    const source = this.currentTurn(actions)?.input;
    if (source && this.currentTurnMessage(source) && this.forkEligible(source.entry,source.message)) this.hooks.fork?.(source.message,source.entry.id);
  }
  private updateTurnFooter(cached: EntryNode, entryId: string): void {
    const turn = this.turnRows.get(entryId);
    if (turn) cached.node.dataset.assistantTurn = turn.key; else delete cached.node.dataset.assistantTurn;
    if (!turn || turn.end !== entryId) { if (cached.turnActions) cached.turnActions.node.hidden = true; return; }
    let actions = cached.turnActions;
    if (!actions) {
      const node = element('div','assistant-turn-actions');
      const copy = cardAction('copy','Copy',()=>{ if (cached.turnActions) this.copyTurn(cached.turnActions,cached.turnActions.copy); });
      const fork = cardAction('fork','Fork',()=>{ if (cached.turnActions) this.forkTurn(cached.turnActions); });
      const ask=cardAction('message','Ask in Primary',()=>{const current=cached.turnActions;if(current&&this.currentTurn(current)&&current.askAction?.valid())current.askAction.item.run();});ask.hidden=true;
      const more=cardAction('menu','More',()=>{if(cached.turnActions)this.turnMenu(cached.turnActions);});
      more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');
      node.append(copy,fork,ask,more); actions = {node,copy,fork,ask,more,turn,generation:this.generation}; cached.turnActions = actions;
    }
    actions.turn = turn; actions.generation = this.generation;
    actions.copy.disabled = !turn.copy || !messageCopyText(turn.copy.message,message => partText(message.parts));
    actions.fork.hidden = !turn.input || !this.forkEligible(turn.input.entry,turn.input.message);
    actions.node.hidden = false;
  }
  private entryTimestamp(entry?: EntryView): number | undefined {
    if (!entry) return;
    const row = this.rows.byId.get(entry.id);
    for (const message of (row?.source ?? entry).messages ?? []) {
      if (row?.parts && !row.parts.has(message.id)) continue;
      if (typeof message.timestamp === 'number' && isValidTimestamp(message.timestamp)) return message.timestamp;
    }
    return;
  }
  /** A boundary belongs to the preceding row so added history leaves the following content anchor intact. */
  private updateDayDivider(cached: EntryNode, entry: EntryView, index: number): void {
    const gapAt=this.timeGaps.get(entry.id),before = this.entryTimestamp(entry), after = gapAt??this.entryTimestamp(this.displayed[index + 1]);
    if ((before === undefined&&gapAt===undefined) || after === undefined) { cached.dayDivider = undefined; return; }
    const previous = new Date(before??after), date = new Date(after);
    const gap=gapAt!==undefined;
    if (previous.toDateString() === date.toDateString()&&!gap) { cached.dayDivider = undefined; return; }
    cached.dayDivider ??= element('time','transcript-day-divider');
    const divider = cached.dayDivider;
    divider.dateTime = date.toISOString(); divider.title = timestampDetails(date).display;divider.dataset.gap=String(gap);
    setText(divider,previous.toDateString()===date.toDateString()?clockTime(after):date.toDateString() === new Date().toDateString() ? 'Today' : `${formatDate(date,{weekday:'long'})} ${formatDate(date,{day:'numeric',month:'short'})}`);
  }
  private updateEntry(entry: EntryView, index: number): HTMLElement {
    const cached = this.entryCacheNode(entry.id),summary=this.noticeBlocks.summary(entry.id);
    cached.node.classList.toggle('received-notice-summary',!!summary);
    this.updateDayDivider(cached,entry,index);
    if(summary){cached.source=this.rows.byId.get(entry.id)?.source??entry;this.reconcileContent(cached.node,[summary,...(cached.dayDivider?[cached.dayDivider]:[])]);return cached.node;}
    this.updateTurnFooter(cached,entry.id);
    return this.entryContent(entry);
  }
  private entryTail(cached: EntryNode): HTMLElement[] {
    const children: HTMLElement[] = [];
    if (cached.turnActions && !cached.turnActions.node.hidden) {
      const failed=[...cached.messages.values()].findLast(message=>message.failure);
      cached.turnActions.copy.hidden=!!failed?.failure&&cached.turnActions.copy.disabled;
      cardActionLabel(cached.turnActions.copy,'Copy');children.push(cached.turnActions.node);
    }
    if (cached.dayDivider) children.push(cached.dayDivider);
    return children;
  }
  private entryContent(entry: EntryView): HTMLElement {
    const cached=this.entryCacheNode(entry.id);
    const row = this.rows.byId.get(entry.id);
    if (row?.steps) {
      this.updateSteps(cached, row.steps, row.source, row.actionsOnly ? row.parts : undefined); cached.source = row.source;
      return cached.node;
    }
    entry = row?.source ?? entry;
    const session = this.index.sessions.get(entry.id);
    if (session) cached.node.classList.add('session-event-group'); else cached.node.classList.remove('session-event-group');
    if (session) this.updateSession(cached, session);
    else { if (cached.session) cached.custom = undefined; cached.session = undefined; this.updateCustom(cached, entry); }
    const children: HTMLElement[] = cached.custom ? [cached.custom] : [];
    if (!row?.parts) children.push(...this.entryToolChildren(entry));
    children.push(...this.updateMessages(cached, entry, row?.parts, row?.actionsOnly));
    setEntryRhythm(cached.node, children, session !== undefined);
    const header = this.groupHeader(cached, entry.id); if (header) children.unshift(header);
    children.push(...this.entryTail(cached));
    reconcileChildren(cached.node, children); this.registerContent(cached.node); cached.source = entry; return cached.node;
  }
  private updateMessages(cached: EntryNode, entry: EntryView, parts?: Map<string, Set<number>>, actionsOnly = false): HTMLElement[] {
    const children: HTMLElement[] = [], ids = new Set<string>();
    for (const message of entry.messages ?? []) {
      if (actionsOnly ? !parts?.has(message.id) : !this.rowMessageVisible(entry.id, message, parts)) continue;
      const current = this.updateMessage(cached, message, entry, parts?.get(message.id));
      if (actionsOnly) {current.node.classList.add('tool-only'); current.heading.hidden = true;}
      ids.add(message.id); children.push(current.node);
    }
    this.pruneMessages(cached, ids); return children;
  }
  private rowMessageVisible(entryId:string,message:MessageView,parts?:Map<string,Set<number>>):boolean{
    return !(parts&&!parts.has(message.id)||!presentMessage(message).visible||this.joinedMessage(entryId,message));
  }
  private updateSteps(cached:EntryNode,run:StepRun,entry:EntryView,parts?:Map<string,Set<number>>):void{
    cached.node.classList.add('compact-entry');
    const children=parts?this.updateMessages(cached,entry,parts,true):[];
    if(!parts)this.pruneMessages(cached,new Set());
    children.push(...run.tools.map(tool=>this.updateTool(tool)));this.stepEvents(cached,run);
    children.push(...this.entryTail(cached));
    reconcileChildren(cached.node,children);this.registerContent(cached.node);
  }
  private stepEvents(cached:EntryNode,run:StepRun):void{
    if(!run.events.length){cached.session?.details.remove();return;}
    this.updateSession(cached,{id:cached.node.dataset.entryId??run.key,entries:run.events,notices:[]});
    const source=run.tools[0],tool=source&&this.tools.get(source.callId);
    if(cached.session&&tool)tool.technical.append(cached.session.details);
  }
  private sentence(tool: JoinedTool): string {return toolSentence(tool,{subject:this.hooks.subject,cwd:this.hooks.cwd?.(),nestedCount:this.rows.nestedCounts.get(tool.callId)});}
  private entryToolChildren(entry: EntryView): HTMLElement[] {
    if (!entry.tool) return [];
    const children: HTMLElement[] = [], tool = this.joined.get(entry.tool.callId);
    if (tool?.owner === entry.id) children.push(this.updateTool(tool));
    if (entry.tool.coverage.truncated) children.push(element('p', 'secondary message-coverage', 'Some tool output or arguments are not shown.'));
    return children;
  }
  private groupHeader(cached: EntryNode, entryId: string): HTMLElement | undefined {
    const group = this.view === 'grouped' ? this.groups.header(entryId) : undefined;
    if (this.view === 'grouped' && this.groups.membership.has(entryId)) cached.node.classList.add('transcript-group-member');
    else cached.node.classList.remove('transcript-group-member');
    if (group) {
      if (!cached.groupHeader) { cached.groupHeader = element('div', 'transcript-group-header'); cached.groupHeader.append(element('span', 'transcript-group-label'), element('span', 'transcript-group-coverage')); }
      const label = cached.groupHeader.children[0] as HTMLElement; const coverage = cached.groupHeader.children[1] as HTMLElement;
      setText(label, `${group.group.kind === 'thread' ? 'Thread' : 'Request'}: ${bounded(group.group.label, 512)}`);
      setText(coverage, `${group.count} loaded ${group.count === 1 ? 'entry' : 'entries'}`);
      cached.groupHeader.dataset.groupKey = group.group.key; return cached.groupHeader;
    }
    return undefined;
  }
  private pruneMessages(entry: EntryNode, ids: ReadonlySet<string>): void {
    for (const [id, message] of entry.messages) if (!ids.has(id)) { this.releaseFrames(message.node); entry.messages.delete(id); }
  }
  private messageError(cached: MessageNode, message: MessageView): string {
    const shown = errorPresentation(message);
    cached.error.className = `${shown.warning ? 'warning' : 'error'} message-error`; cached.error.hidden = !shown.summary;
    const failed=failedResponse(message,shown);
    cached.node.classList.toggle('response-failure-message',failed);
    if(failed)return this.responseFailure(cached,message,shown.diagnostic);
    if(cached.failure){cached.header.append(cached.actions);cached.failure.node.remove();cached.failure=undefined;}
    if (!shown.summary) return '';
    let summary = cached.error.querySelector<HTMLElement>('.response-error-summary');
    if (!summary) { summary = element('span', 'response-error-summary'); cached.error.append(summary); }
    setText(summary, bounded(shown.summary, 4096));
    let diagnostic = cached.error.querySelector<HTMLDetailsElement>('details');
    if (shown.diagnostic) {
      if (!diagnostic) { diagnostic = details('Details', ''); cached.error.append(diagnostic); }
      const body = diagnostic.querySelector('pre'); if (body) setText(body, bounded(shown.diagnostic));
    } else diagnostic?.remove();
    return shown.summary;
  }
  private responseFailure(cached:MessageNode,message:MessageView,diagnostic?:string):string {
    if(this.protectedNode(cached.error))return 'Response failed';
    if(!cached.failure){const generation=this.generation;cached.failure=new ResponseFailure(()=>generation === this.generation && !this.deferred && this.node.contains(cached.node),()=>this.sourceLayout(cached.node.closest<HTMLElement>('.entry')?.dataset.entryId ?? ''));cached.error.replaceChildren(cached.failure.node);}
    cached.failure.update(diagnostic ?? (message.stopReason ? `Stop reason: ${message.stopReason}` : ''));
    cached.failure.actions.append(cached.actions);return 'Response failed';
  }
  private joinedMessage(entryId: string, message: MessageView): boolean {
    if (message.error || !message.parts.length) return false;
    return message.parts.every((part, index) => {
      if (part.type !== 'toolResult') return false;
      const tool = this.joined.get(part.callId);
      return !!tool && tool.slot !== slot(entryId, message.id, index);
    });
  }
  private visibleEntry(entry: EntryView): boolean {
    if (this.initialSettings.has(entry.id) && entry.id !== this.findId) return false;
    if (!entryVisible(entry)) return false;
    if (entry.data || !entry.messages?.length) return true;
    return entry.messages.some(message => presentMessage(message).visible && !this.joinedMessage(entry.id, message));
  }
  private displayId(id: string): string {
    const row = this.rows.owners.get(id); if (row) return this.noticeBlocks.alias(row);
    if (this.rows.byId.has(id)) return this.noticeBlocks.alias(id);
    const session = this.index.sessionOwners.get(id); if (session) return session;
    if (this.visible.get(id)) return id;
    const entry = this.index.entries.get(id);
    for (const message of entry?.messages ?? []) for (const part of message.parts) {
      if (part.type === 'toolResult') return this.joined.get(part.callId)?.owner ?? id;
    }
    return id;
  }
  private eventPage(entries: () => readonly EntryView[], size: number, notice = false): EventPage {
    const node = element('div', 'session-events-body'); const rows = element('div');
    const page: EventPage = {node, rows, page: 0, cache: new Map(), previous: button(notice ? 'Previous notices' : 'Previous events', () => change(-1)), next: button(notice ? 'Next notices' : 'Next events', () => change(1))};
    const change = (delta: number) => { page.page += delta; this.renderEventPage(page, entries(), size, notice); this.schedule(); };
    node.append(rows, page.previous, page.next); return page;
  }
  private renderEventPage(page: EventPage, entries: readonly EntryView[], size: number, notice = false): void {
    page.page = Math.max(0, Math.min(page.page, Math.ceil(entries.length / size) - 1));
    const start = page.page * size; const wanted: HTMLElement[] = []; const ids = new Set<string>();
    for (const entry of entries.slice(start, start + size)) {
      let cached = page.cache.get(entry.id);
      if (!cached || cached.source !== entry && !this.protectedNode(cached.node)) {
        if (cached) this.releaseFrames(cached.node);
        const node = presentEntry(entry, {...this.presentationContext(), bounded: (text, limit = 1024) => bounded(text, Math.min(limit, 1024)),
          inspection: (title, source) => this.inspection(title, () => bounded(source(), 8192))});
        this.registerContent(node);
        node.dataset.sessionEventId = entry.id; if (notice) node.classList.add('warning');
        cached = {source: entry, node}; page.cache.set(entry.id, cached);
      }
      this.registerContent(cached.node); ids.add(entry.id); wanted.push(cached.node);
    }
    for (const [id, cached] of page.cache) if (!ids.has(id)) { this.releaseFrames(cached.node); page.cache.delete(id); }
    reconcileChildren(page.rows, wanted);
    page.previous.hidden = start === 0; page.next.hidden = start + size >= entries.length;
  }
  private protectedNode(node: HTMLElement): boolean {
    const selection = document.getSelection();
    return node.contains(document.activeElement) || !!selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode));
  }
  private updateSession(cached: EntryNode, group: SessionGroup): void {
    let session = cached.session;
    if (!session) {
      const details = element('details', 'session-events'); const id = `events:${group.id}`;
      details.dataset.disclosure = id; details.append(element('summary'));
      session = {details, events: this.eventPage(() => cached.session?.source?.entries ?? [], 32), notices: this.eventPage(() => cached.session?.source?.notices ?? [], 16, true)};
      cached.session = session; cached.custom = element('section', 'transcript-event'); cached.custom.append(session.notices.node, details);
      details.addEventListener('toggle', () => {
        const current = cached.session; if (!current?.source) return;
        if (details.open) { this.renderEventPage(current.events, current.source.entries, 32); details.append(current.events.node); }
        else this.retireNode(current.events.node);
      });
      this.trackDisclosure(details, id);
    }
    session.source = group;
    session.details.dataset.disclosure = `events:${group.id}`;
    const summary = session.details.querySelector('summary');
    if (summary && !this.protectedNode(summary)) setText(summary, sessionEventsSummary(group.entries));
    session.notices.node.hidden = !group.notices.length;
    if (group.notices.length) this.renderEventPage(session.notices, group.notices, 16, true);
    else this.reconcileContent(session.notices.rows, []);
    session.details.open = this.expanded.has(`events:${group.id}`);
    if (session.details.open) { this.renderEventPage(session.events, group.entries, 32); session.details.append(session.events.node); }
  }
  private updateCustom(cached: EntryNode, entry: EntryView): void {
    // A browser-owned input copy shows its delivery beside the role label, not a record section.
    if (entry.tool || entry.kind === 'ui.input' || !entry.data && entry.messages?.length) { cached.custom = undefined; return; }
    if (cached.source === entry) return;
    if (cached.source?.data !== entry.data || cached.source?.head !== entry.head || !cached.custom) {
      if (cached.custom) this.releaseFrames(cached.custom);
      cached.custom = presentEntry(entry, this.presentationContext()); this.registerContent(cached.custom);
    }
  }
  private currentMessage(entry: EntryNode | undefined, id: string, node: HTMLElement, generation: number): MessageNode | undefined {
    const current = entry?.messages.get(id);
    const source = this.index.entries.get(entry?.source?.id ?? '')?.messages?.find(message => message.id === id);
    if (this.deferred || generation !== this.generation || !node.isConnected || this.hidden() || !current || current.node !== node || current.source !== source) return;
    return current;
  }
  private copyMessage(entry: EntryNode, id: string, node: HTMLElement, generation: number): void {
    const current = this.currentMessage(entry, id, node, generation); if (!current) return;
    if (current.communication && !current.communication.current()) return;
    const text = messageCopyText(current.source, source => partText(source.parts)); if (text) void copy(text, node);
  }
  private createMessage(entry: EntryNode, message: MessageView): MessageNode {
    const node = element('article', `message ${message.role === 'user' ? 'user' : ''}`); node.dataset.role = message.role;
    const header = element('div', 'message-header');
    const label = presentMessage(message, this.hooks.operatorInput).label;
    const heading = element('span', 'message-role', bounded(label, 4096)); heading.hidden = !label;
    const delivery = element('span', 'message-delivery'); delivery.hidden = true;
    const actions = element('div', 'message-actions'); const body = element('div', 'message-body'); const error = element('div', 'error message-error'); error.hidden = true;
    node.setAttribute('aria-label', bounded(messageAriaLabel(message, this.hooks.operatorInput), 4096));
    const menu = cardAction('menu', 'Message actions', () => this.messageMenu(entry, message.id, menu), 'message-menu');
    menu.setAttribute('aria-label', 'Message actions'); menu.title = 'Message actions'; menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-expanded', 'false');
    actions.hidden=message.role==='assistant';actions.append(menu); header.append(heading, delivery, actions); node.append(header, body, error);
    const cached = {node, header, heading, delivery, actions, body, error, menu, forkRevision: 0, parts: new Map<string, PartNode>(), source: message}; entry.messages.set(message.id, cached); return cached;
  }
  private operatorMessage(message: MessageView, retained?: EntryView): boolean {
    return message.role === 'user' && (this.hooks.operatorInput === true || retained?.kind === 'ui.input') && !retained?.sender && (!message.communication || message.communication.state === 'unresolved');
  }
  private operatorContent(cached: MessageNode, message: MessageView, retained: EntryView | undefined, entryId: string, children: HTMLElement[]): HTMLElement[] {
    if (!this.operatorMessage(message,retained)) return children;
    let fold = cached.inputFold;
    if (!fold) {
      const content = element('div','operator-message-content'), viewport = element('div','operator-message-viewport'); viewport.append(content);
      const toggle = button('',()=>this.toggleOperatorFold(cached,entryId),'operator-message-toggle'); toggle.hidden = true;
      fold = {content,viewport,toggle,key:`input-fold:${communicationDisclosureKeys(entryId,message.id)[0]}`}; cached.inputFold = fold;
      viewport.dataset.folded = String(!this.expanded.has(fold.key));
    }
    if (fold.source !== message) {
      if (!fold.source || JSON.stringify(fold.source.parts) !== JSON.stringify(message.parts)) fold.lines = undefined;
      fold.source = message;
    }
    this.reconcileContent(fold.content,children);
    return [fold.viewport,fold.toggle];
  }
  private toggleOperatorFold(cached: MessageNode, entryId: string): void {
    const fold = cached.inputFold, retained = this.index.entries.get(entryId), message = retained?.messages?.find(item=>item.id===cached.source.id);
    if (!fold || message !== cached.source || !this.operatorMessage(message,retained) || this.deferred || !this.node.contains(cached.node)) return;
    this.sourceLayout(entryId); this.sourcePreference(fold.key,!this.expanded.has(fold.key)); this.paintOperatorFold(fold);
  }
  private measureOperatorFold(fold: OperatorFold, width: number): void {
    if (fold.lines === undefined || fold.width !== width) {
      const rect = fold.content.getBoundingClientRect(), lineHeight = Number.parseFloat(getComputedStyle(fold.content).lineHeight);
      if (!rect.width || !Number.isFinite(lineHeight) || lineHeight <= 0) return;
      fold.lines = Math.ceil(rect.height / lineHeight); fold.width = width;
    }
    this.paintOperatorFold(fold);
  }
  private paintOperatorFold(fold: OperatorFold): void {
    if (fold.lines === undefined) return;
    const open = this.expanded.has(fold.key), long = fold.lines > 12, folded = String(long && !open);
    if (fold.viewport.dataset.folded !== folded) fold.viewport.dataset.folded = folded;
    fold.toggle.hidden = !long;
    if (fold.toggle.getAttribute('aria-expanded') !== String(open)) fold.toggle.setAttribute('aria-expanded',String(open));
    setText(fold.toggle,open?'Show less':`Show ${Math.max(0,fold.lines-8)} more lines`);
  }
  private refreshOperatorFolds(): void {
    if (this.hidden() || this.scrolling.has(this.node)) return;
    const width = this.node.clientWidth;
    for (const entry of this.cache.values()) for (const cached of entry.messages.values()) {
      if (cached.inputFold?.content.isConnected && !this.protectedNode(cached.node)) this.measureOperatorFold(cached.inputFold, width);
    }
  }
  private inputTimestamp(cached: MessageNode, message: MessageView, retained?: EntryView): HTMLElement | undefined {
    if (!this.operatorMessage(message,retained) || message.timestamp === undefined || !isValidTimestamp(message.timestamp)) { cached.inputTime?.remove(); return undefined; }
    const exact = new Date(message.timestamp).toISOString();
    cached.inputTime ??= element('time', 'operator-message-time');
    const time = cached.inputTime;
    if (time.getAttribute('datetime') !== exact) {
      time.setAttribute('datetime', exact); time.title = timestampDetails(message.timestamp).display; setText(time, clockTime(message.timestamp));
    }
    return time;
  }
  private communicationMessage(cached: MessageNode, message: MessageView, entryId: string): boolean {
    if (message.communication) {
      cached.source = message;
      if (!this.protectedNode(cached.node)) this.updateCommunication(cached, message, entryId);
      cached.actions.hidden = message.role==='assistant'; return true;
    }
    if (!cached.communication) return false;
    cached.source = message;
    if (this.protectedNode(cached.node)) return true;
    cached.communication.dispose(); cached.communication = undefined; return false;
  }
  private updateMessage(entry: EntryNode, message: MessageView, retained: EntryView, selected?: ReadonlySet<number>): MessageNode {
    const entryId = retained.id;
    const cached = entry.messages.get(message.id) ?? this.createMessage(entry, message);
    const error = this.messageError(cached, message);
    if (this.communicationMessage(cached, message, entryId)) return cached;
    this.messageHeading(cached, message, retained);
    cached.node.classList.toggle('extension-notice', message.role === 'custom');
    const delivery = inputDelivery(retained);
    setText(cached.delivery, delivery ? `· ${delivery}` : ''); cached.delivery.hidden = !delivery;
    const children = this.messagePartNodes(cached, message, entryId, selected);
    const time = this.inputTimestamp(cached, message, retained); if (time) children.unshift(time);
    const displayed = this.operatorContent(cached,message,retained,entryId,this.groupThinking(cached,children));
    if (message.coverage.truncated || message.coverage.omitted > 0 || !message.coverage.complete) {
      const reason = bounded(message.coverage.reason ?? '', 4096, 6).trim();
      const notice = element('p', 'secondary message-coverage', message.role === 'toolResult' ? 'Some tool output is unavailable. See Source for details.' : reason || 'Some message content is not shown.');
      displayed.push(notice);
    }
    if (cached.inspection) { this.updateOrdinarySource(cached, message); displayed.push(cached.inspection); }
    this.reconcileContent(cached.body, displayed);
    this.updateMessageLayout(cached, displayed, error);
    cached.source = message; return cached;
  }
  private messageHeading(cached: MessageNode, message: MessageView, retained: EntryView): void {
    if (this.protectedNode(cached.heading)) return;
    const sender = message.role === 'user' && !this.hooks.operatorInput ? retained.sender : undefined;
    if (sender) {
      const generation = this.generation;
      const name = taskSenderHeading(cached.heading, sender, () => this.hooks.subject?.(sender.identity), () => generation === this.generation && this.node.contains(cached.node) && !this.hidden() && this.index.entries.get(retained.id)?.sender?.identity === sender.identity);
      cached.heading.hidden = false; cached.node.setAttribute('aria-label', `Message from ${name}`); return;
    }
    const label = presentMessage(message, this.hooks.operatorInput, retained.head).label;
    if (cached.heading.querySelector('.task-sender')) cached.heading.replaceChildren();
    setText(cached.heading, bounded(label, 4096)); cached.heading.hidden = !label; cached.heading.title = '';
    cached.node.setAttribute('aria-label', bounded(messageAriaLabel(message, this.hooks.operatorInput, retained.head), 4096));
  }
  private messagePartNodes(cached: MessageNode, message: MessageView, entryId: string, selected?: ReadonlySet<number>): HTMLElement[] {
    const children: HTMLElement[] = []; const keys = new Set<string>();
    message.parts.forEach((_part, index) => {
      if (selected && !selected.has(index)) return;
      const displayed = attachmentParts(message, index);
      displayed.forEach((display, piece) => {
        if ((display.type === 'text' || display.type === 'thinking') && !display.text.trim() && !display.redacted && !display.more) return;
        const key = displayed.length === 1 ? `${index}:${display.type}` : `${index}:attachment:${piece}:${display.type}`; keys.add(key);
        const node = this.updatePart(cached, display, index, message.state === 'partial', entryId, key);
        if (node) children.push(node);
      });
    });
    this.pruneParts(cached, keys); return children;
  }
  private groupThinking(message: MessageNode, children: HTMLElement[]): HTMLElement[] {
    this.showThinkingSummaries(message);
    const displayed: HTMLElement[] = []; const used = new Set<string>();
    for (let start = 0; start < children.length;) {
      const first = children[start]; if (!first) break;
      if (!first.classList.contains('thinking')) { displayed.push(first); start++; continue; }
      let end = start + 1; while (end < children.length && children[end]?.classList.contains('thinking')) end++;
      const run = children.slice(start, end); const id = `${first.dataset.disclosure}:group`;
      const previous = message.thinkingGroups?.get(id);
      if (run.length < 2 || !previous && run.some(node => this.protectedNode(node))) displayed.push(...run);
      else { displayed.push(this.thinkingGroup(message, id, run)); used.add(id); }
      start = end;
    }
    this.pruneThinkingGroups(message, used); return displayed;
  }
  private showThinkingSummaries(message: MessageNode): void {
    for (const part of message.parts.values()) if (part.source.type === 'thinking') {
      const summary = part.node.querySelector<HTMLElement>('summary'); if (summary) summary.hidden = false;
    }
  }
  private pruneThinkingGroups(message: MessageNode, used: ReadonlySet<string>): void {
    for (const id of message.thinkingGroups?.keys() ?? []) if (!used.has(id)) message.thinkingGroups?.delete(id);
  }
  private thinkingGroup(message: MessageNode, id: string, parts: HTMLElement[]): HTMLElement {
    const groups = message.thinkingGroups ?? new Map(); message.thinkingGroups = groups; let group = groups.get(id);
    if (!group) {
      const node = element('details', 'thinking thinking-group'); const body = element('div');
      const summary = element('summary'); thinkingSpans(summary);
      node.dataset.disclosure = id; node.append(summary, body);
      group = {node, body}; groups.set(id, group);
      node.addEventListener('toggle', () => {
        if (node.dataset.streaming === 'true') node.open = true;
        for (const part of body.children) (part as HTMLDetailsElement).open = node.open;
      });
      this.trackDisclosure(node, id);
    }
    for (const part of parts) { const summary = part.querySelector<HTMLElement>('summary'); if (summary) summary.hidden = true; }
    reconcileChildren(group.body, parts);
    const heading = group.node.querySelector('summary');
    if (heading) setText(thinkingSpans(heading).preview, parts.map(part => part.querySelector('.thinking-preview')?.textContent ?? '').find(Boolean) ?? '');
    group.node.dataset.streaming = String(parts.some(part => part.dataset.streaming === 'true'));
    group.node.open = this.thinkingOpen(group.node) || parts.some(part => (part as HTMLDetailsElement).open);
    return group.node;
  }
  private updateMessageLayout(cached: MessageNode, children: HTMLElement[], error: string): void {
    const content = children.filter(child => !child.classList.contains('message-coverage'));
    const toolOnly = content.some(child => child.classList.contains('tool-shell')) && content.every(child => child.classList.contains('tool-shell') || child.classList.contains('thinking')) && !error;
    if (toolOnly) cached.node.classList.add('tool-only'); else cached.node.classList.remove('tool-only');
    const thinkingOnly = content.length > 0 && content.every(child => child.classList.contains('thinking')) && !error;
    if (thinkingOnly) cached.node.classList.add('thinking-only'); else cached.node.classList.remove('thinking-only');
    cached.heading.hidden = toolOnly || thinkingOnly || !cached.heading.textContent;
    cached.actions.hidden = cached.source.role==='assistant';
  }
  private pruneParts(message: MessageNode, keys: ReadonlySet<string>): void {
    for (const [key, part] of message.parts) if (!keys.has(key)) { this.releaseFrames(part.node); message.parts.delete(key); }
  }
  private reconcileContent(root: HTMLElement, children: HTMLElement[]): void {
    const wanted = new Set(children);
    for (const child of root.children) if (!wanted.has(child as HTMLElement)) this.releaseFrames(child as HTMLElement);
    reconcileChildren(root, children);
  }
  private retireForks(): void {
    for (const [entryId, cached] of this.cache) {
      const entry = this.index.entries.get(entryId);
      for (const [id, message] of cached.messages) {
        const source = entry?.messages?.find(source => source.id === id);
        if (!entry || source !== message.source || !source || !this.forkEligible(entry, source)) message.forkRevision++;
      }
    }
  }
  private forkEligible(entry: EntryView, message: MessageView): boolean {
    return entry.kind === 'message' && !/^(message:|live:)/.test(entry.id) && message.role === 'user' && message.state === 'final' && !!this.hooks.fork;
  }
  private messageMenuActions(entry:EntryNode,id:string,origin:HTMLElement,assistantRow=false):MessageMenuActions|undefined {
    const cached = entry.messages.get(id); if (!cached) return;
    const generation = this.generation; const source = cached.source;
    const current = () => this.currentMessage(entry, id, cached.node, generation);
    const valid = () => current()?.source === source && (!cached.communication || !!cached.communication.current());
    if (!valid()) return;
    const copyItem = {label: 'Copy', enabled: !!messageCopyText(source, item => partText(item.parts)), description: messageCopyDescription(source), run: () => this.copyMessage(entry, id, cached.node, generation)};
    const items: ContextItem[] = [...selectionCopy(cached.node), ...(source.role === 'assistant' && (assistantRow||origin === cached.menu) ? [] : [copyItem]), {label: 'Source', run: () => {
      if (!valid()) return;
      if (cached.communication) cached.communication.openSource(origin); else this.openOrdinarySource(entry, cached, origin, generation);
    }}];
    const carrier = source.communication;
    const ask=carrier?.state === 'ready' && (carrier.value.kind === 'report' || carrier.value.kind === 'result')?this.primaryAskItems(this.messageDraftSource(entry,cached))[0]:undefined;
    if(ask)items.push(ask);
    const retained = this.index.entries.get(entry.source?.id ?? ''); const revision = cached.forkRevision;
    if (retained && this.forkEligible(retained, source)) items.push({label: 'Fork', run: () => { const currentEntry = this.index.entries.get(retained.id); if (revision === cached.forkRevision && valid() && currentEntry && this.forkEligible(currentEntry, source)) this.hooks.fork?.(source, retained.id); }});
    return {items,ask,valid};
  }
  private messageMenu(entry: EntryNode, id: string, origin: HTMLElement, point?: {x: number; y: number}): void {
    const actions=this.messageMenuActions(entry,id,origin);if(!actions)return;
    if (!['BUTTON', 'A', 'INPUT', 'TEXTAREA'].includes(origin.tagName.toUpperCase())) origin.tabIndex = -1;
    const box = origin.getBoundingClientRect();
    contextMenu.open(origin, point ?? {x: box.right, y: box.bottom}, 'Message actions', actions.items, actions.valid);
  }
  private sourceLayout(entryId: string): void {
    this.reflowAnchor = this.follow ? null : this.anchor(); this.restoring = undefined;
    this.heights.delete(entryId); this.dirtyLayout = true; this.follow = false; this.schedule();
  }
  private sourcePreference(key: string, open: boolean): void {
    if (open) this.expanded.add(key); else this.expanded.delete(key);
    this.hooks.presentation([...this.expanded], this.showThinking, this.view); this.schedule();
  }
  private openOrdinarySource(entry: EntryNode, cached: MessageNode, opener: HTMLElement, generation: number): void {
    if (!this.currentMessage(entry, cached.source.id, cached.node, generation)) return;
    const key = communicationDisclosureKeys(entry.source?.id ?? '', cached.source.id)[0]; cached.sourceOpener = opener;
    if (!cached.inspection) {
      const region = element('section', 'message-source'); region.dataset.disclosure = key;
      region.setAttribute('role', 'region'); region.setAttribute('aria-label', 'Source');
      const heading = element('div', 'message-source-header'); const close = cardAction('close', 'Close Source', () => {
        if (!this.currentMessage(entry, cached.source.id, cached.node, generation)) return;
        this.sourceLayout(entry.source?.id ?? ''); region.hidden = true; region.inert = true; this.sourcePreference(key, false);
        if (cached.sourceOpener?.isConnected) cached.sourceOpener.focus({preventScroll: true});
      }, 'message-source-close'); close.setAttribute('aria-label', 'Close Source');
      heading.append(element('h4', 'message-source-heading', 'Source'), close); region.append(heading, element('div', 'message-source-content'));
      region.hidden = true; region.inert = true; cached.inspection = region; cached.body.append(region);
    }
    this.sourceLayout(entry.source?.id ?? ''); cached.inspection.hidden = false; cached.inspection.inert = false;
    this.updateOrdinarySource(cached, cached.source); this.sourcePreference(key, true);
    cached.inspection.querySelector<HTMLElement>('.message-source-close')?.focus({preventScroll: true});
  }
  private updateOrdinarySource(cached: MessageNode, message: MessageView): void {
    const region = cached.inspection; if (!region || region.hidden || cached.inspectionSource === message || this.protectedNode(region)) return;
    const content = region.querySelector<HTMLElement>('.message-source-content'); if (!content) return;
    const pre = element('pre', 'raw'); pre.append(element('span', 'pre-text-frame', bounded(partText(message.parts))));
    const controls = element('div', 'tool-source-header'); const generation = this.generation;
    controls.append(cardAction('copy', 'Copy original', () => {
      const entry = this.cache.get(cached.node.closest<HTMLElement>('.entry')?.dataset.entryId ?? '');
      const current = this.currentMessage(entry, message.id, cached.node, generation);
      if (current?.source === message && cached.inspectionSource === message && !region.hidden) void copy(partText(message.parts), controls);
    }, 'copy'), sourceWrap(pre));
    const coverage = element('p', 'secondary', !message.coverage.complete || message.coverage.truncated || message.coverage.omitted ? 'Only available message text is retained.' : 'Retained message text');
    const facts: HTMLElement[] = [coverage];
    if (message.coverage.reason) facts.push(element('p', 'secondary', bounded(message.coverage.reason, 4096, 6)));
    if (message.timestamp !== undefined && isValidTimestamp(message.timestamp)) {
      const time = element('time', 'message-source-time', new Date(message.timestamp).toISOString()); time.dateTime = new Date(message.timestamp).toISOString(); facts.push(time);
    }
    content.replaceChildren(...facts, controls, pre); this.registerContent(content); cached.inspectionSource = message;
  }
  private updatePart(message: MessageNode, part: PartView, index: number, partial: boolean, entryId: string, key = `${index}:${part.type}`): HTMLElement | undefined {
    if (part.type === 'toolCall' || part.type === 'toolResult') {
      const tool = this.joined.get(part.callId);
      return tool?.slot === slot(entryId, message.source.id, index) ? this.updateTool(tool) : undefined;
    }
    const previous = message.parts.get(key);
    if (previous?.source === part && previous.partial === partial) { if (part.type === 'thinking') this.thinkingTitle(previous.node, message.source, index, partial); return previous.node; }
    const node = previous?.node ?? this.createPart(part, entryId, message.source.id, index);
    const pages = node.querySelector<HTMLElement>('.output-pages'); if (pages) { this.releaseFrames(pages); pages.remove(); }
    this.partContent(node, part, partial, message.source.role === 'assistant', previous);
    if (part.type === 'thinking') this.markThinking(node as HTMLDetailsElement, part, message.source, index, partial);
    if ((part.type === 'text' || part.type === 'thinking') && part.more) {
      const source = part; const generation = this.generation;
      const pages = outputPages(part.more, this.hooks.output, () => generation === this.generation && message.parts.get(key)?.source === source, () => this.schedule());
      node.append(pages); this.registerContent(pages);
    }
    this.registerContent(node); message.parts.set(key, {node, source: part, partial}); return node;
  }
  private markThinking(node: HTMLDetailsElement, part: Extract<PartView, {type: 'thinking'}>, message: MessageView, index: number, partial: boolean): void {
    const streaming = partial && !part.redacted && !!part.text.trim(), streamKey = this.streamKey(message, index);
    node.dataset.streaming = String(streaming); node.dataset.streamKey = streamKey;
    if (streaming) this.streamedThinking.add(streamKey);
    node.open = this.thinkingOpen(node); this.thinkingTitle(node, message, index, partial);
  }
  private createPart(part: PartView, entryId: string, messageId: string, index: number): HTMLElement {
    if (part.type !== 'thinking') return element('div');
    const node = element('details', 'thinking'); const id = `thinking:${entryId}:${messageId}:${index}`;
    node.dataset.disclosure = id; node.open = this.showThinking || this.expanded.has(id);
    const summary = element('summary'); cardDisclosure(summary); thinkingSpans(summary);
    node.append(summary, element('div', 'thinking-content'));
    this.trackDisclosure(node, id); return node;
  }
  private partContent(node: HTMLElement, part: PartView, partial: boolean, agentProse: boolean, previous?: PartNode): void {
    if (part.type === 'text') {
      this.textContent(node, part.text, partial, agentProse, previous);
    } else if (part.type === 'thinking') {
      this.thinkingContent(node, part, partial);
    } else if (part.type === 'image') this.imageContent(node, part);
    else if (part.type === 'omitted') { node.className = 'secondary message-coverage'; setText(node, bounded(part.label)); }
  }
  private imageContent(node: HTMLElement, part: ImageView): void {
    const url = this.hooks.image?.(part); const key = JSON.stringify([part.digest, part.source, part.width, part.height, part.bytes, url]);
    if (node.dataset.imageKey === key) return;
    const generation = this.generation; node.className = 'image-part'; node.dataset.imageKey = key;
    const open = this.hooks.preview, preview = open ? (shown: ImageView, source: string, invoker: HTMLElement) => { this.dismissPreview(); this.closePreview = open(shown, source, invoker); } : undefined;
    node.replaceChildren(transcriptImage(part, url, () => { if (generation === this.generation) this.schedule(); }, preview));
  }
  private dismissPreview(): void { const close = this.closePreview; this.closePreview = undefined; close?.(); }
  private thinkingContent(node: HTMLElement, part: Extract<PartView, {type: 'text' | 'thinking'}>, partial: boolean): void {
    const content = node.querySelector('.thinking-content'); if (!content) return;
    content.className = partial ? 'thinking-content stream-text' : 'thinking-content';
    const root = content as HTMLElement, summary = node.querySelector('summary');
    if (summary) setText(thinkingSpans(summary).preview, part.redacted ? '' : previewSuffix(thinkingPreview(part.text)));
    if (part.redacted || partial) { this.releaseFrames(root); setText(root, part.redacted ? 'Thinking not available' : bounded(part.text, 8192)); }
    else if (part.text.length > 8192) this.replaceContent(root, markdownDom(bounded(part.text, 8192), true), this.inspection('More thinking', () => part.text));
    else this.replaceContent(root, markdownDom(part.text, true));
  }
  private textContent(node: HTMLElement, text: string, partial: boolean, agentProse: boolean, previous?: PartNode): void {
    if (previous?.source.type === 'text' && previous.source.text === text && previous.partial === partial) return;
    node.className = partial ? 'message-text stream-text' : 'message-text';
    if (partial) { this.releaseFrames(node); setText(node, bounded(text, 8192)); }
    else if (text.length > 8192) this.replaceContent(node, markdownDom(bounded(text, 8192), agentProse), this.inspection('More text', () => text));
    else this.replaceContent(node, markdownDom(text, agentProse));
  }
  private createTool(source: JoinedTool): ToolNode {
    const card = element('div', 'tool-shell'); const node = element('details', 'tool-card'); card.append(node); const summary = element('summary');
    const tier = element('span', 'tool-tier'); const glyph = element('span', 'tool-status'); glyph.setAttribute('aria-hidden', 'true');
    const title = element('span', 'tool-name'); const stateWord = element('span', 'tool-state-word'); const target = element('span', 'tool-target'); const meta = element('span', 'tool-secondary');
    tier.append(title, glyph, stateWord); cardDisclosure(summary); summary.append(tier);
    const preview = element('div', 'tool-preview'); const qualification = element('p', 'tool-preview-qualification', 'Partial output'); qualification.hidden = true;
    const expanded = element('div', 'tool-expanded'), resultArea = element('div', 'tool-result');
    resultArea.tabIndex = 0; resultArea.setAttribute('role', 'region'); resultArea.setAttribute('aria-label', 'Tool result');
    const technical = element('details', 'tool-details'), technicalSummary = element('summary', undefined, 'Details'); cardDisclosure(technicalSummary);
    const info = element('p', 'secondary tool-output-info'); technical.append(technicalSummary, target, meta, info); summary.append(preview, qualification); node.append(summary, expanded);
    node.dataset.disclosure = `tool:${source.callId}`; node.open = this.expanded.has(`tool:${source.callId}`);
    const generation = this.generation;
    const action = button('Copy output', () => {
      const captured = tool.source; if (!captured || !this.currentToolSource(tool, captured, generation)) return;
      const raw = tool.inspections?.output;
      if (raw?.open && tool.inspectionSources?.get(raw) !== captured) return;
      void copy(partText(captured.result ?? []), tool.card).then(copied => {
        if (copied && this.currentToolSource(tool, captured, generation)) cardActionLabel(action, 'Copied');
      });
    }, 'tool-copy');
    action.setAttribute('aria-label', 'Copy tool output'); action.title = 'Copy tool output';
    action.addEventListener('click', event => event.stopPropagation());
    action.addEventListener('blur', () => { if (!this.destroyed && tool.source) this.toolCopyLabel(tool, tool.source); });
    const controls=element('div','tool-source-actions');
    controls.append(button('Copy arguments',()=>{const source=tool.source;if(source&&this.currentToolSource(tool,source,generation))void copy(this.toolArguments(tool),controls);}),button('Copy ID',()=>{const source=tool.source;if(source&&this.currentToolSource(tool,source,generation))void copy(source.callId,controls);}));
    technical.append(controls); const actions = element('div', 'tool-output-actions'); actions.append(action); expanded.append(resultArea, actions, technical);
    const tool: ToolNode = {card, node, copy: action, title, target, glyph, stateWord, meta, preview, qualification, expanded, resultArea, technical, actions, info}; this.tools.set(source.callId, tool);
    this.trackDisclosure(node, `tool:${source.callId}`);
    node.addEventListener('toggle', () => this.toolExpansion(tool)); this.registerContent(card); return tool;
  }
  private toolFileDestination(tool:ToolNode,source:JoinedTool):FileReferenceDestination|undefined {
    if(!this.hooks.openFile||!source.args||source.args.truncated||tool.filePathSource!==source)return;
    return tool.filePath?this.hooks.references?.fileDestination(tool.filePath,this.hooks.cwd?.()):undefined;
  }
  private toolFileOpen(tool:ToolNode,source:JoinedTool):ToolFileOpen|undefined {
    const resolved=this.toolFileDestination(tool,source),path=tool.filePath;if(!resolved||!path)return;
    const captured={...source},generation=this.generation,owner=tool.card,destination={rootId:resolved.rootId,path:resolved.path};
    return {source:captured,generation,path,destination,run:control=>{
      const current=tool.source;
      if(!current||this.hidden()||tool.card!==owner||!owner.isConnected||!control.isConnected||!owner.contains(control)||control.closest('[hidden],[inert]'))return;
      if(control!==owner&&!tool.node.open)return;
      if(!this.index.entries.has(captured.owner)||!this.sameToolPathSource(captured,current)||!this.currentToolSource(tool,current,generation))return;
      if(toolLabelParts(current,{cwd:this.hooks.cwd?.()}).find(part=>part.role==='file')?.title!==path)return;
      const next=this.toolFileDestination(tool,current);if(next?.rootId!==destination.rootId||next.path!==destination.path)return;
      this.hooks.openFile?.(destination);
    }};
  }
  private toolFileItems(tool:ToolNode|undefined):ContextItem[] {
    if(!tool?.source)return [];const open=this.toolFileOpen(tool,tool.source);if(!open)return [];
    const owner=tool.card;return [{label:'Open beside',run:()=>open.run(owner)}];
  }
  private toolFileAction(tool:ToolNode,source:JoinedTool):void {
    const open=this.toolFileOpen(tool,source),previous=tool.fileOpen,action=tool.actions.querySelector<HTMLButtonElement>('.tool-open-beside');
    const same=open&&previous&&open.generation===previous.generation&&this.sameToolPathSource(previous.source,source)&&open.path===previous.path&&open.destination.rootId===previous.destination.rootId&&open.destination.path===previous.destination.path;
    if(action&&!same&&this.protectedNode(action))return;
    if(!open){action?.remove();tool.fileOpen=undefined;return;}
    if(action&&same)return;
    const control:HTMLButtonElement=button('Open beside',()=>open.run(control),'tool-open-beside');
    control.addEventListener('pointerdown',event=>{if(event.button===0)event.preventDefault();});control.addEventListener('click',event=>event.stopPropagation());
    control.title=`Open ${open.destination.path} read-only beside Primary`;
    if(action)action.replaceWith(control);else tool.actions.append(control);tool.fileOpen=open;
  }
  private toolState(tool: ToolNode, source: JoinedTool): void {
    const awaited = source.name === 'agent_await' ? awaitedToolState(source) : undefined;
    const status = awaited?.status ?? source.status;
    const stateLabel = awaited?.label ?? toolStateLabels[status] ?? 'State unavailable';
    const stateIcon = toolStateIcons[status] ?? 'unknown';
    if (status === 'success') { if (tool.glyph.childNodes.length) tool.glyph.replaceChildren(); }
    else if (!tool.glyph.querySelector(`.card-icon-${stateIcon}`)) tool.glyph.replaceChildren(cardIcon(stateIcon));
    tool.glyph.className = `tool-status ${status}`;
    setText(tool.stateWord, stateLabel); tool.stateWord.className = `tool-state-word ${status}`;
  }
  private updateTool(source: JoinedTool): HTMLElement {
    const tool = this.tools.get(source.callId) ?? this.createTool(source);
    const previous = tool.source; tool.source = source;
    this.toolHeading(tool, source);this.toolAnswer(tool,source);this.toolFileAction(tool,source);
    const staleSubjects = !tool.node.open && tool.previewSubjectRevision !== this.subjectRevision;
    if (previous === source) {
      if (tool.previewSource !== source || staleSubjects) this.toolContent(tool);
      if (tool.node.open && tool.documentSource !== source) this.expandTool(tool);
      return tool.card;
    }
    tool.card.dataset.status = source.status;
    this.toolState(tool, source);
    this.toolMetadata(tool, source);
    const explanation = [metadata(source), outputExplanation(source), source.args?.truncated ? 'Some arguments are not available.' : ''].filter(Boolean).join('\n');
    tool.qualification.hidden = !this.partialToolOutput(source);
    tool.meta.title = ''; setText(tool.info, explanation); tool.info.hidden = !explanation;
    tool.meta.hidden = !tool.meta.textContent; tool.copy.hidden = !source.result; this.toolCopyLabel(tool, source);
    const changed = previous?.args !== source.args || previous?.result !== source.result || previous?.argumentText !== source.argumentText || previous?.status !== source.status;
    if (changed || staleSubjects) this.toolContent(tool);
    tool.preview.hidden = tool.node.open || !tool.preview.textContent; tool.expanded.hidden = !tool.node.open; return tool.card;
  }
  private toolAnswer(tool: ToolNode, source: JoinedTool): void {
    const task=this.tasks.byCall.get(source.callId);let state=tool.node.querySelector<HTMLButtonElement>('.step-answer-state');
    const answer=tool.card.querySelector<HTMLElement>('.step-answer');
    if(!task){state?.remove();answer?.remove();tool.node.querySelector('.step-answer-stop')?.remove();return;}
    if(!state){state=button('',()=>this.toggleTaskAnswer(tool,source.callId),'step-answer-state');state.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();});tool.node.querySelector('summary')?.append(state);}
    setText(state,this.taskAnswerLabel(task));state.disabled=!task.answer&&!task.reason;state.dataset.state=task.state;
    this.toolStop(tool,source,task);
    this.inlineTaskAnswer(tool,source,task,answer);
  }
  /** While the recipient still works on this request, the card offers Stop for that work. */
  private toolStop(tool:ToolNode,source:JoinedTool,task:ConversationTask):void{
    let stop=tool.node.querySelector<HTMLButtonElement>('.step-answer-stop');
    const reference=task.reference,stopTask=this.hooks.stopTask;
    if(!reference||!stopTask||!this.tasks.outstandingCall(source.callId)){stop?.remove();return;}
    if(stop)return;
    const control=button('Stop',()=>{
      if(control.disabled)return;control.disabled=true;setText(control,'Stopping');
      void stopTask(reference).catch(()=>{/* The stop path reports its own failure. */}).finally(()=>{control.disabled=false;setText(control,'Stop');this.refreshTasks();});
    },'step-answer-stop');
    stop=control;stop.title='Stop the work this message started';stop.setAttribute('aria-label','Stop the work this message started');
    stop.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();});
    tool.node.querySelector('.step-answer-state')?.after(stop);
  }
  private toggleTaskAnswer(tool:ToolNode,callId:string):void{
    const current=tool.source?this.tasks.byCall.get(tool.source.callId):undefined;if(!current?.answer&&!current?.reason)return;
    const key=`answer:${callId}`;if(this.expanded.has(key))this.expanded.delete(key);else this.expanded.add(key);
    this.hooks.presentation([...this.expanded],this.showThinking);this.schedule();
  }
  private taskAnswerLabel(task:ConversationTask):string{
    if(task.state==='answered')return 'answered';if(task.state==='unanswered')return 'no answer';
    if(task.state==='queued')return 'waiting to start';if(task.state==='unavailable')return 'answer unavailable';return 'awaiting answer';
  }
  private inlineTaskAnswer(tool:ToolNode,source:JoinedTool,task:ConversationTask,answer:HTMLElement|null):void{
    if(this.expanded.has(`answer:${source.callId}`)&&(task.answer||task.reason)){
      if(!answer){answer=element('section','step-answer');tool.card.append(answer);tool.answerText=undefined;}
      const text=task.answer?task.answer.text:task.reason??'';
      if(tool.answerText!==text&&!this.protectedNode(answer)){
        const exact=task.answer?.text;answer.replaceChildren(markdownDom(text, !!task.answer));if(exact!==undefined)answer.append(button('Copy answer',()=>{void copy(exact,answer as HTMLElement);}));tool.answerText=text;
      }
      this.taskAnswerCoverage(answer,task);
    }else{answer?.remove();tool.answerText=undefined;}
  }
  private taskAnswerCoverage(answer:HTMLElement,task:ConversationTask):void{
    let notice=answer.querySelector<HTMLElement>('.step-answer-coverage');
    if(task.answer&&(!task.answer.complete||task.answer.redacted)){if(!notice){notice=element('p','secondary step-answer-coverage');answer.append(notice);}setText(notice,task.answer.redacted?'Some answer text is withheld.':'Only the retained answer text is shown.');}else notice?.remove();
  }
  private partialToolOutput(source: JoinedTool): boolean {
    const partial = (parts: readonly PartView[]): boolean => parts.some(part => part.type === 'omitted' || part.type === 'toolResult' && partial(part.parts) || (part.type === 'text' || part.type === 'thinking') && !!part.more);
    return source.status === 'working' && !!source.result?.length || source.output?.truncation?.truncated === true || partial(source.result ?? []);
  }
  private toolCopyLabel(tool: ToolNode, source: JoinedTool): void {
    const incomplete = this.partialToolOutput(source);
    cardActionLabel(tool.copy, incomplete ? 'Copy available output' : 'Copy output', incomplete ? 'Copy retained output only. Some original output is unavailable or not loaded.' : 'Copy retained tool output');
  }
  private toolMetadata(tool: ToolNode, source: JoinedTool): void {
    setText(tool.meta, [source.parentCallId ? `Within ${source.parentCallId}` : '', source.name === 'read' ? readRange(record(source.args)) : '', toolTime(source)].filter(Boolean).join(' · '));
    tool.meta.hidden = true;
  }
  /** The title carries the browser-observed span; a streaming block keeps counting through the shared clock. */
  private thinkingTitle(node: HTMLElement, message: MessageView, index: number, partial: boolean): void {
    const key = thinkingKey(message, index), time = this.thinkingTimes.get(key), streaming = partial && time !== undefined && time.end === undefined;
    const summary = node.querySelector('summary'); if (summary) setText(thinkingSpans(summary).label, thinkingLabel(time, streaming));
    if (streaming) this.liveThinking.set(key, node); else this.liveThinking.delete(key);
  }
  private paintElapsed(): boolean {
    if (this.hidden() || document.hidden || !this.node.isConnected) return false;
    let active = false;
    for (const [key, node] of this.liveThinking) {
      const time = this.thinkingTimes.get(key), summary = node.querySelector('summary');
      if (!this.node.contains(node) || !summary || time === undefined || time.end !== undefined) { this.liveThinking.delete(key); continue; }
      setText(thinkingSpans(summary).label, thinkingLabel(time, true)); active = true;
    }
    this.hooks.activity?.(this.activitySentence());
    for (const tool of this.tools.values()) {
      if (tool.source?.status !== 'working' || tool.source.observedStart === undefined || !this.node.contains(tool.card)) continue;
      this.toolMetadata(tool, tool.source); active = true;
    }
    return active;
  }
  /** Public caption changes refresh attached cards now and closed cached previews on their next paint. */
  refreshSubjects(): void {
    if (this.destroyed) return;
    this.subjectRevision++; this.referenceNamesPending = true;
    if (this.deferred) return;
    for (const tool of this.tools.values()) if (tool.source && this.node.contains(tool.card)) { this.toolHeading(tool, tool.source); if (!tool.node.open) this.toolContent(tool); }
    this.refreshSenders(); this.schedule();
  }
  private refreshSenders(): void {
    for (const [id, entry] of this.cache) {
      const retained = this.index.entries.get(id); if (!retained) continue;
      for (const message of entry.messages.values()) {
        if (message.communication) message.communication.refreshSender();
        else this.messageHeading(message, message.source, retained);
      }
    }
  }
  private toolTitlePart(part: ToolLabelPart): HTMLElement {
    const node=element('span',part.role?`tool-name-${part.role}`:undefined);node.title=part.title??'';
    if(part.role==='directory')node.append(element('span',undefined,part.text));else setText(node,part.text);
    return node;
  }
  private sameToolPathSource(a:JoinedTool|undefined,b:JoinedTool):boolean {
    return !!a&&a.callId===b.callId&&a.owner===b.owner&&a.slot===b.slot&&a.name===b.name&&a.args===b.args&&a.argumentText===b.argumentText;
  }
  private toolPathCopy(tool:ToolNode,source:JoinedTool,parts=toolLabelParts(source,{cwd:this.hooks.cwd?.()})):ToolPathCopy|undefined {
    const path=parts.find(part=>part.role==='file')?.title,generation=this.generation;
    if(!path?.startsWith('/')||path.includes('\0'))return;
    return {path,run:()=>{
      const current=tool.source;
      if(!current||this.hidden()||!tool.card.isConnected||!this.sameToolPathSource(source,current)||!this.currentToolSource(tool,current,generation))return;
      if(toolLabelParts(current,{cwd:this.hooks.cwd?.()}).find(part=>part.role==='file')?.title!==path)return;
      void copy(path,tool.card);
    }};
  }
  private toolTitleNodes(tool:ToolNode,parts:ToolLabelPart[],pathCopy?:ToolPathCopy):HTMLElement[] {
    const nodes=parts.map(part=>this.toolTitlePart(part));if(!pathCopy)return nodes;
    const at=parts.findIndex(part=>part.role==='file');if(at<0)return nodes;
    const count=parts[at+1]?.role==='directory'?2:1,labels=nodes.splice(at,count);
    const control=element('button','tool-path-copy');control.type='button';control.title=`Copy path ${pathCopy.path}`;control.setAttribute('aria-label',control.title);
    control.onmousedown=event=>{if(event.button===0)event.preventDefault();};
    control.onclick=event=>{event.preventDefault();event.stopPropagation();if(control.isConnected&&tool.title.contains(control))pathCopy.run();};
    for(const label of labels)label.removeAttribute('title');control.append(...labels);nodes.splice(at,0,control);return nodes;
  }
  private toolTitleParts(source: JoinedTool): ToolLabelPart[] {
    if (source.name !== 'bash') return toolLabelParts(source,{subject:this.hooks.subject,cwd:this.hooks.cwd?.(),nestedCount:this.rows.nestedCounts.get(source.callId)});
    const verb = source.status === 'success' ? 'Ran' : source.status === 'working' ? 'Running' : 'Run';
    return [{text: `${verb} a shell command`}];
  }
  private toolTitle(tool: ToolNode, source: JoinedTool): void {
    const parts=this.toolTitleParts(source),pathCopy=this.toolPathCopy(tool,source,parts);
    tool.filePath=parts.find(part=>part.role==='file')?.title;tool.filePathSource=source;
    tool.title.title=[parts.map(part=>part.text).join(''),...parts.flatMap(part=>part.title?[part.title]:[])].join('\n');
    const control=tool.title.querySelector<HTMLButtonElement>(':scope > .tool-path-copy');
    const children=[...tool.title.children].flatMap(node=>node===control?[...node.children]:[node]);
    const samePath=pathCopy?!!control&&control.title===`Copy path ${pathCopy.path}`&&this.sameToolPathSource(tool.pathCopySource,source):!control;
    const sameParts=children.length===parts.length&&parts.every((part,index)=>{
      const title=pathCopy&&(part.role==='file'||part.role==='directory')?'':part.title??'';
      return children[index]?.textContent===part.text&&children[index]?.className===(part.role?`tool-name-${part.role}`:'')&&(children[index]?.getAttribute('title')??'')===title;
    });
    if((control||pathCopy)&&(!samePath||!sameParts)&&this.protectedNode(tool.title))return;
    if(parts.length===1&&!parts[0]?.role)setText(tool.title,parts[0]?.text??'');
    else if(!samePath||!sameParts)tool.title.replaceChildren(...this.toolTitleNodes(tool,parts,pathCopy));
    tool.pathCopySource=pathCopy?source:undefined;
  }
  private toolHeading(tool: ToolNode, source: JoinedTool): void {
    this.toolTitle(tool,source);
    const args = record(source.args), value = args.sessionId ?? args.target;
    const eligible = typeof value === 'string' && subject(source, RAW_LIMIT, Number.MAX_SAFE_INTEGER) === value;
    const caption = eligible ? this.hooks.subject?.(value) : undefined; tool.subject = caption;
    const text = caption?.name && caption.provenance ? caption.name : '';
    let link = tool.target.querySelector<HTMLButtonElement>('.tool-subject-link');
    if (caption?.open && text) {
      if (!link) {
        const generation = this.generation;
        link = button('', () => {if (tool.source && this.currentToolSource(tool, tool.source, generation)) tool.subject?.open?.();}, 'tool-subject-link');
        link.addEventListener('click', event => {event.preventDefault(); event.stopPropagation();});
        tool.target.replaceChildren(link);
      }
      setText(link, text);
    } else {if (link) tool.target.replaceChildren(); setText(tool.target, text);}
    tool.target.hidden = !text; tool.target.title = caption?.title ?? bounded(subject(source, RAW_LIMIT, Number.MAX_SAFE_INTEGER));
  }
  /** Compact previews name a conversation only when the shared caption rule already knows its name. */
  private nameResolver(): (identity: string) => string | undefined {
    return identity => { const caption = this.hooks.subject?.(identity); return caption?.name && caption.provenance ? caption.name : undefined; };
  }
  /** A responder reads as the send card names its recipient: the caption text when it begins with the name (a child conversation keeps its number), otherwise the name. */
  private responderNames(): (identity: string) => string | undefined {
    return identity => {
      const caption = this.hooks.subject?.(identity); if (!caption?.name || !caption.provenance) return undefined;
      return caption.text === caption.name || caption.text.startsWith(`${caption.name} · `) ? caption.text : caption.name;
    };
  }
  private quietReportResult(source: JoinedTool): boolean {
    return source.name === 'agent_send' && source.status !== 'error' && quietTextResult(source);
  }
  private quietStructuredResult(source: JoinedTool): boolean {
    if (source.status === 'error' || !hasStructuredResult(source.result ?? [])) return false;
    return !(source.name === 'agent_await' && awaitedFromParts(source.result ?? []));
  }
  private toolPreviewText(source: JoinedTool, resolve: (identity: string) => string | undefined, title: string, quiet: boolean): string {
    if (quiet || source.status === 'success' && quietTextResult(source)) return '';
    return resultPreview(source.result ?? [], {resolve, tidy: source.status !== 'error', title});
  }
  private paintToolPreview(tool: ToolNode, source: JoinedTool): void {
    const resolve = source.name === 'agent_await' && awaitedFromParts(source.result ?? []) ? this.responderNames() : this.nameResolver(), title = tool.title.textContent ?? '';
    const quietReport = this.quietReportResult(source), structured = this.quietStructuredResult(source);
    const supplied = quietReport ? undefined : presentToolPreview(source) ?? (structured ? undefined : presentResultPreview(source, resolve, title));
    if (supplied) this.replaceContent(tool.preview, supplied);
    else setText(tool.preview, this.toolPreviewText(source, resolve, title, quietReport || structured));
    tool.preview.classList.toggle('tool-error', source.status === 'error');
    this.toolPreviewFold(tool,source,quietReport || structured);
    tool.previewSource = source;
    tool.previewSubjectRevision = this.subjectRevision;
  }
  private toolContent(tool: ToolNode): void {
    const source = tool.source; if (!source) return;
    if (!this.protectedNode(tool.preview)) this.paintToolPreview(tool, source);
    tool.preview.hidden = tool.node.open || !tool.preview.textContent;
    if (tool.node.open) this.expandTool(tool);
  }
  private toolPreviewFold(tool:ToolNode,source:JoinedTool,quietReport:boolean):void {
    const args=record(source.args),full=quietReport||source.status==='success'&&quietTextResult(source)?'':source.name==='write'&&typeof args.content==='string'?args.content:partText(source.result??[]);
    const normalized=full.replace(/\r\n?/g,'\n').replace(/^(?:[ \t]*\n)+/,'').trimEnd(),shown=tool.preview.textContent??'';
    const prefix=normalized.startsWith(shown),total=normalized?normalized.split('\n').length:0,visible=shown?shown.split('\n').length:0;
    const remaining=prefix?Math.max(0,total-visible):0;
    tool.preview.classList.toggle('preview-fade',remaining>0);
    if(!tool.previewMore){
      const more=button('',()=>this.openToolPreview(tool),'tool-preview-more');
      more.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();});tool.node.querySelector('summary')?.append(more);tool.previewMore=more;
    }
    tool.previewMore.hidden=remaining===0||tool.node.open;
    setText(tool.previewMore,`Show ${remaining} more lines`);tool.previewMore.title='Expand the retained content. This count excludes unavailable source lines.';
  }
  private openToolPreview(tool:ToolNode):void {
    if(!tool.source||!this.currentToolSource(tool,tool.source,this.generation))return;
    const held=!!tool.previewMore&&document.activeElement===tool.previewMore;
    tool.node.open=true;this.toolExpansion(tool);tool.technical.open=true;
    if(held)tool.node.querySelector<HTMLElement>('summary')?.focus({preventScroll:true});
    if(tool.inspections){if(tool.source.name==='write'||tool.source.name==='edit')tool.inspections.arguments.open=true;else tool.inspections.output.open=true;}
  }
  private toolExpansion(tool: ToolNode): void {
    if (this.destroyed) return;
    if (!tool.source || this.tools.get(tool.source.callId) !== tool) return;
    this.toolHeading(tool, tool.source);
    tool.preview.hidden = tool.node.open || !tool.preview.textContent; tool.expanded.hidden = !tool.node.open;
    if(tool.previewMore)tool.previewMore.hidden=tool.node.open||!tool.preview.classList.contains('preview-fade');
    if (tool.node.open) this.expandTool(tool);
  }
  private toolArguments(tool: ToolNode): string {
    const source = tool.source; if (!source) return '';
    return source.argumentText ?? (source.args ? rawText(source.args.value) : '');
  }
  private toolInspection(tool: ToolNode, label: string, source: () => string, id: string): HTMLDetailsElement {
    const node = element('details', 'raw-details'); const controls = element('div', 'source-header');
    const pre = element('pre'); const frame = preTextFrame(pre); const summary = element('summary', undefined, label); cardDisclosure(summary); node.append(summary);
    const sources = tool.inspectionSources ?? new Map(); tool.inspectionSources = sources;
    if (tool.source) sources.set(node, tool.source);
    controls.append(sourceWrap(pre)); node.append(controls);
    const materialize = () => {
      if (this.destroyed || !node.open || pre.parentElement && this.protectedNode(pre)) return;
      setText(frame, bounded(source())); if (!pre.parentElement) { controls.after(pre); this.registerContent(pre); }
      if (tool.source) sources.set(node, tool.source);
    };
    node.dataset.disclosure = id; node.open = this.expanded.has(id); this.trackDisclosure(node, id);
    node.addEventListener('toggle', materialize); this.observeDisclosure(node); materialize();
    return node;
  }
  private attachToolArguments(tool: ToolNode): void {
    const cached = tool.presentation ?? tool.argumentsDocument;
    if (tool.inspections && cached && cached.parentElement !== tool.inspections.arguments) {
      tool.inspections.arguments.append(cached); this.registerContent(cached);
    }
  }
  private presentToolRegion(tool: ToolNode, source: JoinedTool): void {
    const previous = tool.argumentsSource;
    const sameArgs = previous?.args === source.args || previous?.args?.value === source.args?.value && previous?.args?.truncated === source.args?.truncated;
    if (sameArgs && previous?.name === source.name && (tool.presentation || tool.argumentsDocument)) {
      this.attachToolArguments(tool); tool.argumentsSource = source; return;
    }
    const context = this.presentationContext();
    if ([tool.presentation, tool.argumentsDocument, tool.resultDocument].some(root => root && this.protectedNode(root))) return;
    const supplied = source.name === 'write' || source.name === 'edit';
    const budget = new PreviewBudget(this.savedOutputActions(tool, source));
    const generation = this.generation;
    const filePath = ['read', 'edit', 'write'].includes(source.name) ? (text: string) => {
      const args = source.args?.value;
      const offset: unknown = args && typeof args === 'object' && !Array.isArray(args) ? Object.getOwnPropertyDescriptor(args,'offset')?.value : undefined;
      const line = source.name === 'read' ? typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0 ? offset : 1 : undefined;
      return this.hooks.references?.renderFile(text, () => this.currentToolSource(tool, tool.argumentsSource ?? source, generation), line);
    } : undefined;
    const args = presentArguments(source.args, context, budget, {caption: source.name === 'write' ? 'Supplied content' : undefined, replacement: source.name === 'edit', shellCommand: source.name === 'bash', filePath});
    this.retireNode(tool.presentation); this.retireNode(tool.argumentsDocument);
    tool.presentation = supplied ? args : undefined; tool.argumentsDocument = supplied ? undefined : args;
    tool.previewBudget = budget;
    if (tool.presentation && tool.inspections) { tool.inspections.arguments.append(tool.presentation); this.registerContent(tool.presentation); }
    if (tool.argumentsDocument && tool.inspections) { tool.inspections.arguments.append(tool.argumentsDocument); this.registerContent(tool.argumentsDocument); }
    tool.argumentsSource = source; tool.previewBudget = budget; tool.documentSource = undefined;
  }
  private savedOutputActions(tool: ToolNode, source: JoinedTool): PreviewActions {
    const generation = this.generation;
    if (!hasSavedText(source.result ?? [])) return {};
    const current = () => this.currentToolSource(tool, source, generation);
    return {showSavedOutput: () => {
      const output = tool.inspections?.output; if (!current() || !output) return;
      tool.technical.open = true; output.open = true; output.querySelector<HTMLElement>('summary')?.focus({preventScroll: true}); this.follow = false; this.schedule();
    }};
  }
  private currentToolSource(tool: ToolNode, source: JoinedTool, generation: number): boolean {
    const current = tool.source;
    return !this.destroyed && !this.deferred && !!current && generation === this.generation && this.tools.get(source.callId) === tool && this.node.contains(tool.card) &&
      current.result === source.result && current.args === source.args && current.argumentText === source.argumentText && current.name === source.name;
  }
  private previewNotice(tool: ToolNode, source: JoinedTool): HTMLElement {
    const notice = element('p', 'secondary tool-caption preview-omission', 'Preview shortened.');
    const actions = this.savedOutputActions(tool, source);
    if (actions.showSavedOutput) notice.append(document.createTextNode(' '), button('Show saved output', actions.showSavedOutput));
    return notice;
  }
  private resultBudget(tool: ToolNode, source: JoinedTool): PreviewBudget {
    const budget = new PreviewBudget(this.savedOutputActions(tool, source));
    for (const key of ['presentation', 'argumentsDocument'] as const) {
      const root = tool[key];
      if (root && !budget.adopt(root)) { this.retireNode(root); tool[key] = undefined; }
    }
    tool.previewBudget = budget; return budget;
  }
  private expandedContent(tool: ToolNode, source: JoinedTool): void {
    if (tool.contentSource === source) return;
    const rich = this.documentResult(source);
    if (tool.contentSource?.result !== source.result) this.replaceToolPages(tool, source, rich);
    tool.contentSource = source;
  }
  private replaceToolPages(tool: ToolNode, source: JoinedTool, rich: boolean): void {
    for (const page of tool.pageViewports ?? []) this.releaseOutput(page);
    tool.pageViewports?.clear(); this.retireNode(tool.output); const output = element('div'); tool.output = output;
    const generation = this.generation;
    const append = (parts: PartView[]) => { for (const part of parts) {
      if (part.type === 'toolResult') append(part.parts);
      else if ((part.type === 'text' || part.type === 'thinking') && part.more) output.append(this.toolOutputPages(part.more, source, tool, generation));
    } };
    if (!rich) append(source.result ?? []);
    const text = tool.expanded.querySelector('.tool-output-text');
    if (text) text.after(output); else tool.resultArea.append(output);
  }
  private toolOutputNode(tool: ToolNode, source: JoinedTool): HTMLElement {
    let pre = tool.resultArea.querySelector<HTMLElement>('.tool-output-text');
    if (!pre) {
      pre = element('pre', 'tool-output-text'); preTextFrame(pre as HTMLElement); tool.resultArea.append(pre); tool.actions.append(sourceWrap(pre as HTMLElement));
      if (tool.output) pre.after(tool.output);
      const argumentsInspection = this.toolInspection(tool, 'Arguments', () => this.toolArguments(tool), `arguments:${source.callId}`);
      const resultInspection = this.toolInspection(tool, 'Raw output', () => partText(tool.source?.result ?? []), `raw-output:${source.callId}`);
      argumentsInspection.classList.add('tool-inspection'); argumentsInspection.classList.add('tool-arguments');
      resultInspection.classList.add('tool-inspection'); resultInspection.classList.add('tool-raw-output');
      const details = this.inspection('Metadata', () => this.toolDetails(tool)); details.classList.add('tool-inspection');
      tool.inspections = {arguments: argumentsInspection, output: resultInspection, details};
      tool.technical.append(argumentsInspection, resultInspection, details);
      if (argumentsInspection.open || resultInspection.open) tool.technical.open = true;
    }
    return pre;
  }
  private emptyToolResult(status: string): string {
    switch (status) {
      case 'preparing': return 'The assistant is preparing this call.';
      case 'working': return 'Working';
      case 'pending': return 'The tool has not started.';
      case 'ended': return 'The tool ended. No outcome is available.';
      case 'error': return 'The tool failed. No output is available.';
      case 'missing': return 'No result recorded.';
      case 'available': return 'No result text available.';
      default: return 'The tool completed without output.';
    }
  }
  private expandTool(tool: ToolNode): void {
    const source = tool.source; if (!source) return;
    const output = partText(source.result ?? []); const pre = this.toolOutputNode(tool, source);
    this.presentToolRegion(tool, source); this.expandedContent(tool, source);
    this.updateResultDocument(tool, source, pre);
    const wait = source.name === 'agent_await' ? awaitedToolState(source)?.label : undefined;
    if (!tool.resultDocument) this.paintToolOutput(pre, source, bounded(output || wait || this.emptyToolResult(source.status)));
    else if (pre.textContent) setText(preTextFrame(pre as HTMLElement), '');
    this.updateOutputNotice(tool, source, pre as HTMLElement, output);
    this.refreshToolPages(tool, source); this.refreshToolInspections(tool, source);
  }
  private updateOutputNotice(tool: ToolNode, source: JoinedTool, pre: HTMLElement, text: string): void {
    if (tool.resultDocument || text.length <= RAW_LIMIT) { this.retireNode(tool.outputNotice?.node); tool.outputNotice = undefined; return; }
    if (tool.outputNotice?.source === source || (tool.outputNotice && this.protectedNode(tool.outputNotice.node))) return;
    this.retireNode(tool.outputNotice?.node); const notice = this.previewNotice(tool, source);
    tool.outputNotice = {node: notice, source}; pre.after(notice);
  }
  private documentResult(source: JoinedTool): boolean {
    return imageParts(source.result ?? []).length > 0 || source.status !== 'working' && hasStructuredResult(source.result ?? []);
  }
  private updateResultDocument(tool: ToolNode, source: JoinedTool, pre: HTMLElement): void {
    if (tool.documentSource?.result !== source.result || tool.documentSource?.status !== source.status || tool.documentSource?.args !== source.args) {
      const controls = [...tool.actions.querySelectorAll<HTMLElement>('.tool-result-wrap')];
      if (tool.resultDocument && (this.protectedNode(tool.resultDocument) || controls.some(control => this.protectedNode(control)))) return;
      this.retireNode(tool.resultDocument); for (const control of controls) control.remove();
      tool.resultDocument = this.documentResult(source) ? this.resultParts(tool, source) : undefined;
      if (tool.resultDocument) {
        const texts = [...tool.resultDocument.querySelectorAll<HTMLElement>('.tool-result-text')];
        texts.forEach((text, index) => {const control = sourceWrap(text, texts.length > 1 ? `text ${index + 1}` : undefined); control.classList.add('tool-result-wrap'); tool.actions.append(control);});
        pre.after(tool.resultDocument);
      }
    }
    tool.documentSource = source;
    pre.hidden = !!tool.resultDocument;
    const wrap = tool.actions.querySelector<HTMLElement>('.source-wrap'); if (wrap) wrap.hidden = pre.hidden;
    if (pre.hidden) this.releaseOutput(pre); else this.registerOutput(pre);
    tool.viewport = tool.resultArea; this.registerOutput(tool.resultArea);
  }
  private resultParts(tool: ToolNode, source: JoinedTool): HTMLElement {
    const node = element('div', 'tool-result-parts'); const generation = this.generation; const budget = this.resultBudget(tool, source);
    const append = (parts: readonly PartView[]): void => {
      for (const part of parts) {
        if (part.type === 'toolResult') append(part.parts);
        else node.append(this.resultPart(part, source, tool, generation, budget));
      }
    };
    append(source.result ?? []);
    const limited = [...node.children].some(part => part.hasAttribute('aria-label'));
    if (limited && !node.querySelector('.preview-omission') && !tool.presentation?.querySelector('.preview-omission')) {
      node.append(this.previewNotice(tool, source));
    }
    if (tool.presentation) this.registerContent(tool.presentation);
    this.registerContent(node); return node;
  }
  private resultPart(part: PartView, source: JoinedTool, tool: ToolNode, generation: number, budget: PreviewBudget): HTMLElement {
    const section = element('section', 'tool-result-part');
    if (part.type === 'image') { const image = element('div'); this.imageContent(image, part); section.append(image); }
    else if (part.type === 'omitted') section.append(element('p', 'secondary', bounded(part.label)));
    else if (part.type === 'text' || part.type === 'thinking') {
      this.resultTextPart(section, part, source, budget);
      if (part.more) section.append(this.toolOutputPages(part.more, source, tool, generation));
    }
    this.registerContent(section); return section;
  }
  private awaitedDocument(awaited: NonNullable<ReturnType<typeof awaitedAnswers>>, structured: JsonDisplay, budget: PreviewBudget): HTMLElement | undefined {
    if (awaited.results.length) return presentAwaited(structured, this.presentationContext(), budget, this.responderNames());
    const root = element('section', 'tool-content'); root.append(element('p', 'secondary tool-caption', stillWaitingSentence(awaited))); return root;
  }
  private resultTextPart(section: HTMLElement, part: Extract<PartView, {type: 'text' | 'thinking'}>, source: JoinedTool, budget: PreviewBudget): void {
    if (part.type === 'text' && part.structured && readSourcePart(source) !== part) {
      const awaited = source.name === 'agent_await' ? awaitedAnswers(part.structured) : undefined;
      const document = awaited ? this.awaitedDocument(awaited, part.structured, budget) : presentResult(part.structured, this.presentationContext(), budget);
      if (document) section.append(document);
      else {
        budget.limit();
        section.setAttribute('aria-label', 'Structured part exceeds the content preview limit. Use raw result or copy.');
      }
      return;
    }
    if (part.text.length > RAW_LIMIT) section.setAttribute('aria-label', 'Saved text exceeds the display limit.');
    const text = element('pre', 'tool-result-text');
    this.paintToolOutput(text, source, bounded(part.redacted ? 'Thinking not available' : part.text)); section.append(text); this.registerOutput(text);
  }
  private refreshToolPages(tool: ToolNode, source: JoinedTool): void {
    for (const page of tool.output?.querySelectorAll<HTMLElement>('.output-page') ?? []) {
      if (!page.hidden) this.paintToolOutput(page, source, page.textContent ?? '');
    }
  }
  private paintToolOutput(pre: Element, source: JoinedTool, text: string, force = false): void {
    const args = record(source.args);
    const language = source.name === 'read' && source.status === 'success' ? languageFromPath(args.file_path ?? args.path) : undefined;
    const node = pre as HTMLElement;
    const start = node.classList.contains('output-page') ? undefined : readLineStart(source, text);
    const numbering = start === undefined ? '' : String(start);
    if (!force && pre.textContent === text && node.dataset.language === (language ?? '') && node.dataset.readLineStart === numbering) return;
    const frame = preTextFrame(node);
    if (start !== undefined) frame.replaceChildren(numberedRead(text, start, language));
    else frame.replaceChildren(language ? highlight(text, language) : document.createTextNode(text));
    node.dataset.language = language ?? ''; node.dataset.readLineStart = numbering;
  }
  private toolOutputPages(more: OutputContinuation, source: JoinedTool, tool: ToolNode, generation: number): HTMLElement {
    const current = () => generation === this.generation && this.tools.get(source.callId) === tool && tool.source?.result === source.result;
    let pages: HTMLElement | undefined;
    const changed = () => {
      const pre = pages?.querySelector<HTMLElement>('.output-page');
      if (pre && !pre.hidden && current()) this.paintToolOutput(pre, tool.source ?? source, pre.textContent ?? '', true);
      this.schedule();
    };
    pages = outputPages(more, this.hooks.output, current, changed); this.registerContent(pages);
    const pre = pages.querySelector<HTMLElement>('.output-page');
    if (pre) {
      if (!tool.pageViewports) tool.pageViewports = new Set();
      tool.pageViewports.add(pre); this.registerOutput(pre);
    }
    return pages;
  }
  private toolDetails(tool: ToolNode): string {
    const source = tool.source;
    const awaitedFields = source?.name === 'agent_await' ? awaitedFieldsFromParts(source.result ?? []) : undefined;
    const cards = source?.name === 'write' || source?.name === 'edit' ? cardPreviewLimits() : '';
    return [source ? `Tool: ${source.name}\nCall ID: ${source.callId}\n${metadata(source)}\n${toolTime(source)}` : '', awaitedFields ? `Fields of the awaited results (answers are shown above):\n${awaitedFields}` : '', cards, previewLimits(), `Raw inspection: at most ${RAW_LIMIT} characters.`, source ? outputExplanation(source) : ''].filter(Boolean).join('\n\n');
  }
  private refreshToolInspections(tool: ToolNode, source: JoinedTool): void {
    this.refreshToolInspection(tool.inspections?.arguments, () => this.toolArguments(tool), tool);
    this.refreshToolInspection(tool.inspections?.output, () => partText(source.result ?? []), tool);
    this.refreshToolInspection(tool.inspections?.details, () => this.toolDetails(tool));
    if (tool.inspections) tool.inspections.details.hidden = false;
  }
  private refreshToolInspection(node: HTMLDetailsElement | undefined, source: () => string, tool?: ToolNode): void {
    if (!node?.open || this.protectedNode(node) || tool?.source && tool.inspectionSources?.get(node) === tool.source) return;
    const data = [...node.children].find(child => child.tagName.toLowerCase() === 'pre') as HTMLElement | undefined;
    if (data) { setText(preTextFrame(data), bounded(source())); if (tool?.source) tool.inspectionSources?.set(node, tool.source); }
  }
  private thinkingOpen(node: HTMLElement): boolean {
    return node.dataset.streaming === 'true' || this.showThinking || this.expanded.has(node.dataset.disclosure ?? '') || this.streamedOpen(node);
  }
  private streamKey(message: MessageView, index: number): string {
    const stamp = pairedTimestamp(message);
    return stamp !== undefined ? `@${stamp}:${index}` : `${message.id}:${index}`;
  }
  private streamedParts(node: HTMLElement): HTMLElement[] {
    return node.classList.contains('thinking-group') ? [...node.querySelectorAll<HTMLElement>('.thinking')] : [node];
  }
  private streamedOpen(node: HTMLElement): boolean {
    return this.streamedParts(node).some(part => part.dataset.streamKey !== undefined && this.streamedThinking.has(part.dataset.streamKey));
  }
  private forgetStreamed(node: HTMLElement): void {
    for (const part of this.streamedParts(node)) if (part.dataset.streamKey !== undefined) this.streamedThinking.delete(part.dataset.streamKey);
  }
  private trackDisclosure(node: HTMLDetailsElement, id: string): void {
    node.querySelector('summary')?.addEventListener('click', event => {
      if (this.hasSelection() || event.detail > 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) event.preventDefault();
    });
    node.addEventListener('toggle', () => {
      if (this.destroyed || !this.node.contains(node)) return;
      const current = node.dataset.disclosure ?? id;
      if (node.dataset.streaming === 'true') { node.open = true; return; }
      if (node.open === this.disclosureExpected(node, current)) return;
      this.follow = false;
      if (node.open) this.expanded.add(current); else this.disclosureClosed(node, current);
      this.hooks.presentation([...this.expanded], this.showThinking); this.schedule();
    });
  }
  private disclosureClosed(node: HTMLElement, id: string): void {
    this.expanded.delete(id);
    if (!id.startsWith('thinking:')) return;
    this.forgetStreamed(node);
    if (this.showThinking) this.closeThinkingPreference(id);
  }
  private disclosureExpected(node: HTMLElement, id: string): boolean {
    return this.expanded.has(id) || id.startsWith('thinking:') && (this.showThinking || this.streamedOpen(node));
  }
  private closeThinkingPreference(excluded: string): void {
    for (const entry of this.cache.values()) for (const node of entry.node.querySelectorAll<HTMLDetailsElement>('.thinking')) {
      const id = node.dataset.disclosure;
      if (node.open && node.dataset.streaming !== 'true' && id && id !== excluded) this.expanded.add(id);
    }
    this.showThinking = false; this.thinkingChoice = 'hidden';
  }
  private applyPreferences(): void {
    for (const entry of this.cache.values()) for (const node of entry.node.querySelectorAll<HTMLDetailsElement>('[data-disclosure]')) {
      const id = node.dataset.disclosure ?? ''; const open = id.startsWith('thinking:') ? this.thinkingOpen(node) : this.expanded.has(id);
      if (node.classList.contains('message-source')) { node.hidden = !open; node.inert = !open; }
      else node.open = open;
    }
    for (const entry of this.cache.values()) this.openThinkingGroups(entry);
  }
  private openThinkingGroups(entry: EntryNode): void {
    for (const message of entry.messages.values()) for (const group of message.thinkingGroups?.values() ?? []) {
      if ([...group.body.children].some(part => (part as HTMLDetailsElement).open)) group.node.open = true;
    }
  }
  expandLoaded(tools: boolean, expanded: boolean): void {
    if (!tools) {this.showThinking = expanded; this.thinkingChoice = expanded ? 'shown' : 'hidden'; if (!expanded) this.streamedThinking.clear(); this.deriveRows();}
    for (const id of this.loadedDisclosures(tools)) {
      if (expanded) this.expanded.add(id); else this.expanded.delete(id);
    }
    this.applyPreferences();
    this.follow = false; this.hooks.presentation([...this.expanded], this.showThinking); this.schedule();
  }
  private loadedDisclosures(tools: boolean): string[] {
    const ids = [...this.index.disclosures.keys()].filter(id => tools ? id.startsWith('tool:') || id.startsWith('steps:') : id.startsWith('thinking:'));
    if (!tools) ids.push(...[...this.expanded].filter(id => id.endsWith(':group') && this.index.disclosures.has(id.slice(0, -6))));
    return ids;
  }
  private clearFind(restore = true): void {
    this.findNode?.classList.remove('find-current'); this.findNode = undefined;
    if (this.findId) this.pins.delete(this.findId);
    const hidden = this.findId && this.initialSettings.has(this.findId);
    this.findId = undefined;
    if (hidden && restore && !this.destroyed) this.set(this.entries, this.toolStates, this.thinkingTimes, this.historyBeginning);
  }
  private refreshFind(): void {
    const cached = this.findId ? this.cache.get(this.displayId(this.findId)) : undefined;
    const node = cached?.session ? cached.session.events.cache.get(this.findId ?? '')?.node ?? cached.session.notices.cache.get(this.findId ?? '')?.node : cached?.node;
    if (this.findNode !== node) this.findNode?.classList.remove('find-current');
    this.findNode = node; node?.classList.add('find-current');
  }
  private findMatches(query: string): string[] {
    if (!query.trim()) return [];
    const needle = query.toLocaleLowerCase();
    return [...new Set(this.entries.filter(entry => rawText(entry).toLocaleLowerCase().includes(needle)).map(entry => entry.id))];
  }
  private revealFind(destination: string): void {
    const changedVisibility = this.initialSettings.has(this.findId ?? '') || this.initialSettings.has(destination);
    this.findId = destination;
    if (changedVisibility) this.set(this.entries, this.toolStates, this.thinkingTimes, this.historyBeginning);
    this.revealEntry(destination, false);
  }
  private findEnd(direction: number, index: number, total: number): FindStatus {
    return {total, position: index + 1, moved: false, end: direction < 0 ? 'first' : 'last'};
  }
  find(active: () => boolean = () => true): FindSession {
    this.clearFind(); const revision = ++this.findRevision, generation = this.generation;
    let closed = false, query = '', current = '';
    const close = () => {closed = true; if (revision === this.findRevision) this.clearFind();};
    const reset = () => {query = ''; current = ''; if (revision === this.findRevision) this.clearFind();};
    const valid = () => !closed && revision === this.findRevision && generation === this.generation && !this.destroyed && active();
    const initial = (direction: number, changed: boolean, total: number) => changed || direction > 0 ? 0 : total - 1;
    const step = (text: string, direction: number): FindStatus => {
      if (!valid()) {close(); return {total: 0, position: 0, moved: false, end: 'unavailable'};}
      if (this.hidden()) return {total: 0, position: 0, moved: false, end: 'unavailable'};
      const changed = text !== query; if (changed) reset(); query = text;
      const matches = this.findMatches(query);
      if (!matches.length) {reset(); return {total: 0, position: 0, moved: false, end: 'none'};}
      const index = matches.indexOf(current);
      const next = index < 0 ? initial(direction, changed, matches.length) : index + direction;
      const destination = matches[next];
      if (!destination) return this.findEnd(direction, index, matches.length);
      current = destination; this.revealFind(current);
      return {total: matches.length, position: next + 1, moved: true, end: null};
    };
    return {next: query => step(query, 1), previous: query => step(query, -1), reset, close};
  }
}
