import { parseMarkdown } from './markdown.ts';
import type { MarkdownBlock, MarkdownInline } from './markdown.ts';
import { copy, element } from './dom.ts';
import { cardAction, cardActionLabel } from './card-icons.ts';
import { highlight, knownSyntax } from './highlight.ts';

function hashBoundary(character: string, after = false): boolean {
  return !character || /\s/.test(character) || "()[]{}<>,;.!?\"'`".includes(character) || after && character === ':';
}
/** The complete token remains the selectable text; CSS limits only its painted width. */
function proseText(text: string, before = '', after = ''): DocumentFragment {
  const fragment = document.createDocumentFragment(); let cursor = 0;
  for (const match of text.matchAll(/[a-f0-9]{40,}/gi)) {
    const value = match[0], start = match.index, end = start + value.length;
    if (value.length !== 40 && value.length !== 64) continue;
    if (!hashBoundary(text[start - 1] ?? before) || !hashBoundary(text[end] ?? after,true)) continue;
    if (start > cursor) fragment.append(document.createTextNode(text.slice(cursor,start)));
    const token = element('span','prose-hash',value); token.title = value; fragment.append(token); cursor = end;
  }
  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}
function inlineBoundaryText(node: MarkdownInline): string {
  if (node.type === 'text') return node.text;
  if (node.type === 'strong' || node.type === 'emphasis') return node.children.map(inlineBoundaryText).join('');
  return ' ';
}
function inlineNode(node: MarkdownInline, before = '', after = ''): Node {
  if (node.type === 'text') return proseText(node.text,before,after);
  if (node.type === 'code') return element('code', 'markdown-inline-code', node.text);
  if (node.type === 'omitted') return element('span', 'secondary', node.label);
  if (node.type === 'link') {
    const link = element('a'); link.href = node.href; link.rel = 'noopener noreferrer'; link.target = '_blank'; link.append(inline(node.children)); return link;
  }
  const emphasis = element(node.type === 'strong' ? 'strong' : 'em'); emphasis.append(inline(node.children,before,after)); return emphasis;
}
function inline(nodes: MarkdownInline[], before = '', after = ''): DocumentFragment {
  const fragment = document.createDocumentFragment(), boundaries = nodes.map(inlineBoundaryText); let previous = before;
  nodes.forEach((node,index) => {
    const next = boundaries.slice(index + 1).find(Boolean)?.[0] ?? after;
    fragment.append(inlineNode(node,previous,next)); previous = boundaries[index]?.at(-1) ?? previous;
  });
  return fragment;
}
function listBlock(node: Extract<MarkdownBlock, {type: 'list'}>): HTMLElement {
  const list = node.ordered ? element('ol') : element('ul');
  if (node.ordered) list.setAttribute('start', String(node.start));
  for (const item of node.items) { const li = element('li'); li.append(...item.map(block)); list.append(li); }
  return list;
}
/** Wrap changes only the scrollport's whitespace mode, not its text nodes. */
export function sourceWrap(pre: HTMLElement, subject = 'source lines'): HTMLButtonElement {
  pre.dataset.wrap = 'true';
  const label = subject === 'source lines' ? 'Wrap' : `Wrap ${subject}`;
  const wrap = cardAction('wrap', label, () => {
    pre.dispatchEvent(new Event('source-wrap', {bubbles: true}));
    const wrapped = pre.dataset.wrap !== 'true';
    pre.dataset.wrap = String(wrapped); wrap.setAttribute('aria-pressed', String(wrapped));
    wrap.title = `${wrapped ? 'Do not wrap' : 'Wrap'} ${subject}`;
  }, 'source-wrap');
  wrap.setAttribute('aria-pressed', 'true'); cardActionLabel(wrap, label, `Wrap ${subject}`); wrap.title = `Do not wrap ${subject}`;
  return wrap;
}
/** Controls stay outside the source's scrollport and never replace its text nodes. */
export function sourceHeader(pre: HTMLElement, language: string | HTMLElement = '', source?: () => string): HTMLElement {
  const header = element('div', 'source-header');
  const label = typeof language === 'string' ? element('span', 'source-language', language) : language;
  if (typeof language !== 'string') label.classList.add('source-language');
  header.append(label);
  if (source) header.append(cardAction('copy', 'Copy code', () => { void copy(source(), header); }, 'copy'));
  header.append(sourceWrap(pre)); return header;
}
function codeBlock(node: Extract<MarkdownBlock, {type: 'code'}>): HTMLElement {
  const wrap = element('div', 'code-block'); const pre = element('pre'); const code = element('code');
  code.append(highlight(node.text, node.language));
  if (node.language) code.dataset.language = node.language;
  if (knownSyntax(node.language)) code.dataset.syntax = 'known';
  pre.append(code); wrap.append(sourceHeader(pre, node.language, () => node.text), pre); return wrap;
}
function tableBlock(node: Extract<MarkdownBlock, {type: 'table'}>): HTMLElement {
  const table = element('table'); const head = element('thead'); const row = element('tr');
  node.header.forEach((cell, index) => {
    const th = element('th'); th.scope = 'col'; th.style.textAlign = node.align[index] ?? ''; th.append(inline(cell)); row.append(th);
  });
  head.append(row); table.append(head); const body = element('tbody');
  for (const cells of node.rows) {
    const tr = element('tr'); cells.forEach((cell, index) => {
      const td = element('td'); td.style.textAlign = node.align[index] ?? ''; td.append(inline(cell)); tr.append(td);
    }); body.append(tr);
  }
  table.append(body); return table;
}
function block(node: MarkdownBlock): HTMLElement {
  const result = markdownBlock(node); result.className = [result.className, 'markdown-content'].filter(Boolean).join(' '); return result;
}
function markdownBlock(node: MarkdownBlock): HTMLElement {
  switch (node.type) {
    case 'paragraph': { const p = element('p'); p.append(inline(node.children)); return p; }
    case 'heading': { const h = element(`h${Math.min(6, Math.max(1, node.level))}` as 'h1'); h.append(inline(node.children)); return h; }
    case 'rule': return element('hr');
    case 'quote': { const quote = element('blockquote'); quote.append(...node.children.map(block)); return quote; }
    case 'list': return listBlock(node);
    case 'code': return codeBlock(node);
    case 'table': return tableBlock(node);
  }
}
const PREVIEW_BLOCKS = 12;
const PREVIEW_NODES = 160;
type PreviewBudget = {nodes: number; blocks: number; limited: boolean};
function previewInlineNode(node: MarkdownInline, budget: PreviewBudget, parent: HTMLElement, before: string, after: string): void {
  if (node.type === 'text') parent.append(proseText(node.text,before,after));
  else if (node.type === 'code') parent.append(element('code', 'prose-preview-code', node.text));
  else if (node.type === 'omitted') parent.append(document.createTextNode(node.label));
  else if (node.type === 'link') previewInline(node.children,budget,parent);
  else { const emphasis = element(node.type === 'strong' ? 'strong' : 'em'); previewInline(node.children,budget,emphasis,before,after); parent.append(emphasis); }
}
function previewInline(nodes: MarkdownInline[], budget: PreviewBudget, parent: HTMLElement, before = '', after = ''): void {
  const boundaries = nodes.map(inlineBoundaryText); let previous = before;
  for (const [index,node] of nodes.entries()) {
    if (budget.nodes <= 0) { budget.limited = true; return; }
    budget.nodes--; const next = boundaries.slice(index + 1).find(Boolean)?.[0] ?? after;
    previewInlineNode(node,budget,parent,previous,next);
    previous = boundaries[index]?.at(-1) ?? previous;
  }
}
function previewSpan(budget: PreviewBudget, out: HTMLElement[], className: string): HTMLElement | undefined {
  if (budget.blocks <= 0) { budget.limited = true; return undefined; }
  budget.blocks--; const span = element('span', className); out.push(span); return span;
}
function previewCells(cells: MarkdownInline[][], budget: PreviewBudget, out: HTMLElement[]): void {
  const span = previewSpan(budget, out, 'prose-preview-block'); if (!span) return;
  cells.forEach((cell, index) => { if (index) span.append(document.createTextNode(' · ')); previewInline(cell, budget, span); });
}
function previewTextBlock(node: Extract<MarkdownBlock, {type: 'paragraph' | 'heading' | 'code'}>, budget: PreviewBudget, out: HTMLElement[], lead: string): void {
  const span = previewSpan(budget, out, node.type === 'heading' ? 'prose-preview-block prose-preview-heading' : 'prose-preview-block'); if (!span) return;
  if (lead) span.append(document.createTextNode(lead));
  if (node.type === 'code') span.append(element('code', 'prose-preview-code', node.text)); else previewInline(node.children, budget, span);
}
function previewList(node: Extract<MarkdownBlock, {type: 'list'}>, budget: PreviewBudget, out: HTMLElement[]): void {
  for (const [index, item] of node.items.entries()) {
    const marker = node.ordered ? `${node.start + index}. ` : '\u2022 ';
    for (const [at, child] of item.entries()) previewBlock(child, budget, out, at ? '' : marker);
  }
}
function previewBlock(node: MarkdownBlock, budget: PreviewBudget, out: HTMLElement[], lead = ''): void {
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'code') previewTextBlock(node, budget, out, lead);
  else if (node.type === 'quote') for (const child of node.children) previewBlock(child, budget, out);
  else if (node.type === 'list') previewList(node, budget, out);
  else if (node.type === 'table') { previewCells(node.header, budget, out); for (const row of node.rows) previewCells(row, budget, out); }
}
/**
 * A bounded, noninteractive projection of the parser's output for collapsed summaries.
 * Links keep only their labels, images stay omission labels, and nothing is a control.
 */
export function markdownPreviewDom(text: string): DocumentFragment {
  const budget: PreviewBudget = {nodes: PREVIEW_NODES, blocks: PREVIEW_BLOCKS, limited: false}; const blocks: HTMLElement[] = [];
  const parsed = parseMarkdown(text);
  for (const node of parsed) previewBlock(node, budget, blocks);
  const fragment = document.createDocumentFragment();
  const title = parsed[0]?.type === 'heading' ? blocks.shift() : undefined;
  if (title) { title.className = `${title.className} prose-preview-title`; fragment.append(title); }
  const body = element('span', 'prose-preview-body');
  blocks.forEach((block, index) => { if (index) body.append(document.createTextNode(' ')); body.append(block); });
  if (budget.limited) body.append(document.createTextNode('…'));
  if (blocks.length || budget.limited) fragment.append(body);
  return fragment;
}
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
/** Removes a leading block delimited by `---` lines; text without a closing delimiter is returned unchanged. */
export function withoutFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '');
}
export function markdownDom(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment(); fragment.append(...parseMarkdown(text).map(block)); return fragment;
}
