import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {statePaths} from '../server/state-paths.mts';
import {releaseRoot, readSelection} from '../server/release-store.mts';
import {requestReleaseControl} from '../server/release-control.mts';
import {OWNER_PROTOCOL} from '../shared/owner.ts';
function releaseFlag(flag:string|undefined,value:string,options:{stateDir:string;source:string;release?:string}) {
  switch(flag){case '--state-dir':options.stateDir=resolve(value);return;case '--source':options.source=resolve(value);return;case '--release':options.release=value;return;default:throw new Error('Unknown release flag.');}
}
export function parseReleaseArgs(args: string[]) {
  const kind=args[0];if(!['stage','status','switch','rollback','stop'].includes(kind??''))throw new Error('Use stage, status, switch, rollback, or stop.');
  const options:{stateDir:string;source:string;release?:string}={stateDir:statePaths().stateDir,source:resolve('.')};
  for(let i=1;i<args.length;i++) {const flag=args[i],value=args[++i];if(!value||value.startsWith('--'))throw new Error('A release flag requires a value.');releaseFlag(flag,value,options);}
  if(kind==='switch'&&(!options.release||!/^[a-f0-9]{64}$/.test(options.release)))throw new Error('Switch requires --release with its complete identity.');
  if(kind!=='switch'&&options.release)throw new Error('Only switch accepts --release.');
  return {kind:kind as 'stage'|'status'|'switch'|'rollback'|'stop',...options};
}
export async function releaseMain(args=process.argv.slice(2)) {
  const options=parseReleaseArgs(args);
  if(options.kind==='stage') {
    const {stageRelease}=await import('../server/release-stage.mts');
    return stageRelease(options.source,options.stateDir,{ownerProtocol:OWNER_PROTOCOL});
  }
  const paths=await releaseRoot(options.stateDir);
  if(options.kind==='status') {
    try {return await requestReleaseControl(paths.control,{kind:'status'});}
    catch(error) {if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;return {state:'stopped',selection:await readSelection(paths.root)};}
  }
  return requestReleaseControl(paths.control,options.kind==='switch'?{kind:'switch',release:options.release as string}:{kind:options.kind});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) void releaseMain().then(value=>process.stdout.write(`${JSON.stringify(value)}\n`),error=>{process.stderr.write(`${error instanceof Error?error.message:'Release control failed.'}\n`);process.exitCode=1;});
