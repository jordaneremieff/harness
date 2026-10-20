import { element } from './dom.ts';
import type { PartView } from '../shared/api.ts';
import { awaitedFromParts, awaitedLine } from './awaited-answers.ts';
import { decodedArray, decodedLines, structuredResultPreview, type NameResolver } from './generic-content.ts';
import type { PresentationContext, ToolPresentationSource } from './transcript-presentation.ts';
import { previewText } from './format.ts';
import { highlight, isMarkdownPath, languageFromPath } from './highlight.ts';
import { markdownPreviewDom, withoutFrontmatter } from './safe-markdown.ts';
import { suppliedDifference, differenceNotice, type SuppliedDifference } from './supplied-difference.ts';

const PREVIEW_CHARS = 8192;
const TOTAL_CHARS = 16384;
const PREVIEW_LINES = 80;
const EDITS = 8;
export function cardPreviewLimits(): string {
  return `Write and edit previews: at most ${PREVIEW_CHARS} characters and ${PREVIEW_LINES} lines per text, ${TOTAL_CHARS} characters of supplied text in total, and ${EDITS} replacements. Replacement sides share the remaining text budget. Comparisons inspect at most 65536 characters per side to locate the first difference.`;
}
type Replacement = {oldText: string; newText: string};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function replacements(args: Record<string, unknown>): {edits: Replacement[]; count: number} | undefined {
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  if (!edits.length) return undefined;
  const result: Replacement[] = [];
  for (const value of edits.slice(0, EDITS)) {
    const edit = record(value);
    if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') return undefined;
    result.push({oldText: edit.oldText, newText: edit.newText});
  }
  return {edits: result, count: edits.length};
}
function preview(text: string, maxChars: number, maxLines = PREVIEW_LINES): {text: string; limited: boolean} {
  let end = Math.min(text.length, Math.max(0, Math.floor(maxChars))); let lines = 1;
  for (let index = 0; index < end; index++) {
    if ((text[index] === '\n' || (text[index] === '\r' && text[index + 1] !== '\n')) && ++lines > maxLines) { end = index; break; }
  }
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return {text: text.slice(0, end), limited: end < text.length};
}
/** Marked preview lines: shared lines take a space, removed lines "-", added lines "+". */
function comparisonLines(edit: Replacement, comparison: SuppliedDifference): string[] {
  return [
    ...(comparison.omittedBefore ? ['Earlier context omitted.'] : []),
    ...(comparison.contextBefore === null ? [] : [`  ${comparison.contextBefore}`]),
    ...(edit.oldText === '' ? ['Old text: empty'] : comparison.removed.map(line => `- ${line}`)),
    ...(edit.newText === '' ? ['New text: empty'] : comparison.added.map(line => `+ ${line}`)),
    ...(comparison.contextAfter === null ? [] : [`  ${comparison.contextAfter}`]),
  ];
}
function replacementPreview(edit: Replacement, budget: number): {text: string; limited: boolean} {
  const comparison = suppliedDifference(edit.oldText, edit.newText, Math.max(0, Math.min(PREVIEW_CHARS, Math.floor((budget - 240) / 2) - PREVIEW_LINES * 2)), PREVIEW_LINES);
  const notice = differenceNotice(comparison);
  return {text: [...comparisonLines(edit, comparison), ...(notice ? [notice] : [])].join('\n'),
    limited: comparison.omittedBefore || comparison.omittedAfter || comparison.scanLimited};
}
function writePreview(source: ToolPresentationSource, text: string, className?: string): HTMLElement {
  const args = record(source.args?.value); const pre = element('pre', className);
  pre.append(highlight(text, languageFromPath(args.file_path ?? args.path))); return pre;
}
function writeInspection(source: ToolPresentationSource, content: string, context: PresentationContext): HTMLDetailsElement {
  const node = context.inspection('More supplied content', () => content);
  const args = record(source.args?.value); const language = languageFromPath(args.file_path ?? args.path);
  if (language) node.addEventListener('toggle', () => {
    const pre = node.querySelector('pre');
    if (node.open && pre) pre.replaceChildren(highlight(pre.textContent ?? '', language));
  });
  return node;
}
function written(source: ToolPresentationSource, content: string, context: PresentationContext): HTMLElement {
  const node = element('section', 'tool-content');
  const text = preview(content, PREVIEW_CHARS);
  node.append(element('p', 'secondary tool-caption', 'Supplied content'),
    content === '' ? element('pre', undefined, '(empty content)') : writePreview(source, context.bounded(text.text, TOTAL_CHARS)));
  if (text.limited) {
    node.append(element('p', 'secondary', 'Preview shortened.'), writeInspection(source, content, context));
  }
  return node;
}
function replacementBlock(text: string): HTMLElement {
  const block = element('pre');
  if (!text) return block;
  for (const line of text.split('\n')) {
    const className = line.startsWith('- ') ? 'diff-del' : line.startsWith('+ ') ? 'diff-add' : undefined;
    block.append(className ? element('span', className, line) : document.createTextNode(line), document.createTextNode('\n'));
  }
  return block;
}
function edited(edits: Replacement[], context: PresentationContext, count: number): HTMLElement {
  const node = element('section', 'tool-content');
  node.append(element('p', 'secondary tool-caption', 'Supplied replacement'));
  let budget = TOTAL_CHARS;
  for (const [index, edit] of edits.slice(0, EDITS).entries()) {
    const text = replacementPreview(edit, Math.max(0, budget / 2));
    const shown = preview(text.text, Math.max(0, budget - 1), Number.MAX_SAFE_INTEGER);
    if (shown.text) budget -= shown.text.length + 1;
    node.append(replacementBlock(context.bounded(shown.text, TOTAL_CHARS)));
    if (text.limited || shown.limited) node.append(element('p', 'secondary', 'Replacement preview shortened.'),
      context.inspection(`Replacement ${index + 1}: old text`, () => edit.oldText),
      context.inspection(`Replacement ${index + 1}: new text`, () => edit.newText));
  }
  if (count > EDITS) node.append(element('p', 'secondary', `${count - EDITS} more replacements in Arguments.`));
  return node;
}
export function readRange(args: Record<string, unknown>): string {
  if (args.offset == null && args.limit == null) return '';
  const offset = args.offset ?? 1;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 1) return '';
  if (args.limit == null) return `lines ${offset} onward`;
  if (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1) return '';
  const end = offset + (args.limit - 1);
  return Number.isSafeInteger(end) ? `lines ${offset}–${end}` : '';
}

