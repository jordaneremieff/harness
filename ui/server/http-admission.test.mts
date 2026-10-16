import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { LocalHttp, HTTP_CLOSE_GRACE_MS, type HttpBackend } from './http.mts';
import { Journal } from './journal.mts';
const assets = new Map([['/',{type:'text/html',data:Buffer.from('<html><head></head></html>')}],['/web/app.js',{type:'text/javascript',data:Buffer.from('export {};')}]]);
function backend(): HttpBackend {return {journal:new Journal(),dispatch:async()=>({}),workspace:async()=> 'test',observe:async()=>{},detached:()=>{}};}
async function call(origin:string,path:string,method='GET',body?:unknown,extra:Record<string,string>={}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Promise<{status:number;body:string} >((resolve,reject) => {
    const req = request(origin,{path,method,agent:false,headers:{Origin:origin,...(text?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(text))}:{}),...extra}},res => {
      let body = '';res.setEncoding('utf8');res.on('data',chunk => {body += chunk;});res.on('end',()=>resolve({status:res.statusCode ?? 0,body}));res.on('error',reject);
    });req.on('error',reject);req.end(text);
  });
}

test('static module bursts preserve API admission and remain available after API exhaustion',async context => {
  context.mock.method(performance,'now',()=>1);const http = new LocalHttp(backend(),assets), origin = new URL(await http.listen(0)).origin;context.after(()=>http.close());
  for (let index=0;index<400;index++) assert.equal((await call(origin,'/web/app.js')).status,200);
  for (let index=0;index<240;index++) assert.equal((await call(origin,'/api/bootstrap')).status,200);
  assert.equal((await call(origin,'/api/bootstrap')).status,429);assert.equal((await call(origin,'/web/app.js')).status,200);
  assert.equal((await call(origin,'/web/app.js','GET',undefined,{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await call(origin,'/web/app.js','GET',undefined,{Host:'foreign.invalid'})).status,403);
  assert.equal((await call(origin,'/web/app.js','POST',{},{Origin:'http://foreign.invalid'})).status,403);
  assert.equal((await call(origin,'/web/app.js','POST',{})).status,405);
});
test('graceful close bounds stalled HTTP sockets without disabling body or header protection',{timeout:6000},async () => {
  const http = new LocalHttp(backend(),assets), origin = new URL(await http.listen(0));
  assert.equal(http.server.requestTimeout,30000);assert.equal(http.server.headersTimeout,10000);assert.equal(http.server.maxHeadersCount,64);
  const connected = new Promise<void>(resolve=>http.server.once('connection',()=>resolve())), socket = connect({host:'127.0.0.1',port:Number(origin.port)});socket.on('error',()=>{});await connected;
  socket.write(`POST /api/workspaces HTTP/1.1\r\nHost: ${origin.host}\r\n`);const closed = new Promise<void>(resolve=>socket.once('close',()=>resolve()));const start = performance.now();
  await Promise.all([http.close(),http.close(),closed]);assert(performance.now()-start<HTTP_CLOSE_GRACE_MS+1500);assert.equal(socket.destroyed,true);assert.equal(http.server.listening,false);
});
