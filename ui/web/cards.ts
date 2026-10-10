import { element } from './dom.ts';
import type { PresentationContext, ToolPresentationSource } from './transcript-presentation.ts';
import { previewText } from './format.ts';
import { highlight, languageFromPath } from './highlight.ts';

const PREVIEW_CHARS = 8192;
const TOTAL_CHARS = 16384;
const PREVIEW_LINES = 80;
const EDITS = 8;
type Replacement = {oldText: string; newText: string};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function replacements(args: Record<string, unknown>): Replacement[] | undefined {
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  if (!edits.length) return undefined;
  const result: Replacement[] = [];
  for (const value of edits) {
    const edit = record(value);
    if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') return undefined;
    result.push({oldText: edit.oldText, newText: edit.newText});
  }
  return result;
}
function preview(text: string, maxChars: number, maxLines = PREVIEW_LINES): {text: string; limited: boolean} {
  let end = Math.min(text.length, Math.max(0, Math.floor(maxChars))); let lines = 1;
  for (let index = 0; index < end; index++) {
    if (text[index] === '\n' && ++lines > maxLines) { end = index; break; }
  }
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return {text: text.slice(0, end), limited: end < text.length};
}
function replacementPreview(edit: Replacement, budget: number): {text: string; limited: boolean} {
  const before = preview(edit.oldText, Math.min(PREVIEW_CHARS, Math.floor(budget / 2)));
  const after = preview(edit.newText, Math.min(PREVIEW_CHARS, Math.floor(budget / 2)));
  const prefix = (text: string, sign: string) => text.split('\n').map(line => `${sign} ${line}`).join('\n');
  return {text: [edit.oldText === '' ? 'Old text: empty' : prefix(before.text, '-'), edit.newText === '' ? 'New text: empty' : prefix(after.text, '+')].join('\n'), limited: before.limited || after.limited};
}
function writePreview(source: ToolPresentationSource, text: string, className?: string): HTMLElement {
  const args = record(source.args?.value); const pre = element('pre', className);
  pre.append(highlight(text, languageFromPath(args.file_path ?? args.path))); return pre;
}
function writeInspection(source: ToolPresentationSource, content: string, context: PresentationContext): HTMLDetailsElement {
  const node = context.inspection('Retained supplied content (bounded)', () => content);
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
  node.append(element('p', 'secondary tool-caption', source.status === 'success' ? 'written content' : 'content to write'),
    content === '' ? element('pre', undefined, '(empty content)') : writePreview(source, context.bounded(text.text, TOTAL_CHARS)));
  if (text.limited) {
    node.append(element('p', 'secondary', 'Content preview limited.'), writeInspection(source, content, context));
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
function edited(edits: Replacement[], context: PresentationContext): HTMLElement {
  const node = element('section', 'tool-content');
  node.append(element('p', 'secondary tool-caption', 'supplied old and new text, not an inferred diff'));
  let budget = TOTAL_CHARS;
  for (const [index, edit] of edits.slice(0, EDITS).entries()) {
    const text = replacementPreview(edit, Math.max(0, budget / 2));
    const shown = preview(text.text, Math.max(0, budget - 1), Number.MAX_SAFE_INTEGER);
    if (shown.text) budget -= shown.text.length + 1;
    node.append(replacementBlock(context.bounded(shown.text, TOTAL_CHARS)));
    if (text.limited || shown.limited) node.append(element('p', 'secondary', 'Replacement preview limited.'),
      context.inspection(`Replacement ${index + 1}: retained old text (bounded)`, () => edit.oldText),
      context.inspection(`Replacement ${index + 1}: retained new text (bounded)`, () => edit.newText));
  }
  if (edits.length > EDITS) node.append(element('p', 'secondary', `${edits.length - EDITS} more replacements in Arguments.`));
  return node;
}
function pathComponents(path: string): string[] {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.length && parts.at(-1) !== '..') parts.pop();
    else if (!path.startsWith('/')) parts.push(part);
  }
  return parts;
}
const RESOURCE_FILES = new Set(['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']);

/** Pi docs classification needs the host package root; skill and resource names do not. */
export function compactRead(args: Record<string, unknown>): {name: string; target: string} | undefined {
  const path = args.file_path ?? args.path;
  if (typeof path !== 'string' || !path) return undefined;
  const parts = pathComponents(path); const file = parts.at(-1);
  const parent = parts.at(-2);
  if (file === 'SKILL.md') return {name: '[skill]', target: parent && parent !== '..' ? parent : file};
  if (file && RESOURCE_FILES.has(file)) return {name: 'read resource', target: path};
  return undefined;
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

/** Compact supplied text keeps write and edit calls useful before expansion. */
export function presentToolPreview(source: ToolPresentationSource): HTMLElement | undefined {
  if (source.status === 'error') return undefined;
  const args = record(source.args?.value);
  if (source.name === 'write' && typeof args.content === 'string') {
    const text = previewText(args.content, 2, 1800);
    return args.content === '' ? element('pre', 'tool-content-preview', '(empty content)') : writePreview(source, `${text.text}${text.truncated ? '\n…' : ''}`, 'tool-content-preview');
  }
  if (source.name !== 'edit') return undefined;
  const edit = replacements(args)?.[0]; if (!edit) return undefined;
  const before = previewText(edit.oldText, 2, 700); const after = previewText(edit.newText, 2, 700);
  const block = replacementBlock([
    edit.oldText === '' ? 'Old text: empty' : before.text.split('\n').map(line => `- ${line}`).join('\n'),
    edit.newText === '' ? 'New text: empty' : after.text.split('\n').map(line => `+ ${line}`).join('\n'),
    ...(before.truncated || after.truncated || (Array.isArray(args.edits) && args.edits.length > 1) ? ['…'] : []),
  ].join('\n'));
  block.className = 'tool-content-preview'; return block;
}

/** Expanded content comes from supplied arguments, never a guessed file diff. */
export function presentTool(source: ToolPresentationSource, context: PresentationContext): HTMLElement | undefined {
  const args = record(source.args?.value);
  let node: HTMLElement | undefined;
  if (source.name === 'bash' && typeof args.command === 'string') {
    node = element('section', 'tool-content');
    node.append(element('pre', 'tool-command', context.bounded(`$ ${args.command}`)));
  }
  if (source.name === 'write' && typeof args.content === 'string') node = written(source, args.content, context);
  if (source.name === 'edit') {
    const edits = replacements(args); if (edits) node = edited(edits, context);
  }
  if (node && source.args?.truncated) node.append(element('p', 'warning', 'Arguments omitted by host. This is retained supplied text, not a complete file diff.'));
  return node;
}
