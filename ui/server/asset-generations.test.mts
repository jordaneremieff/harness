import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AssetGeneration, AssetGenerations, LatestBuild, GENERATION_TOTAL_BYTES, GENERATION_FILE_BYTES } from './asset-generations.mts';
import type { Asset } from './http.mts';

function generation(revision='one',css='body { color: black; }') {
  const assets=new Map<string,Asset>([
    ['/',{type:'text/html',data:Buffer.from('<html><head><link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg"></head><body><script type="module" src="/web/app.js"></script></body></html>')}],
    ['/style.css',{type:'text/css',data:Buffer.from(css)}],['/favicon.svg',{type:'image/svg+xml',data:Buffer.from('<svg/>')}],
    ['/web/app.js',{type:'text/javascript',data:Buffer.from(`import '../shared/api.js'; import './child.js'; export const revision='${revision}';`)}],
    ['/web/child.js',{type:'text/javascript',data:Buffer.from(`export const revision='${revision}';`)}],
    ['/shared/api.js',{type:'text/javascript',data:Buffer.from('export {};')}]
  ]);
  return {assets,imports:new Map<string,string[]>([['/web/app.js', ['../shared/api.js','./child.js']],['/web/child.js',[]],['/shared/api.js',[]]])};
}
const build=(revision='one',css?:string)=>{const input=generation(revision,css);return new AssetGeneration(input.assets,input.imports);};
const deferred=<T,>()=>{let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('a complete generation pins HTML and resolves delayed relative module dependencies to old bytes',()=> {
  const old=build();const generations=new AssetGenerations(old);const page=generations.document();generations.bind(page.client);
  assert.match(page.asset.data.toString(),new RegExp(`/_ui/${old.id}/web/app.js`));
  assert.match(page.asset.data.toString(),new RegExp(`/_ui/${old.id}/style.css`));
  assert.match(page.asset.data.toString(),/meta name="ui-client"/);
  const next=build('two');assert.equal(generations.offer(next,1),true);
  assert.match(generations.asset(old.id,'/web/child.js')?.data.toString()??'',/one/);
  assert.match(generations.asset(next.id,'/web/child.js')?.data.toString()??'',/two/);
  assert.equal(generations.asset('f'.repeat(64),'/web/app.js'),undefined);
  const mutable=old.asset('/web/app.js');mutable?.data.fill(0);
  assert.match(old.asset('/web/app.js')?.data.toString()??'',/one/);
});

test('the manifest hashes exact retained bytes and a newer build removes the older held candidate',()=> {
  const one=build();for(const [route,hash] of Object.entries(one.manifest)) assert.equal(createHash('sha256').update(one.asset(route)?.data??Buffer.alloc(0)).digest('hex'),hash);
  const generations=new AssetGenerations(one);const page=generations.document();generations.bind(page.client);
  generations.offer(build('two'),1);generations.offer(build('three'),2);assert.equal(generations.counts().candidate,1);
  generations.building(3);assert.equal(generations.counts().candidate,0);assert.equal(generations.counts().published,2);assert.ok(generations.asset(one.id,'/web/app.js'));
});

test('missing imports and oversized inputs fail before publication and keep the complete active generation',()=> {
  const generations=new AssetGenerations(build());const before=generations.status();const input=generation();input.assets.delete('/web/child.js');
  assert.throws(()=>new AssetGeneration(input.assets,input.imports),/invalid-assets/);assert.deepEqual(generations.status(),before);
  const large=generation();large.assets.set('/style.css',{type:'text/css',data:Buffer.alloc(2*1024*1024+1)});
  assert.throws(()=>new AssetGeneration(large.assets,large.imports),/invalid-assets/);
  const external=generation();external.imports.set('/web/app.js',['https://elsewhere.invalid/module.js']);
  assert.throws(()=>new AssetGeneration(external.assets,external.imports),/invalid-assets/);
});

test('bootstrap validation rejects missing head and reserves envelope bytes before publication',()=> {
  const missing=generation();missing.assets.set('/',{type:'text/html',data:Buffer.from('<html><body></body></html>')});assert.throws(()=>new AssetGeneration(missing.assets,missing.imports),/invalid-assets/);
  const large=generation();const prefix='<html><head></head><body>';const suffix='</body></html>';
  large.assets.set('/',{type:'text/html',data:Buffer.from(prefix+'x'.repeat(GENERATION_FILE_BYTES-prefix.length-suffix.length)+suffix)});assert.throws(()=>new AssetGeneration(large.assets,large.imports),/capacity/);
  const generations=new AssetGenerations(build());const head=generations.documentHead();assert.equal(generations.counts().clients,0);
  const page=generations.document();assert.equal(head?.data.length,page.asset.data.length);
});

test('active plus previous plus newest candidate are bounded without evicting an active client',()=> {
  const one=build();const generations=new AssetGenerations(one);const page=generations.document();generations.bind(page.client);
  const two=build('two');const three=build('three');const four=build('four');
  assert.equal(generations.offer(two,1),true);assert.equal(generations.offer(three,2),false);assert.equal(generations.offer(four,3),false);
  assert.equal(generations.counts().published,2);assert.equal(generations.counts().candidate,1);
  assert.ok(generations.counts().bytes<=3*GENERATION_TOTAL_BYTES);assert.equal(generations.status().status,'held');
  assert.ok(generations.asset(one.id,'/web/app.js'));assert.equal(generations.asset(three.id,'/web/app.js'),undefined);
  generations.acknowledge(page.client,two.id,two.id);
  assert.equal(generations.status().generation,four.id);assert.equal(generations.asset(one.id,'/web/app.js'),undefined);
  assert.ok(generations.asset(two.id,'/web/app.js'));
});

test('CSS adoption keeps the old JavaScript generation pinned, and stream disconnect does not release it',()=> {
  const one=build();const generations=new AssetGenerations(one);const page=generations.document();let notifications=0;
  const disconnect=generations.subscribe(page.client,()=>{notifications++;});
  const two=build('one','body { color: blue; }');generations.offer(two,1);assert.equal(generations.status().change,'css');
  generations.acknowledge(page.client,one.id,two.id);disconnect();
  assert.equal(generations.offer(build('three'),2),true);assert.equal(generations.offer(build('four'),3),false);assert.ok(generations.asset(one.id,'/web/app.js'));
    generations.release(page.client);assert.equal(generations.status().status,'ready');assert.equal(notifications,2);
});

test('consecutive CSS generations advance in place while old JS aliases retain exact shared bytes',()=> {
  const a=build();const generations=new AssetGenerations(a);const page=generations.document();generations.bind(page.client);
  const js=a.asset('/web/child.js')?.data;const b=build('one','body {color:blue;}');const c=build('one','body {color:green;}');
  assert.equal(generations.offer(b,1),true);generations.acknowledge(page.client,a.id,b.id);
  assert.equal(generations.offer(c,2),true);assert.equal(generations.status().change,'css');assert.equal(generations.status().generation,c.id);
  generations.acknowledge(page.client,a.id,c.id);assert.deepEqual(generations.asset(a.id,'/web/child.js')?.data,js);
  assert.equal(generations.asset(a.id,'/style.css'),undefined);assert.equal(generations.asset(a.id,'/'),undefined);assert.equal(generations.documentHead(a.id),undefined);assert.throws(()=>generations.document(a.id));
  assert.equal(generations.counts().jsPins,1);assert.ok(generations.counts().bytes< a.bytes+b.bytes+c.bytes);
  for(let revision=3;revision<35;revision++) {const next=build('one',`body {opacity:${revision/100};}`);assert.equal(generations.offer(next,revision),true);generations.acknowledge(page.client,a.id,next.id);assert.equal(generations.counts().jsPins,1);assert.ok(generations.counts().bytes<=3*GENERATION_TOTAL_BYTES);}
  const copy=generations.asset(a.id,'/web/app.js');copy?.data.fill(0);assert.deepEqual(generations.asset(a.id,'/web/child.js')?.data,js);assert.match(generations.asset(a.id,'/web/app.js')?.data.toString()??'',/one/);
  generations.release(page.client);assert.equal(generations.counts().jsPins,0);assert.equal(generations.asset(a.id,'/web/child.js'),undefined);
});

test('live JS aliases stay lease-bounded across many CSS pages and release without retained payload growth',()=> {
  const generations=new AssetGenerations(build());const pages:{client:string;generation:string}[]=[];
  for(let revision=0;revision<64;revision++) {
    if(revision) {const next=build('one',`body {opacity:${revision/100};}`);assert.equal(generations.offer(next,revision),true);for(const page of pages) generations.acknowledge(page.client,page.generation,next.id);}
    const document=generations.document();generations.bind(document.client);pages.push(document);
    assert.ok(generations.counts().jsPins<=generations.counts().clients);assert.ok(generations.counts().bytes<=3*GENERATION_TOTAL_BYTES);
    for(const page of pages) assert.ok(generations.asset(page.generation,'/web/child.js'));
  }
  assert.throws(()=>generations.document(),/capacity/);assert.equal(generations.counts().clients,64);assert.equal(generations.counts().jsPins,62);
  for(const page of pages) generations.release(page.client);assert.equal(generations.counts().jsPins,0);assert.equal(generations.counts().clients,0);
});

test('CSS still protects an active old stylesheet and incompatible JS family without eviction',()=> {
  const a=build();const generations=new AssetGenerations(a);const first=generations.document();const second=generations.document();
  generations.bind(first.client);generations.bind(second.client);const b=build('one','body {color:blue;}');const c=build('one','body {color:green;}');
  generations.offer(b,1);generations.acknowledge(first.client,a.id,b.id);assert.equal(generations.offer(c,2),false);assert.equal(generations.status().status,'held');assert.ok(generations.asset(a.id,'/style.css'));
  generations.acknowledge(second.client,a.id,b.id);assert.equal(generations.status().generation,c.id);generations.acknowledge(first.client,a.id,c.id);generations.acknowledge(second.client,a.id,c.id);
  const d=build('different');assert.equal(generations.offer(d,3),true);const e=build('different','body {color:red;}');assert.equal(generations.offer(e,4),false);
  assert.deepEqual(generations.asset(a.id,'/web/child.js')?.data,a.asset('/web/child.js')?.data);assert.throws(()=>generations.acknowledge(first.client,a.id,d.id));
  generations.acknowledge(first.client,d.id,d.id);assert.equal(generations.status().status,'held');assert.ok(generations.asset(a.id,'/web/child.js'));
  generations.acknowledge(second.client,d.id,d.id);assert.equal(generations.status().generation,e.id);assert.equal(generations.asset(a.id,'/web/child.js'),undefined);assert.equal(generations.counts().jsPins,0);assert.ok(generations.counts().bytes<=3*GENERATION_TOTAL_BYTES);
});

test('restart-required is a declaration and incompatible publication stays held',()=> {
  const old=build();const generations=new AssetGenerations(old);const page=generations.document();const statuses:string[]=[];
  generations.subscribe(page.client,state=>{statuses.push(state.status);});
  generations.restartRequired();assert.equal(generations.offer(build('two'),1),false);
  assert.equal(generations.status().generation,old.id);assert.equal(generations.status().status,'restart-required');
  assert.deepEqual(statuses,['ready','restart-required']);assert.equal(generations.counts().clients,1);
});

test('one builder discards stale completion and compiles only the newest dirty revision',async()=> {
  const old=build();const generations=new AssetGenerations(old);const first=deferred<AssetGeneration>();const last=deferred<AssetGeneration>();const calls:number[]=[];
  const builder=new LatestBuild(generations,revision=>{calls.push(revision);return revision===1?first.promise:last.promise;});
  builder.request();for(let i=0;i<100;i++) builder.request();assert.deepEqual(calls,[1]);
  first.resolve(build('stale'));await Promise.resolve();await Promise.resolve();assert.deepEqual(calls,[1,101]);
  assert.equal(generations.status().generation,old.id);last.resolve(build('latest'));await builder.drain();
  assert.equal(generations.status().generation,build('latest').id);assert.deepEqual(calls,[1,101]);
});

test('syntax failure leaves the last good generation and a corrected producer recovers once',async()=> {
  const old=build();const generations=new AssetGenerations(old);let fails=true;let calls=0;
  const builder=new LatestBuild(generations,async()=>{calls++;if(fails) throw new Error('compile');return build('fixed');});
  builder.request();await builder.drain();assert.equal(generations.status().status,'failed');assert.equal(generations.status().generation,old.id);
  fails=false;builder.request();await builder.drain();assert.equal(generations.status().generation,build('fixed').id);assert.equal(calls,2);
});

test('restart lease checks distinguish proven absence from malformed identity and known generation mismatch',()=> {
  const initial=build();const generations=new AssetGenerations(initial);const page=generations.document();generations.bind(page.client);
  assert.equal(generations.checkLease(page.client,page.generation,page.generation,initial.family.id).lease,'present');
  for(const [client,generation,css] of [[page.client,'f'.repeat(64),page.generation],[page.client,page.generation,'f'.repeat(64)],['bad',page.generation,page.generation],['0'.repeat(24),'bad',page.generation]] as const) assert.throws(()=>generations.checkLease(client,generation,css,initial.family.id),/invalid-assets/);
  const restarted=new AssetGenerations(initial);const replacement=restarted.checkLease(page.client,page.generation,page.generation,initial.family.id);assert.equal(replacement.lease,'replaced');assert.equal(restarted.counts().clients,1);
  assert.ok('client' in replacement);assert.notEqual(replacement.client,page.client);
  assert.throws(()=>restarted.acknowledge(page.client,page.generation,page.generation));
  assert.equal(restarted.release(page.client),'absent');assert.throws(()=>restarted.release('bad'));
  assert.equal(generations.release(page.client),'released');assert.equal(generations.release(page.client),'absent');
});
test('missing lease checks respect global fresh-page capacity without admission',()=> {
  const initial=build(),generations=new AssetGenerations(initial);const pages=Array.from({length:64},()=>generations.document());
  const first=pages[0];assert.ok(first);
  assert.throws(()=>generations.checkLease('0'.repeat(24),first.generation,first.generation,initial.family.id),/capacity/);
  assert.equal(generations.counts().clients,pages.length);
});
test('fresh rotation retries stay inside live lease capacity and reject changed predecessors',()=> {
  const initial=build(),generations=new AssetGenerations(initial),old='0'.repeat(24);
  const first=generations.checkLease(old,initial.id,initial.id,initial.family.id);assert.ok('client' in first);
  assert.match(first.client,/^[a-f0-9]{24}$/);assert.notEqual(first.client,old);assert.equal(first.lease,'replaced');
  for(let index=1;index<64;index++) generations.checkLease(index.toString(16).padStart(24,'0'),initial.id,initial.id,initial.family.id);
  assert.equal(generations.counts().clients,64);
  assert.deepEqual(generations.checkLease(old,initial.id,initial.id,initial.family.id),first);
  for(const [js,css,family] of [['f'.repeat(64),initial.id,initial.family.id],[initial.id,'f'.repeat(64),initial.family.id],[initial.id,initial.id,'f'.repeat(64)]]) assert.throws(()=>generations.checkLease(old,js??'',css??'',family??''),/invalid-assets/);
  assert.throws(()=>generations.bind(old),/invalid-assets/);
  assert.throws(()=>generations.checkLease('e'.repeat(24),initial.id,initial.id,initial.family.id),/capacity/);
  assert.equal(generations.counts().clients,64);generations.acknowledge(first.client,initial.id,initial.id);
  assert.deepEqual(generations.checkLease(old,initial.id,initial.id,initial.family.id),first);
});
test('CSS-history rotation pins exact module and favicon aliases but never HTML or CSS and releases publication pressure',()=> {
  const a=build(),b=build('one','body {color:blue;}'),generations=new AssetGenerations(b),old='0'.repeat(24);
  assert.equal(a.family.id,b.family.id);
  const replacement=generations.checkLease(old,a.id,b.id,a.family.id);assert.ok('client' in replacement);
  assert.equal(replacement.build.change,'css');assert.deepEqual(generations.asset(a.id,'/web/child.js'),b.asset('/web/child.js'));
  assert.deepEqual(generations.asset(a.id,'/favicon.svg'),b.asset('/favicon.svg'));
  for(const route of ['/','/index.html','/style.css']) assert.equal(generations.asset(a.id,route),undefined);
  assert.equal(generations.documentHead(a.id),undefined);assert.throws(()=>generations.document(a.id));
  generations.acknowledge(replacement.client,a.id,b.id);
  const c=build('different');assert.equal(generations.offer(c,1),true);
  const before=generations.counts();assert.throws(()=>generations.checkLease('1'.repeat(24),a.id,c.id,c.family.id),/invalid-assets/);assert.deepEqual(generations.counts(),before);
  const notifications:string[]=[];generations.subscribe(replacement.client,status=>notifications.push(status.change));assert.deepEqual(notifications,['reload']);
  assert.equal(generations.offer(build('newest'),2),false);assert.equal(generations.status().status,'held');
  generations.release(replacement.client);assert.equal(generations.counts().clients,0);assert.equal(generations.counts().jsPins,0);assert.equal(generations.status().status,'ready');assert.equal(generations.asset(a.id,'/web/child.js'),undefined);
});
test('predecessor release removes an unadopted reservation, its aliases and its publication hold',()=> {
  const a=build(),b=build('one','body{color:blue}'),generations=new AssetGenerations(b),old='0'.repeat(24);
  const reserved=generations.checkLease(old,a.id,b.id,a.family.id);assert.ok('client' in reserved);
  assert.deepEqual(generations.checkLease(old,a.id,b.id,a.family.id),reserved);assert.equal(generations.counts().clients,1);assert.equal(generations.counts().jsPins,1);
  assert.throws(()=>generations.acknowledge(reserved.client,'f'.repeat(64),b.id),/invalid-assets/);
  assert.equal(generations.offer(build('one','body{color:green}'),1),true);assert.equal(generations.offer(build('one','body{color:purple}'),2),false);
  assert.equal(generations.status().status,'held');assert.equal(generations.counts().clients,1);
  assert.equal(generations.release(old),'absent');assert.equal(generations.counts().clients,0);assert.equal(generations.counts().jsPins,0);assert.equal(generations.status().status,'ready');assert.equal(generations.counts().candidate,0);
  for(const route of ['/web/child.js','/favicon.svg','/','/index.html','/style.css'])assert.equal(generations.asset(a.id,route),undefined);
  assert.equal(generations.release(old),'absent');
});
test('stale predecessor release never removes a replacement after a valid request under its new identity',()=> {
  for(const adoption of ['ack','lease','stream']) {
    const a=build(),b=build('one','body{color:blue}'),generations=new AssetGenerations(b),old='0'.repeat(24);
    const reserved=generations.checkLease(old,a.id,b.id,a.family.id);assert.ok('client' in reserved);
    if(adoption==='ack')generations.acknowledge(reserved.client,a.id,b.id);
    if(adoption==='lease')assert.equal(generations.checkLease(reserved.client,a.id,b.id,a.family.id).lease,'present');
    if(adoption==='stream')generations.subscribe(reserved.client,()=>{})();
    assert.equal(generations.release(old),'absent');assert.equal(generations.counts().clients,1);assert.equal(generations.counts().jsPins,1);
    assert.equal(generations.release(old),'absent');assert.equal(generations.checkLease(old,a.id,b.id,a.family.id).lease,'replaced');
    const retry=generations.checkLease(old,a.id,b.id,a.family.id);assert.ok('client' in retry);assert.equal(retry.client,reserved.client);assert.equal(generations.counts().clients,1);
    assert.equal(generations.offer(build('one','body{color:green}'),1),true);assert.equal(generations.offer(build('one','body{color:purple}'),2),false);assert.equal(generations.release(old),'absent');assert.equal(generations.status().status,'held');
    assert.equal(generations.release(reserved.client),'released');assert.equal(generations.counts().clients,0);assert.equal(generations.counts().jsPins,0);assert.equal(generations.status().status,'ready');
  }
});
test('unadopted predecessor cleanup restores global rotation capacity',()=> {
  const capacity=64,a=build(),generations=new AssetGenerations(a),identities=Array.from({length:capacity},(_,index)=>({client:index.toString(16).padStart(24,'0')}));
  for(const identity of identities)generations.checkLease(identity.client,a.id,a.id,a.family.id);
  const fresh='f'.repeat(24);assert.throws(()=>generations.checkLease(fresh,a.id,a.id,a.family.id),/capacity/);
  const first=identities[0];assert.ok(first);assert.equal(generations.release(first.client),'absent');assert.equal(generations.counts().clients,capacity-1);
  assert.equal(generations.checkLease(fresh,a.id,a.id,a.family.id).lease,'replaced');assert.equal(generations.counts().clients,capacity);
  for(const identity of identities)generations.release(identity.client);generations.release(fresh);assert.equal(generations.counts().clients,0);
});
test('unknown incompatible bytes require the existing missing-lease update path without an alias or replacement',()=> {
  const old=build(),current=build('different'),generations=new AssetGenerations(current);
  assert.equal(generations.checkLease('0'.repeat(24),old.id,old.id,old.family.id).lease,'missing');assert.equal(generations.counts().clients,0);assert.equal(generations.counts().jsPins,0);
  assert.throws(()=>generations.checkLease('0'.repeat(24),old.id,current.id,old.family.id),/invalid-assets/);
  assert.throws(()=>generations.checkLease('0'.repeat(24),old.id,old.id,'bad'),/invalid-assets/);
});
test('bootstrap family metadata reserves its complete byte envelope at the document boundary',()=> {
  const probe=new AssetGenerations(build()).document(),metadata=probe.asset.data.toString().match(/<meta name="ui-generation"[\s\S]*?<meta name="ui-module-family" content="([a-f0-9]{64})">/)?.[0];assert.ok(metadata);
  const overhead=Buffer.byteLength(metadata),prefix='<html><head></head><body>',suffix='</body></html>';
  for(const extra of [0,1]) {const input=generation();input.assets.set('/',{type:'text/html',data:Buffer.from(prefix+'x'.repeat(GENERATION_FILE_BYTES-overhead-prefix.length-suffix.length+extra)+suffix)});
    if(extra) assert.throws(()=>new AssetGeneration(input.assets,input.imports),/capacity/);
    else {const generation=new AssetGeneration(input.assets,input.imports),generations=new AssetGenerations(generation),page=generations.document();assert.equal(page.asset.data.length,GENERATION_FILE_BYTES);assert.equal(generations.documentHead()?.data.length,page.asset.data.length);assert.match(page.asset.data.toString(),new RegExp(`name="ui-module-family" content="${generation.family.id}"`));}
  }
});
test('page admission is bounded and never silently removes a prior page lease',()=> {
  const generations=new AssetGenerations(build());const pages=Array.from({length:64},()=>generations.document());
  assert.throws(()=>generations.document(),/capacity/);assert.equal(generations.counts().clients,64);
  for(const page of pages) generations.bind(page.client);assert.throws(()=>generations.bind('missing'),/invalid-assets/);
  generations.release(pages[0]?.client??'');assert.equal(generations.counts().clients,63);
});
