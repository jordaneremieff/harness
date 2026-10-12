import { createHash } from 'node:crypto';
import { constants, watch, type FSWatcher } from 'node:fs';
import { open, opendir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { AssetGeneration, AssetGenerations, LatestBuild } from './asset-generations.mts';
import type { Asset } from './http.mts';

export type InputSnapshot=ReadonlyMap<string,Buffer>;
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const directories=['web','shared','server','rpc','agents'] as const;
/** Each reconciliation stops at fixed entry and byte bounds, independently of output size. */
export async function captureInputs(root:string):Promise<InputSnapshot> {
  const inputs=new Map<string,Buffer>();let bytes=0;let entries=0;
  for(const directory of directories) {
    const handle=await opendir(join(root,directory),{bufferSize:1});let visits=0;
    for await(const entry of handle) {
      if(++entries>1280||++visits>256) throw new Error('capacity');
      if(!inputName(directory,entry.name)) continue;
      const path=`${directory}/${entry.name}`;const data=await captureFile(join(root,path),16*1024*1024-bytes);
      bytes+=data.length;inputs.set(path,data);
    }
  }
  return inputs;
}
function inputName(directory:string,name:string) {
  if(name.endsWith('.test.mts')||name.endsWith('.test.ts')) return false;
  return /^[a-zA-Z0-9_-]+\.(?:ts|mts)$/.test(name)||(directory==='web'&&['index.html','style.css','favicon.svg','tsconfig.json'].includes(name));
}
async function captureFile(path:string,remaining:number) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>2*1024*1024) throw new Error('invalid-assets');
    const limit=Math.min(2*1024*1024,remaining);const data=Buffer.alloc(limit+1);let size=0;
    while(size<data.length) {const result=await file.read(data,size,data.length-size,null);if(!result.bytesRead) break;size+=result.bytesRead;}
    if(size>limit) throw new Error('capacity');return Buffer.from(data.subarray(0,size));
  } finally {await file.close();}
}
export function sameInputs(left:InputSnapshot,right:InputSnapshot) {return left.size===right.size && [...left].every(([path,data])=>right.has(path)&&hash(data)===hash(right.get(path) as Buffer));}
export function needsRestart(left:InputSnapshot,right:InputSnapshot) {
  const paths=new Set([...left.keys(),...right.keys()]);
  return [...paths].some(path=>!path.startsWith('web/') && (!left.has(path)||!right.has(path)||hash(left.get(path) as Buffer)!==hash(right.get(path) as Buffer)));
}
export type BuildProducer={capture():Promise<InputSnapshot>;compile(inputs:InputSnapshot):Promise<AssetGeneration>};
/** Completion includes a second bounded inventory, not a quiet-time assumption. */
export async function confirmedBuild(producer:BuildProducer) {
  const inputs=await producer.capture();const generation=await producer.compile(inputs);
  if(!sameInputs(inputs,await producer.capture())) throw new Error('input-changed');return generation;
}

