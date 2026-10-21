/** Plain words for a compact line; full text and copies retain their source marks. */
export function plainPreviewWords(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|[*`]/g, '').replace(/\s+/g, ' ').trim();
}

type Timestamp = string | number | Date;
function timestampDate(value: Timestamp): Date { return value instanceof Date ? value : new Date(value); }
export function isValidTimestamp(value: Timestamp): boolean { return Number.isFinite(timestampDate(value).getTime()); }
/** Fixed day-first dates and uppercase day periods in the local zone unless a zone is supplied. */
export function formatDate(value: Timestamp, fields: Intl.DateTimeFormatOptions, timeZone?: string): string {
  const date = timestampDate(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', {...fields, hour12: true, timeZone}).formatToParts(date)
    .map(part => part.type === 'dayPeriod' ? part.value.toUpperCase() : part.value.replace(/\s/g, ' ')).join('');
}
export function relativeTime(value: Timestamp, now: number, timeZone?: string): string {
  const date = timestampDate(value);
  if (!isValidTimestamp(date) || !isValidTimestamp(now)) return '';
  const seconds = (now - date.getTime()) / 1000;
  if (Math.abs(seconds) <= 60) return 'now';
  if (seconds < -60 || seconds >= 30 * 86400) {
    return formatDate(date, {year: 'numeric', month: 'short', day: 'numeric'}, timeZone);
  }
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}hr ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function compactAge(value: number, now: number, timeZone?: string): string {
  const full = relativeTime(value, now, timeZone); if (!full) return '';
  const seconds = (now - value) / 1000;
  if (seconds < -60 || seconds >= 30 * 86400) return formatDate(value, {month: 'short', day: 'numeric'}, timeZone);
  return full.replace(/hr ago$/, 'h').replace(/ ago$/, '');
}
/** A zero-padded 24-hour clock in the local zone. */
export function clockTime(value: Timestamp): string {
  const date = timestampDate(value);
  return isValidTimestamp(date) ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';
}
export function absoluteTime(value: Timestamp, options: { timeZone?: string } = {}): string {
  return formatDate(value, {year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}, options.timeZone);
}
/** Local day, month and 12-hour time with seconds, for example "20 Oct, 2:29:23 PM". */
export function localDateTime(value: Timestamp, timeZone?: string): string {
  return formatDate(value, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'}, timeZone);
}
export function timestampDetails(value: Timestamp, timeZone?: string): { exact: string; display: string } {
  const date = timestampDate(value);
  if (!Number.isFinite(date.getTime())) return { exact: '', display: '' };
  return { exact: date.toISOString(), display: formatDate(date, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }, timeZone) };
}
/** Remove terminal instructions while retaining line breaks and ordinary text. */
export function stripControls(text: string): string {
  return text
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
export function previewText(text: string, maxLines = 6, maxChars = 2000): { text: string; truncated: boolean } {
  const safe = stripControls(text);
  const lines = safe.split('\n');
  const lineLimit = Math.max(0, Math.floor(maxLines));
  const charLimit = Math.max(0, Math.floor(maxChars));
  let preview = lines.slice(0, lineLimit).join('\n');
  if (preview.length > charLimit) {
    let end = charLimit;
    if (end && /[\uD800-\uDBFF]/.test(preview.charAt(end - 1))) end--;
    preview = preview.slice(0, end);
  }
  return { text: preview, truncated: preview.length < safe.length };
}
