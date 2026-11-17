import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scripts} from '../../test/load.mts';
function bridge(){return scripts(['app/host/native.ts']).reader as ReaderNamespace;}
test('classic host sends exact versioned envelopes and matches reply IDs',async()=>{
 const api=bridge();const host=api.createNativeHost(m=>({v:1,type:'reply',id:m.id,ok:true,generation:0,blocks:[]}));
 const reply=await host.request('render',{generation:0}) as Record<string,unknown>;assert.equal(reply.generation,0);host.dispose();
});
test('unknown version, type and command refuse without dispatch',()=>{
 const api=bridge(),host=api.createNativeHost(()=>undefined);let count=0;host.on('command',()=>count++);
 assert.equal(api.receive({v:2,type:'command',name:'undo'}),false);assert.equal(api.receive({v:1,type:'invented'}),false);assert.equal(api.receive({v:1,type:'command',name:'invented'}),false);assert.equal(count,0);host.dispose();
});
test('malformed and mismatched replies reject requests',async()=>{
 const api=bridge(),host=api.createNativeHost(()=>({v:1,type:'reply',id:'wrong',ok:true}));await assert.rejects(host.request('render',{generation:0}),/Unexpected reader reply/);host.dispose();
});
test('disposal rejects pending requests',async()=>{
 const api=bridge(),host=api.createNativeHost(()=>new Promise(()=>{}));const pending=host.request('render',{generation:0});host.dispose();await assert.rejects(pending,/disposed/);
});
test('ready and format use the current command vocabulary',()=>{
 const api=bridge();assert.equal(api.bridge.page({v:1,type:'ready',version:'reader',capabilities:{lock:true}}).v,1);
 assert.equal(api.bridge.native({v:1,type:'command',name:'format',args:{command:'heading',level:2}}).type,'command');
 assert.throws(()=>api.bridge.native({v:1,type:'command',name:'format',args:{command:'heading',level:7}}));
});
test('ordinary messages enforce their exact byte bound',()=>{
 const api=bridge(),base={v:1,type:'command',name:'copy',args:{text:''}};const overhead=Buffer.byteLength(JSON.stringify(base));base.args.text='a'.repeat(256*1024-overhead);assert.equal(api.bridge.page(base).type,'command');base.args.text+='a';assert.throws(()=>api.bridge.page(base),/byte limit/);
});