/** The existing build executable emits only a private captured project, never ui/dist. */
export async function compileBrowser(root:string,inputs:InputSnapshot,cssCheck:(css:Buffer)=>Promise<void>) {
  const bundle=await emitInWorker(root,inputs);const css=inputs.get('web/style.css');if(!css) throw new Error('invalid-assets');await cssCheck(css);
  const assets=new Map([...bundle.assets].map(([route,asset])=>[route,{type:asset.type,data:Buffer.from(asset.data)}]));
  return new AssetGeneration(assets,bundle.imports);
}
const compilerOptions=new Set(['target','module','moduleResolution','lib','types','strict','noUncheckedIndexedAccess','skipLibCheck','rewriteRelativeImportExtensions','erasableSyntaxOnly','rootDir','outDir','verbatimModuleSyntax']);
function privateConfig(inputs:InputSnapshot,names:string[]) {
  const text=inputs.get('web/tsconfig.json');if(!text) throw new Error('invalid-assets');
  let config:Record<string,unknown>;
  try {config=JSON.parse(text.toString('utf8'));} catch {throw new Error('compile');}
  if(!config||Array.isArray(config)||typeof config!=='object'||Object.keys(config).some(key=>!['compilerOptions','include','exclude'].includes(key))) throw new Error('compile');
  const options=config.compilerOptions;
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!compilerOptions.has(key))) throw new Error('compile');
  return JSON.stringify({compilerOptions:{...options,rootDir:'..',outDir:'../dist',types:[],typeRoots:[],noResolve:true,noEmitOnError:true},files:names.map(name=>`../${name}`)});
}
async function runCompiler(root:string,project:string) {
  await new Promise<void>((resolve,reject)=> {
    const child=spawn(process.execPath,[join(root,'../node_modules/typescript/bin/tsc'),'--project',project,'--pretty','false'],{stdio:'ignore',timeout:30000});
    child.once('error',()=>reject(new Error('compile')));child.once('close',code=>code===0?resolve():reject(new Error('compile')));
  });
}
async function emitBrowser(root:string,inputs:InputSnapshot) {
  validateInputBounds(inputs);
  const names=[...inputs.keys()].filter(path=>/^(?:web|shared)\/[a-zA-Z0-9_-]+\.ts$/.test(path)&&!path.endsWith('.test.ts'));
  const config=privateConfig(inputs,names);const directory=await mkdtemp(join(tmpdir(),'ui-browser-build-'));
  try {
    await mkdir(join(directory,'web'));await mkdir(join(directory,'shared'));
    for(const name of names) await writeFile(join(directory,name),inputs.get(name) as Buffer,{flag:'wx'});
    const project=join(directory,'web/tsconfig.json');await writeFile(project,config,{flag:'wx'});await runCompiler(root,project);
    const {assets:outputs,imports}=await collectOutputs(directory);
    const staticFiles=[['/','web/index.html','text/html; charset=utf-8'],['/style.css','web/style.css','text/css; charset=utf-8'],['/favicon.svg','web/favicon.svg','image/svg+xml']] as const;
    for(const [route,path,type] of staticFiles) {const data=inputs.get(path);if(!data) throw new Error('invalid-assets');outputs.set(route,{type,data});}
    return {assets:outputs,imports};
  } finally {await rm(directory,{recursive:true,force:true});}
}
function validateInputBounds(inputs:InputSnapshot) {
  let bytes=0;if(inputs.size>1280) throw new Error('capacity');
  for(const data of inputs.values()) {bytes+=data.length;if(data.length>2*1024*1024||bytes>16*1024*1024) throw new Error('capacity');}
}
async function collectOutputs(directory:string) {
  const assets=new Map<string,Asset>(),imports=new Map<string,string[]>();let bytes=0,visits=0;
  for(const folder of ['web','shared']) {
    const handle=await opendir(join(directory,'dist',folder),{bufferSize:1});
    for await(const entry of handle) {
      if(++visits>253) throw new Error('capacity');
      if(!entry.isFile()||!/^[a-zA-Z0-9_-]+\.js$/.test(entry.name)) throw new Error('invalid-assets');
      const route=`/${folder}/${entry.name}`,data=await captureFile(join(directory,'dist',folder,entry.name),16*1024*1024-bytes);bytes+=data.length;
      imports.set(route,moduleImports(data.toString('utf8')));assets.set(route,{type:'text/javascript; charset=utf-8',data});
    }
  }
  return {assets,imports};
}
/** V8 parses modules without linking or evaluating them, including literal string escapes. */
function moduleImports(text:string) {
  const references=[...new vm.SourceTextModule(text).dependencySpecifiers];
  const gap='(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*(?:\\r?\\n|$))*';
  const calls=new RegExp(`\\bimport${gap}\\(`,'g');let count=0;
  for(const match of text.matchAll(calls)) {
    if(++count>1024) throw new Error('capacity');const index=match.index;
    // A reserved class token keeps property names and inert text valid, but not an import expression.
    try {new vm.SourceTextModule(`${text.slice(0,index)}class${text.slice(index+6)}`);continue;} catch { /* Active syntax requires an exact literal argument. */ }
    const rest=text.slice(index+match[0].length),argument=new RegExp(`^${gap}("(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*')${gap}\\)`).exec(rest);
    if(!argument?.[1]) throw new Error('invalid-assets');
    references.push(...new vm.SourceTextModule(`import ${argument[1]};`).dependencySpecifiers);
  }
  return references;
}
export function checkCss(root:string,css:Buffer):Promise<void> {
  return new Promise((resolve,reject)=> {
    const child=spawn(process.execPath,[join(root,'../node_modules/@biomejs/biome/bin/biome'),'check','--formatter-enabled=false','--linter-enabled=false','--stdin-file-path=style.css'],{cwd:join(root,'..'),stdio:['pipe','ignore','ignore'],timeout:10000});
    child.once('error',()=>reject(new Error('invalid-assets')));child.once('exit',code=>code===0?resolve():reject(new Error('invalid-assets')));
    child.stdin.on('error',()=>reject(new Error('invalid-assets')));child.stdin.end(css);
  });
}

