import {readFile,readdir,stat} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';

const TSCONFIG = 'ui/web/tsconfig.json';
const INCLUDE_PATTERN = /^((?:\.{1,2}\/|[A-Za-z0-9_-]+\/)*)(\*|[A-Za-z0-9_.-]+)\.ts$/;
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+\.ts)['"]/g;
export const STALE_ASSETS_MESSAGE = 'Browser assets are not built from this source. Run npm run ui:build.';

type Config = {extends?: unknown; include?: unknown; compilerOptions?: {rootDir?: unknown; outDir?: unknown}};
const inside = (root: string, path: string) => relative(root, path).split(sep)[0] !== '..';
const exists = (path: string) => stat(path).then(info => info.isFile(), (error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return false; throw error;});

async function readConfig(root: string): Promise<{config: Config; directory: string}> {
  const config = JSON.parse(await readFile(join(root, TSCONFIG), 'utf8')) as Config;
  if (config.extends !== undefined) throw new Error(`${TSCONFIG} must not extend another configuration.`);
  if (!Array.isArray(config.include) || !config.include.length) throw new Error(`${TSCONFIG} must list its included sources.`);
  return {config, directory: dirname(join(root, TSCONFIG))};
}

function includePattern(root: string, directory: string, pattern: unknown): {folder: string; name: string} {
  const match = typeof pattern === 'string' ? INCLUDE_PATTERN.exec(pattern) : null;
  if (!match) throw new Error(`${TSCONFIG} include entry is not a directory-level .ts pattern.`);
  const folder = resolve(directory, match[1] ?? '');
  if (!inside(root, folder)) throw new Error(`${TSCONFIG} include entry leaves the checkout.`);
  return {folder, name: match[2] as string};
}

async function includedFiles(root: string, config: Config, directory: string): Promise<Set<string>> {
  const files = new Set<string>();
  for (const pattern of config.include as unknown[]) {
    const {folder, name} = includePattern(root, directory, pattern);
    if (name !== '*') {files.add(join(folder, `${name}.ts`)); continue;}
    for (const entry of await readdir(folder, {withFileTypes: true}))
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.add(join(folder, entry.name));
  }
  return files;
}

/** Adds each relative `.ts` module the files import, because the compiler emits them too. */
async function importClosure(root: string, files: Set<string>): Promise<void> {
  for (const file of files) {
    for (const [, specifier] of (await readFile(file, 'utf8')).matchAll(IMPORT_PATTERN)) {
      const target = resolve(dirname(file), specifier as string);
      if (inside(root, target) && !files.has(target) && await exists(target)) files.add(target);
    }
  }
}

/** Source files the browser compiler reads, relative to the checkout root, excluding the tsconfig itself. */
export async function browserSourceFiles(root: string): Promise<string[]> {
  const {config, directory} = await readConfig(root), files = await includedFiles(root, config, directory);
  await importClosure(root, files);
  return [...files].map(file => relative(root, file).split(sep).join('/')).sort();
}

function emittedPath(root: string, config: Config, directory: string, source: string): string {
  const {rootDir, outDir} = config.compilerOptions ?? {};
  if (typeof rootDir !== 'string' || typeof outDir !== 'string') throw new Error(`${TSCONFIG} must set rootDir and outDir.`);
  const base = resolve(directory, rootDir), relativePath = relative(base, join(root, source));
  if (relativePath.split(sep)[0] === '..') throw new Error(`${source} is outside the compiler root directory.`);
  return join(resolve(directory, outDir), relativePath.replace(/\.ts$/, '.js'));
}

/**
 * Refuses a checkout whose emitted browser modules are missing or older than the
 * source they come from. Each compiler input needs an emitted file at least as new
 * as the input and the browser tsconfig.
 */
export async function assertBrowserAssetsFresh(root: string): Promise<void> {
  const {config, directory} = await readConfig(root), configTime = (await stat(join(root, TSCONFIG))).mtimeMs;
  for (const source of await browserSourceFiles(root)) {
    const output = emittedPath(root, config, directory, source);
    let emitted: number;
    try {emitted = (await stat(output)).mtimeMs;}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(STALE_ASSETS_MESSAGE);
      throw error;
    }
    if ((await stat(join(root, source))).mtimeMs > emitted || configTime > emitted) throw new Error(STALE_ASSETS_MESSAGE);
  }
}
