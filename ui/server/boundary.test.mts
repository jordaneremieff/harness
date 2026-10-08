import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ui = path.join(root, 'ui');
type Edge = {specifier: string; typeOnly: boolean};
type Analysis = {edges: Edge[]; errors: string[]};
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
function analyze(source: string, filename: string): Analysis {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const edges: Edge[] = []; const errors: string[] = [];
  const loaders = new Set(['require']); const resolvers = new Set(['createRequire']);
  const add = (node: ts.Node | undefined, typeOnly = false) => {
    const specifier = literal(node);
    if (specifier === undefined) errors.push('computed loader'); else edges.push({specifier, typeOnly});
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
    if (['eval', 'Function', 'runInThisContext', 'runInNewContext', 'compileFunction'].includes(name)) errors.push('code loader');
    if (['setTimeout', 'setInterval'].includes(name) && literal(args[0]) !== undefined) errors.push('code loader');
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
function target(filename: string, specifier: string, files: Map<string, string>) {
  const base = path.resolve(path.dirname(filename), specifier);
  const source = base.replace(`${path.join(ui, 'dist')}${path.sep}`, `${ui}${path.sep}`);
  return [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), source.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.mts`, path.join(base, 'index.ts')].find(p => files.has(p));
}
function checkEdge(filename: string, edge: Edge, files: Map<string, string>, runtime: Set<string>, dev: Set<string>): string | undefined {
  const specifier = edge.specifier;
  if (path.isAbsolute(specifier) || path.win32.isAbsolute(specifier) || specifier.includes('\\') || /^(?:file|data|https?):/.test(specifier)) return `absolute loader: ${specifier}`;
  if (specifier.startsWith('.')) {
    const resolved = path.resolve(path.dirname(filename), specifier);
    if (!resolved.startsWith(`${ui}${path.sep}`)) return `harness escape: ${specifier}`;
    return target(filename, specifier, files) ? undefined : `missing local source: ${specifier}`;
  }
  if (isBuiltin(specifier)) return;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] ?? '';
  if (runtime.has(name)) return;
  if ((filename.endsWith('.test.mts') || edge.typeOnly) && dev.has(name)) return;
  return `${dev.has(name) ? 'dev-only runtime' : 'undeclared'} dependency: ${name}`;
}
function browserSource(filename: string) {
  return ['web', 'shared'].includes(path.relative(ui, filename).split(path.sep)[0] ?? '');
}
function check(files: Map<string, string>, runtime: Set<string>, dev: Set<string>) {
  const errors: string[] = []; const parsed = new Map<string, Analysis>();
  for (const [filename, source] of files) {
    const info = analyze(source, filename); parsed.set(filename, info);
    errors.push(...info.errors.map(e => `${path.relative(root, filename)}: ${e}`));
    for (const edge of info.edges) {
      const error = checkEdge(filename, edge, files, runtime, dev); if (error) errors.push(error);
    }
  }
  const seen = new Set<string>();
  const browser = (filename: string) => {
    if (seen.has(filename)) return; seen.add(filename);
    for (const edge of parsed.get(filename)?.edges ?? []) {
      const local = target(filename, edge.specifier, files);
      if (!edge.specifier.startsWith('.')) errors.push(`browser platform/package: ${edge.specifier}`);
      if (local) {
        if (!browserSource(local)) errors.push(`browser server graph: ${path.relative(ui, local)}`);
        browser(local);
      }
    }
  };
  for (const filename of files.keys()) if (filename.startsWith(`${path.join(ui, 'web')}${path.sep}`) && !filename.endsWith('.test.mts')) browser(filename);
  return errors;
}
async function sources() {
  const files = new Map<string, string>(); let visits = 0; let bytes = 0;
  async function walk(directory: string, depth = 0) {
    assert.ok(depth < 8, 'source depth bound');
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      assert.ok(++visits <= 256, 'source visit bound');
      if (entry.name.startsWith('.') || ['dist', 'node_modules'].includes(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'source tree contains no links');
      if (entry.isDirectory()) await walk(filename, depth + 1);
      else if (/\.(?:[cm]?ts|[cm]?js)$/.test(entry.name)) {
        const content = await readFile(filename, 'utf8'); bytes += Buffer.byteLength(content);
        assert.ok(bytes <= 4 * 1024 * 1024, 'source byte bound'); files.set(filename, content);
      }
    }
  }
  await walk(ui); return files;
}

test('UI loaders remain local or declared; browser graph has no Node/server code', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const runtime = new Set<string>(Object.keys({...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies}));
  const dev = new Set<string>(Object.keys(manifest.devDependencies ?? {}));
  assert.ok(dev.has('typescript')); assert.ok(!runtime.has('typescript'));
  assert.deepEqual(check(await sources(), runtime, dev), []);
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
    const files = new Map([[filename, `import ${JSON.stringify(specifier)};`]]);
    assert.ok(check(files, new Set(), new Set(['typescript'])).length, specifier);
  }
});

test('browser checks traverse shared modules into Node and server dependencies', () => {
  const files = new Map([
    [path.join(ui, 'web', 'fixture.ts'), "import '../shared/bridge.js';"],
    [path.join(ui, 'shared', 'bridge.ts'), "export * from '../server/fixture.mts';"],
    [path.join(ui, 'server', 'fixture.mts'), "import 'node:fs';"],
  ]);
  const errors = check(files, new Set(), new Set());
  assert.ok(errors.some(e => e.includes('browser server graph')));
  assert.ok(errors.some(e => e.includes('browser platform/package: node:fs')));
});
