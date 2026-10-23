const COMPARE_CHARS = 65536;
const CONTEXT_LINE_CHARS = 200;

/**
 * A comparison of two supplied strings in whole lines: one shared line before the change,
 * the removed lines, the added lines and one shared line after the change.
 * `null` means the side has no such line.
 */
export type SuppliedDifference = {
  contextBefore: string | null; removed: string[]; added: string[]; contextAfter: string | null;
  omittedBefore: boolean; omittedAfter: boolean; scanLimited: boolean; same: boolean;
};

function isBreak(char: string | undefined): boolean { return char === '\n' || char === '\r'; }
function lineStartAt(value: string, position: number): boolean {
  return position === 0 || value[position - 1] === '\n' || (value[position - 1] === '\r' && value[position] !== '\n');
}
function lineStartBefore(value: string, position: number): number {
  let start = position;
  while (start > 0 && !lineStartAt(value, start)) start--;
  return start;
}
function lineEnd(value: string, from: number): number {
  let end = from;
  while (end < value.length && !isBreak(value[end])) end++;
  return end;
}
function terminatorLength(value: string, end: number): number {
  if (value[end] === '\r' && value[end + 1] === '\n') return 2;
  return isBreak(value[end]) ? 1 : 0;
}
function terminatorBefore(value: string, position: number): number {
  return value[position - 2] === '\r' && value[position - 1] === '\n' ? 2 : 1;
}
function windowText(value: string, start: number, chars: number, lines: number): string {
  let end = Math.min(value.length, start + chars); let count = 1;
  for (let index = start; index < end; index++) {
    if ((value[index] === '\n' || (value[index] === '\r' && value[index + 1] !== '\n')) && ++count > lines) {end = index; break;}
  }
  if (end < value.length && end > start && !isBreak(value[end])) {
    while (end > start && !isBreak(value[end - 1])) end--;
    if (end > start) end -= terminatorBefore(value, end);
  }
  if (end < value.length && end > start && value[end - 1] === '\r' && value[end] === '\n') end--;
  return value.slice(start, end);
}
/** Lines of a bounded window over `region`; `present` is false when the side has no line at all. */
function windowLines(region: string, present: boolean, chars: number, lines: number): {lines: string[]; truncated: boolean} {
  if (!present) return {lines: [], truncated: false};
  const shown = windowText(region, 0, chars, lines);
  const truncated = shown.length < region.length;
  return {lines: shown === '' && region !== '' ? [] : shown.split(/\r\n|\r|\n/), truncated};
}
/** A shared line is present whole or omitted; `cut` reports an omitted line. */
function contextLine(line: string, chars: number): {text: string | null; cut: boolean} {
  const limit = Math.min(CONTEXT_LINE_CHARS, Math.floor(chars / 2));
  if (line.length <= limit) return {text: line, cut: false};
  return {text: null, cut: true};
}

type Start = {oldFrom: number; newFrom: number; displayOld: number; displayNew: number; contextBefore: string | null;
  omittedBefore: boolean; oldTrailing: boolean; newTrailing: boolean};
type End = {suffix: number; oldEnd: number; newEnd: number; contextAfter: string | null; omittedAfter: boolean};

