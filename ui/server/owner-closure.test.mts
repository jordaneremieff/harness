import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {isBuiltin} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
function importReference(node:ts.ImportDeclaration):string|undefined {
  const clause=node.importClause;if(clause?.isTypeOnly)return;
  if(clause?.namedBindings&&ts.isNamedImports(clause.namedBindings)&&!clause.name&&clause.namedBindings.elements.every(element=>element.isTypeOnly))return;
  assert.ok(ts.isStringLiteral(node.moduleSpecifier));return node.moduleSpecifier.text;
}
function exportReference(node:ts.ExportDeclaration):string|undefined {
  if(node.isTypeOnly||!node.moduleSpecifier)return;
  if(node.exportClause&&ts.isNamedExports(node.exportClause)&&node.exportClause.elements.every(element=>element.isTypeOnly))return;
  assert.ok(ts.isStringLiteral(node.moduleSpecifier));return node.moduleSpecifier.text;
}
function callReference(node:ts.CallExpression):string|undefined {
  if(node.expression.kind!==ts.SyntaxKind.ImportKeyword)return;
  const argument=node.arguments[0];assert.equal(node.arguments.length,1);assert.ok(argument&&ts.isStringLiteral(argument));return argument.text;
}
function workerReference(node:ts.NewExpression):string|undefined {
  if(!ts.isIdentifier(node.expression)||node.expression.text!=='Worker')return;
  const target=node.arguments?.[0];assert.ok(target&&ts.isNewExpression(target));assert.ok(ts.isIdentifier(target.expression)&&target.expression.text==='URL');
  const argument=target.arguments?.[0];assert.ok(argument&&ts.isStringLiteral(argument),'Owner workers require a literal local module.');return argument.text;
}
function reference(node:ts.Node):string|undefined {
  if(ts.isImportDeclaration(node))return importReference(node);
  if(ts.isExportDeclaration(node))return exportReference(node);
  if(ts.isCallExpression(node))return callReference(node);
  if(ts.isNewExpression(node))return workerReference(node);
}
test('the persistent launcher and supervisor have a Node-builtins-only runtime import closure',async()=> {
  const queue=[new URL('./main.mts',import.meta.url)],seen=new Set<string>();
  while(queue.length){
    const url=queue.shift();assert.ok(url);if(seen.has(url.href))continue;seen.add(url.href);assert.ok(seen.size<=32,'Owner import closure exceeds its source bound.');
    const source=await readFile(url,'utf8');assert.ok(Buffer.byteLength(source)<=256*1024);const ast=ts.createSourceFile(fileURLToPath(url),source,ts.ScriptTarget.Latest,true),specifiers:string[]=[];
    const visit=(node:ts.Node)=>{const specifier=reference(node);if(specifier)specifiers.push(specifier);ts.forEachChild(node,visit);};visit(ast);
    for(const specifier of specifiers){if(isBuiltin(specifier))continue;assert.match(specifier,/^\.{1,2}\//,`${fileURLToPath(url)} imports a package at runtime: ${specifier}`);assert.match(specifier,/\.(?:mts|ts)$/);queue.push(new URL(specifier,url));}
  }
  assert.ok(seen.has(new URL('./primary-owner.mts',import.meta.url).href));assert.ok(!seen.has(new URL('./backend.mts',import.meta.url).href));
});