type CompilerBundle={assets:Map<string,Asset>;imports:Map<string,string[]>};
async function emitInWorker(root:string,inputs:InputSnapshot) {
  return new Promise<CompilerBundle>((resolve,reject)=> {
    const worker=new Worker(new URL('./development-build.mts',import.meta.url),{workerData:{kind:'browser-build',root,inputs},execArgv:['--experimental-vm-modules']});let result:CompilerBundle|undefined;let failure:Error|undefined;
    worker.once('message',(message:CompilerBundle|{error:string})=>{if('error'in message) failure=new Error(['compile','capacity'].includes(message.error)?message.error:'invalid-assets');else result=message;});
    worker.once('error',()=>{failure=new Error('invalid-assets');});
    worker.once('exit',code=>{if(code===0&&result&&!failure) resolve(result);else reject(failure??new Error('invalid-assets'));});
  });
}
async function compileInWorker(root:string,inputs:InputSnapshot) {return compileBrowser(root,inputs,css=>checkCss(root,css));}
if(!isMainThread&&workerData?.kind==='browser-build') {
  const inputs=new Map<string,Buffer>([...workerData.inputs].map(([path,data]:[string,Uint8Array])=>[path,Buffer.from(data)]));
  void emitBrowser(workerData.root,inputs).then(bundle=>parentPort?.postMessage(bundle),error=>parentPort?.postMessage({error:error instanceof Error&&['compile','capacity'].includes(error.message)?error.message:'invalid-assets'})).finally(()=>parentPort?.close());
}
/** One watcher set and one periodic reconciliation; no request/render path reads inputs. */
export class DevelopmentBuild {
  private builder:LatestBuild;
  private watchers:FSWatcher[]=[];
  private timer?:ReturnType<typeof setInterval>;
  private debounce?:ReturnType<typeof setTimeout>;
  private scan?:Promise<void>;
  private again=false;
  private stopped=false;
  private inputs:InputSnapshot;
  private root:string;
  private generations:AssetGenerations;
  private constructor(root:string,generations:AssetGenerations,inputs:InputSnapshot,producer:BuildProducer) {
    this.root=root;this.generations=generations;this.inputs=inputs;this.builder=new LatestBuild(generations,()=>confirmedBuild(producer));
  }
  static async open(root=fileURLToPath(new URL('../',import.meta.url))) {
    const inputs=await captureInputs(root);const producer={capture:()=>captureInputs(root),compile:(snapshot:InputSnapshot)=>compileInWorker(root,snapshot)};
    const generation=await confirmedBuild(producer);const generations=new AssetGenerations(generation);
    return {generations,build:new DevelopmentBuild(root,generations,inputs,producer)};
  }
  start() {
    if(this.stopped||this.watchers.length) return;
    for(const directory of directories) {
      const watcher=watch(join(this.root,directory),{persistent:false},(_event,name)=>{if(name && (String(name).endsWith('.test.mts')||String(name).endsWith('.md'))) return;this.hint();});
      watcher.on('error',()=>{this.generations.failure(this.generations.status().revision,'io');void this.reconcile();});this.watchers.push(watcher);
    }
    this.timer=setInterval(()=>{void this.reconcile();},30000);this.timer.unref();void this.reconcile();
  }
  private hint() {if(this.debounce||this.stopped) return;this.debounce=setTimeout(()=>{this.debounce=undefined;void this.reconcile();},100);this.debounce.unref();}
  reconcile() {
    if(this.stopped) return Promise.resolve();
    if(this.scan) {this.again=true;return this.scan;}
    this.scan=(async()=> {
      do {
        this.again=false;const next=await captureInputs(this.root);
        if(needsRestart(this.inputs,next)) {this.generations.restartRequired();this.builder.stop();this.inputs=next;break;}
        if(!sameInputs(this.inputs,next)) {this.inputs=next;this.builder.request();}
      } while(this.again&&!this.stopped);
    })().catch(()=>this.generations.failure(this.generations.status().revision,'io')).finally(()=>{this.scan=undefined;});return this.scan;
  }
  async close() {this.stopped=true;this.builder.stop();for(const watcher of this.watchers) watcher.close();if(this.timer) clearInterval(this.timer);if(this.debounce) clearTimeout(this.debounce);await this.scan;await this.builder.drain();}
}
