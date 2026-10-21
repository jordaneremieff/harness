import type { JsonDisplay } from '../shared/api.ts';
import { awaitedAnswers, missingAnswerNote, responderName, type AnswerNamer } from './awaited-answers.ts';
import { button, element } from './dom.ts';
import { highlight, languageFromPath } from './highlight.ts';
import { plainPreviewWords, previewText } from './format.ts';
import { markdownDom, withoutFrontmatter } from './safe-markdown.ts';
import type { PresentationContext } from './transcript-presentation.ts';
import { suppliedDifference, differenceNotice } from './supplied-difference.ts';

const SCAN = 2048;
const DEPTH = 8;
const NODES = 128;
const FIELDS = 24;
const ROWS = 12;
const COLS = 6;
const DOC_CHARS = 8192;
const DOC_LINES = 80;
const TEXT_CHARS = 16384;
const DOM_NODES = 512;
const NOTICE_CHARS = 112;
// Reserve all notice controls before saved-output actions become available.
const NOTICE_NODES = 8;
export function previewLimits(): string {
  return `Structured previews: at most ${DOC_CHARS} characters and ${DOC_LINES} lines per document, ${TEXT_CHARS} total characters (${NOTICE_CHARS} reserved for the notice), ${FIELDS} fields per object, ${ROWS} rows per array, ${COLS} table columns, depth ${DEPTH}, ${NODES} visited values, ${SCAN} scanned fields, and ${DOM_NODES} display nodes. Arguments, output, and expanded details share these limits. Collapsed summaries use at most 240 characters and 2 lines, ${FIELDS} own fields per object, ${NODES} scanned fields in total, and depth ${DEPTH}.`;
}
type PreviewOmission = 'text' | 'fields' | 'rows' | 'nested values';
const sourceKey = /(?:^|[_-])(command|program|code|script)$/i;
const payloadKey = /^(?:payload|content|body|text|document|data|records|results|items|entries|value)$/i;
type Entry = [string, unknown];
type Metadata = {path: string; value: unknown; depth: number; hint?: string; pathOnly?: boolean};
type Scan = {entries: Entry[]; complete: boolean};
type Field = {key: string; value: unknown; path: string; depth: number; rank: number; order: number[]; promoted: boolean};
const previews = new WeakMap<HTMLElement, Preview>();

