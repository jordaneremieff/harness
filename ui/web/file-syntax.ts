import {HIGHLIGHT_BYTES, HIGHLIGHT_LINES, languageFromPath, tokenRanges, type TokenRange} from './highlight.ts';

export const FILE_SYNTAX_BYTES = HIGHLIGHT_BYTES;
export const FILE_SYNTAX_LINES = HIGHLIGHT_LINES;
export const FILE_SYNTAX_SPANS = 16_384;
/** Exact source ranges only; every known file family uses the same bounded scanner. */
export function fileSyntaxRanges(path: string, text: string): TokenRange[] | undefined {
  const language = languageFromPath(path);
  return language ? tokenRanges(text, language, FILE_SYNTAX_SPANS) : undefined;
}
