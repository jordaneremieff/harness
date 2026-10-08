import type { OutputContinuation, OutputPage } from '../shared/api.ts';
import { button, copy, element, setText } from './dom.ts';

export type OutputLoader = (more: OutputContinuation) => Promise<OutputPage>;
function outputError(error: unknown): string { return error instanceof Error ? error.message : 'Output request failed.'; }
function pageBytes(page: OutputPage, more: OutputContinuation, offset: number): number {
  const bytes = new TextEncoder().encode(page.text).length;
  const nextValid = page.nextOffset === null || (Number.isSafeInteger(page.nextOffset) && page.nextOffset > offset);
  if (page.entryId !== more.entryId || page.part !== more.part || bytes > 8192 || !nextValid) throw new Error('Output page does not match this text.');
  return bytes;
}
/** Each request replaces one bounded page, never an accumulated full output. */
export function outputPages(more: OutputContinuation, load: OutputLoader | undefined, current: () => boolean, changed: () => void): HTMLElement {
  const node = element('section', 'output-pages');
  const content = element('pre', 'output-page'); content.hidden = true;
  const status = element('p', 'secondary');
  let offsets = [more.offset]; let pageIndex = -1; let nextOffset: number | null = more.offset; let busy = false; let version = 0;
  function displayPage(page: OutputPage, offset: number, index: number): void {
    const bytes = pageBytes(page, more, offset);
    pageIndex = index; nextOffset = page.nextOffset; offsets[index] = offset;
    if (offsets.length > 64) { offsets = offsets.slice(-64); pageIndex = offsets.length - 1; }
    setText(content, page.text); content.hidden = false;
    setText(status, `Retained output · ${offset}–${offset + bytes} of ${page.totalBytes} bytes`);
  }
  const active = (request: number) => request === version && current();
  const requestPage = async (offset: number, index: number) => {
    if (!load || busy || !current()) return;
    busy = true; const request = ++version; setText(status, 'Loading output'); controls(); changed();
    try {
      const page = await load({...more, offset});
      if (!active(request)) return;
      displayPage(page, offset, index);
    } catch (error) {
      if (!active(request)) return;
      setText(status, outputError(error));
    } finally {
      if (active(request)) { busy = false; controls(); changed(); }
    }
  };
  const next = button('Load more output', () => { if (nextOffset !== null) void requestPage(nextOffset, pageIndex + 1); });
  const previous = button('Previous output', () => { const index = pageIndex - 1; const offset = offsets[index]; if (offset !== undefined) void requestPage(offset, index); });
  const restart = button('Start over', () => {
    if (busy) return;
    version++; offsets = [more.offset]; pageIndex = -1; nextOffset = more.offset;
    content.hidden = true; setText(content, ''); setText(status, ''); controls(); changed();
  });
  const copyPage = button('Copy page', () => { void copy(content.textContent ?? '', node); });
  function controls(): void {
    next.disabled = busy || !load || nextOffset === null; setText(next, pageIndex < 0 ? 'Load more output' : 'Next output');
    previous.hidden = pageIndex <= 0; previous.disabled = busy; restart.disabled = busy; restart.hidden = pageIndex < 0 && !busy;
    copyPage.hidden = content.hidden;
    if (!load) setText(status, 'More retained output is unavailable in this view.');
  }
  node.append(content, status, previous, next, restart, copyPage); controls(); return node;
}
