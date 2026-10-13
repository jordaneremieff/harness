const COMPARE_CHARS = 65536;
const CONTEXT_CHARS = 80;

export type SuppliedDifference = {oldText: string; newText: string; omittedBefore: boolean; omittedAfter: boolean; scanLimited: boolean; same: boolean};

function contextStart(value: string, difference: number, chars: number): number {
  let start = difference;
  const minimum = Math.max(0, difference - Math.min(CONTEXT_CHARS, Math.floor(chars / 4)));
  while (start > minimum && value[start - 1] !== '\n' && value[start - 1] !== '\r') start--;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value[start] ?? '') && /[\uD800-\uDBFF]/.test(value[start - 1] ?? '')) start--;
  if (start > 0 && value[start - 1] === '\r' && value[start] === '\n') start--;
  return start;
}
function windowText(value: string, start: number, chars: number, lines: number): string {
  let end = Math.min(value.length, start + chars); let count = 1;
  for (let index = start; index < end; index++) {
    if ((value[index] === '\n' || (value[index] === '\r' && value[index + 1] !== '\n')) && ++count > lines) {end = index; break;}
  }
  if (end < value.length && end > start && /[\uD800-\uDBFF]/.test(value[end - 1] ?? '')) end--;
  if (end < value.length && end > start && value[end - 1] === '\r' && value[end] === '\n') end--;
  return value.slice(start, end);
}
/** Compare retained supplied strings, not a current file or a reconstructed diff. */
export function suppliedDifference(oldText: string, newText: string, chars = 8192, lines = 80): SuppliedDifference {
  const width = Math.max(0, Math.floor(chars)); const lineLimit = Math.max(1, Math.floor(lines));
  const bound = Math.min(COMPARE_CHARS, oldText.length, newText.length); let difference = 0;
  while (difference < bound && oldText.charCodeAt(difference) === newText.charCodeAt(difference)) difference++;
  const scanLimited = difference === COMPARE_CHARS && oldText.length > difference && newText.length > difference;
  const same = difference === oldText.length && difference === newText.length;
  const start = same || scanLimited ? 0 : contextStart(oldText, difference, width);
  const before = windowText(oldText, start, width, lineLimit), after = windowText(newText, start, width, lineLimit);
  return {oldText: before, newText: after, omittedBefore: start > 0,
    omittedAfter: start + before.length < oldText.length || start + after.length < newText.length, scanLimited, same};
}
export function differenceNotice(value: SuppliedDifference): string {
  return [value.omittedAfter ? 'Later context omitted.' : '', value.scanLimited ? 'First difference not located within scan limit.' : '',
    value.same && (value.oldText || value.newText) ? 'No differing text in supplied pair.' : ''].filter(Boolean).join(' ');
}
