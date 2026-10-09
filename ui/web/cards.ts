import { element } from './dom.ts';
import type { PresentationContext, ToolPresentationSource } from './transcript-presentation.ts';

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
function written(source: ToolPresentationSource, content: string, context: PresentationContext): HTMLElement {
  const node = element('section', 'tool-content');
  const text = preview(content, PREVIEW_CHARS);
  node.append(element('p', 'secondary tool-caption', source.status === 'success' ? 'Written content' : 'Content to write'),
    element('pre', undefined, content === '' ? '(empty content)' : context.bounded(text.text, TOTAL_CHARS)));
  if (text.limited) {
    node.append(element('p', 'secondary', 'Content preview limited.'), context.inspection('Retained supplied content (bounded)', () => content));
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
  node.append(element('p', 'secondary tool-caption', 'Supplied old and new text, not an inferred diff'));
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
/** Called only when the tool disclosure opens; content never comes from a guessed file diff. */
export function presentTool(source: ToolPresentationSource, context: PresentationContext): HTMLElement | undefined {
  const args = record(source.args?.value);
  let node: HTMLElement | undefined;
  if (source.name === 'write' && typeof args.content === 'string') node = written(source, args.content, context);
  if (source.name === 'edit') {
    const edits = replacements(args); if (edits) node = edited(edits, context);
  }
  if (node && source.args?.truncated) node.append(element('p', 'warning', 'Arguments omitted by host. This is retained supplied text, not a complete file diff.'));
  return node;
}
