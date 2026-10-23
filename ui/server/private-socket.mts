import {randomBytes} from 'node:crypto';
import {chmod, link, lstat, mkdir, realpath, unlink} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import type {Server} from 'node:http';
import {isAbsolute, join, resolve} from 'node:path';
import {assertControlPath} from './release-control.mts';

function unavailable(): Error {return new Error('The private UI socket path is not safe or available.');}
async function existing(path: string): Promise<Stats | undefined> {
  try {return await lstat(path);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
}
async function absent(path: string): Promise<void> {
  if (await existing(path)) throw unavailable();
}
function ownedDirectory(stat: Stats, exact: boolean): boolean {
  return stat.isDirectory() && stat.uid === process.getuid?.() && (exact ? (stat.mode & 0o777) === 0o700 : (stat.mode & 0o022) === 0);
}
function sameSocket(stat: Stats, owner: Stats): boolean {
  return stat.isSocket() && stat.uid === owner.uid && stat.dev === owner.dev && stat.ino === owner.ino;
}
/** Exclusive hard-link publication leaves Node's automatic unlink tied to an unpublished name. */
export async function listenPrivateSocket(server: Server, stateDir: string): Promise<{path: string; cleanup(): Promise<void>}> {
  if (!isAbsolute(stateDir) || await realpath(stateDir) !== resolve(stateDir) || !ownedDirectory(await lstat(stateDir), false)) throw unavailable();
  const directory = join(stateDir, 'private'), path = join(directory, 'http.sock');
  assertControlPath(path);
  try {await mkdir(directory, {mode: 0o700});} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
  const directoryOwner = await lstat(directory);
  if (!ownedDirectory(directoryOwner, true)) throw unavailable();
  await absent(path);
  const unpublished = join(directory, `.${randomBytes(4).toString('hex')}`);
  assertControlPath(unpublished);
  await absent(unpublished);
  let owner: Stats | undefined;
  const cleanup = async () => {
    const currentDirectory = await existing(directory);
    if (!currentDirectory) return;
    if (!ownedDirectory(currentDirectory, true) || currentDirectory.dev !== directoryOwner.dev || currentDirectory.ino !== directoryOwner.ino) throw unavailable();
    if (!owner) return;
    const current = await existing(path);
    if (current && sameSocket(current, owner)) await unlink(path);
  };
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(unpublished, () => {server.off('error', reject); accept();});
    });
    owner = await lstat(unpublished);
    if (!owner.isSocket() || owner.uid !== process.getuid?.()) throw unavailable();
    await chmod(unpublished, 0o600);
    // link() refuses any existing destination rather than replacing another instance's path.
    await link(unpublished, path);
    await unlink(unpublished);
    return {path, cleanup};
  } catch (error) {
    if (server.listening) await new Promise<void>(accept => server.close(() => accept()));
    await cleanup();
    throw error;
  }
}
