import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scripts} from './load.mts';
test('product fixtures expose safe link/code markup with exact visible-text maps',()=>{
 let host:ReaderMemoryHost|undefined;
 const context=scripts(['app/host/native.ts','app/core/exact.ts','app/core/source-model.ts','test/fixtures.ts','test/host-memory.ts','test/product-host.ts'],{
  reader:{boot(value:ReaderMemoryHost){host=value;return {controller:{},editor:{},ui:{}};}},document:{documentElement:{dataset:{}}}
 });
 assert.ok(context.readerProduct);assert.ok(host);
 const payload=host.document,rich=payload.blocks.find(block=>block.html?.includes('<a href=')),code=payload.blocks.find(block=>block.type==='code');
 assert.ok(rich?.html);assert.ok(code?.html);assert.match(rich.html,/<a href="https:\/\/example\.test">a link<\/a>/);assert.match(rich.html,/<code>code<\/code>/);assert.match(code.html,/<pre><code class="language-typescript">/);
 for(const block of [rich,code]){
  const visible=(block.html??'').replace(/<[^>]*>/g,'');assert.ok(block.map?.length);
  for(const [rendered,length,source,sourceLength] of block.map)assert.equal(visible.slice(rendered,rendered+length),payload.source.slice(source,source+sourceLength));
 }
 host.dispose();
});
