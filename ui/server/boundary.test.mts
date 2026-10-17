import assert from 'node:assert/strict';
import { mkdtemp, open, opendir, readFile, rm, writeFile } from 'node:fs/promises';
import {constants} from 'node:fs';
import { tmpdir } from 'node:os';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {LocalBoundary, securityHeaders} from './boundary.mts';
import {ApiError} from './errors.mts';

const origin = 'http://127.0.0.1:43123';
function boundaryRequest(method = 'GET', headers: IncomingMessage['headers'] = {}) {
  return {method, headers: {host: '127.0.0.1:43123', ...headers}} as IncomingMessage;
}
function boundary() {const value = new LocalBoundary(); value.setPort(43123); return value;}
function boundaryRejected(error: unknown) {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'origin_rejected'); assert.equal(error.status, 403); return true;
}

test('only the exact host and port are trusted, never forwarded headers', () => {
  const value = boundary(); value.validate(boundaryRequest());
  for (const host of [undefined, 'localhost:43123', '127.0.0.1', '127.0.0.1:43124', '127.0.0.1:43123.', '[::1]:43123', '127.0.0.1:43123,evil.invalid']) {
    assert.throws(() => value.validate(boundaryRequest('GET', {host, 'x-forwarded-host': '127.0.0.1:43123', forwarded: 'host=127.0.0.1:43123'})), boundaryRejected);
  }
});
test('each mutation requires exact Origin and safe reads reject a supplied foreign Origin', () => {
  const value = boundary();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    value.validate(boundaryRequest(method, {origin}));
    for (const wrong of [undefined, 'null', 'http://localhost:43123', `${origin}/`, 'https://127.0.0.1:43123', 'http://127.0.0.1:43124']) {
      assert.throws(() => value.validate(boundaryRequest(method, {origin: wrong})), boundaryRejected);
    }
  }
  for (const method of ['GET', 'HEAD']) {
    value.validate(boundaryRequest(method)); value.validate(boundaryRequest(method, {origin}));
    assert.throws(() => value.validate(boundaryRequest(method, {origin: 'http://evil.invalid'})), boundaryRejected);
  }
});
test('fetch metadata permits only same-origin, none, or absent', () => {
  const value = boundary();
  for (const site of [undefined, 'same-origin', 'none']) value.validate(boundaryRequest('POST', {origin, 'sec-fetch-site': site}));
  for (const site of ['same-site', 'cross-site', 'Same-Origin']) {
    assert.throws(() => value.validate(boundaryRequest('GET', {'sec-fetch-site': site})), boundaryRejected);
  }
});
test('security headers prohibit inline/eval content, framing, caching, and referrer leakage', () => {
  const headers = new Map<string, string>();
  securityHeaders({setHeader(name: string, value: string) {headers.set(name, value);}} as unknown as ServerResponse);
  assert.equal(headers.get('Content-Security-Policy'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('Referrer-Policy'), 'no-referrer'); assert.equal(headers.get('Cache-Control'), 'no-store');
});

const root = fileURLToPath(new URL('../../', import.meta.url));
const ui = path.join(root, 'ui');
const transport = path.join(root, 'transport');
const publicTransport = path.join(transport, 'index.ts');
type Edge = {specifier: string; typeOnly: boolean};
type Analysis = {edges: Edge[]; errors: string[]};
const inventoryBudget = 5 * 1024 * 1024;
function literal(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}
function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return unwrap(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) return unwrap(node.right);
  return node;
}
function member(expression: ts.Expression): string | undefined {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return literal(node.argumentExpression);
  return undefined;
}
function typeImport(node: ts.ImportDeclaration) {
  if (node.importClause?.isTypeOnly) return true;
  const bindings = node.importClause?.namedBindings;
  return !!(bindings && ts.isNamedImports(bindings) && bindings.elements.length && bindings.elements.every(e => e.isTypeOnly));
}
function isLoader(expression: ts.Expression, tree: ts.SourceFile, loaders: Set<string>) {
  const node = unwrap(expression); const name = member(node);
  if (node.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(node)) return loaders.has(node.text);
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const object = node.expression.getText(tree);
  if (name === 'require') return ['module', 'globalThis', 'window'].includes(object);
  return name === 'resolve' && (object === 'import.meta' || loaders.has(object));
}
function workerPath(node: ts.Expression | undefined, tree: ts.SourceFile) {
  if (node && ts.isNewExpression(node) && member(node.expression) === 'URL' && node.arguments?.[1]?.getText(tree) === 'import.meta.url') return node.arguments[0];
  return node;
}
function resolverAliases(node: ts.Node, resolvers: Set<string>) {
  if (!ts.isImportDeclaration(node) || literal(node.moduleSpecifier) !== 'node:module') return;
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return;
  for (const item of bindings.elements) if ((item.propertyName?.text ?? item.name.text) === 'createRequire') resolvers.add(item.name.text);
}
function analyze(source: string, filename: string, maxBytes = inventoryBudget): Analysis {
  const edges: Edge[] = []; const errors: string[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({edges, errors}));
  assert.ok(bytes <= maxBytes, 'analysis byte bound');
  function retain<T>(values: T[], value: T): void {
    const added = Buffer.byteLength(JSON.stringify(value)) + (values.length ? 1 : 0);
    assert.ok(bytes + added <= maxBytes, 'analysis byte bound'); bytes += added; values.push(value);
  }
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const loaders = new Set(['require']); const resolvers = new Set(['createRequire']);
  const add = (node: ts.Node | undefined, typeOnly = false) => {
    const specifier = literal(node);
    if (specifier === undefined) retain(errors, 'computed loader'); else retain(edges, {specifier, typeOnly});
  };
  const aliases = (node: ts.Node) => {
    resolverAliases(node, resolvers);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isIdentifier(node.initializer) && loaders.has(node.initializer.text)) loaders.add(node.name.text);
      if (ts.isCallExpression(node.initializer) && resolvers.has(member(node.initializer.expression) ?? '')) loaders.add(node.name.text);
    }
    ts.forEachChild(node, aliases);
  };
  aliases(tree);
  const call = (node: ts.CallExpression | ts.NewExpression) => {
    const name = member(node.expression) ?? ''; const args = node.arguments ?? [];
    if (isLoader(node.expression, tree, loaders)) add(args[0]);
    if (['eval', 'Function', 'runInThisContext', 'runInNewContext', 'compileFunction'].includes(name)) retain(errors, 'code loader');
    if (['setTimeout', 'setInterval'].includes(name) && literal(args[0]) !== undefined) retain(errors, 'code loader');
    if (name === 'Worker') add(workerPath(args[0], tree));
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, typeImport(node));
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, node.isTypeOnly);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node.isTypeOnly);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) call(node);
    ts.forEachChild(node, visit);
  };
  visit(tree); return {edges, errors};
}
function target(filename: string, specifier: string, files: ReadonlyMap<string, Analysis>) {
  const base = path.resolve(path.dirname(filename), specifier);
  const source = base.replace(`${path.join(ui, 'dist')}${path.sep}`, `${ui}${path.sep}`);
  return [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), source.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.mts`, path.join(base, 'index.ts')].find(p => files.has(p));
}
function checkLocal(filename: string, specifier: string, files: ReadonlyMap<string, Analysis>): string | undefined {
  const resolved = path.resolve(path.dirname(filename), specifier);
  if (filename.startsWith(`${transport}${path.sep}`)) {
    if (!resolved.startsWith(`${transport}${path.sep}`)) return `transport escape: ${specifier}`;
  } else if (!resolved.startsWith(`${ui}${path.sep}`)) {
    const publicAgentTransport = filename.startsWith(`${path.join(ui, 'agents')}${path.sep}`) && specifier === '../../transport/index.ts' && resolved === publicTransport;
    if (!publicAgentTransport) return `harness escape: ${specifier}`;
  }
  return target(filename, specifier, files) ? undefined : `missing local source: ${specifier}`;
}
function checkEdge(filename: string, edge: Edge, files: ReadonlyMap<string, Analysis>, runtime: Set<string>, dev: Set<string>): string | undefined {
  const specifier = edge.specifier;
  if (path.isAbsolute(specifier) || path.win32.isAbsolute(specifier) || specifier.includes('\\') || /^(?:file|data|https?):/.test(specifier)) return `absolute loader: ${specifier}`;
  if (specifier.startsWith('.')) return checkLocal(filename, specifier, files);
  if (isBuiltin(specifier)) return;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] ?? '';
  if (runtime.has(name)) return;
  if ((filename.endsWith('.test.mts') || edge.typeOnly) && dev.has(name)) return;
  return `${dev.has(name) ? 'dev-only runtime' : 'undeclared'} dependency: ${name}`;
}
function browserSource(filename: string) {
  return ['web', 'shared'].includes(path.relative(ui, filename).split(path.sep)[0] ?? '');
}
function check(files: ReadonlyMap<string, Analysis>, runtime: Set<string>, dev: Set<string>) {
  const errors: string[] = [];
  for (const [filename, info] of files) {
    errors.push(...info.errors.map(e => `${path.relative(root, filename)}: ${e}`));
    for (const edge of info.edges) {
      const error = checkEdge(filename, edge, files, runtime, dev); if (error) errors.push(error);
    }
  }
  const seen = new Set<string>();
  const browser = (filename: string) => {
    if (seen.has(filename)) return; seen.add(filename);
    for (const edge of files.get(filename)?.edges ?? []) {
      const local = target(filename, edge.specifier, files);
      if (!edge.specifier.startsWith('.')) errors.push(`browser platform/package: ${edge.specifier}`);
      if (local) {
        if (!browserSource(local)) errors.push(`browser server graph: ${path.relative(ui, local)}`);
        browser(local);
      }
    }
  };
  for (const filename of files.keys()) if (filename.startsWith(`${path.join(ui, 'web')}${path.sep}`) && filename.endsWith('.ts') && !filename.endsWith('.test.ts')) browser(filename);
  return errors;
}
async function sources(directories = [ui, transport], maxVisits = 512, maxBytes = inventoryBudget) {
  const filenames = new Set<string>(), files = new Map<string, Analysis>(); let visits = 0, bytes = 0, retainedBytes = 0, peakBytes = 0;
  // Logical bytes cover filenames, one live UTF-8 source and serialized Analysis, not parser heap or RSS.
  const admit = (filename: string) => {
    if (filenames.has(filename)) return;
    const added = Buffer.byteLength(filename); assert.ok(retainedBytes + added <= maxBytes, 'source filename byte bound');
    filenames.add(filename); retainedBytes += added;
  };
  async function walk(directory: string, depth = 0) {
    assert.ok(depth < 8, 'source depth bound');
    for await (const entry of await opendir(directory)) {
      assert.ok(++visits <= maxVisits, 'source visit bound');
      if (entry.name.startsWith('.') || ['dist', 'node_modules'].includes(entry.name) || directory.startsWith(transport) && entry.name.endsWith('.test.mts')) continue;
      const filename = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'source tree contains no links');
      if (entry.isDirectory()) await walk(filename, depth + 1);
      else if (/\.(?:[cm]?ts|[cm]?js)$/.test(entry.name)) admit(filename);
    }
  }
  async function readAnalysis(filename: string) {
    const available = maxBytes - retainedBytes, file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const {size} = await file.stat(); assert.ok(size <= available, 'source byte bound');
      const buffer = Buffer.alloc(size); let offset = 0;
      while (offset < size) {
        const {bytesRead} = await file.read(buffer, offset, size - offset, null);
        assert.ok(bytesRead > 0, 'source changed during inventory'); offset += bytesRead;
      }
      // Probe EOF so growth cannot turn a bounded read into silently incomplete coverage.
      const {bytesRead} = await file.read(Buffer.alloc(1), 0, 1, null);
      assert.equal(bytesRead, 0, 'source changed during inventory');
      const source = buffer.toString('utf8'), sourceBytes = Buffer.byteLength(source);
      assert.ok(sourceBytes <= available, 'source byte bound');
      const info = analyze(source, filename, available - sourceBytes);
      return {info, sourceBytes, analysisBytes: Buffer.byteLength(JSON.stringify(info))};
    } finally {await file.close();}
  }
  for (const directory of directories) await walk(directory);
  for (const filename of [...filenames].sort()) {
    const value = await readAnalysis(filename); files.set(filename, value.info);
    peakBytes = Math.max(peakBytes, retainedBytes + value.sourceBytes + value.analysisBytes);
    bytes += value.sourceBytes; retainedBytes += value.analysisBytes;
  }
  return {files, visits, bytes, retainedBytes, peakBytes};
}

test('UI loaders remain local or declared; browser graph has no Node/server code', async t => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const runtime = new Set<string>(Object.keys({...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies}));
  const dev = new Set<string>(Object.keys(manifest.devDependencies ?? {}));
  assert.ok(dev.has('typescript')); assert.ok(!runtime.has('typescript'));
  const inventory = await sources();
  t.diagnostic(`Source inventory: ${inventory.visits} visits, ${inventory.files.size} files, ${inventory.bytes} cumulative source bytes, ${inventory.retainedBytes} retained / ${inventory.peakBytes} peak logical bytes`);
  assert.deepEqual(check(inventory.files, runtime, dev), []);
});

test('source inventory rejects visit exhaustion and checks every admitted source', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ui-source-bound-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const name of ['one.mts', 'two.mts', 'three.mts']) await writeFile(path.join(directory, name), "import 'undeclared';");
  await assert.rejects(sources([directory], 2), {message: 'source visit bound'});
  const inventory = await sources([directory], 3);
  assert.equal(inventory.visits, 3); assert.equal(inventory.files.size, 3);
  assert.deepEqual(check(inventory.files, new Set(), new Set()), Array(3).fill('undeclared dependency: undeclared'));
});

test('incremental inventory checks every source beyond its live byte budget, including a late violation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ui-source-incremental-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const padding = `/*${'x'.repeat(1150)}*/`, source = `${padding}import 'node:fs';`, late = "import 'late-undeclared';", budget = 2048;
  for (const name of ['a.mts', 'b.mts', 'c.mts']) await writeFile(path.join(directory, name), source);
  await writeFile(path.join(directory, 'z.mts'), late);
  const inventory = await sources([directory], 4, budget);
  assert.equal(inventory.files.size, 4); assert.equal(inventory.bytes, 3 * Buffer.byteLength(source) + Buffer.byteLength(late));
  assert.ok(inventory.bytes > budget); assert.ok(inventory.retainedBytes <= budget); assert.ok(inventory.peakBytes <= budget);
  for (const name of ['a.mts', 'b.mts', 'c.mts']) assert.deepEqual(inventory.files.get(path.join(directory, name)), {edges: [{specifier: 'node:fs', typeOnly: false}], errors: []});
  assert.deepEqual(check(inventory.files, new Set(), new Set()), ['undeclared dependency: late-undeclared']);
});
test('incremental source release preserves complete cross-file browser graph resolution', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ui-source-graph-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const padding = `/*${'x'.repeat(1150)}*/`, budget = 2048;
  await writeFile(path.join(directory, 'entry.ts'), `${padding}import './m-bridge.mts';`);
  await writeFile(path.join(directory, 'm-bridge.mts'), `${padding}import '../server/z-server.mts';`);
  await writeFile(path.join(directory, 'z-server.mts'), `${padding}import 'node:fs';`);
  const inventory = await sources([directory], 3, budget);
  assert.ok(inventory.bytes > budget); assert.equal(inventory.files.size, 3);
  const files = new Map([...inventory.files].map(([filename, info]) => [path.join(ui, filename.endsWith('z-server.mts') ? 'server' : 'web', path.basename(filename)), info]));
  assert.deepEqual(check(files, new Set(), new Set()), ['browser server graph: server/z-server.mts', 'browser platform/package: node:fs']);
});
test('inventory refuses a single source before reading beyond its available logical budget', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ui-source-oversize-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const filename = path.join(directory, 'source.ts'); await writeFile(filename, ' '.repeat(512));
  await assert.rejects(sources([directory], 1, Buffer.byteLength(filename) + 511), {message: 'source byte bound'});
});
test('inventory refuses analysis that cannot coexist with its live source and retained filenames', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ui-analysis-oversize-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const filename = path.join(directory, 'source.ts'), source = "import 'node:fs';";
  await writeFile(filename, source);
  const emptyBytes = Buffer.byteLength(JSON.stringify({edges: [], errors: []}));
  await assert.rejects(sources([directory], 1, Buffer.byteLength(filename) + Buffer.byteLength(source) + emptyBytes), {message: 'analysis byte bound'});
});
test('retained analyses share one budget across the complete inventory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ui-analysis-retained-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const source = "import 'node:fs';", names = ['a.mts', 'b.mts', 'c.mts'].map(name => path.join(directory, name));
  for (const filename of names) await writeFile(filename, source);
  const recordBytes = Buffer.byteLength(JSON.stringify({edges: [{specifier: 'node:fs', typeOnly: false}], errors: []}));
  const budget = names.reduce((sum, name) => sum + Buffer.byteLength(name), 0) + Buffer.byteLength(source) + 3 * recordBytes - 1;
  await assert.rejects(sources([directory], 3, budget), {message: 'analysis byte bound'});
});
test('compiler inspection sees literal imports, exports, require, dynamic imports, and import types', () => {
  const info = analyze("import x from './one.mts'; export * from './two.mts'; require('./three.mts'); import(`./four.mts`); import x = require('./five.mts'); type T = import('./six.mts').T;", 'fixture.mts');
  assert.deepEqual(info.errors, []);
  assert.deepEqual(info.edges.map(e => e.specifier), ['./one.mts', './two.mts', './three.mts', './four.mts', './five.mts', './six.mts']);
});

test('computed, aliased, indirect code loaders and worker escapes demand review', () => {
  for (const source of ["import(name)", "(require)(name)", "(0, eval)(code)", "require('./' + name)", "const load = require; load(name)", "module['require'](name)", "import {createRequire as cr} from 'node:module'; const load = cr(import.meta.url); load(name)", "globalThis['eval'](code)", "new Function(code)", "import.meta.resolve(name)", "new Worker(name)"]) {
    assert.ok(analyze(source, 'fixture.mts').errors.length, source);
  }
  assert.deepEqual(analyze("const text = 'require(name)'; // import(name)\nthis.require(['task-submit']);", 'fixture.mts').errors, []);
});

test('boundary rejects absolute paths, harness source escapes, and undeclared/dev runtime packages', () => {
  const filename = path.join(ui, 'server', 'fixture.mts');
  for (const specifier of ['../../extensions/agent/index.ts', '../../scripts/check-slices.mts', '../../evals/cli.mts', '../../README.md', '/outside/module.mts', 'C:\\outside\\module.ts', 'file:///outside/module.mts', 'undeclared', 'typescript']) {
    const files = new Map([[filename, analyze(`import ${JSON.stringify(specifier)};`, filename)]]);
    assert.ok(check(files, new Set(), new Set(['typescript'])).length, specifier);
  }
});

test('only the named public transport entrypoint crosses the agent UI boundary', () => {
  const agent = path.join(ui, 'agents', 'fixture.mts');
  const internal = path.join(transport, 'endpoint.ts');
  const files = new Map([[agent, analyze("import '../../transport/index.ts';", agent)],
    [publicTransport, analyze("export * from './endpoint.ts';", publicTransport)], [internal, analyze("import '@earendil-works/chord'; import 'typebox';", internal)]]);
  const runtime = new Set(['@earendil-works/chord', 'typebox']);
  assert.deepEqual(check(files, runtime, new Set()), []);
  for (const specifier of ['../../transport/endpoint.ts', '../../transport/unix-link.ts', '../../transport', '../../transport/./index.ts']) {
    files.set(agent, analyze(`import ${JSON.stringify(specifier)};`, agent));
    assert.ok(check(files, runtime, new Set()).some(error => error.includes('harness escape')), specifier);
  }
  files.set(agent, analyze("import '../../transport/index.ts';", agent));
  files.set(internal, analyze("import 'typescript';", internal));
  assert.ok(check(files, runtime, new Set(['typescript'])).includes('dev-only runtime dependency: typescript'));
  files.set(internal, analyze("import '../extensions/agent/index.ts';", internal));
  assert.ok(check(files, runtime, new Set()).some(error => error.includes('transport escape')));
  const browser = path.join(ui, 'web', 'fixture.ts'); files.set(browser, analyze("import '../../transport/index.ts';", browser));
  assert.ok(check(files, runtime, new Set()).some(error => error.includes('browser server graph')));
});

test('unshipped browser test support is not an entrypoint but runtime imports still traverse it', () => {
  const app = path.join(ui, 'web', 'app.ts'), fixture = path.join(ui, 'web', 'app-fixture.mts'), server = path.join(ui, 'server', 'fixture.mts');
  const files = new Map([[app, analyze('export {};', app)], [fixture, analyze("import 'node:test'; import '../server/fixture.mts';", fixture)], [server, analyze("import 'node:fs';", server)]]);
  assert.deepEqual(check(files, new Set(), new Set()), []);
  files.set(app, analyze("import './app-fixture.mts';", app));
  const errors = check(files, new Set(), new Set());
  assert.ok(errors.some(error => error.includes('browser platform/package: node:test')));
  assert.ok(errors.some(error => error.includes('browser server graph: server/fixture.mts')));
});

test('browser checks traverse shared modules into Node and server dependencies', () => {
  const browser = path.join(ui, 'web', 'fixture.ts'), shared = path.join(ui, 'shared', 'bridge.ts'), server = path.join(ui, 'server', 'fixture.mts');
  const files = new Map([
    [browser, analyze("import '../shared/bridge.js';", browser)],
    [shared, analyze("export * from '../server/fixture.mts';", shared)],
    [server, analyze("import 'node:fs';", server)],
  ]);
  const errors = check(files, new Set(), new Set());
  assert.ok(errors.some(e => e.includes('browser server graph')));
  assert.ok(errors.some(e => e.includes('browser platform/package: node:fs')));
});
