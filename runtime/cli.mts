import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateNativeSource} from './sessions.mts';
import {readDocument} from './config.mts';
import {runtimeDirectories,callRuntime} from './client.mts';
import {serveRuntime,type ServeOptions} from './http.mts';
import {launchAgentPlan} from './launchd.mts';
import {RuntimeError,readRequest,RUNTIME_PROTOCOL,type RuntimeConfig} from './contract.mts';

function parseFlags(args:string[]) {
  const values:Record<string,string>={};let restoreUi=false;
  for(let index=1;index<args.length;index++) {
    const flag=args[index];if(flag==='--restore-ui'){restoreUi=true;continue;}
    if(!['--agent-dir','--state-dir','--cwd','--ui-state-dir','--source-root','--pi','--port','--private-port','--private-origin','--private-owner-login','--request-file','--existing-root','--existing-source-root','--existing-package-dir','--path'].includes(flag)||args[index+1]===undefined)throw new RuntimeError('invalid_request','The runtime option is invalid.');
    values[flag]=args[++index];
  }
  return {values,restoreUi};
}
function networkOptions(values:Record<string,string>) {
  const network:RuntimeConfig={};
  for(const [flag,key]of [['--port','port'],['--private-port','privatePort']] as const)if(values[flag]!==undefined){if(!/^\d+$/.test(values[flag]))throw new RuntimeError('invalid_config','A runtime port is invalid.');network[key]=Number(values[flag]);}
  if(values['--private-origin']!==undefined)network.privateOrigin=values['--private-origin'];if(values['--private-owner-login']!==undefined)network.privateOwnerLogin=values['--private-owner-login'];
  return network;
}
function existingSourceOption(values:Record<string,string>) {
  const fields=['--existing-root','--existing-source-root','--existing-package-dir'];
  if(!fields.some(flag=>values[flag]!==undefined))return undefined;
  return validateNativeSource({root:values['--existing-root'],sourceRoot:values['--existing-source-root'],packageDir:values['--existing-package-dir']});
}
export function parseRuntimeArgs(args:string[]) {
  const action=args[0]??'help';if(!['serve','call','service-plan','help'].includes(action))throw new RuntimeError('invalid_request','Use serve, call or service-plan.');
  const {values,restoreUi}=parseFlags(args),directories=runtimeDirectories({agentDir:values['--agent-dir'],stateDir:values['--state-dir']}),network=networkOptions(values);
  if(values['--path']!==undefined&&action!=='service-plan')throw new RuntimeError('invalid_request','--path is only a service-plan option.');
  const options:ServeOptions={...directories,cwd:resolve(values['--cwd']??process.cwd()),sourceRoot:resolve(values['--source-root']??fileURLToPath(new URL('../',import.meta.url))),uiStateDir:resolve(values['--ui-state-dir']??join(directories.agentDir,'ui')),existingSource:existingSourceOption(values),...(values['--pi']?{piExecutable:values['--pi']} : {}),...(Object.keys(network).length?{network}:{})};
  return {action,options,restoreUi,servicePath:values['--path'],requestFile:values['--request-file']};
}
export async function runtimeMain(args=process.argv.slice(2)):Promise<void> {
  const parsed=parseRuntimeArgs(args);
  if(parsed.action==='help') {process.stdout.write('Runtime: serve [--agent-dir path] [--state-dir path] [--cwd path] [--restore-ui]; call --request-file path; service-plan\n');return;}
  if(parsed.action==='service-plan') {process.stdout.write(`${JSON.stringify(launchAgentPlan({...parsed.options,...parsed.options.network,path:parsed.servicePath}),null,2)}\n`);return;}
  if(parsed.action==='call') {
    if(!parsed.requestFile)throw new RuntimeError('invalid_request','Call requires --request-file.');
    const file=await readDocument(parsed.requestFile);if(file.status!=='valid')throw new RuntimeError('invalid_request','The request file must contain a bounded JSON object.');
    const request=readRequest(file.value),result=await callRuntime(request,parsed.options);process.stdout.write(`${JSON.stringify(result)}\n`);if(!result.ok)process.exitCode=1;return;
  }
  const runtime=await serveRuntime(parsed.options);process.stdout.write(`${JSON.stringify(runtime.descriptor)}\n`);
  if(parsed.restoreUi)void runtime.service.call({protocol:RUNTIME_PROTOCOL,request:{operation:'lifecycle.start'}}).then(result=>{if(!result.ok)process.stderr.write('UI restoration is unconfirmed. Use the independent recovery page.\n');});
  await new Promise<void>(accept=> {
    let closing=false;
    const stop=()=>{if(closing)return;closing=true;void runtime.close().then(()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);accept();});};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void runtimeMain().catch(error=>{process.stderr.write(`${error instanceof RuntimeError?error.message:'The runtime command failed.'}\n`);process.exitCode=1;});
