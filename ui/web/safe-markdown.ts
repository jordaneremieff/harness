import { parseMarkdown } from './markdown.ts';
import type { MarkdownBlock, MarkdownInline } from './markdown.ts';
import { copy, element } from './dom.ts';
import { cardAction, cardActionLabel } from './card-icons.ts';
import { highlight } from './highlight.ts';

function inlineNode(node: MarkdownInline): Node {
  if (node.type === 'text') return document.createTextNode(node.text);
  if (node.type === 'code') return element('code', 'markdown-inline-code', node.text);
  if (node.type === 'omitted') return element('span', 'secondary', node.label);
  if (node.type === 'link') {
    const link = element('a'); link.href = node.href; link.rel = 'noopener noreferrer'; link.target = '_blank'; link.append(inline(node.children)); return link;
  }
  const emphasis = element(node.type === 'strong' ? 'strong' : 'em'); emphasis.append(inline(node.children)); return emphasis;
}
function inline(nodes: MarkdownInline[]): DocumentFragment {
  const fragment = document.createDocumentFragment(); fragment.append(...nodes.map(inlineNode)); return fragment;
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
function previewInline(nodes: MarkdownInline[], budget: PreviewBudget, parent: HTMLElement): void {
  for (const node of nodes) {
    if (budget.nodes <= 0) { budget.limited = true; return; }
    budget.nodes--;
    if (node.type === 'text') parent.append(document.createTextNode(node.text));
    else if (node.type === 'code') parent.append(element('code', 'prose-preview-code', node.text));
    else if (node.type === 'omitted') parent.append(document.createTextNode(node.label));
    else if (node.type === 'link') previewInline(node.children, budget, parent);
    else { const emphasis = element(node.type === 'strong' ? 'strong' : 'em'); previewInline(node.children, budget, emphasis); parent.append(emphasis); }
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
  for (const node of parseMarkdown(text)) previewBlock(node, budget, blocks);
  const fragment = document.createDocumentFragment(); fragment.append(...blocks);
  if (budget.limited) fragment.append(document.createTextNode('…'));
  return fragment;
}
export function markdownDom(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment(); fragment.append(...parseMarkdown(text).map(block)); return fragment;
}
