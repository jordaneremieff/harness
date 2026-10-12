import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureInputs, compileBrowser, confirmedBuild, sameInputs, needsRestart, type InputSnapshot } from './development-build.mts';
import { parseArgs } from './main.mts';

const snapshot=(app="import '../shared/api.ts'; export const value=1;"):InputSnapshot=>new Map([
  ['web/tsconfig.json',Buffer.from(JSON.stringify({compilerOptions:{target:'ES2023',module:'ES2022',moduleResolution:'Bundler',lib:['ES2023','DOM'],types:[],strict:true,skipLibCheck:true,rootDir:'..',outDir:'../dist',rewriteRelativeImportExtensions:true},include:['./*.ts','../shared/api.ts']}))],
  ['web/app.ts',Buffer.from(app)],['shared/api.ts',Buffer.from('export {};')],
  ['web/index.html',Buffer.from('<html><head><link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg"></head><body><script src="/web/app.js" type="module"></script></body></html>')],
  ['web/style.css',Buffer.from('body { color: black; }')],['web/favicon.svg',Buffer.from('<svg/>')]
]);
const root=fileURLToPath(new URL('../',import.meta.url));

test('producer completion validates both input inventories and never treats a watch hint as completion',async()=> {
  const original=snapshot();const generation=await compileBrowser(root,original,async()=>{});let captures=0;
  const changed=snapshot('export const value=2;');
  await assert.rejects(()=>confirmedBuild({capture:async()=>++captures===1?original:changed,compile:async()=>generation}),/input-changed/);
  assert.equal(captures,2);assert.equal(sameInputs(original,changed),false);assert.equal(sameInputs(original,snapshot()),true);
  assert.equal((await confirmedBuild({capture:async()=>original,compile:async()=>generation})).id,generation.id);
});

test('the private compiler produces a complete in-memory generation without modifying dist',async()=> {
  const output=join(root,'dist/web/app.js');
  const readOutput=()=>readFile(output).catch(error=>{if(error.code==='ENOENT') return null;throw error;});
  const before=await readOutput(),inputs=snapshot(),captured=new Map([...inputs].map(([path,data])=>[path,Buffer.from(data)]));
  let checks=0;const generation=await compileBrowser(root,inputs,async css=>{checks++;assert.equal(css.toString(),'body { color: black; }');});
  assert.deepEqual(await readOutput(),before);assert.equal(sameInputs(inputs,captured),true);
  assert.ok(generation.asset('/web/app.js'));assert.ok(generation.asset('/shared/api.js'));assert.match(generation.asset('/')?.data.toString()??'',new RegExp(`/_ui/${generation.id}/web/app.js`));
  assert.equal(checks,1);assert.equal(Object.keys(generation.manifest).length,5);
});

test('real syntax failure and failed CSS validation refuse publication, then corrected source compiles',async()=> {
  await assert.rejects(()=>compileBrowser(root,snapshot('export const = ;'),async()=>{}),/compile/);
  await assert.rejects(()=>compileBrowser(root,snapshot(),async()=>{throw new Error('invalid-assets');}),/invalid-assets/);
  const fixed=await compileBrowser(root,snapshot(),async()=>{});assert.ok(fixed.asset('/web/app.js'));
});

test('static imports, exports and escaped literal dynamic imports retain exact local graph checks',async()=> {
  const app="import '../shared/api.ts'; export * from '../shared/api.ts'; export const load=()=>import(/* source */ '\\u002e\\u002e/shared/api.ts');";
  const generation=await compileBrowser(root,snapshot(app),async()=>{});assert.ok(generation.asset('/web/app.js'));
  for(const app of ["const path='../shared/api.ts'; export const load=()=>import(path);", "const path='../shared/api.ts'; export const load=()=>import /* gap */ (path);", "// @ts-ignore\nexport const load=()=>import('../shared/api.ts', {});"]) await assert.rejects(()=>compileBrowser(root,snapshot(app),async()=>{}),/invalid-assets/);
});

