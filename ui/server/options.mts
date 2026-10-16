import {resolve} from 'node:path';
export type Options = {cwd: string; port: number; pi: string; stateDir?: string; open?: boolean; devReload?: boolean; devDiagnostics?: boolean};
function invalid(message: string): never {throw Object.assign(new Error(message), {code: 'invalid_request'});}
function booleanFlag(result: Options, flag: string | undefined): boolean {
  switch(flag) {case '--open':result.open=true;return true;case '--dev-reload':result.devReload=true;return true;case '--dev-diagnostics':result.devDiagnostics=true;return true;default:return false;}
}
function assignValue(result: Options, flag: string | undefined, value: string) {
  switch(flag) {
    case '--cwd':result.cwd=resolve(value);return;
    case '--state-dir':result.stateDir=resolve(value);return;
    case '--pi':result.pi=value;return;
    case '--port': {const port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)invalid('The port must be a local TCP port.');result.port=port;return;}
    default:invalid('Use --cwd, --port, --pi, and --state-dir with values, or --open, --dev-reload, and --dev-diagnostics.');
  }
}
export function parseArgs(args: string[], cwd = process.cwd()): Options {
  const result: Options = {cwd, port: 4318, pi: 'pi', open: false};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];if(booleanFlag(result,flag))continue;
    const value=args[++i];if(!value||value.startsWith('--'))invalid('A value-taking UI flag requires a value.');assignValue(result,flag,value);
  }
  return result;
}
