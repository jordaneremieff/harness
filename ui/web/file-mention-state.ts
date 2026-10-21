export type MentionToken = {start: number; end: number; query: string};
/** An at sign that begins a word, with a collapsed caret inside it; an address such as a@b is not a mention. */
export function mentionToken(text: string, start: number, end: number): MentionToken | undefined {
  if (start !== end || start < 1 || start > text.length) return undefined;
  let tokenStart = start;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? '')) tokenStart--;
  if (text[tokenStart] !== '@' || start <= tokenStart) return undefined;
  let tokenEnd = start;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? '')) tokenEnd++;
  return {start: tokenStart, end: tokenEnd, query: text.slice(tokenStart + 1, tokenEnd)};
}
/** Root-relative directory labels retain their complete text; CSS handles overflow. */
export function shortDirectory(directory: string, _limit = 28): string { return directory; }
export function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}