function previewSource(part: {text: string; redacted?: boolean}, skipFrontmatter: boolean): string {
  return skipFrontmatter && !part.redacted ? withoutFrontmatter(part.text) : part.text;
}
/** Drops blank lines before the first and after the last visible line; indentation of the first visible line stays. */
function withoutOuterBlankLines(text: string): string {
  let start = 0; let lineStart = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\n' || char === '\r') lineStart = index + 1;
    else if (char !== ' ' && char !== '\t') { start = lineStart; break; }
    if (index === text.length - 1) return '';
  }
  let end = text.length;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--;
  return text.slice(start, end);
}
type ResultPreviewText = {text: string; summary: boolean; redacted: boolean; literal: boolean};
/**
 * A sentence of prose that ends in a labeled JSON literal ("Admitted to a task. Result: {...}") reads as the sentence alone.
 * Only a line of at least three words that starts with a capital letter or digit qualifies; every other line stays literal.
 */
export function withoutTrailingJson(line: string): string {
  const start = line.search(/[{[]/); if (start < 1 || line.length - start > 4096) return line;
  try { if (typeof JSON.parse(line.slice(start)) !== 'object') return line; } catch { return line; }
  const prose = line.slice(0, start).replace(/\s*\b[A-Z][A-Za-z ]{0,24}:\s*$/, '').trimEnd();
  return /^[A-Z0-9]/.test(prose) && prose.split(/\s+/).length >= 3 ? prose : line;
}
const LABELED_JSON = /^[A-Z][^:{}[\]]{0,22}:\s*([{[].*)$/;
/** A line that is only a short capitalized label and one JSON object or array ("Result: {...}"). */
function labeledJson(line: string): boolean {
  const body = LABELED_JSON.exec(line.trim())?.[1]; if (!body || body.length > 4096) return false;
  try { const value: unknown = JSON.parse(body); return typeof value === 'object' && value !== null; } catch { return false; }
}
/** Success previews drop a labeled JSON line once an earlier line of prose has said what happened; the full text stays in the expanded result. */
function tidied(source: string, tidy: boolean): string {
  if (!tidy) return source;
  let prose = false;
  return source.split(/\r\n|\r|\n/).map(withoutTrailingJson).filter(line => {
    const labeled = labeledJson(line); if (labeled && prose) return false;
    const text = line.trim(); if (text && !labeled && !/^[{[]/.test(text)) prose = true;
    return true;
  }).join('\n');
}
type PreviewOptions = {resolve?: NameResolver; tidy?: boolean; title?: string};
function resultPreviewText(parts: readonly PartView[], skipFrontmatter: boolean, options: PreviewOptions): ResultPreviewText | undefined {
  for (const part of parts) {
    if (part.type === 'toolResult') { const nested = resultPreviewText(part.parts, skipFrontmatter, options); if (nested) return nested; }
    if (part.type !== 'text') continue;
    const shown = textPreview(part, skipFrontmatter, options); if (shown) return shown;
  }
  return undefined;
}
function textPreview(part: Extract<PartView, {type: 'text'}>, skipFrontmatter: boolean, options: PreviewOptions): ResultPreviewText | undefined {
  // Prose mixed with JSON lines previews element by element, so an object says what it holds instead of showing its raw line.
  const lines = !part.redacted && !part.text.trimStart().startsWith('[') ? decodedLines(part.structured, options.resolve, options.title) : undefined;
  if (lines) {
    const joined = withoutOuterBlankLines(lines.map(line => line.kind === 'text' ? tidied(line.text, !!options.tidy) : line.text).join('\n'));
    if (!joined) return undefined;
    const shown = preview(joined, 1200, 6);
    return {text: shown.limited ? `${preview(shown.text, 1199, 6).text}…` : shown.text, summary: false, redacted: false, literal: false};
  }
  // An array summarizes text that is one JSON array; text of prose or JSON lines keeps its own lines.
  const summarizable = !decodedArray(part.structured) || part.text.trimStart().startsWith('[');
  const summary = !part.redacted && summarizable ? structuredResultPreview(part.structured, options.resolve, options.title) : undefined;
  const text = withoutOuterBlankLines(summary ?? tidied(previewSource(part, skipFrontmatter), !!options.tidy && !part.redacted));
  if (!text) return undefined;
  const shown = preview(text, 1200, 6);
  return {text: shown.limited ? `${preview(shown.text, 1199, 6).text}…` : shown.text, summary: summary !== undefined, redacted: !!part.redacted, literal: summary === undefined};
}

/** A collapsed result describes supplied structured data or keeps a literal text prefix. */
export function resultPreview(parts: readonly PartView[], options: PreviewOptions = {}): string {
  return resultPreviewText(parts, false, options)?.text ?? '';
}

/** A wait call whose result has the awaited-answers shape previews as its first responder and answer; null for every other result. */
function awaitedPreview(source: ToolPresentationSource, resolve?: NameResolver): HTMLElement | undefined | null {
  const awaited = source.name === 'agent_await' ? awaitedFromParts(source.result ?? []) : undefined; if (!awaited) return null;
  const line = awaitedLine(awaited, resolve); return line ? element('span', 'tool-prose-preview', line) : undefined;
}
function readPreviewPath(source: ToolPresentationSource, shown: ResultPreviewText): unknown {
  if (shown.summary || shown.redacted || source.name !== 'read' || source.status !== 'success') return undefined;
  const args = record(source.args?.value); return args.file_path ?? args.path;
}
/**
 * Prose previews come only from explicit content facts: a structured summary, or a successful
 * read of a path with a Markdown extension. Known source reads retain their literal monospace prefix with syntax colors.
 */
export function presentResultPreview(source: ToolPresentationSource, resolve?: NameResolver, title = ''): HTMLElement | undefined {
  if (source.status === 'error') return undefined;
  const awaited = awaitedPreview(source, resolve); if (awaited !== null) return awaited;
  const shown = resultPreviewText(source.result ?? [], false, {resolve, title}); if (!shown) return undefined;
  const path = readPreviewPath(source, shown);
  const markdown = isMarkdownPath(path);
  const language = shown.literal && !markdown ? languageFromPath(path) : undefined;
  if (language) {
    const node = element('pre', 'tool-content-preview');
    node.append(highlight(resultPreview(source.result ?? [], {resolve, title, tidy: true}), language)); return node;
  }
  if (!shown.summary && !markdown) return undefined;
  const node = element('span', 'tool-prose-preview');
  if (markdown) node.append(markdownPreviewDom(resultPreviewText(source.result ?? [], true, {})?.text ?? '')); else node.textContent = shown.text;
  return node.textContent ? node : undefined;
}

function collapsedReplacement(source: ToolPresentationSource, args: Record<string, unknown>): HTMLElement | undefined {
  const supplied = replacements(args); const edit = supplied?.edits[0]; if (!edit || !supplied) return undefined;
  const comparison = suppliedDifference(edit.oldText, edit.newText, 500, 2);
  const remaining = supplied.count - 1;
  const notice = [differenceNotice(comparison), remaining ? `${remaining} more ${remaining === 1 ? 'replacement' : 'replacements'} in Arguments.` : '',
    source.args?.truncated ? 'Some arguments are unavailable.' : ''].filter(Boolean).join(' ');
  const block = replacementBlock([...comparisonLines(edit, comparison), ...(notice ? [notice] : [])].join('\n'));
  block.className = 'tool-content-preview'; return block;
}

/** Compact supplied text keeps write and edit calls useful before expansion. */
export function presentToolPreview(source: ToolPresentationSource): HTMLElement | undefined {
  if (source.status === 'error') return undefined;
  const args = record(source.args?.value);
  if (source.name === 'write' && typeof args.content === 'string') {
    const text = previewText(args.content, 6, 1199);
    return args.content === '' ? element('pre', 'tool-content-preview', '(empty content)') : writePreview(source, `${text.text}${text.truncated ? '…' : ''}`, 'tool-content-preview');
  }
  return source.name === 'edit' ? collapsedReplacement(source, args) : undefined;
}

/** Expanded content comes from supplied arguments, never a guessed file diff. */
export function presentTool(source: ToolPresentationSource, context: PresentationContext): HTMLElement | undefined {
  const args = record(source.args?.value);
  let node: HTMLElement | undefined;
  if (source.name === 'bash' && typeof args.command === 'string') {
    node = element('section', 'tool-content');
    const command = element('pre', 'tool-command');
    command.append(highlight(context.bounded(`$ ${args.command}`), 'bash')); node.append(command);
  }
  if (source.name === 'write' && typeof args.content === 'string') node = written(source, args.content, context);
  if (source.name === 'edit') {
    const supplied = replacements(args); if (supplied) node = edited(supplied.edits, context, supplied.count);
  }
  if (node && source.args?.truncated) node.append(element('p', 'warning', 'Some arguments are not available. This preview is not a complete file diff.'));
  return node;
}
