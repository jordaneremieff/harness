import type { RecentCommit } from '../shared/version.ts';

/** What this tab remembers between page loads: the release it showed before, the one it shows now, and whether the notice was dismissed. */
export type UpdateRecord = {from?: string; to: string; dismissed: boolean};
export const UPDATE_KEY = 'ui:update';
/** Details lists this many subjects; a copy of the whole kept list is always available. */
export const DETAIL_SUBJECTS = 20;
const COMMIT = /^[a-f0-9]{40,64}$/;

/** A stored record is trusted only in this exact shape. */
export function readUpdateRecord(raw: string | null): UpdateRecord | undefined {
  if (!raw || raw.length > 1024) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.to !== 'string' || !COMMIT.test(record.to) || typeof record.dismissed !== 'boolean') return undefined;
    if (record.from !== undefined && (typeof record.from !== 'string' || !COMMIT.test(record.from))) return undefined;
    return {...(record.from === undefined ? {} : {from: record.from}), to: record.to, dismissed: record.dismissed};
  } catch { return undefined; }
}
/** The first load has nothing to compare with. A different release makes a new notice; the same release keeps the earlier record, dismissed or not. */
export function nextUpdateRecord(stored: UpdateRecord | undefined, current: string): UpdateRecord {
  if (!stored) return {to: current, dismissed: true};
  if (stored.to === current) return stored;
  return {from: stored.to, to: current, dismissed: false};
}
export type UpdateChanges = {known: boolean; subjects: RecentCommit[]; more: number};
/** The commits newer than `from`, newest first. When `from` is not in the kept list the answer is unknown, never a guess. */
export function changesSince(recent: readonly RecentCommit[] | undefined, from: string | undefined): UpdateChanges {
  const at = recent && from ? recent.findIndex(item => item.commit === from) : -1;
  if (!recent || at < 0) return {known: false, subjects: [], more: 0};
  const subjects = recent.slice(0, at);
  return {known: true, subjects: subjects.slice(0, DETAIL_SUBJECTS), more: Math.max(0, subjects.length - DETAIL_SUBJECTS)};
}
/** The text Copy puts on the clipboard: every kept subject since `from`, not only the first twenty. */
export function changesText(recent: readonly RecentCommit[] | undefined, from: string | undefined): string {
  const at = recent && from ? recent.findIndex(item => item.commit === from) : -1;
  if (!recent || at < 0) return '';
  return recent.slice(0, at).map(item => `${item.commit.slice(0, 8)} ${item.subject}`).join('\n');
}
