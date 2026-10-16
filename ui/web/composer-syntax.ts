import {tokenRanges, type TokenRange} from './highlight.ts';
export const DECORATION_BYTES = 16 * 1024;
export const DECORATION_LINES = 500;
export const DECORATION_SPANS = 2048;
/** Native drafts retain their smaller decoration budget and exact UTF-16 offsets. */
export function composerSyntax(text: string): TokenRange[] | undefined {
  return tokenRanges(text, 'markdown', DECORATION_SPANS, {bytes: DECORATION_BYTES, lines: DECORATION_LINES});
}
