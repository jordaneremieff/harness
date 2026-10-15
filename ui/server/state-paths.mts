import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
function expand(path:string):string {return path==='~'?homedir():path.startsWith('~/')?join(homedir(),path.slice(2)):resolve(path);}
export function statePaths(environment:NodeJS.ProcessEnv=process.env) {
  const agentDir=environment.PI_CODING_AGENT_DIR?expand(environment.PI_CODING_AGENT_DIR):join(homedir(),'.pi','agent');
  const agentStore=environment.PI_AGENT_SESSIONS_DIR?expand(environment.PI_AGENT_SESSIONS_DIR):join(agentDir,'agent-sessions');
  return {agentDir,agentStore,stateDir:join(agentDir,'ui')};
}
