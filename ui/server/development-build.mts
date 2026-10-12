import { createHash } from 'node:crypto';
import { constants, watch, type FSWatcher } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type ts from 'typescript';
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

/** Existing development tools are loaded only through the explicitly selected mode. */
export async function compileBrowser(root:string,inputs:InputSnapshot,cssCheck:(css:Buffer)=>Promise<void>) {
  const bundle=await emitBrowser(root,inputs);const css=inputs.get('web/style.css');if(!css) throw new Error('invalid-assets');await cssCheck(css);
  return new AssetGeneration(bundle.assets,bundle.imports);
}
async function emitBrowser(root:string,inputs:InputSnapshot) {
  const compiler=await import('typescript');
  const configText=inputs.get('web/tsconfig.json');if(!configText) throw new Error('invalid-assets');
  const config=compiler.parseConfigFileTextToJson(join(root,'web/tsconfig.json'),configText.toString('utf8'));if(config.error) throw new Error('compile');
  const parsed=compiler.parseJsonConfigFileContent(config.config,compiler.sys,join(root,'web'));
  if(parsed.errors.length) throw new Error('compile');
  const options={...parsed.options,noEmitOnError:true};const host=compiler.createCompilerHost(options);
  const read=host.readFile;const exists=host.fileExists;const libraryRoot=resolve(root,'../node_modules')+sep;
  const source=(path:string)=>inputs.get(relative(root,path).split(sep).join('/'));
  host.readFile=path=>source(path)?.toString('utf8')??(resolve(path).startsWith(libraryRoot)?read(path):undefined);
  host.fileExists=path=>!!source(path)||(resolve(path).startsWith(libraryRoot)&&exists(path));
  host.getSourceFile=(path,languageVersion)=>{const text=host.readFile(path);return text===undefined?undefined:compiler.createSourceFile(path,text,languageVersion);};
  const outputs=new Map<string,Asset>();const imports=new Map<string,string[]>();let emittedBytes=0;
  host.writeFile=(path,text)=> {
    const route=`/${relative(join(root,'dist'),path).split(sep).join('/')}`;
    if(!/^\/(?:web|shared)\/[a-zA-Z0-9_-]+\.js$/.test(route)) throw new Error('invalid-assets');
    const bytes=Buffer.byteLength(text);emittedBytes+=bytes;
    if(bytes>2*1024*1024||emittedBytes>16*1024*1024||outputs.size>=253) throw new Error('capacity');
    imports.set(route,moduleImports(compiler,path,text));outputs.set(route,{type:'text/javascript; charset=utf-8',data:Buffer.from(text)});
  };
  const rootNames=[...inputs.keys()].filter(path=>(path.startsWith('web/')&&path.endsWith('.ts'))||path==='shared/api.ts').map(path=>join(root,path));
  const program=compiler.createProgram(rootNames,options,host);
  if(compiler.getPreEmitDiagnostics(program).length||program.emit().emitSkipped) throw new Error('compile');
  const staticFiles=[['/','web/index.html','text/html; charset=utf-8'],['/style.css','web/style.css','text/css; charset=utf-8'],['/favicon.svg','web/favicon.svg','image/svg+xml']] as const;
  for(const [route,path,type] of staticFiles) {const data=inputs.get(path);if(!data) throw new Error('invalid-assets');outputs.set(route,{type,data});}
  return {assets:outputs,imports};
}
function moduleImports(compiler:typeof ts,path:string,text:string) {
  const references:string[]=[];const tree=compiler.createSourceFile(path,text,compiler.ScriptTarget.ES2023,true,compiler.ScriptKind.JS);
  const staticImport=(node:ts.ImportDeclaration|ts.ExportDeclaration)=> {
    if(!node.moduleSpecifier) return;
    if(!compiler.isStringLiteral(node.moduleSpecifier)) throw new Error('invalid-assets');references.push(node.moduleSpecifier.text);
  };
  const dynamicImport=(node:ts.CallExpression)=> {
    const argument=node.arguments[0];if(node.arguments.length!==1||!argument||!compiler.isStringLiteral(argument)) throw new Error('invalid-assets');references.push(argument.text);
  };
  const visit=(node:ts.Node)=> {
    if(compiler.isImportDeclaration(node)||compiler.isExportDeclaration(node)) staticImport(node);
    if(compiler.isCallExpression(node)&&node.expression.kind===compiler.SyntaxKind.ImportKeyword) dynamicImport(node);
    compiler.forEachChild(node,visit);
  };visit(tree);return references;
}
export function checkCss(root:string,css:Buffer):Promise<void> {
  return new Promise((resolve,reject)=> {
    const child=spawn(process.execPath,[join(root,'../node_modules/@biomejs/biome/bin/biome'),'check','--formatter-enabled=false','--linter-enabled=false','--stdin-file-path=style.css'],{cwd:join(root,'..'),stdio:['pipe','ignore','ignore'],timeout:10000});
    child.once('error',()=>reject(new Error('invalid-assets')));child.once('exit',code=>code===0?resolve():reject(new Error('invalid-assets')));
    child.stdin.on('error',()=>reject(new Error('invalid-assets')));child.stdin.end(css);
  });
}

type CompilerBundle={assets:Map<string,Asset>;imports:Map<string,string[]>};
async function compileInWorker(root:string,inputs:InputSnapshot) {
  const bundle=await new Promise<CompilerBundle>((resolve,reject)=> {
    const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'browser-build',root,inputs},execArgv:[]});let result:CompilerBundle|undefined;let failure:Error|undefined;
    worker.once('message',(message:CompilerBundle|{error:string})=>{if('error'in message) failure=new Error(message.error==='compile'?'compile':'invalid-assets');else result=message;});
    worker.once('error',()=>{failure=new Error('invalid-assets');});
    worker.once('exit',code=>{if(code===0&&result&&!failure) resolve(result);else reject(failure??new Error('invalid-assets'));});
  });
  const css=inputs.get('web/style.css');if(!css) throw new Error('invalid-assets');await checkCss(root,css);
  const assets=new Map([...bundle.assets].map(([route,asset])=>[route,{type:asset.type,data:Buffer.from(asset.data)}]));
  return new AssetGeneration(assets,bundle.imports);
}
if(!isMainThread&&workerData?.kind==='browser-build') {
  const inputs=new Map<string,Buffer>([...workerData.inputs].map(([path,data]:[string,Uint8Array])=>[path,Buffer.from(data)]));
  void emitBrowser(workerData.root,inputs).then(bundle=>parentPort?.postMessage(bundle),error=>parentPort?.postMessage({error:error instanceof Error&&error.message==='compile'?'compile':'invalid-assets'})).finally(()=>parentPort?.close());
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
