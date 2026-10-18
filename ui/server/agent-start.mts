import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { deriveEndpoint, readClaim, readJson, readRecord, storageName, type CatalogRecord } from '../agents/catalog-record.mts';
import { assertOperation, decodeDescriptor } from '../agents/contract.mts';
import { ApiError } from './errors.mts';

export type LaunchMetadata = Pick<CatalogRecord, 'storageId' | 'cwd' | 'agentDir' | 'packageDir' | 'storagePath' | 'model' | 'thinkingLevel' | 'name' | 'trust' | 'ownerId' | 'independent'>;
export type StartOptions = {store: string; executable:string; agentDir?:string; spawn?: (command:string,args:string[],options:SpawnOptions)=>ChildProcess; timeoutMs?: number};
type Attempt = {promise: Promise<void>; child?: ChildProcess; exited: boolean; cancel?:()=>void};
const PREFIX = 'PI_AGENT_HOST_READY ';
const OUTPUT_BYTES = 64 * 1024;

/** Canonical conversation spelling prevents alternate keys from acquiring the same storage. */
export function startIdentity(identity: string): string {
  if(typeof identity !== 'string' || identity.length > 512 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(identity)) throw new ApiError('invalid_request','The agent identity is invalid.');
  const parts = identity.split(':');
  try { storageName(parts[0]); } catch { throw new ApiError('invalid_request','The agent identity is invalid.'); }
  if(parts.length > 2 || (parts.length === 2 && (!/^[1-9]\d*$/.test(parts[1]) || !Number.isSafeInteger(Number(parts[1])) || Number(parts[1]) <= 1))) throw new ApiError('invalid_request','Use the exact agent conversation identity.');
  return parts[0];
}
async function canonical(path: string, directory: boolean) {
  const info = await lstat(path);
  if((directory ? !info.isDirectory() : !info.isFile()) || await realpath(path) !== path) throw new Error('Noncanonical path');
}
/** Global server-owned settings select the Agent source, never retained metadata or project settings. */
async function configuredRunner(agentDir:string, member: 'durable-runner.ts' | 'retained-read.ts' | 'create-saved-context.ts' = 'durable-runner.ts') {
  await canonical(agentDir,true);
  const settings = (await readJson(join(agentDir,'settings.json'),65536)).value as {extensions?:unknown;packages?:unknown};
  if(!settings) throw new Error('Agent source configuration is unavailable');
  const extensions = settings.extensions ?? []; const packages = settings.packages ?? [];
  if(!Array.isArray(extensions) || !Array.isArray(packages) || extensions.length > 128 || packages.length > 128 || extensions.some((entry:unknown)=>typeof entry !== 'string' || /[!*?[\]{}]/u.test(entry) || entry.startsWith('-'))) throw new Error('Agent source configuration is unsupported');
  const entries = [...extensions,...packages].filter((entry:unknown):entry is string=>typeof entry === 'string' && (isAbsolute(entry) || entry.startsWith('./') || entry.startsWith('../')) && entry.endsWith('/extensions/agent/index.ts')).map(entry=>resolve(agentDir,entry));
  if(entries.length !== 1) throw new Error('Agent source configuration is ambiguous or unavailable');
  const entry=entries[0]; await canonical(entry,false);
  const slice=dirname(entry); const root=dirname(dirname(slice));
  const manifest=(await readJson(join(root,'package.json'),32768)).value as {name?:unknown;pi?:{extensions?:unknown}};
  if(manifest?.name !== 'harness' || !Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.includes('./extensions')) throw new Error('The configured Agent package is invalid');
  const runner=join(slice,member);await canonical(runner,false);return runner;
}
export async function savedContextCreatorPath(agentDir?:string):Promise<string> {
  try{return await configuredRunner(resolve(agentDir??getAgentDir()),'create-saved-context.ts');}
  catch{throw new ApiError('host_unavailable','The configured saved context creator is unavailable.',503,'read');}
}
/** The reader comes from global server resources, never a target record or browser argument. */
export async function retainedReaderPath(agentDir?: string): Promise<string> {
  try { return await configuredRunner(resolve(agentDir ?? getAgentDir()), 'retained-read.ts'); }
  catch { throw new ApiError('host_unavailable','The configured retained reader is unavailable.',503,'read'); }
}
async function searchExecutable(path:string) {
  try {await access(path,constants.X_OK);return await realpath(path);}
  catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))throw error;return undefined;}
}
async function executablePath(executable:string) {
  if(!executable || executable.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(executable)) throw new Error('Invalid Pi executable');
  if(isAbsolute(executable)) {await access(executable,constants.X_OK);return realpath(executable);}
  if(executable.includes('/') || executable.includes('\\')) throw new Error('Use an absolute Pi executable or a PATH command');
  const paths=(process.env.PATH ?? '').split(delimiter);
  if(paths.length > 128) throw new Error('Executable search exceeds its bound');
  for(const path of paths) {
    if(!isAbsolute(path) || path.length > 4096) continue;
    const candidate=join(path,executable);
    const found=await searchExecutable(candidate);if(found)return found;
  }
  throw new Error('The configured Pi executable is unavailable');
}
async function managedVersion(root:string) {
  const file=await open(join(root,'current-version'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if(!(await file.stat()).isFile())throw new Error('Invalid managed installation marker');
    const buffer=Buffer.alloc(257);const {bytesRead}=await file.read(buffer,0,buffer.length,0);
    const version=buffer.subarray(0,bytesRead).toString('utf8').trim();
    if(bytesRead > 256 || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(version))throw new Error('Invalid managed installation version');
    return version;
  } finally {await file.close();}
}
async function installation(executable:string) {
  const selected=await executablePath(executable);let root:string;let version:string|undefined;
  if(basename(selected) === 'pi' && basename(dirname(selected)) === 'bin') {
    const managed=resolve(dirname(selected),'../install');await canonical(managed,true);version=await managedVersion(managed);
    root=join(managed,'releases',version,'node_modules','@earendil-works','pi-coding-agent');
  } else root=dirname(dirname(dirname(selected)));
  await canonical(root,true);
  const manifest=(await readJson(join(root,'package.json'),32768)).value as {name?:unknown;version?:unknown;bin?:{pi?:unknown}};
  if(manifest?.name !== '@earendil-works/pi-coding-agent' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version) || (version !== undefined && manifest.version !== version) || manifest.bin?.pi !== 'dist/bundle/cli.js') throw new Error('The configured Pi installation is invalid');
  const cli=join(root,'dist','bundle','cli.js');await canonical(cli,false);
  if(version === undefined && cli !== selected)throw new Error('The executable does not belong to the selected Pi installation');
  if(process.env.PI_PACKAGE_DIR && await realpath(process.env.PI_PACKAGE_DIR) !== root)throw new Error('The Pi package override disagrees with the selected executable');
  return root;
}
/** Resolve both executable authorities before any spawn, without loading the Agent implementation. */
export async function startBinding(options: Pick<StartOptions,'executable'|'agentDir'>) {
  try {
    const [runner,packageDir]=await Promise.all([configuredRunner(resolve(options.agentDir ?? getAgentDir())),installation(options.executable)]);
    return {runner,packageDir};
  } catch {throw new ApiError('not_ready','The configured Agent source or current Pi installation is unavailable. No host was started.',503,'manual');}
}
function metadata(record: CatalogRecord, packageDir: string): LaunchMetadata {
  return {storageId:record.storageId,cwd:record.cwd,agentDir:record.agentDir,packageDir,storagePath:record.storagePath,model:record.model,thinkingLevel:record.thinkingLevel,
    ...(record.name === undefined ? {} : {name:record.name}),...(record.trust === undefined ? {} : {trust:record.trust}),
    ...(record.ownerId === undefined ? {} : {ownerId:record.ownerId}),...(record.independent === undefined ? {} : {independent:record.independent})};
}
function uncertain(message: string) { return new ApiError('not_ready',message,503,'read'); }
function validateReady(line: string, child: ChildProcess, record: CatalogRecord) {
  const ready = JSON.parse(line.slice(PREFIX.length)) as Record<string,unknown>;
  if(!ready || typeof ready !== 'object' || Array.isArray(ready) || !Number.isSafeInteger(ready.pid) || ready.pid !== child.pid || ready.socketPath !== deriveEndpoint(record).socketPath) throw new Error('Wrong readiness endpoint');
  const contract = decodeDescriptor(ready.contract);
  for(const operation of ['task-submit','snapshot','observe-open','observe-frame','observe-close'] as const) assertOperation(contract,operation);
}
function readiness(child: ChildProcess, record: CatalogRecord, timeoutMs: number, attempt: Attempt): Promise<void> {
  return new Promise((done,reject)=> {
    let pending = Buffer.alloc(0); let total = 0; let settled = false;
    const finish = (error?: Error) => {
      if(settled) return; settled = true; clearTimeout(timer); attempt.cancel = undefined;
      child.stdout?.off('data',data);child.stdout?.off('error',lost);child.stdout?.off('end',lost);child.stdout?.off('close',lost); child.off('error',failed); child.off('exit',exited);
      if(error) reject(error); else done();
    };
    const failed = () => finish(uncertain('Agent start is not confirmed. Check the agent; the host was not stopped.'));
    const lost = () => finish(uncertain('Agent readiness output was lost. Start is not confirmed; the host was not stopped.'));
    const exited = () => finish(uncertain('The agent process exited before readiness.'));
    const data = (chunk: Buffer) => {
      total += chunk.length;
      if(total > OUTPUT_BYTES) { finish(uncertain('Agent readiness exceeded its output bound. Start is not confirmed.')); return; }
      pending = Buffer.concat([pending,chunk]);
      for(let cut = pending.indexOf(10); cut >= 0; cut = pending.indexOf(10)) {
        const line = pending.subarray(0,cut).toString('utf8'); pending = pending.subarray(cut+1);
        if(!line.startsWith(PREFIX)) continue;
        try {
          validateReady(line,child,record); finish();
        } catch { finish(uncertain('Agent readiness is malformed or incompatible. Start is not confirmed.')); }
        return;
      }
    };
    const timer = setTimeout(()=>finish(uncertain('Agent start is not confirmed. Check the agent; the host was not stopped.')),timeoutMs);
    attempt.cancel = ()=>finish(uncertain('The UI closed before readiness. The host was not stopped.'));
    child.stdout?.on('data',data);child.stdout?.once('error',lost);child.stdout?.once('end',lost);child.stdout?.once('close',lost); child.once('error',failed); child.once('exit',exited);
  });
}
function detach(child: ChildProcess) {
  child.unref();
  for(const stream of [child.stdout,child.stderr]) {
    stream?.on('data',()=>{});stream?.on('error',()=>{});
    (stream as (NodeJS.ReadableStream & {unref?:()=>void}) | null)?.unref?.();
  }
}
/** Launch attempts survive browser loss. This adapter never signals a host or edits its claim. */
export class StoredAgentStarter {
  private readonly options: StartOptions;
  private readonly attempts = new Map<string,Attempt>();
  private closed = false;
  constructor(options: StartOptions) { this.options = options; }
  async start(identity: string): Promise<void> {
    if(this.closed) throw uncertain('The UI no longer accepts agent starts.');
    const storageId = startIdentity(identity);
    let record: CatalogRecord;
    try {
      const root = join(resolve(this.options.store),'durable'); await canonical(root,true);
      record = (await readRecord(root,storageId)).record;
      await Promise.all([canonical(record.cwd,true),canonical(record.agentDir,true),canonical(record.storagePath,false)]);
    } catch { throw new ApiError('invalid_request','The stored agent identity or path is invalid.'); }
    const claim = await readClaim(record);
    if(claim.state === 'live') return;
    if(claim.state === 'unknown') throw uncertain('The agent writer owner is unknown. No host was started.');
    const prior = this.attempts.get(storageId);
    if(prior && !prior.exited) return prior.promise;
    if(prior) this.attempts.delete(storageId);
    if(this.attempts.size >= 32) throw new ApiError('capacity','The agent start capacity is full.',429);
    const attempt: Attempt = {promise:Promise.resolve(),exited:false};
    this.attempts.set(storageId,attempt);
    attempt.promise = this.launch(record,attempt);
    return attempt.promise;
  }
  close() { this.closed = true; for(const attempt of this.attempts.values()) attempt.cancel?.(); }
  private async launch(record: CatalogRecord, attempt: Attempt) {
    try {
      const binding = await startBinding(this.options);
      const claim = await readClaim(record);
      if(claim.state === 'live') { attempt.exited = true; return; }
      if(claim.state === 'unknown') { attempt.exited = true; throw uncertain('The agent writer owner is unknown. No host was started.'); }
      if(this.closed) throw uncertain('The UI no longer accepts agent starts.');
      const child = (this.options.spawn ?? spawn)(process.execPath,[binding.runner,JSON.stringify(metadata(record,binding.packageDir))],{cwd:record.cwd,detached:true,stdio:['ignore','pipe','pipe'],env:process.env});
      attempt.child = child;
      child.once('exit',()=>{attempt.exited = true;});
      child.once('error',()=>{if(child.pid === undefined) attempt.exited = true;});
      const ready = readiness(child,record,this.options.timeoutMs ?? (record.trust === undefined ? 330000 : 30000),attempt);
      detach(child);
      try { await ready; }
      catch(error) {
        const winner = await readClaim(record);
        if(attempt.exited && winner.state === 'live' && winner.claim?.pid !== child.pid) return;
        throw error;
      }
      const owner = await readClaim(record);
      if(owner.state !== 'live') throw uncertain('The agent writer claim is not confirmed. The host was not stopped.');
      // A competing live owner wins; preparation negotiates its actual endpoint.
    } catch(error) {
      if(!attempt.child) attempt.exited = true;
      throw error;
    }
  }
}
