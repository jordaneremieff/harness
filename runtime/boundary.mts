import type {IncomingMessage,ServerResponse} from 'node:http';
import type {RuntimeConfig} from './contract.mts';
import {RuntimeError} from './contract.mts';

const sensitive=(name:string)=>['host','origin','sec-fetch-site','forwarded'].includes(name)||name.startsWith('x-forwarded-')||name.startsWith('tailscale-')||name.includes('funnel');
function identityHeaders(request:IncomingMessage) {
  const headers=new Map<string,string>();
  for(let i=0;i<request.rawHeaders.length;i+=2) {
    const name=request.rawHeaders[i].toLowerCase(),value=request.rawHeaders[i+1];if(!sensitive(name))continue;
    if(headers.has(name)||!value||value.length>2048||/[^\x20-\x7e]/.test(value)||value.trim()!==value)throw new RuntimeError('forbidden','The request identity is invalid.');headers.set(name,value);
  }
  return headers;
}
function deny():never {throw new RuntimeError('forbidden','The request does not match this runtime entrypoint.');}
function entrypointOrigin(headers:Map<string,string>,localOrigin:string,kind:'local'|'private',config:RuntimeConfig) {
  if(kind==='private') {
    if(!config.privateOrigin||!config.privateOwnerLogin)deny();
    const host=new URL(config.privateOrigin).host;
    if(headers.get('host')!==host||headers.get('x-forwarded-host')!==host||headers.get('x-forwarded-proto')!=='https'||headers.get('tailscale-user-login')!==config.privateOwnerLogin)deny();
    if([...headers.keys()].some(name=>name.includes('funnel')||name==='forwarded'))deny();
    return config.privateOrigin;
  }
  if(headers.get('host')!==new URL(localOrigin).host||[...headers.keys()].some(name=>name==='forwarded'||name.startsWith('tailscale-')||name.startsWith('x-forwarded-')||name.includes('funnel')))deny();
  return localOrigin;
}
export function validateEntrypoint(request:IncomingMessage,localOrigin:string,kind:'local'|'private'|'socket',config:RuntimeConfig) {
  if(kind==='socket')return;
  const headers=identityHeaders(request),origin=entrypointOrigin(headers,localOrigin,kind,config);
  if(request.method!=='GET'&&request.method!=='HEAD'&&headers.get('origin')!==origin)deny();
  if(headers.has('origin')&&headers.get('origin')!==origin)deny();
  if(headers.has('sec-fetch-site')&&!['same-origin','none'].includes(headers.get('sec-fetch-site') as string))deny();
}
export function secureResponse(response:ServerResponse) {
  response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
}