function ordered(a: Field, b: Field): number {
  for (let i = 0; i < Math.min(a.order.length, b.order.length); i++) {
    const difference = (a.order[i] ?? 0) - (b.order[i] ?? 0); if (difference) return difference;
  }
  return a.order.length - b.order.length;
}
function container(value: unknown): value is Record<string, unknown> | unknown[] { return record(value) || Array.isArray(value); }
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function words(key: string): string { return key.slice(0, 240).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(); }
function explicitKey(key: string): boolean {
  return /(?:^|[_.-])(?:errors?|warnings?|truncated|omitted|omissions?)(?:$|[_.-])/.test(words(key));
}
function metadataKey(key: string): boolean {
  return !explicitKey(key) && /(?:^|[_-])(?:cursor|digest|coverage|limits?|provenance|metadata|transport|usage|quer(?:y|ies)|scans?|counters?|stats|statistics|consistency|representation|offsets?|(?:excerpt_?)?(?:start|end)|field)(?:$|[_-])/.test(words(key));
}
function pathFor(parent: string, key: string): string { return prefix(parent ? `${parent}.${key}` : key, 240, 1); }
/** Dot boundaries preserve readable path segments and exact key text. */
export function appendKey(node: HTMLElement, key: string): void {
  node.className = `${node.className ? `${node.className} ` : ''}field-key${key.length > 24 ? ' field-key-wide' : ''}`;
  const segments = key.split('.');
  segments.forEach((segment, index) => {
    node.append(document.createTextNode(`${segment}${index < segments.length - 1 ? '.' : ''}`));
    if (index < segments.length - 1) node.append(element('wbr'));
  });
}
function multiline(value: string): boolean { return /[\r\n]/.test(value); }
function prefix(text: string, chars: number, lines = DOC_LINES): string {
  return previewText(text, lines, chars).text;
}
function summaryFact(key: string, value: unknown, truncated: boolean): string {
  const name = prefix(key, 80, 1).replace(/[\r\n\t]/g, ' ');
  if (Array.isArray(value)) return `${name}: ${summaryArray(value, truncated)}`;
  const literal = value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  return literal ? `${name}: ${prefix(scalar(value), 80, 1).replace(/[\r\n\t]/g, ' ')}` : name;
}
function summaryArray(value: unknown[], truncated: boolean): string {
  // The projection can replace an unknown tail with a single omission marker.
  if (truncated) return 'Array preview limited';
  return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
}
/** A complete frontmatter document contributes its first body line, with its first heading as the empty-prose fallback. */
function documentPreview(text: string): string | undefined {
  const body = withoutFrontmatter(text); if (body === text) return undefined;
  let heading = '';
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    if (/^\s*#{1,6}(?:\s|$)/.test(line)) { if (!heading) heading = plainPreviewWords(line); continue; }
    return prefix(plainPreviewWords(line), 240, 1);
  }
  return prefix(heading, 240, 1);
}
type SummaryField = {key: string; value: unknown; rank: number; label?: string};
/** Resolves an opaque conversation or thread identity to a name the reader already knows, when one is known. */
export type NameResolver = (identity: string) => string | undefined;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const opaqueValue = new RegExp(`^(?:${UUID}(?:[:/][0-9a-z]+)*|[0-9a-f]{16,})$`, 'i');
const identifierKey = /(?:^|_)ids?$/;
/** An identifier is a field named for one, or a value shaped like one: a UUID with optional qualifiers, or a long hex digest. */
export function identifierField(key: string, value: unknown): boolean {
  const last = key.slice(key.lastIndexOf('.') + 1);
  if (identifierKey.test(words(last)) && (typeof value === 'string' || typeof value === 'number')) return true;
  return typeof value === 'string' && value.length <= 256 && opaqueValue.test(value);
}
function summaryPayload(value: unknown): boolean { return typeof value === 'string' && value.length > 0 || container(value); }
function summaryFlag(value: unknown): boolean { return value === true || typeof value === 'number' && value > 0 || summaryPayload(value); }
function summaryRank(key: string, value: unknown, metadata: boolean): number {
  if (explicitKey(key)) return summaryFlag(value) ? 0 : 4;
  if (metadataKey(key)) return 4;
  if (payloadKey.test(key) && summaryPayload(value)) return 1;
  if (typeof value === 'string' && (multiline(value.slice(0, 81)) || !metadata && value.length > 80)) return 1;
  return metadata ? 4 : 3;
}
function emptyCollection(value: unknown): boolean {
  return Array.isArray(value) ? value.length === 0 : record(value) && Object.keys(value).length === 0;
}
class ResultSummary {
  private scanned = 0;
  private limited = false;
  private readonly seen = new WeakSet<object>();
  private readonly facts: SummaryField[] = [];
  private omitted = false;
  private readonly resolve: NameResolver | undefined;
  private readonly title: string;
  constructor(resolve?: NameResolver, title = '') {this.resolve = resolve; this.title = title;}
  private entries(value: Record<string, unknown>, metadata: boolean): SummaryField[] {
    const fields: SummaryField[] = []; let visited = 0;
    for (const key in value) {
      if (visited++ >= FIELDS || this.scanned >= NODES) {this.limited = true; break;}
      this.scanned++;
      const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) continue;
      const child = 'value' in descriptor ? descriptor.value : undefined;
      fields.push({key, value: child, rank: summaryRank(key, child, metadata)});
    }
    return fields.sort((a, b) => a.rank - b.rank);
  }
  /** Reports whether every field was an identifier left out of the line. */
  private collect(value: Record<string, unknown>, path: string, depth: number, metadata: boolean, flag: boolean): boolean {
    if (depth > DEPTH || this.seen.has(value)) {this.limited = true; return false;}
    this.seen.add(value);
    const fields = this.entries(value, metadata); let identifiers = 0;
    for (const field of fields) if (this.collectField(field, path, depth, metadata, flag)) identifiers++;
    return identifiers > 0 && identifiers === fields.length;
  }
  private identity(key: string, value: unknown): void {
    const name = typeof value === 'string' ? this.resolve?.(value) : undefined;
    if (name) this.facts.push({key, value: name, rank: 2, label: prefix(name, 80, 1).replace(/[\r\n\t]/g, ' ')}); else this.omitted = true;
  }
  /** Identifiers never appear in a compact line, except as the name of a conversation or thread the reader already knows. Returns true when the field was an identifier. */
  private collectField(field: SummaryField, path: string, depth: number, metadata: boolean, flag: boolean): boolean {
    const key = pathFor(path, prefix(field.key, 80, 1)); const rank = flag ? 0 : field.rank;
    if (identifierField(key, field.value)) { this.identity(key, field.value); return true; }
    const fact = {key, value: field.value, rank};
    if (!depth || rank <= 1) this.facts.push(fact);
    if (!record(field.value)) return false;
    const before = this.facts.length;
    const identifiers = this.collect(field.value, key, depth + 1, metadata || metadataKey(field.key), flag || rank === 0);
    if (this.facts.length > before || identifiers) {
      const index = this.facts.indexOf(fact); if (index !== -1) this.facts.splice(index, 1);
    }
    return false;
  }
  /** A name the card title already shows, or a false flag other than an outcome or an explicit error, warning or truncation fact, adds nothing to the line. */
  private redundant(field: SummaryField): boolean {
    if (field.label !== undefined) return this.title.includes(field.label);
    if (field.value !== false) return false;
    const name = words(field.key.slice(field.key.lastIndexOf('.') + 1));
    return name !== 'ok' && name !== 'success' && !explicitKey(field.key);
  }
  text(value: Record<string, unknown>, truncated: boolean): string {
    this.collect(value, '', 0, false, false);
    const useful = this.facts.some(field => field.rank < 4);
    const readable = this.facts.find(field => field.rank === 1 && typeof field.value === 'string');
    const document = readable ? documentPreview(String(readable.value)) : undefined;
    const shown = new Set<string>(); let dropped = false;
    const listed = this.facts.filter(field => (!useful || field.rank < 4) && (document === undefined || field.rank !== 3));
    // An empty collection is a fact only when nothing else is; at equal rank facts that say something in words read first, then array counts, then objects shown by key name alone.
    const present = listed.filter(field => !emptyCollection(field.value));
    const facts = (present.length ? present : listed).sort((a, b) => a.rank - b.rank || shapeOrder(a.value) - shapeOrder(b.value)).flatMap(field => {
      if (this.redundant(field)) {dropped = true; return [];}
      const text = field === readable ? document ?? prefix(String(field.value).replace(/\s*\n\s*(?:\n\s*)+/g, '\n'), 240, 2) : field.label ?? summaryFact(field.key, field.value, truncated);
      if (!text || shown.has(text)) {dropped = true; return [];}
      shown.add(text); return [text];
    }).slice(0, 3);
    const notice = [truncated ? 'Partial preview.' : '', this.limited ? 'Summary scan limited.' : ''].filter(Boolean).join(' ');
    const suffix = notice ? ` · ${notice}` : '';
    if (!facts.length && (this.omitted || dropped)) return document === undefined ? '' : notice;
    return prefix(facts.length ? facts.join(' · ') : 'Empty object', 240 - suffix.length, document === undefined ? 2 : 1) + suffix;
  }
}
/** Tie-break order at equal rank: scalar 0, array count 1, object 2 (its fact is only a key name). */
function shapeOrder(value: unknown): number {
  return Array.isArray(value) ? 1 : record(value) ? 2 : 0;
}
/** True when the decoded value is an array, which the server also uses for text made of several JSON lines or prose mixed with JSON lines. */
export function decodedArray(display: JsonDisplay | undefined): boolean {
  return record(display) && Array.isArray(own(display, 'value'));
}
export type DecodedLine = {kind: 'text' | 'summary'; text: string};
/**
 * The elements of a decoded array that came from prose and JSON lines, in order: text stays text, an object is its compact summary,
 * a nested array is its count. An element that has nothing readable to say (only identifiers) adds no line.
 */
