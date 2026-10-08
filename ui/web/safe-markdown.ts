import { parseMarkdown } from './markdown.ts';
import type { MarkdownBlock, MarkdownInline } from './markdown.ts';
import { button, copy, element } from './dom.ts';

function inlineNode(node: MarkdownInline): Node {
  if (node.type === 'text') return document.createTextNode(node.text);
  if (node.type === 'code') return element('code', undefined, node.text);
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
function codeBlock(node: Extract<MarkdownBlock, {type: 'code'}>): HTMLElement {
  const wrap = element('div', 'code-block'); const pre = element('pre'); const code = element('code', undefined, node.text);
  if (node.language) code.dataset.language = node.language;
  pre.append(code); wrap.append(button('Copy code', () => { void copy(node.text, wrap); }, 'copy'), pre); return wrap;
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
  switch (node.type) {
    case 'paragraph': { const p = element('p'); p.append(inline(node.children)); return p; }
    case 'heading': { const h = element(`h${Math.min(6, Math.max(1, node.level))}` as 'h1'); h.append(inline(node.children)); return h; }
    case 'quote': { const quote = element('blockquote'); quote.append(...node.children.map(block)); return quote; }
    case 'list': return listBlock(node);
    case 'code': return codeBlock(node);
    case 'table': return tableBlock(node);
  }
}
export function markdownDom(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment(); fragment.append(...parseMarkdown(text).map(block)); return fragment;
}