/** The line holding the first difference, or the line after a shared last line when one text ends inside it. */
function commonStart(oldText: string, newText: string, difference: number, width: number): Start {
  const lineStart = Math.min(lineStartBefore(oldText, difference), lineStartBefore(newText, difference));
  const oldLineEnd = lineEnd(oldText, lineStart), newLineEnd = lineEnd(newText, lineStart);
  const oldBreak = terminatorLength(oldText, oldLineEnd), newBreak = terminatorLength(newText, newLineEnd);
  const sharedLast = (difference === oldText.length || difference === newText.length)
    && oldText.slice(lineStart, oldLineEnd) === newText.slice(lineStart, newLineEnd);
  if (sharedLast) {
    const line = contextLine(oldText.slice(lineStart, oldLineEnd), width);
    const oldFrom = oldBreak ? oldLineEnd + oldBreak : oldText.length, newFrom = newBreak ? newLineEnd + newBreak : newText.length;
    return {oldFrom, newFrom, displayOld: oldFrom, displayNew: newFrom, contextBefore: line.text, omittedBefore: line.text === null || lineStart > 0,
      oldTrailing: oldBreak > 0 && oldFrom === oldText.length, newTrailing: newBreak > 0 && newFrom === newText.length};
  }
  const start = lineStart;
  const base = {oldFrom: lineStart, newFrom: lineStart, oldTrailing: false, newTrailing: false};
  if (start > lineStart) return {...base, displayOld: start, displayNew: start, contextBefore: null, omittedBefore: true};
  if (lineStart === 0) return {...base, displayOld: 0, displayNew: 0, contextBefore: null, omittedBefore: false};
  const contentEnd = lineStart - terminatorBefore(oldText, lineStart);
  const previous = lineStartBefore(oldText, contentEnd);
  const line = contextLine(oldText.slice(previous, contentEnd), width);
  return {...base, displayOld: lineStart, displayNew: lineStart, contextBefore: line.text, omittedBefore: line.text === null || previous > 0};
}
/** The first line after the changed lines that both texts share, found within the compare bound. */
function commonEnd(oldText: string, newText: string, difference: number, from: Start, width: number): End {
  const room = Math.min(COMPARE_CHARS, Math.min(oldText.length, newText.length) - difference);
  let common = 0;
  while (common < room && oldText.charCodeAt(oldText.length - 1 - common) === newText.charCodeAt(newText.length - 1 - common)) common++;
  const shift = newText.length - oldText.length; let suffix = -1;
  for (let position = oldText.length - common; position <= oldText.length; position++) {
    if (lineStartAt(oldText, position) && lineStartAt(newText, position + shift)) {suffix = position; break;}
  }
  if (suffix < 0) return {suffix, oldEnd: oldText.length, newEnd: newText.length, contextAfter: null, omittedAfter: false};
  const oldEnd = suffix > from.oldFrom ? suffix - terminatorBefore(oldText, suffix) : suffix;
  const newEnd = suffix + shift > from.newFrom ? suffix + shift - terminatorBefore(newText, suffix + shift) : suffix + shift;
  if (suffix === oldText.length) return {suffix, oldEnd, newEnd, contextAfter: null, omittedAfter: false};
  const end = lineEnd(oldText, suffix); const line = contextLine(oldText.slice(suffix, end), width);
  return {suffix, oldEnd, newEnd, contextAfter: line.text, omittedAfter: line.cut || end + terminatorLength(oldText, end) < oldText.length};
}
/** Compare retained supplied strings, not a current file or a reconstructed diff. */
export function suppliedDifference(oldText: string, newText: string, chars = 8192, lines = 80): SuppliedDifference {
  const width = Math.max(0, Math.floor(chars)); const lineLimit = Math.max(1, Math.floor(lines));
  const bound = Math.min(COMPARE_CHARS, oldText.length, newText.length); let difference = 0;
  while (difference < bound && oldText.charCodeAt(difference) === newText.charCodeAt(difference)) difference++;
  const scanLimited = difference === COMPARE_CHARS && oldText.length > difference && newText.length > difference;
  const same = difference === oldText.length && difference === newText.length;
  if (same || scanLimited) {
    const removed = windowLines(oldText, oldText !== '', width, lineLimit), added = windowLines(newText, newText !== '', width, lineLimit);
    return {contextBefore: null, removed: removed.lines, added: added.lines, contextAfter: null,
      omittedBefore: false, omittedAfter: removed.truncated || added.truncated, scanLimited, same};
  }
  const start = commonStart(oldText, newText, difference, width);
  const end = commonEnd(oldText, newText, difference, start, width);
  const shift = newText.length - oldText.length;
  const hasOld = end.suffix >= 0 ? end.suffix > start.oldFrom : end.oldEnd > start.displayOld || start.oldTrailing;
  const hasNew = end.suffix >= 0 ? end.suffix + shift > start.newFrom : end.newEnd > start.displayNew || start.newTrailing;
  const removed = windowLines(oldText.slice(start.displayOld, end.oldEnd), hasOld, width, lineLimit);
  const added = windowLines(newText.slice(start.displayNew, end.newEnd), hasNew, width, lineLimit);
  return {contextBefore: start.contextBefore, removed: removed.lines, added: added.lines, contextAfter: end.contextAfter,
    omittedBefore: start.omittedBefore, omittedAfter: end.omittedAfter || removed.truncated || added.truncated, scanLimited, same};
}
export type SuppliedChange = {start: number; removedEnd: number; addedEnd: number};
/** Only a complete single-line pair has an unambiguous changed middle; offsets preserve whole code points. */
export function suppliedChange(value: SuppliedDifference): SuppliedChange | undefined {
  if (value.same || value.scanLimited || value.omittedBefore || value.omittedAfter || value.removed.length !== 1 || value.added.length !== 1) return undefined;
  const oldText = value.removed[0] ?? '', newText = value.added[0] ?? '';
  if (oldText.length > COMPARE_CHARS || newText.length > COMPARE_CHARS) return undefined;
  const oldPoints = Array.from(oldText), newPoints = Array.from(newText);
  let start = 0;
  while (start < oldPoints.length && start < newPoints.length && oldPoints[start] === newPoints[start]) start++;
  let removedEnd = oldPoints.length, addedEnd = newPoints.length;
  while (removedEnd > start && addedEnd > start && oldPoints[removedEnd - 1] === newPoints[addedEnd - 1]) { removedEnd--; addedEnd--; }
  if (start === removedEnd && start === addedEnd) return undefined;
  return {start: oldPoints.slice(0, start).join('').length,
    removedEnd: oldPoints.slice(0, removedEnd).join('').length, addedEnd: newPoints.slice(0, addedEnd).join('').length};
}
export function differenceNotice(value: SuppliedDifference): string {
  return [value.omittedAfter ? 'Later context omitted.' : '', value.scanLimited ? 'First difference not located within scan limit.' : '',
    value.same && (value.removed.length || value.added.length) ? 'No differing text in supplied pair.' : ''].filter(Boolean).join(' ');
}