export function decodedLines(display: JsonDisplay | undefined, resolve?: NameResolver, title = ''): DecodedLine[] | undefined {
  if (!decodedArray(display)) return undefined;
  const value = own(display as object, 'value') as unknown[], truncated = own(display as object, 'truncated') === true, lines: DecodedLine[] = [];
  for (const item of value) {
    if (typeof item === 'string') {lines.push({kind: 'text', text: item}); continue;}
    const text = structuredResultPreview({value: item, truncated}, resolve, title);
    if (text?.trim()) lines.push({kind: 'summary', text: text.trimEnd()});
  }
  return lines;
}
/** Summarize only decoded own data; bounded classification never parses raw output. */
export function structuredResultPreview(display: JsonDisplay | undefined, resolve?: NameResolver, title = ''): string | undefined {
  if (!record(display)) return undefined;
  const value = own(display, 'value'); const truncated = own(display, 'truncated') === true;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return summaryArray(value, truncated);
  if (record(value)) return new ResultSummary(resolve, title).text(value, truncated);
  if (typeof value === 'string' && identifierField('', value)) return resolve?.(value) ?? '';
  const suffix = truncated ? ' · Partial preview.' : '';
  return prefix(scalar(value), 240 - suffix.length, 2) + suffix;
}
function countNodes(node: Node, limit = DOM_NODES): number {
  let count = 0; const pending = [node];
  while (pending.length && count <= limit) {
    const current = pending.pop(); if (!current) break;
    count++;
    for (const child of current.childNodes) pending.push(child);
  }
  return count;
}
function preFrame(pre: HTMLElement): HTMLElement {
  const content = Array.from(pre.childNodes); const frame = element('span', 'pre-text-frame');
  pre.textContent = ''; frame.append(...content); pre.append(frame); return frame;
}
function framedPre(className?: string, text?: string): {pre: HTMLPreElement; frame: HTMLElement} {
  const pre = element('pre', className); const frame = preFrame(pre);
  if (text !== undefined) frame.textContent = text;
  return {pre, frame};
}
function scalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return 'Value not displayed';
}
function shortScalar(value: unknown): boolean {
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && !multiline(value) && value.length <= 80);
}
function language(args: Record<string, unknown>): string | undefined {
  for (const key of ['language', 'lang']) {
    const value = own(args, key);
    if (typeof value === 'string') return value.slice(0, 40);
  }
  for (const key of ['path', 'file_path', 'filename']) {
    const value = own(args, key);
    if (typeof value === 'string') return languageFromPath(value.slice(0, 4096));
  }
  return undefined;
}

export type PreviewActions = {showSavedOutput?: () => void; copySavedText?: () => void};
type ArgumentPresentation = {caption?: string; replacement?: boolean; shellCommand?: boolean; filePath?: (text: string) => HTMLElement | undefined};

/** Share one instance across a tool's arguments, result previews and deferred metadata. */
export class PreviewBudget {
  text = TEXT_CHARS - NOTICE_CHARS;
  visits = 0;
  scanned = 0;
  private readonly roots = new Set<HTMLElement>();
  private notice?: HTMLElement;
  private noticeText?: Text;
  private noticeRoot?: HTMLElement;
  private readonly omissions = new Set<PreviewOmission>();
  private hostOmitted = false;
  private readonly actions: PreviewActions;
  constructor(actions: PreviewActions = {}) { this.actions = {...actions}; }
  /** Transfer only a helper-owned root, before fresh result previews are created. */
  adopt(root: HTMLElement): boolean {
    if (this.roots.has(root)) return true;
    return previews.get(root)?.transfer(this) ?? false;
  }
  retainedCost(root: HTMLElement): {text: number; nodes: number} {
    let text = (root.textContent ?? '').length; let nodes = countNodes(root);
    if (this.notice && Array.from(root.childNodes).includes(this.notice)) {
      text -= (this.notice.textContent ?? '').length; nodes -= countNodes(this.notice);
    }
    return {text, nodes};
  }
  retain(root: HTMLElement, cost: {text: number; nodes: number}, visits: number, scanned: number): boolean {
    if (cost.text > this.text || cost.nodes > this.room() || this.visits + visits > NODES || this.scanned + scanned > SCAN) {
      this.limit(); return false;
    }
    this.roots.add(root); this.text -= cost.text; this.visits += visits; this.scanned += scanned; return true;
  }
  detach(root: HTMLElement): void {
    this.roots.delete(root);
    if (this.noticeRoot === root) this.noticeRoot = undefined;
    if (this.notice && Array.from(root.childNodes).includes(this.notice)) { this.notice.remove(); this.notice = undefined; }
  }
  acquire(root: HTMLElement): boolean {
    if (this.room() < 1 || !this.text || this.visits >= NODES) { this.limit(); return false; }
    this.roots.add(root); return true;
  }
  releaseEmpty(root: HTMLElement): void { if (!root.childNodes.length) this.roots.delete(root); }
  finish(root: HTMLElement): void {
    if (!Array.from(root.childNodes).some(child => child !== this.notice)) return;
    this.noticeRoot = root;
    if (this.omissions.size || this.hostOmitted) this.updateNotice();
  }
  room(): number {
    let nodes = 0;
    for (const root of this.roots) {
      nodes += countNodes(root, DOM_NODES - nodes);
      if (nodes >= DOM_NODES) break;
    }
    return DOM_NODES - nodes - (NOTICE_NODES - (this.notice ? countNodes(this.notice) : 0));
  }
  limit(reason: PreviewOmission = 'fields'): void { this.omissions.add(reason); this.updateNotice(); }
  truncate(): void { this.hostOmitted = true; this.updateNotice(); }
  private updateNotice(): void {
    const root = this.noticeRoot ?? this.roots.values().next().value; if (!root) return;
    if (!this.notice) {
      this.notice = element('p', 'secondary tool-caption preview-omission');
      this.noticeText = document.createTextNode(''); this.notice.append(this.noticeText);
      for (const [label, action] of [
        ['Show saved output', this.actions.showSavedOutput], ['Copy saved text', this.actions.copySavedText],
      ] as const) {
        if (action) this.notice.append(document.createTextNode(' '), button(label, action));
      }
    }
    if (this.noticeText) this.noticeText.textContent = [
      this.omissions.size ? 'Preview shortened.' : '', this.hostOmitted ? 'Some output was not retained.' : '',
    ].filter(Boolean).join(' ');
    this.notice.remove(); root.append(this.notice);
  }
}

