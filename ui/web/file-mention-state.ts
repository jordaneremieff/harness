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
/** A long directory loses its start so the distinguishing tail stays visible. */
export function shortDirectory(directory: string, limit = 28): string {
  if (directory.length <= limit) return directory;
  const parts = directory.split('/'); let tail = '';
  for (let index = parts.length - 1; index >= 0; index--) {
    const next = tail ? `${parts[index]}/${tail}` : parts[index] ?? '';
    if (next.length + 2 > limit && tail) break;
    tail = next;
  }
  return `…/${tail.length + 2 > limit ? tail.slice(tail.length - (limit - 2)) : tail}`;
}
export function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}
