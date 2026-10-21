import type { PartView } from '../shared/api.ts';
import type { JoinedTool } from './transcript-tools.ts';
import { element } from './dom.ts';
import { highlight } from './highlight.ts';

type TextPart = Extract<PartView, {type: 'text'}>;
function flatParts(parts: readonly PartView[]): PartView[] {
  return parts.flatMap(part => part.type === 'toolResult' ? flatParts(part.parts) : [part]);
}
function readArguments(source: JoinedTool): Record<string, unknown> | undefined {
  if (source.name !== 'read' || source.status !== 'success' || source.args?.truncated || source.argumentsError) return undefined;
  const args = source.args?.value;
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof (args as Record<string, unknown>).path !== 'string') return undefined;
  return args as Record<string, unknown>;
}
function binaryRead(path: string, text: string): boolean {
  return /\.(?:pdf|zip|gz|bz2|xz|7z|png|jpe?g|gif|webp|bmp|ico|wasm|woff2?|ttf|otf|exe|dll|dylib|so|o|a|sqlite3?|db|mp[34]|mov|wav|flac)$/i.test(path)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(text) || text.startsWith('%PDF-');
}
/** Only the retained native text supplies source lines, never a decoded sidecar. */
export function readSourcePart(source: JoinedTool): TextPart | undefined {
  const args = readArguments(source); if (!args) return undefined;
  const parts = flatParts(source.result ?? []); const part = parts[0];
  if (parts.length !== 1 || part?.type !== 'text' || part.redacted) return undefined;
  if (part.text.startsWith('Read image file [') || part.text.includes('[redacted') || binaryRead(String(args.path), part.text)) return undefined;
  return part;
}
/** Read's continuation notice is output metadata, not another source line. */
function readBody(text: string): [string, string] {
  const notice = /(?:\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^\n]* limit\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\]|\n\[truncated\])$/.exec(text);
  return notice ? [text.slice(0, notice.index), text.slice(notice.index)] : [text, ''];
}
function alreadyLabeled(text: string): boolean {
  const lines = text.split('\n').filter(line => line.trim());
  const first = /^\s*(\d+)\s*[|:]/.exec(lines[0] ?? '');
  return !!first && lines.every((line, index) => {
    const label = /^\s*(\d+)\s*[|:]/.exec(line);
    return !!label && Number(label[1]) === Number(first[1]) + index;
  });
}
export function readLineStart(source: JoinedTool, text: string): number | undefined {
  if (readSourcePart(source)?.text !== text || source.output?.truncation?.firstLineExceedsLimit) return undefined;
  const args = source.args?.value as Record<string, unknown>;
  const start = args.offset === undefined ? 1 : args.offset;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1) return undefined;
  const [body] = readBody(text);
  if (!body || /^\[Line \d+ is [^\n]+, exceeds [^\n]+ limit\. Use bash:/.test(body) || alreadyLabeled(body)) return undefined;
  return Number.isSafeInteger(start + body.split('\n').length - 1) ? start : undefined;
}
function sourceLine(root: HTMLElement, number: number): HTMLElement {
  const row = element('span', 'read-source-line');
  const gutter = element('span', 'read-line-number'); gutter.dataset.line = String(number); gutter.setAttribute('aria-hidden', 'true');
  const text = element('span', 'read-line-text'); row.append(gutter, text); root.append(row); return text;
}
/** Partition an already highlighted stream so multiline tokens keep their syntax state. */
export function numberedRead(text: string, start: number, language?: string): DocumentFragment {
  const [body, notice] = readBody(text); const fragment = document.createDocumentFragment();
  const root = element('span', 'read-source-lines');
  root.style.setProperty('--read-line-digits', String(String(start + body.split('\n').length - 1).length));
  let number = start; let line = sourceLine(root, number);
  for (const node of highlight(body, language).childNodes) {
    const parts = (node.textContent ?? '').split('\n');
    parts.forEach((part, index) => {
      const newline = index < parts.length - 1;
      const text = part + (newline ? '\n' : '');
      line.append(node instanceof HTMLElement ? element('span', node.className, text) : document.createTextNode(text));
      if (newline) line = sourceLine(root, ++number);
    });
  }
  fragment.append(root);
  if (notice) fragment.append(document.createTextNode(notice));
  return fragment;
}
