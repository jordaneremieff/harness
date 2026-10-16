import {spawn, execFile} from 'node:child_process';
import {open, unlink} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseArgs} from './options.mts';
import {statePaths} from './state-paths.mts';
import {supervise} from './supervisor.mts';
import {boundedFile, releaseRoot, readSelection, manifestAt, findRelease, writeSelection} from './release-store.mts';
import {listenReleaseControl} from './release-control.mts';
import {identityLabel} from '../shared/version.ts';
import {OWNER_PROTOCOL, type OwnerNotice} from '../shared/owner.ts';
import type {BackendReady} from './supervisor.mts';
export {parseArgs, type Options} from './options.mts';
const packageRoot=fileURLToPath(new URL('../../',import.meta.url));
function stage(source:string,stateDir:string):Promise<string> {
  return new Promise((accept,reject)=>execFile(process.execPath,['--experimental-vm-modules',join(source,'ui/cli/release.mts'),'stage','--source',source,'--state-dir',stateDir],{cwd:source,encoding:'utf8',maxBuffer:4*1024*1024,timeout:180000},(error,out)=>{if(error){reject(new Error('Initial release staging failed; run the release stage command for details.'));return;}try{const v=JSON.parse(out);if(typeof v.manifest?.id!=='string')throw new Error('Invalid staged release.');accept(v.manifest.id);}catch(failure){reject(failure);}}));
}
async function claim(path:string) {
  const file=await open(path,'wx',0o600),token=randomUUID();
  await file.writeFile(JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString(),release:packageRoot}));await file.sync();
  return async()=>{await file.close();const value=JSON.parse((await boundedFile(path,4096)).toString('utf8'));if(value.token===token)await unlink(path);};
}
async function bootManifest() {
  try{return await manifestAt(packageRoot,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return undefined;}
}
/** Checkout launchers select real sealed files before the persistent owner starts. */
export async function main(args=process.argv.slice(2), observation:{ready?:(message:BackendReady)=>void;observeOwnerRecord?:(notice:Extract<OwnerNotice,{kind:'record'}>)=>void}={}) {
  const options=parseArgs(args),paths=await releaseRoot(options.stateDir??statePaths().stateDir);options.stateDir=paths.state;
  const manifest=await bootManifest();
  if(!manifest) {
    if(observation.ready||observation.observeOwnerRecord)throw new Error('Injected supervisor observation requires a sealed main module.');
    const selection=await readSelection(paths.root),id=selection?.current??await stage(packageRoot,paths.state);
    const release=await findRelease(paths.root,id);if(!selection)await writeSelection(paths.root,id);
    const child=spawn(process.execPath,[join(release.directory,'ui/server/main.mts'),...args,'--state-dir',paths.state],{stdio:'inherit',shell:false});
    const signal=()=>child.kill('SIGTERM');process.on('SIGINT',signal);process.on('SIGTERM',signal);
    try {return await new Promise<number>((accept,reject)=>{child.once('error',reject);child.once('exit',(code)=>accept(code??1));});}
    finally {process.off('SIGINT',signal);process.off('SIGTERM',signal);}
  }
  const selection=await readSelection(paths.root),release=await findRelease(paths.root,selection?.current??manifest.id);
  if(release.manifest.ownerProtocol!==OWNER_PROTOCOL)throw new Error('The selected release requires a different raw owner protocol.');
  if(!selection)await writeSelection(paths.root,release.manifest.id);
  const releaseClaim=await claim(paths.claim);
  const parent=supervise(options,{release:{...release},releaseRoot:paths.root,lastGood:selection?.lastGood,observeOwnerRecord:observation.observeOwnerRecord,output:line=>process.stderr.write(`${line}\n`),ready:message=> {
    process.stdout.write(`${message.url}\n${identityLabel(message.identity)}\n`);observation.ready?.(message);
    if(options.open) {options.open=false;const child=spawn('open',[message.url],{stdio:'ignore',shell:false});child.on('error',()=>process.stderr.write('The browser did not open; use the local URL.\n'));}
  }});
  let control:Awaited<ReturnType<typeof listenReleaseControl>>|undefined;
  try {
    control=await listenReleaseControl(paths.control,async request=> {
      if(request.kind==='status')return parent.status();
      if(request.kind==='switch')return parent.switchRelease(request.release);
      if(request.kind==='rollback')return parent.rollback();
      parent.stop();return {accepted:true,state:parent.status()};
    });
    const stop=()=>parent.stop(),fatal=()=>{process.stderr.write('The supervisor needs an explicit control action. Pi ownership remains active.\n');};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('unhandledRejection',fatal);process.on('uncaughtException',fatal);
    try {return await parent.closed;} finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);process.off('unhandledRejection',fatal);process.off('uncaughtException',fatal);}
  } finally {await control?.close();await releaseClaim();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().then(code=>{process.exitCode=code;},error=>{process.stderr.write(`${error instanceof Error?error.message:'The UI did not start.'}\n`);process.exitCode=1;});
