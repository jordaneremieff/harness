/** The iteration owner advances this value with each shipped UI iteration. */
export const UI_ITERATION = '0.6';

export type UiIdentity = Readonly<{
  iteration: string;
  git?: Readonly<{commit: string; shortCommit: string; branch: string; modified: boolean; committedAt: string}>;
  assets?: Readonly<{digest: string; builtAt?: string}>;
  startedAt?: string;
  pi?: string;
  durable?: string;
}>;

export function identityLabel(identity: UiIdentity): string {
  return `ui ${identity.iteration}${identity.git ? ` · ${identity.git.shortCommit}${identity.git.modified ? ' · modified' : ''}` : ''}`;
}
export function identityText(identity: UiIdentity): string {
  if (!identity.git) return identityLabel(identity);
  return [identityLabel(identity), `Commit at server start: ${identity.git.commit}`, `Branch: ${identity.git.branch}`,
    `UI source at server start: ${identity.git.modified ? 'modified' : 'clean'}`, `Commit time: ${identity.git.committedAt}`,
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
    return value as UiIdentity;
  } catch { return declared; }
}
function record(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value);}
function text(value: unknown, limit: number): value is string {return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);}
function date(value: unknown): value is string {return text(value, 40) && Number.isFinite(Date.parse(value));}