test('import text in comments, strings and regular expressions is not executable module syntax',async()=> {
  const app="// import(path)\nconst text='import(path)'; const pattern=/import(path)/; const custom={import(path:string){return path;}}; custom.import('not-a-module'); throw new Error('Modules must not execute'); export {text,pattern};";
  assert.ok((await compileBrowser(root,snapshot(app),async()=>{})).asset('/web/app.js'));
  await assert.rejects(()=>compileBrowser(root,snapshot("class Derived extends Object { constructor() { super(); const path='../shared/api.ts'; void import(path); } } export {Derived};"),async()=>{}),/invalid-assets/);
  await assert.rejects(()=>compileBrowser(root,snapshot(`const path='../shared/api.ts'; export const value=\`\${import(path)}\`;`),async()=>{}),/invalid-assets/);
});

test('private compilation refuses external sources and configuration escapes',async()=> {
  await assert.rejects(()=>compileBrowser(root,snapshot("export * from '../server/development-build.mts';"),async()=>{}),/compile/);
  for(const extra of [{extends:'../../outside.json'}, {compilerOptions:{outFile:'../../outside.js'}}, {compilerOptions:{paths:{'*':['../../*']}}}]) {
    const inputs=new Map(snapshot());inputs.set('web/tsconfig.json',Buffer.from(JSON.stringify(extra)));
    await assert.rejects(()=>compileBrowser(root,inputs,async()=>{}),/compile/);
  }
});

test('input byte and entry bounds reject the build before publication',async()=> {
  const oversized=new Map(snapshot());oversized.set('web/app.ts',Buffer.alloc(2*1024*1024+1));
  const total=new Map(snapshot());for(let index=0;index<9;index++)total.set(`server/source-${index}.mts`,Buffer.alloc(2*1024*1024));
  const entries=new Map(snapshot());for(let index=0;index<1281;index++)entries.set(`server/source-${index}.mts`,Buffer.alloc(0));
  for(const inputs of [oversized,total,entries]) await assert.rejects(()=>compileBrowser(root,inputs,async()=>{}),/capacity/);
});

test('the captured browser project compiles through the existing build executable',async()=> {
  const generation=await compileBrowser(root,await captureInputs(root),async()=>{});assert.ok(generation.asset('/web/app.js'));assert.ok(generation.asset('/shared/api.js'));
});

test('backend, worker and wire input changes declare restart while browser changes remain build inputs',()=> {
  const original=snapshot();assert.equal(needsRestart(original,snapshot('export const value=2;')),false);
  for(const path of ['server/http.mts','rpc/client.mts','agents/service-worker.mts','shared/api.ts']) {
    const changed=new Map(original);changed.set(path,Buffer.from('export const contract=2;'));assert.equal(needsRestart(original,changed),true);
  }
  const removed=new Map(original);removed.delete('shared/api.ts');assert.equal(needsRestart(original,removed),true);
});

test('input reconciliation ignores documentation and tests and stops at a directory visit cap',async context=> {
  const directory=await mkdtemp(join(tmpdir(),'build-inputs-'));context.after(()=>rm(directory,{recursive:true,force:true}));
  for(const name of ['web','shared','server','rpc','agents']) await mkdir(join(directory,name));
  await writeFile(join(directory,'web/app.ts'),'export {};');await writeFile(join(directory,'web/readme.md'),'one');await writeFile(join(directory,'web/app.test.mts'),'one');
  const before=await captureInputs(directory);assert.equal(before.size,1);await writeFile(join(directory,'web/readme.md'),'two');assert.equal(sameInputs(before,await captureInputs(directory)),true);
  for(let index=0;index<254;index++) await writeFile(join(directory,`web/ignored-${index}.md`),'');
  await assert.rejects(()=>captureInputs(directory),/capacity/);
});

test('development modes are explicit reversible options and normal startup flags remain unchanged',()=> {
  assert.deepEqual(parseArgs([],'/project'),{cwd:'/project',port:4318,pi:'pi',open:false});
  const selected=parseArgs(['--dev-reload','--dev-diagnostics','--port','0'],'/project');assert.equal(selected.devReload,true);assert.equal(selected.devDiagnostics,true);assert.equal(selected.port,0);
  assert.equal(parseArgs(['--dev-diagnostics'],'/project').devReload,undefined);assert.throws(()=>parseArgs(['--dev-reload','--unknown'],'/project'));
});
