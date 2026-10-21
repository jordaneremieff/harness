/** The iteration owner advances this value with each shipped UI iteration. */
export const UI_ITERATION = '1.10';

/** One commit of the source a release was staged from: its full identity and the first line of its message. */
export type RecentCommit = Readonly<{commit: string; subject: string}>;
/** How many recent commits a release keeps, how long a kept subject is, and how large their encoded form may be inside the page identity. */
export const RECENT_COMMITS = 30;
export const RECENT_SUBJECT_CHARS = 120;
export const RECENT_ENCODED_CHARS = 8 * 1024;

export type UiIdentity = Readonly<{
  iteration: string;
  /** The sealed release that supplied this page, absent for a checkout run. */
  release?: string;
  git?: Readonly<{commit: string; shortCommit: string; branch: string; modified: boolean; committedAt: string}>;
  assets?: Readonly<{digest: string; builtAt?: string}>;
  startedAt?: string;
  pi?: string;
  durable?: string;
  /** Newest first, ending at the oldest commit kept. Absent when the release was staged without it. */
  recent?: readonly RecentCommit[];
}>;

export function identityLabel(identity: UiIdentity): string {
  return `ui ${identity.iteration}${identity.git ? ` · ${identity.git.shortCommit}${identity.git.modified ? ' · modified' : ''}` : ''}`;
}
export function identityText(identity: UiIdentity): string {
  if (!identity.git) return identityLabel(identity);
  return [identityLabel(identity), `Commit at server start: ${identity.git.commit}`, `Branch: ${identity.git.branch}`,
    `UI source at server start: ${identity.git.modified ? 'modified' : 'clean'}`, `Commit time: ${identity.git.committedAt}`,
    ...(identity.release ? [`Release: ${identity.release}`] : []),
    `Asset build time: ${identity.assets?.builtAt ?? 'unknown'}`, `Served asset set: ${identity.assets?.digest ?? 'unknown'}`,
    `Server start: ${identity.startedAt ?? 'unknown'}`, `Pi runtime: ${identity.pi ?? 'unknown'}`, `Resolved Durable: ${identity.durable ?? 'unknown'}`].join('\n');
}

/** Current malformed metadata loses detail, never invents a commit or runtime version. */
export function readIdentity(encoded: string | null): UiIdentity {
  const declared = {iteration: UI_ITERATION};
  if (!encoded || encoded.length > 16 * 1024) return declared;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(encoded));
    if (!record(value) || typeof value.iteration !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(value.iteration)) return declared;
    if (!value.git) return {iteration: value.iteration as string};
    const git = value.git;
    if (!record(git) || typeof git.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(git.commit)
      || typeof git.shortCommit !== 'string' || !/^[a-f0-9]{7,64}$/.test(git.shortCommit) || !git.commit.startsWith(git.shortCommit)
      || !text(git.branch, 256) || typeof git.modified !== 'boolean' || !date(git.committedAt)) return declared;
    if (!date(value.startedAt) || !text(value.pi, 128) || !text(value.durable, 128) || !record(value.assets)
      || typeof value.assets.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.assets.digest)
      || (value.assets.builtAt !== undefined && !date(value.assets.builtAt))) return declared;
    if (value.release !== undefined && (typeof value.release !== 'string' || !/^[a-f0-9]{64}$/.test(value.release))) return declared;
    const recent = readRecent(value.recent);
    const {recent: _unchecked, ...identity} = value as UiIdentity & Record<string, unknown>;
    return (recent ? {...identity, recent} : identity) as UiIdentity;
  } catch { return declared; }
}
function record(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value);}
function text(value: unknown, limit: number): value is string {return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);}
function date(value: unknown): value is string {return text(value, 40) && Number.isFinite(Date.parse(value));}

const COMMIT = /^[a-f0-9]{40,64}$/;
/** Subjects stay single-line text: control characters go, and a long subject is cut with an ellipsis. */
function subjectText(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > RECENT_SUBJECT_CHARS ? `${clean.slice(0, RECENT_SUBJECT_CHARS - 1)}…` : clean;
}
/** Keeps the newest commits whose encoded form fits the page identity, so a long or non-ASCII subject list can never push the identity past its reader's bound. */
export function boundedRecent(list: readonly RecentCommit[]): RecentCommit[] {
  const kept = list.slice(0, RECENT_COMMITS);
  while (kept.length && encodeURIComponent(JSON.stringify(kept)).length > RECENT_ENCODED_CHARS) kept.pop();
  return kept;
}
/** Reads `git log --format=%H%x00%s` output into the recent list. Malformed lines are skipped. */
export function parseRecentCommits(output: string): RecentCommit[] {
  const found: RecentCommit[] = [];
  for (const line of output.split('\n')) {
    const at = line.indexOf('\0'); if (at < 0) continue;
    const commit = line.slice(0, at).trim(), subject = subjectText(line.slice(at + 1));
    if (COMMIT.test(commit) && subject) found.push({commit, subject});
  }
  return boundedRecent(found);
}
/** A recent list read from untrusted metadata: anything out of bounds drops the list, never the identity. */
export function readRecent(value: unknown): RecentCommit[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > RECENT_COMMITS) return undefined;
  const list: RecentCommit[] = [];
  for (const item of value) {
    if (!record(item) || typeof item.commit !== 'string' || !COMMIT.test(item.commit) || !text(item.subject, RECENT_SUBJECT_CHARS)) return undefined;
    list.push({commit: item.commit, subject: item.subject});
  }
  return encodeURIComponent(JSON.stringify(list)).length > RECENT_ENCODED_CHARS ? undefined : list;
}