class Preview {
  readonly root = element('section', 'tool-content');
  private budget: PreviewBudget;
  private readonly admitted: boolean;
  private readonly truncated: boolean;
  private readonly omissions = new Set<PreviewOmission>();
  private spentVisits = 0;
  private spentScans = 0;
  private readonly scans = new WeakMap<object, Scan>();
  private readonly metadata: Metadata[] = [];
  private readonly promotedPaths = new Set<string>();
  private readonly classifiedMetadata = new Set<string>();
  private readonly metadataSeen = new WeakSet<object>();
  private readonly prepared = new WeakSet<object>();
  private readonly documentCounts = new WeakMap<object, number>();
  private readonly sectionPaths = new Set<string>();
  private readonly scalarBranches = new WeakSet<object>();
  private readonly ancestors = new WeakSet<object>();
  private metadataBuilt = false;
  private readonly context: PresentationContext;
  private readonly argumentsMode: boolean;
  private shellCommand = false;
  private argumentFilePath?: ArgumentPresentation['filePath'];
  constructor(context: PresentationContext, argumentsMode: boolean, truncated: boolean, budget: PreviewBudget) {
    this.context = context; this.argumentsMode = argumentsMode; this.budget = budget; this.truncated = truncated;
    this.admitted = budget.acquire(this.root);
    if (this.admitted) previews.set(this.root, this);
    if (truncated) budget.truncate();
  }
  transfer(budget: PreviewBudget): boolean {
    const previous = this.budget;
    if (!budget.retain(this.root, previous.retainedCost(this.root), this.spentVisits, this.spentScans)) return false;
    previous.detach(this.root); this.budget = budget;
    for (const reason of this.omissions) budget.limit(reason);
    if (this.truncated) budget.truncate();
    budget.finish(this.root);
    return true;
  }
  private limit(reason: PreviewOmission = 'fields'): void { this.omissions.add(reason); this.budget.limit(reason); }
  private room(): number { return this.budget.room(); }
  private scan(value: Record<string, unknown> | unknown[]): Scan {
    const cached = this.scans.get(value); if (cached) return cached;
    const entries: Entry[] = []; let complete = true;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (this.budget.scanned >= SCAN) { complete = false; this.limit(); break; }
      this.budget.scanned++; this.spentScans++;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) entries.push([key, descriptor.value]);
      else { complete = false; this.limit(); }
    }
    const result = {entries, complete}; this.scans.set(value, result); return result;
  }
  private documentString(value: unknown): value is string {
    return typeof value === 'string' && (multiline(value) || value.length >= (this.argumentsMode ? 512 : 81));
  }
  private documentCount(value: unknown): number {
    if (this.documentString(value)) return 1;
    return container(value) ? this.documentCounts.get(value) ?? 0 : 0;
  }
  private documentValue(value: unknown): boolean { return this.documentCount(value) > 0; }
  private shapedMetadata(value: unknown): boolean {
    return value === null || (record(value) && this.scalarBranches.has(value));
  }
  private rank([key, value]: Entry): number {
    if (metadataKey(key)) return 4;
    if (!this.argumentsMode && this.documentValue(value)) return 0;
    if (explicitKey(key)) return this.meaningfulFlag(value) ? 1 : 4;
    if (this.argumentsMode && (sourceKey.test(key) || key === 'edits')) return 1;
    if (this.documentString(value) || (payloadKey.test(key) && this.usefulType(value))) return 1;
    if (container(value)) return 2;
    return 3;
  }
  private usefulType(value: unknown): boolean { return (typeof value === 'string' && value.length > 0) || container(value); }
  private meaningfulFlag(value: unknown): boolean {
    return value === true || (typeof value === 'number' && value > 0) || (typeof value === 'string' && Boolean(value.trim())) || container(value);
  }
  private scanRank([key, value]: Entry): number {
    if (explicitKey(key)) return 0;
    if (this.documentString(value)) return 1;
    if (payloadKey.test(key) && this.usefulType(value)) return 2;
    return container(value) ? 3 : 4;
  }
  private prepare(value: unknown, depth: number): void {
    if (!container(value) || this.prepared.has(value)) return;
    if (depth > DEPTH) { this.limit(); return; }
    this.prepared.add(value);
    const entries = [...this.scan(value).entries];
    const selected = Array.isArray(value) ? entries.slice(0, ROWS) : entries.filter(([key]) => !metadataKey(key));
    selected.sort((a, b) => this.rank(a) - this.rank(b));
    const shown = selected.slice(0, FIELDS);
    for (const [key, child] of shown) {
      if (!(this.argumentsMode && key === 'edits')) this.prepare(child, depth + 1);
    }
    const documents = Math.min(2, shown.reduce((count, [, child]) => count + this.documentCount(child), 0));
    const complete = this.scan(value).complete && selected.length <= FIELDS;
    this.documentCounts.set(value, documents === 1 && !complete ? 2 : documents);
    if (this.scan(value).complete && entries.every(([, child]) => shortScalar(child) || (container(child) && this.scalarBranches.has(child)))) this.scalarBranches.add(value);
  }
  private prepareFields(entries: Entry[], depth: number): void {
    for (const [key, child] of [...entries].sort((a, b) => this.rank(a) - this.rank(b))) {
      if (!metadataKey(key) && !(this.argumentsMode && key === 'edits')) this.prepare(child, depth + 1);
    }
  }
  private fields(value: Record<string, unknown>, path: string, depth: number, collectMetadata: boolean): Field[] {
    // Classify payloads before metadata, without consuming display visits or text.
    const entries = this.scan(value).entries;
    if (collectMetadata) this.prepareFields(entries, depth);
    const documentRecord = !this.argumentsMode && entries.some(([, child]) => this.documentValue(child));
    const fields: Field[] = [];
    for (const [index, [key, child]] of entries.entries()) {
      const childPath = this.path(path, key);
      const shapedMetadata = documentRecord && !explicitKey(key) && this.shapedMetadata(child);
      fields.push({key, value: child, path: childPath, depth: depth + 1, rank: shapedMetadata ? 4 : this.rank([key, child]), order: [index], promoted: false});
      if (collectMetadata && (metadataKey(key) || shapedMetadata)) fields.push(...this.promote(child, key, childPath, depth + 1, [index]));
    }
    fields.sort((a, b) => a.rank - b.rank || ordered(a, b));
    if (fields.length > FIELDS) this.limit();
    return fields.slice(0, FIELDS);
  }
  private promotionRank(key: string, value: unknown, entries: Entry[]): number | undefined {
    if (explicitKey(key)) return this.meaningfulFlag(value) ? 1 : undefined;
    if (typeof value === 'string' && multiline(value)) return this.argumentsMode ? 1 : 0;
    if (!payloadKey.test(key)) return undefined;
    if ((typeof value === 'string' && value.length > 0) || (container(value) && entries.length > 0)) return 2;
    return undefined;
  }
  private promote(value: unknown, key: string, path: string, depth: number, order: number[]): Field[] {
    if (this.classifiedMetadata.has(path)) return [];
    this.classifiedMetadata.add(path);
    if (depth > DEPTH) { this.limit(); return []; }
    const entries = this.metadataEntries(value);
    if (entries === undefined) return [];
    const fields: Field[] = []; const rank = this.promotionRank(key, value, entries);
    if (rank !== undefined) {
      fields.push({key, value, path, depth, rank, order, promoted: true}); this.promotedPaths.add(path);
    }
    const children = entries.map((entry, index) => ({entry, index}));
    children.sort((a, b) => this.scanRank(a.entry) - this.scanRank(b.entry));
    for (const {entry: [childKey, child], index} of children) {
      const label = Array.isArray(value) && /^\d+$/.test(childKey) ? String(Number(childKey) + 1) : childKey;
      fields.push(...this.promote(child, childKey, this.path(path, label), depth + 1, [...order, index]));
    }
    return fields;
  }
  private metadataEntries(value: unknown): Entry[] | undefined {
    if (!container(value)) return [];
    if (this.metadataSeen.has(value)) { this.limit(); return undefined; }
    this.metadataSeen.add(value); return this.scan(value).entries;
  }
  private covered(path: string): boolean {
    let scope = '';
    for (const entry of this.metadata) {
      if ((path === entry.path || path.startsWith(`${entry.path}.`)) && entry.path.length > scope.length) scope = entry.path;
    }
    for (const promoted of this.promotedPaths) {
      if (scope !== promoted && scope.startsWith(`${promoted}.`)) continue;
      if (path === promoted || path.startsWith(`${promoted}.`)) return true;
    }
    return false;
  }
  private take(text: string, limit = DOC_CHARS, lines = DOC_LINES): string {
    const bound = Math.min(limit, this.budget.text);
    const shown = prefix(this.context.bounded(prefix(text, bound, lines), bound), bound, lines);
    this.budget.text -= shown.length;
    if (shown.length < text.length) this.limit('text');
    return shown;
  }
  private append(parent: HTMLElement, child: Node): boolean {
    if (countNodes(child, this.room()) > this.room()) { this.limit('nested values'); return false; }
    parent.append(child); return true;
  }
  private caption(parent: HTMLElement, text: string): void {
    if (this.budget.text) {
      const caption = element('p', 'secondary tool-caption'); appendKey(caption, this.take(text, 240, 1)); this.append(parent, caption);
    } else this.limit('text');
  }
  private document(parent: HTMLElement, key: string, value: string): void {
    if (key) this.caption(parent, key);
    const text = this.take(value); if (!text) return;
    const doc = element('div', 'tool-document message-body'); doc.append(markdownDom(text));
    // Raw inspection and copy belong to the containing tool, not to previews.
    for (const header of doc.querySelectorAll('.source-header')) header.remove();
    for (const pre of doc.querySelectorAll('pre')) { delete pre.dataset.wrap; preFrame(pre); }
    const rendered = doc.textContent ?? '';
    if (rendered.length > text.length || rendered.split(/\r\n|\r|\n/).length > DOC_LINES || countNodes(doc, DOM_NODES) > this.room()) {
      this.append(parent, framedPre('tool-document message-body', text).pre);
    } else this.append(parent, doc);
  }
  private suppliedPre(parent: HTMLElement, value: string, className: string, hint?: string): void {
    const text = this.take(value); if (!text) return;
    const {pre, frame} = framedPre(className); frame.append(highlight(text, hint));
    if (countNodes(pre, DOM_NODES) > this.room()) frame.textContent = text;
    this.append(parent, pre);
  }
  private source(parent: HTMLElement, key: string, value: string, hint?: string): void {
    const details = element('details', 'tool-source'); details.open = true;
    const summary = element('summary'); appendKey(summary, this.take(key, 240, 1)); details.append(summary);
    if (this.append(parent, details)) this.suppliedPre(details, value, 'tool-command', hint);
  }
  private pair(parent: HTMLElement, key: string, value: unknown): void {
    if (!this.budget.text) { this.limit(); return; }
    const dl = element('dl', 'kv');
    const term = element('dt'); appendKey(term, this.take(key, 240, 1));
    const text = this.take(scalar(value), 240, 3), description = element('dd');
    const link = typeof value === 'string' && text === value && (key === 'path' || key === 'file_path') ? this.argumentFilePath?.(value) : undefined;
    if (link) description.append(link); else description.textContent = text;
    dl.append(term, description);
    this.append(parent, dl);
  }
  private tableShape(values: unknown[]): Entry[][] | undefined {
    if (!values.length) return undefined;
    const rows: Entry[][] = [];
    for (let i = 0; i < Math.min(values.length, ROWS); i++) {
      const value = own(values, String(i)); if (!record(value)) return undefined;
      const scanned = this.scan(value); const row = scanned.entries;
      if (!scanned.complete || !row.length || row.length > COLS) return undefined;
      if (row.some(([key, child]) => metadataKey(key) || key.length > 32 || multiline(key) || !shortScalar(child))) return undefined;
      if (rows[0] && row.some(([key], index) => key !== rows[0]?.[index]?.[0])) return undefined;
      if (rows[0] && row.length !== rows[0].length) return undefined;
      rows.push(row);
    }
    return rows;
  }
  private table(parent: HTMLElement, key: string, rows: Entry[][], depth: number): void {
    if (depth + 2 > DEPTH) { this.limit(); return; }
    this.caption(parent, key);
    const table = element('table', 'tool-rows'); if (!this.append(parent, table)) return;
    const head = element('thead'); const tr = element('tr');
    for (const [column] of rows[0] ?? []) { const th = element('th', undefined, this.take(column, 32, 1)); th.scope = 'col'; tr.append(th); }
    head.append(tr); if (!this.append(table, head)) return;
    const body = element('tbody'); if (!this.append(table, body)) return;
    for (const row of rows) {
      if (this.budget.visits + 1 + row.length > NODES || !this.budget.text) { this.limit(); break; }
      this.budget.visits += 1 + row.length; this.spentVisits += 1 + row.length;
      const tr = element('tr');
      for (const [, child] of row) tr.append(element('td', undefined, this.take(scalar(child), 80, 1)));
      if (!this.append(body, tr)) break;
    }
  }
  private diffRow(frame: HTMLElement, text: string, className?: string): void {
    const row = element('span', `diff-row${className ? ` ${className}` : ''}`);
    row.append(element('span', 'diff-marker', text.slice(0, 2)), element('span', 'diff-text', text.slice(2)));
    frame.append(row);
  }
  private editSide(frame: HTMLElement, lines: string[], sign: string, className: string, empty: boolean): void {
    if (!this.budget.text) { this.limit(); return; }
    if (empty) {
      const label = this.take(`${sign === '-' ? 'Old' : 'New'} text: empty`, DOC_CHARS);
      if (label) frame.append(document.createTextNode(label), document.createTextNode(this.take('\n', 1)));
      return;
    }
    if (!lines.length) return;
    const text = this.take(lines.map(line => `${sign} ${line}`).join('\n'), DOC_CHARS);
    if (text) {
      const shown = text.split('\n');
      for (const [index, line] of shown.entries()) this.diffRow(frame, `${line}${index < shown.length - 1 ? '\n' : this.take('\n', 1)}`, className);
    }
  }
  private contextLine(frame: HTMLElement, line: string | null): void {
    if (line === null) return;
    if (!this.budget.text) { this.limit(); return; }
    this.diffRow(frame, this.take(`  ${line}`, DOC_CHARS) + this.take('\n', 1));
  }
  private replacementFrame(old: string, next: string): HTMLPreElement {
    const comparison = suppliedDifference(old, next, Math.min(DOC_CHARS - DOC_LINES * 2, Math.max(0, Math.floor((this.budget.text - 240) / 2))), DOC_LINES);
    const {pre, frame} = framedPre();
    if (comparison.omittedBefore) frame.append(document.createTextNode(this.take('Earlier context omitted.\n', 32, 2)));
    this.contextLine(frame, comparison.contextBefore);
    this.editSide(frame, comparison.removed, '-', 'diff-del', old === '');
    this.editSide(frame, comparison.added, '+', 'diff-add', next === '');
    this.contextLine(frame, comparison.contextAfter);
    const notice = differenceNotice(comparison); if (notice) frame.append(document.createTextNode(this.take(notice, 160, 1)));
    if (comparison.omittedBefore || comparison.omittedAfter || comparison.scanLimited) this.limit('text');
    if (countNodes(pre) > this.room()) frame.textContent = pre.textContent;
    return pre;
  }
  private edits(parent: HTMLElement, values: unknown[]): void {
    this.caption(parent, 'Supplied replacement');
    let inspected = 0;
    while (inspected < Math.min(values.length, 8) && this.budget.text > 240) {
      if (this.budget.visits + 3 > NODES) { this.limit(); break; }
      this.budget.visits += 3; this.spentVisits += 3;
      const edit = own(values, String(inspected++)); if (!record(edit)) { this.limit(); continue; }
      const old = own(edit, 'oldText'); const next = own(edit, 'newText');
      if (typeof old !== 'string' || typeof next !== 'string') { this.limit(); continue; }
      if (!this.append(parent, this.replacementFrame(old, next))) break;
    }
    if (inspected < values.length) {
      const remaining = values.length - inspected;
      this.caption(parent, `${remaining} more ${remaining === 1 ? 'replacement' : 'replacements'} in Arguments.`); this.limit();
    }
  }
  private path(parent: string, key: string): string {
    if (key.length + parent.length + (parent ? 1 : 0) > 240 || multiline(key)) this.limit();
    return pathFor(parent, key);
  }
  private transparent(fields: Field[]): boolean {
    if (this.argumentsMode) return false;
    const documents = fields.filter(field => this.documentValue(field.value));
    if (documents.length !== 1 || this.documentCount(documents[0]?.value) !== 1) return false;
    return fields.every(field => field === documents[0] || field.rank >= 3 || explicitKey(field.key) || this.shapedMetadata(field.value));
  }
  private defer(entry: Metadata): void {
    if (this.metadata.length < FIELDS) this.metadata.push(entry);
    else this.limit();
  }
  private object(parent: HTMLElement, value: Record<string, unknown>, depth: number, path: string, hint: string | undefined, collectMetadata: boolean, fullLabels = false, supplied?: Field[]): void {
    const fields = supplied ?? this.fields(value, path, depth, collectMetadata);
    const transparent = collectMetadata && this.transparent(fields);
    for (const field of fields) {
      if (this.skipField(field, collectMetadata, fullLabels)) continue;
      this.objectField(parent, field, hint, collectMetadata, fullLabels, transparent);
    }
  }
  private skipField(field: Field, collectMetadata: boolean, fullLabels: boolean): boolean {
    if (!collectMetadata) return this.covered(field.path);
    return fullLabels && !field.promoted && this.promotedPaths.has(field.path);
  }
  private metadataField(field: Field, transparent: boolean): boolean {
    if (field.promoted) return false;
    if (transparent && shortScalar(field.value) && !explicitKey(field.key)) return true;
    return field.rank === 4 || metadataKey(field.key) || (explicitKey(field.key) && !this.meaningfulFlag(field.value));
  }
  private objectField(parent: HTMLElement, field: Field, hint: string | undefined, collectMetadata: boolean, fullLabels: boolean, transparent: boolean): void {
    if (collectMetadata && this.metadataField(field, transparent)) {
      this.defer({path: field.path, value: field.value, depth: field.depth, hint}); return;
    }
    const labels = fullLabels || field.promoted || !collectMetadata;
    let label = labels ? field.path : field.key;
    if (transparent && this.documentString(field.value) && !explicitKey(field.key)) {
      this.defer({path: field.path, value: undefined, depth: field.depth, pathOnly: true}); label = '';
    }
    if (collectMetadata && explicitKey(field.key) && container(field.value)) {
      this.fact(parent, label, field.value, field.depth, field.path, hint); return;
    }
    this.field(parent, label, field.value, field.depth, field.path, hint, collectMetadata, labels);
  }
  private fact(parent: HTMLElement, label: string, value: Record<string, unknown> | unknown[], depth: number, path: string, hint?: string): void {
    const details = element('details', 'tool-fact'); const summary = element('summary');
    const facts = this.scan(value).entries.filter(([, child]) => !container(child) && this.meaningfulFlag(child)).slice(0, 3);
    const text = `${label}${facts.length ? ` · ${facts.map(([key, child]) => `${key} ${scalar(child)}`).join(', ')}` : ' · Details'}`;
    appendKey(summary, this.take(text, 160, 1)); details.append(summary);
    if (!this.append(parent, details)) return;
    let built = false;
    details.addEventListener('toggle', () => {
      if (!details.open || built) return; built = true;
      for (const [key, child] of this.scan(value).entries) {
        this.field(details, `${label}.${key}`, child, depth + 1, this.path(path, key), hint, true);
      }
    });
  }
  private field(parent: HTMLElement, label: string, value: unknown, depth: number, path: string, hint?: string, collectMetadata = true, fullLabels = false): void {
    if (!collectMetadata && this.covered(path)) return;
    if (this.budget.visits >= NODES || depth > DEPTH || !this.budget.text || this.room() < 2) { this.limit(); return; }
    this.budget.visits++; this.spentVisits++;
    this.content(parent, label, value, depth, path, hint, collectMetadata, fullLabels);
  }
  private content(parent: HTMLElement, label: string, value: unknown, depth: number, path: string, hint: string | undefined, collectMetadata: boolean, fullLabels: boolean): void {
    if (this.argumentsMode && sourceKey.test(label) && typeof value === 'string') this.source(parent, label, value, this.shellCommand && path === 'command' ? 'bash' : hint);
    else if (this.argumentsMode && label === 'edits' && Array.isArray(value)) this.edits(parent, value);
    else if (this.documentString(value)) this.textField(parent, label, value, hint);
    else if (container(value)) this.nested(parent, label, value, depth, path, hint, collectMetadata, fullLabels);
    else { if (!shortScalar(value) && typeof value !== 'string') this.limit(); this.pair(parent, label, value); }
  }
  private scaffold(entries: Entry[]): boolean {
    return entries.length === 1 && container(entries[0]?.[1]) && !metadataKey(entries[0]?.[0] ?? '') && !explicitKey(entries[0]?.[0] ?? '');
  }
  private nested(parent: HTMLElement, label: string, value: Record<string, unknown> | unknown[], depth: number, path: string, hint: string | undefined, collectMetadata: boolean, fullLabels: boolean): void {
    if (this.ancestors.has(value)) { this.limit(); return; }
    this.ancestors.add(value);
    try {
      if (record(value)) {
        const entries = this.scan(value).entries;
        const fields = this.fields(value, path, depth, collectMetadata);
        const scaffold = this.scaffold(entries);
        const transparent = collectMetadata && this.transparent(fields) && !this.sectionPaths.has(path);
        if ((scaffold || transparent) && !this.sectionPaths.has(path)) this.object(parent, value, depth, path, hint, collectMetadata, true, fields);
        else {
          const section = element('section', 'tool-record'); if (!this.append(parent, section)) return;
          this.caption(section, label); this.object(section, value, depth, path, hint, collectMetadata, fullLabels, fields);
        }
      } else this.array(parent, label, value, depth, path, hint, collectMetadata, fullLabels);
    } finally { this.ancestors.delete(value); }
  }
  private textField(parent: HTMLElement, label: string, value: string, hint: string | undefined): void {
    if (!this.argumentsMode) this.document(parent, label, value);
    else { this.caption(parent, label); this.suppliedPre(parent, value, 'tool-document message-body', hint); }
  }
  private array(parent: HTMLElement, label: string, value: unknown[], depth: number, path: string, hint: string | undefined, collectMetadata: boolean, fullLabels: boolean): void {
    if (value.length > ROWS) this.limit('rows');
    const promoted = fullLabels && [...this.promotedPaths].some(child => child.startsWith(`${path}.`));
    const rows = promoted ? undefined : this.tableShape(value);
    if (rows) this.table(parent, label, rows, depth);
    else for (let i = 0; i < Math.min(value.length, ROWS); i++) {
      const itemPath = pathFor(path, String(i + 1));
      if (!this.argumentsMode && this.documentCount(value) > 1) this.sectionPaths.add(itemPath);
      this.field(parent, `${label}.${i + 1}`, own(value, String(i)), depth + 1, itemPath, hint, collectMetadata, fullLabels);
    }
  }
  private argumentObject(value: Record<string, unknown>, presentation?: ArgumentPresentation): void {
    this.shellCommand = presentation?.shellCommand === true;
    this.argumentFilePath = presentation?.filePath;
    if (presentation?.caption) this.caption(this.root, presentation.caption);
    let fields: Field[] | undefined;
    if (presentation?.replacement && typeof own(value, 'oldText') === 'string' && typeof own(value, 'newText') === 'string') {
      this.edits(this.root, [value]); fields = this.fields(value, '', 0, true).filter(field => field.key !== 'oldText' && field.key !== 'newText');
    }
    this.object(this.root, value, 0, '', language(value), true, false, fields);
  }
  render(value: unknown, presentation?: ArgumentPresentation): HTMLElement | undefined {
    if (!this.admitted) return undefined;
    if (record(value)) {
      this.ancestors.add(value);
      if (this.argumentsMode) this.argumentObject(value, presentation);
      else this.object(this.root, value, 0, '', undefined, true);
      this.ancestors.delete(value);
    } else this.field(this.root, 'Result', value, 0, 'Result');
    this.revealMetadata();
    this.budget.finish(this.root); this.budget.releaseEmpty(this.root);
    return this.root.childNodes.length ? this.root : undefined;
  }
  /** Each awaited answer under the name of its responder; its other fields stay out of the body. */
  renderAwaited(display: JsonDisplay, resolve?: AnswerNamer): HTMLElement | undefined {
    const awaited = awaitedAnswers(display); if (!this.admitted || !awaited) return undefined;
    if (awaited.results.length > ROWS) this.limit('rows');
    for (const result of awaited.results.slice(0, ROWS)) {
      if (!this.budget.text) { this.limit(); break; }
      const block = element('section', 'tool-awaited-answer'); if (!this.append(this.root, block)) break;
      const name = element('p', 'tool-awaited-name'); name.textContent = this.take(responderName(result, resolve), 240, 1); block.append(name);
      const note = missingAnswerNote(result);
      if (note) block.append(element('p', 'secondary tool-caption', note)); else this.document(block, '', result.answer);
    }
    this.budget.finish(this.root); this.budget.releaseEmpty(this.root);
    return this.root.childNodes.length ? this.root : undefined;
  }
  private revealMetadata(): void {
    if (!this.metadata.length) return;
    if (this.budget.text < 'Details'.length) { this.limit(); return; }
    const details = element('details', 'tool-metadata'); details.append(element('summary', undefined, this.take('Details', 8, 1)));
    if (!this.append(this.root, details)) return;
    details.addEventListener('toggle', () => {
      if (!details.open || this.metadataBuilt) return;
      this.metadataBuilt = true;
      for (const entry of this.metadata) {
        if (entry.pathOnly) this.caption(details, entry.path);
        else this.field(details, entry.path, entry.value, entry.depth, entry.path, entry.hint, false, true);
      }
    });
  }
}

/** Projected values are already sanitized and decoded. Raw output belongs to its renderer. */
export function presentResult(display: JsonDisplay | undefined, context: PresentationContext, budget?: PreviewBudget): HTMLElement | undefined {
  if (!record(display)) return undefined;
  const value = own(display, 'value');
  if (value === undefined) return undefined;
  return new Preview(context, false, own(display, 'truncated') === true, budget ?? new PreviewBudget()).render(value);
}

/** An awaited-answers value shows each answer under its responder's name. */
export function presentAwaited(display: JsonDisplay, context: PresentationContext, budget: PreviewBudget, resolve?: AnswerNamer): HTMLElement | undefined {
  return new Preview(context, false, own(display, 'truncated') === true, budget).renderAwaited(display, resolve);
}

/** Supplied argument previews have their own collapse controls, without extra raw inspection. */
export function presentArguments(args: JsonDisplay | undefined, context: PresentationContext, budget?: PreviewBudget, presentation?: ArgumentPresentation): HTMLElement | undefined {
  if (!record(args)) return undefined;
  const value = own(args, 'value'); if (!record(value)) return undefined;
  return new Preview(context, true, own(args, 'truncated') === true, budget ?? new PreviewBudget()).render(value, presentation);
}
