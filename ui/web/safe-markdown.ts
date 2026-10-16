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
export function sourceWrap(pre: HTMLElement): HTMLButtonElement {
  pre.dataset.wrap = 'true';
  const wrap = cardAction('wrap', 'Wrap', () => {
    pre.dispatchEvent(new Event('source-wrap', {bubbles: true}));
    const wrapped = pre.dataset.wrap !== 'true';
    pre.dataset.wrap = String(wrapped); wrap.setAttribute('aria-pressed', String(wrapped));
    wrap.title = wrapped ? 'Do not wrap source lines' : 'Wrap source lines';
  }, 'source-wrap');
  wrap.setAttribute('aria-pressed', 'true'); cardActionLabel(wrap, 'Wrap', 'Wrap source lines'); wrap.title = 'Do not wrap source lines';
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
export function markdownDom(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment(); fragment.append(...parseMarkdown(text).map(block)); return fragment;
}
