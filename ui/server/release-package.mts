import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {boundedFile, RELEASE_LIMITS, sha256, type InventoryEntry} from './release-store.mts';

export const RELEASE_CODE_ROOT = 'ui/package';
const staticAssets = new Set(['ui/web/index.html', 'ui/web/style.css', 'ui/web/favicon.svg']);

/** Browser paths remain stable for retained backends; executable source has one package root. */
export function packagedSourcePath(path: string): string {
  if (path.startsWith('ui/dist/') || staticAssets.has(path)) return path;
  if (path === 'ui/server/main.mts') return `${RELEASE_CODE_ROOT}/ui/server/main-implementation.mts`;
  if (path === 'ui/server/backend.mts') return `${RELEASE_CODE_ROOT}/ui/server/backend-implementation.mts`;
  return `${RELEASE_CODE_ROOT}/${path}`;
}

function mainDriver(implementation: string, outer: string): string {
  return `import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {main as implementationMain} from '${implementation}';
export * from '${implementation}';
const releaseDirectory=fileURLToPath(new URL('${outer}',import.meta.url));
export function main(args=process.argv.slice(2),observation:Parameters<typeof implementationMain>[1]={}) {
  return implementationMain(args,{...observation,releaseDirectory});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().then(code=>{process.exitCode=code;},error=>{process.stderr.write(\`\${error instanceof Error?error.message:'The UI did not start.'}\\n\`);process.exitCode=1;});
`;
}
function backendDriver(implementation: string, outer: string): string {
  return `import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {cli as implementationCli} from '${implementation}';
export * from '${implementation}';
const releaseDirectory=fileURLToPath(new URL('${outer}',import.meta.url));
export function cli() {return implementationCli(releaseDirectory);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void cli().catch(()=>{process.stderr.write('The backend failed to start.\\n');process.exitCode=1;});
`;
}

/** Both the supervisor and independent runtime use the same implementation and outer manifest. */
export function packageEntryDrivers(): ReadonlyMap<string, string> {
  return new Map([
    ['ui/server/main.mts', mainDriver('../package/ui/server/main-implementation.mts', '../../')],
    [`${RELEASE_CODE_ROOT}/ui/server/main.mts`, mainDriver('./main-implementation.mts', '../../../../')],
    ['ui/server/backend.mts', backendDriver('../package/ui/server/backend-implementation.mts', '../../')],
    [`${RELEASE_CODE_ROOT}/ui/server/backend.mts`, backendDriver('./backend-implementation.mts', '../../../../')],
  ]);
}

/** Copy the captured bytes, including notices, once and hash every generated or copied file. */
export async function copyReleaseSource(source: string, directory: string, inputs: Map<string, InventoryEntry[]>) {
  const files: Record<string, string> = {};
  const emit = async (path: string, bytes: Uint8Array | string, executable = false) => {
    if (Object.hasOwn(files, path)) throw new Error('Duplicate release package path.');
    await mkdir(dirname(join(directory, path)), {recursive: true, mode: 0o700});
    await writeFile(join(directory, path), bytes, {flag: 'wx', mode: executable ? 0o700 : 0o600});
    files[path] = sha256(bytes);
  };
  for (const [name, entries] of inputs) for (const entry of entries) {
    if (entry.directory || entry.path.endsWith('.test.mts') || entry.path.endsWith('.test.ts')) continue;
    const path = `${name}/${entry.path}`, bytes = await boundedFile(join(source, path), RELEASE_LIMITS.fileBytes);
    if (bytes.length !== entry.bytes) throw new Error('The source changed after its staging reservation.');
    await emit(packagedSourcePath(path), bytes, entry.executable);
  }
  for (const path of ['package.json', 'LICENSE']) {
    await emit(packagedSourcePath(path), await boundedFile(join(source, path), 128 * 1024));
  }
  for (const path of ['ui/server/main.mts', 'ui/server/backend.mts']) {
    if (!Object.hasOwn(files, packagedSourcePath(path))) throw new Error('The release package lacks an implementation entrypoint.');
  }
  for (const [path, bytes] of packageEntryDrivers()) await emit(path, bytes);
  return files;
}
