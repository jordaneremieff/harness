import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { UI_ITERATION, type UiIdentity } from '../shared/version.ts';
import type { Asset } from './http.mts';
import { ApiError } from './errors.mts';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export type GitOptions = {cwd: string; shell: false; encoding: 'utf8'; maxBuffer: number; timeout: number};
export type GitExec = (command: string, args: string[], options: GitOptions) => Promise<string>;
const execute: GitExec = (command, args, options) => new Promise((accept, reject) => {
  execFile(command, args, options, (error, stdout) => error ? reject(error) : accept(stdout));
});
const gitOptions = (cwd: string): GitOptions => ({cwd, shell: false, encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 3000});
const gitArgs = ['-c', 'core.hooksPath=/dev/null', '--no-optional-locks'];

/** Porcelain -z records include both paths for a rename; non-UI and ignored paths do not mark this UI. */
export function uiModified(status: string): boolean {
  const rows = status.split('\0');
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] ?? ''; const code = row.slice(0, 2);
    if (!/^[ MADRCU?!]{2}$/.test(code) || code === '!!' || code === '  ') continue;
    const paths = [row.slice(3)];
    if (/[RC]/.test(code)) paths.push(rows[++index] ?? '');
    if (paths.some(path => path.startsWith('ui/'))) return true;
  }
  return false;
}
export function assetDigest(assets: ReadonlyMap<string, Asset>): string {
  const hash = createHash('sha256');
  for (const [route, asset] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([route, asset.type, asset.data.length])); hash.update(asset.data);
  }
  return hash.digest('hex');
}
/** The latest emission mtime of the served compiled files is a file-time stamp, not a source-commit attestation. */
async function assetBuildTime(assets: ReadonlyMap<string, Asset>, root: string): Promise<string | undefined> {
  const paths = [...assets.keys()].filter(route => /^\/(?:web|shared)\/[a-zA-Z0-9_-]+\.js$/.test(route));
  const times = await Promise.all(paths.map(async route => {
    try {return (await stat(resolve(root, `dist${route}`))).mtimeMs;} catch {return undefined;}
  }));
  if (!times.length || times.some(time => time === undefined)) return undefined;
  return new Date(Math.max(...times as number[])).toISOString();
}
async function durableVersion(): Promise<string> {
  try {
    const path = createRequire(import.meta.url).resolve('@earendil-works/pi-durable/package.json');
    const info = await stat(path); if (info.size > 16 * 1024) return 'unknown';
    const metadata = JSON.parse(await readFile(path, 'utf8')) as {name?: string; version?: string};
    return metadata.name === '@earendil-works/pi-durable' && typeof metadata.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version) ? metadata.version : 'unknown';
  } catch {return 'unknown';}
}
export async function collectIdentity(assets: ReadonlyMap<string, Asset>, options: {
  root?: string; assetRoot?: string; startedAt?: string; execute?: GitExec;
  build?: {digest: string; builtAt?: string};
} = {}): Promise<UiIdentity> {
  const root = options.root ?? packageRoot; const run = options.execute ?? execute;
  const declared = Object.freeze({iteration: UI_ITERATION});
  try {
    const git = (args: string[]) => run('git', [...gitArgs, ...args], gitOptions(root));
    const top = (await git(['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(top) !== await realpath(root)) return declared;
    const [record, branch, status] = await Promise.all([
      git(['show', '--no-patch', '--format=%H%x00%h%x00%cI', 'HEAD']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', 'ui/']),
    ]);
    const [commit, shortCommit, committedAt] = record.trim().split('\0');
    if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !shortCommit || !commit.startsWith(shortCommit)
      || !/^[a-f0-9]{7,64}$/.test(shortCommit) || !committedAt || !Number.isFinite(Date.parse(committedAt))) return declared;
    const name = branch.trim(); if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) return declared;
    const [builtAt, durable] = await Promise.all([assetBuildTime(assets, options.assetRoot ?? resolve(root, 'ui')), durableVersion()]);
    const build = options.build ?? {digest: assetDigest(assets), ...(builtAt ? {builtAt} : {})};
    return Object.freeze({iteration: UI_ITERATION, git: Object.freeze({commit, shortCommit, branch: name === 'HEAD' ? 'detached' : name,
      modified: uiModified(status), committedAt}), assets: Object.freeze({...build}), startedAt: options.startedAt ?? new Date().toISOString(), pi: VERSION, durable});
  } catch {return declared;}
}
/** HTML carries the exact startup identity alongside the retained page, never a mutable workspace lookup. */
export function identityDocument(asset: Asset, identity: UiIdentity, limit: number): Asset {
  const meta = `<meta name="ui-identity" content="${encodeURIComponent(JSON.stringify(identity))}">`;
  const html = asset.data.toString('utf8');
  const data = Buffer.from(/<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, head => head + meta) : /^<!doctype[^>]*>/i.test(html) ? html.replace(/^<!doctype[^>]*>/i, head => head + meta) : meta + html);
  if (data.length > limit) throw new ApiError('capacity', 'The identity exceeds the browser document bound.', 503);
  return {type: asset.type, data};
}
