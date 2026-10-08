type Timestamp = string | number | Date;
function timestampDate(value: Timestamp): Date { return value instanceof Date ? value : new Date(value); }
export function isValidTimestamp(value: Timestamp): boolean { return Number.isFinite(timestampDate(value).getTime()); }
export function relativeTime(value: Timestamp, now: number): string {
  const date = timestampDate(value);
  if (!isValidTimestamp(date) || !isValidTimestamp(now)) return '';
  const seconds = (now - date.getTime()) / 1000;
  if (Math.abs(seconds) <= 60) return 'now';
  if (seconds < -60 || seconds >= 30 * 86400) {
    return new Intl.DateTimeFormat('en-US', {year: 'numeric', month: 'short', day: 'numeric'}).format(date);
  }
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}hr ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function absoluteTime(value: Timestamp, options: { locale?: string; timeZone?: string } = {}): string {
  const date = timestampDate(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(options.locale ?? 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: options.timeZone,
  }).format(date);
}
export function timestampDetails(value: Timestamp, timeZone?: string): { exact: string; display: string } {
  const date = timestampDate(value);
  if (!Number.isFinite(date.getTime())) return { exact: '', display: '' };
  return { exact: date.toISOString(), display: new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium', timeStyle: 'long', timeZone,
  }).format(date) };
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
