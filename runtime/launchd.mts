import {dirname,isAbsolute,join,resolve} from 'node:path';
import {RuntimeError,type RuntimeConfig} from './contract.mts';
import {validateRuntimeConfig} from './config.mts';
import {validateNativeSource,type NativeSource} from './sessions.mts';

function xml(value:string) {return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char] as string));}
function executablePath(node:string,path:string|undefined) {
  if(!path||path.length>16384)throw new RuntimeError('invalid_config','Supply a bounded service PATH.');
  const directories=[dirname(node),...path.split(':')];
  if(directories.some(value=>!isAbsolute(value)||/[\u0000-\u001f\u007f]/.test(value)))throw new RuntimeError('invalid_config','Each service PATH entry must be an absolute directory.');
  const selected=[...new Set(directories.map(value=>resolve(value)))];
  if(selected.length>64)throw new RuntimeError('invalid_config','The service PATH exceeds its directory bound.');
  return selected.join(':');
}
/** A service plan is data. Installing or bootstrapping it is a separate deliberate deployment action. */
export function launchAgentPlan(options:RuntimeConfig & {sourceRoot:string;stateDir:string;agentDir:string;cwd:string;uiStateDir:string;node?:string;path?:string;piExecutable?:string;existingSource?:NativeSource}) {
  validateRuntimeConfig({port:options.port,privatePort:options.privatePort,privateOrigin:options.privateOrigin,privateOwnerLogin:options.privateOwnerLogin});
  const source=options.existingSource===undefined?undefined:validateNativeSource(options.existingSource);
  for(const value of [options.sourceRoot,options.stateDir,options.agentDir,options.cwd,options.uiStateDir,options.node??process.execPath])if(!isAbsolute(value)||/[\u0000-\u001f]/.test(value))throw new RuntimeError('invalid_config','Service directories and executable must be absolute.');
  const environment={PATH:executablePath(options.node??process.execPath,options.path??process.env.PATH)};
  const label='dev.pi.harness.runtime';
  const arguments_=[options.node??process.execPath,join(options.sourceRoot,'runtime','cli.mts'),'serve','--agent-dir',options.agentDir,'--state-dir',options.stateDir,'--cwd',options.cwd,'--ui-state-dir',options.uiStateDir,'--source-root',options.sourceRoot,'--restore-ui',...(options.port!==undefined?['--port',String(options.port)]:[]),...(options.piExecutable?['--pi',options.piExecutable]:[]),...(source?['--existing-root',source.root,'--existing-source-root',source.sourceRoot,'--existing-package-dir',source.packageDir]:[]),...(options.privateOrigin?['--private-origin',options.privateOrigin,'--private-owner-login',options.privateOwnerLogin??'','--private-port',String(options.privatePort??4321)]:[])];
  const plist=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${arguments_.map(value=>`<string>${xml(value)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(options.cwd)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(environment.PATH)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`;
  return {label,filename:`${label}.plist`,plist,arguments:arguments_,environment,restoration:'The per-user macOS service restarts management after process loss and login. It restores the UI through its existing launcher, without replay of model input.',limits:'A logged-out or powered-off host is unreachable. Existing unconfirmed ordinary work needs its owning recovery path.',activation:'Install the plan at an owner-agreed boundary. Keep its source and Node installation intact while this service uses them.'};
}
