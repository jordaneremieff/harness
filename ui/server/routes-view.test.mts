import assert from 'node:assert/strict';
import test from 'node:test';
import {LIMITS, type ConversationLayout, type Workspace} from '../shared/api.ts';
import type {Registry} from './registry.mts';
import {dispatchView} from './routes-view.mts';

function layout(): ConversationLayout {
  return {root:{kind:'pane',id:'pane',tabs:[{kind:'agent',identity:'a'}],active:'agent:a'},focusedPane:'pane'};
}
function fixture(observation?:Promise<void>) {
  let workspace:Workspace={id:'w',revision:0,panelVisible:true,selectedTarget:{kind:'agent',identity:'a'},conversationLayout:layout()};
  const changes:unknown[]=[];let observed=0;
  const registry={store:{workspace:async()=>workspace,target:async()=>undefined,
    updateSelection:async(_id:string,change:Partial<Workspace>)=>{changes.push(change);workspace={...workspace,...change};return workspace;}},
    saved:new Map(),observe:async()=>{observed++;await observation;}} as unknown as Registry;
  return {changes,get observed(){return observed;},select:(body:Record<string,unknown>)=>dispatchView(registry,{parts:['api','workspaces','w','selection'],body,method:'PUT',url:new URL('http://localhost/api/workspaces/w/selection')})};
}
test('pure concurrent layout replacement validates and clones one tree without focus or panel ownership',async()=> {
  const f=fixture();const conversationLayout=layout();const original=structuredClone(conversationLayout);
  const saved=await f.select({expectedRevision:0,conversationLayout,selectedTarget:{kind:'agent',identity:'a'}}) as Workspace;
  assert.deepEqual(saved.conversationLayout,original);assert.equal(f.observed,1);
  conversationLayout.root={kind:'pane',id:'empty',tabs:[],active:null};assert.deepEqual(f.changes,[{expectedRevision:0,conversationLayout:original,selectedTarget:{kind:'agent',identity:'a'}}]);
  const preserved=await f.select({expectedRevision:0,sidebarVisible:false,panelVisible:false,selectedTarget:null}) as Workspace;
  assert.deepEqual(preserved.conversationLayout,original);assert.equal(f.observed,2);
  const empty:ConversationLayout={root:{kind:'pane',id:'empty',tabs:[],active:null},focusedPane:'empty'};
  await f.select({expectedRevision:0,conversationLayout:empty});assert.equal(f.observed,3);
});
test('pure concurrent selection responds before observation setup completes',{timeout:1000},async()=> {
  let release!:()=>void;let completed=false;
  const observation=new Promise<void>(resolve=>{release=resolve;}).then(()=>{completed=true;});
  const f=fixture(observation);
  try {
    const saved=await f.select({expectedRevision:0,conversationLayout:layout()}) as Workspace;
    assert.deepEqual(saved.conversationLayout,layout());assert.equal(f.observed,1);assert.equal(completed,false);
  } finally {release();await observation;}
});
test('pure concurrent layout admits the conversation bound and bounded split ratios',async()=> {
  const f=fixture();
  for(const ratio of [20,80]) {
    const conversationLayout:ConversationLayout={root:{kind:'split',id:'split',axis:'y',ratio,
      first:{kind:'pane',id:'first',tabs:Array.from({length:LIMITS.conversationTabs-1},(_,i)=>({kind:'agent',identity:`a${i}`})),active:'agent:a0'},
      second:{kind:'pane',id:'second',tabs:[{kind:'primary'}],active:'primary'}},focusedPane:'second'};
    assert.deepEqual((await f.select({expectedRevision:0,conversationLayout}) as Workspace).conversationLayout,conversationLayout);
  }
});
test('pure concurrent malformed closed trees reject before state or observation changes',async()=> {
  const f=fixture();const one=layout();const invalid:unknown[]=[null,[],{}, {...one,unknown:true},{...one,focusedPane:'missing'},
    {...one,root:{...one.root,active:'missing'}},{...one,root:{kind:'pane',id:'pane',tabs:[],active:'primary'}},
    {...one,root:{kind:'pane',id:'pane',tabs:[{kind:'primary'},{kind:'primary'}],active:'primary'}},
    {...one,root:{kind:'pane',id:'pane',tabs:[{kind:'agent',identity:'bad\nidentity'}],active:'agent:bad\nidentity'}},
    {...one,root:{kind:'pane',id:'pane',tabs:Array.from({length:LIMITS.conversationTabs+1},(_,i)=>({kind:'agent',identity:`a${i}`})),active:'agent:a0'}},
    {tabs:[{kind:'primary'}],active:0,splitRatio:50}];
  for(const conversationLayout of invalid) await assert.rejects(f.select({expectedRevision:0,conversationLayout}));
  assert.deepEqual(f.changes,[]);assert.equal(f.observed,0);
});
test('Enter preference admits booleans only and preserves omission',async()=> {
  const f=fixture();
  assert.equal((await f.select({expectedRevision:0,enterSendsMessages:true}) as Workspace).enterSendsMessages,true);
  assert.equal((await f.select({expectedRevision:0,appearance:'light'}) as Workspace).enterSendsMessages,true);
  assert.equal((await f.select({expectedRevision:0,enterSendsMessages:false}) as Workspace).enterSendsMessages,false);
  for(const enterSendsMessages of [null,'true',0,{},[]]) await assert.rejects(f.select({expectedRevision:0,enterSendsMessages}),/Enter preference/);
  assert.equal(f.observed,3);
});
test('appearance and sidebar values retain exact validation without changing observation ownership',async()=> {
  const f=fixture();const choices=['dark','light','system','latte','frappe','macchiato','mocha'] as const;
  for(const appearance of choices) assert.equal((await f.select({expectedRevision:0,appearance}) as Workspace).appearance,appearance);
  await assert.rejects(f.select({expectedRevision:0,appearance:'unknown'}),/appearance/);
  for(const sidebarWidth of [200,264,480]) assert.equal((await f.select({expectedRevision:0,sidebarWidth}) as Workspace).sidebarWidth,sidebarWidth);
  for(const sidebarWidth of [null,'264',199,481,200.5,NaN,Infinity,{},[]]) await assert.rejects(f.select({expectedRevision:0,sidebarWidth}),/sidebar width/);
  for(const sidebarVisible of [null,'false',0,{},[]]) await assert.rejects(f.select({expectedRevision:0,sidebarVisible}),/sidebar visibility/);
  assert.equal(f.observed,10);
});
