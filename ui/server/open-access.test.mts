import assert from 'node:assert/strict';
import {request} from 'node:http';
import test from 'node:test';
import {LocalHttp, type HttpBackend} from './http.mts';
import {Journal} from './journal.mts';

async function fixture(t:import('node:test').TestContext) {
  const backend:HttpBackend={journal:new Journal(),dispatch:async()=>({ready:true}),workspace:async()=> 'workspace',observe:async()=>{},detached:()=>{}};
  const http=new LocalHttp(backend,new Map([['/',{type:'text/html',data:Buffer.from('<html><head></head></html>')}]]));
  const url=await http.listen(0);t.after(()=>http.close());
  const call=(path:string,method='GET',headers:Record<string,string>={})=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders} >((resolve,reject)=> {
    const req=request(new URL(path,url),{method,headers},response=>{response.resume();response.on('end',()=>resolve({status:response.statusCode??0,headers:response.headers}));});req.on('error',reject);req.end();
  });return {http,url,call};
}
test('plain local pages and API reads need no browser state and issue no cookie',async t=> {
  const f=await fixture(t);assert.equal(new URL(f.url).hash,'');
  const address=f.http.server.address();assert.ok(address&&typeof address!=='string');assert.equal(address.address,'127.0.0.1');
  for(const path of ['/','/api/bootstrap','/api/snapshot']) {
    const reply=await f.call(path);assert.equal(reply.status,200);assert.equal(reply.headers['set-cookie'],undefined);
    assert.equal(reply.headers['cache-control'],'no-store');assert.equal(reply.headers['x-content-type-options'],'nosniff');
    assert.equal(reply.headers['referrer-policy'],'no-referrer');assert.match(String(reply.headers['content-security-policy']),/frame-ancestors 'none'/);
    assert.equal(reply.headers['access-control-allow-origin'],undefined);
  }
  for(const path of ['/api/auth/launch','/api/auth/logout'])assert.equal((await f.call(path,'POST',{Origin:new URL(f.url).origin})).status,404);
});
test('open local access retains exact Host Origin and Fetch Metadata refusal without CORS',async t=> {
  const f=await fixture(t),origin=new URL(f.url).origin;
  const cases:[string,string,Record<string,string>][]=[
    ['/','GET',{Host:'localhost:4318'}],['/api/bootstrap','GET',{Host:'foreign.invalid'}],
    ['/api/bootstrap','GET',{Origin:'http://foreign.invalid'}],
    ['/','GET',{'Sec-Fetch-Site':'cross-site'}],['/api/bootstrap','GET',{'Sec-Fetch-Site':'same-site'}],
    ['/api/workspaces','POST',{}],['/api/control/requests','POST',{Origin:'http://foreign.invalid'}],
    ['/api/workspaces','POST',{Origin:origin,'Sec-Fetch-Site':'cross-site'}],['/api/workspaces','OPTIONS',{Origin:'http://foreign.invalid'}]
  ];
  for(const [path,method,headers] of cases) {const reply=await f.call(path,method,headers);assert.equal(reply.status,403);assert.equal(reply.headers['access-control-allow-origin'],undefined);}
  for(const site of ['same-origin','none'])assert.equal((await f.call('/api/bootstrap','GET',{'Sec-Fetch-Site':site})).status,200);
});
