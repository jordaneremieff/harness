import assert from 'node:assert/strict';
import test from 'node:test';
import {fileCandidates, fileReference, ReferenceResolver} from './references.ts';
import {fileLineTarget, FileView} from './file-view.ts';
import {FileOwner} from './file-owner.ts';
import {createAppFixture} from './app-fixture.mts';
import {markdownDom} from './safe-markdown.ts';
import {presentArguments} from './generic-content.ts';
import type {FileTab} from '../shared/api.ts';
import {primaryBlocks} from './state.ts';
import {tabKey} from './tabs.ts';
const f = await createAppFixture();
const {app,arrive,settle,HostNode,byId,primaryControl,primaryFixture,targetFixture,entryFixture,messageFixture,textPart} = f;
const root = {id:'r',path:'/r',name:'r'};
test('file candidates retain original syntax and resolve only root-contained paths with extensions',()=> {
  for (const [text,line] of [['ui/web/app.ts:1318',1318],['ui/web/app.ts:1318:5',1318],['ui/web/app.ts:12-20',12],['ui/web/app.ts#L12',12],['ui/web/app.ts#L12-L20',12],['/r/ui/web/app.ts:7',7],['./note.md',undefined]] as const) {
    const candidates=fileCandidates(`See (${text}).`,root);assert.equal(candidates.length,1);assert.equal(candidates[0]?.text,text);assert.deepEqual(candidates[0]?.destination,{rootId:'r',path:text.startsWith('./')?'note.md':'ui/web/app.ts',...(line?{line}:{})});
  }
  for (const text of ['https://x/y.ts:3','file:///r/y.ts:3','10:30','../x.ts:2','a/../x.ts:2','/elsewhere/x.ts:2','/root/x.ts:2','//r/x.ts:2','x.ts:0','no-extension:2','1.2.0','3.14','e.g.','i.e.','GPT-6.1','Node.js','README.md','ui/app.2','x.ts:9007199254740992','```ts\nx.ts:2\n```','~~~\nx.ts:2\n~~~']) assert.deepEqual(fileCandidates(text,root),[],text);
  assert.equal(fileCandidates('```\nx.ts:2\n```\ny.ts:3',root)[0]?.text,'y.ts:3');
  for (const [text,path,line] of [['ui/web/app.ts','ui/web/app.ts',undefined],['app.ts:12','app.ts',12],['README.md#L3','README.md',3],['/r/note.md','note.md',undefined]] as const) assert.deepEqual(fileCandidates(text,root)[0]?.destination,{rootId:'r',path,...(line?{line}:{})});
  for (const path of ['Makefile','LICENSE','folder/Makefile','/r/LICENSE']) assert.deepEqual(fileReference(path,root),{rootId:'r',path:path.replace('/r/','')});
  for (const path of ['../Makefile','/elsewhere/LICENSE','https://x/LICENSE']) assert.equal(fileReference(path,root),undefined);
});
test('file decoration preserves exact prose and inline code, skips fences and summary, and revalidates the root',()=> {
  let current=root;const opened:unknown[]=[];
  const resolver=new ReferenceResolver(()=>({reason:'not loaded'}),()=>{}, {root:()=>current,navigate:value=>opened.push(value)});
  const host=new HostNode('div');host.className='message-text';byId('workspace').append(host);
  const text='See ui/web/app.ts:12 and `note.md#L7`.\n\n```ts\nfenced.ts:2\n```';host.append(markdownDom(text) as unknown as InstanceType<typeof HostNode>);
  resolver.decorate(host as unknown as HTMLElement,()=>true);const links=host.querySelectorAll('.file-reference');assert.equal(links.length,2);assert.equal(links[0]?.textContent,'ui/web/app.ts:12');assert.match(host.textContent,/fenced.ts:2/);assert.equal(host.querySelector('pre')?.querySelector('a'),null);
  links[0]?.click();assert.deepEqual(opened,[{rootId:'r',path:'ui/web/app.ts',line:12}]);current={...root,id:'other'};links[0]?.click();assert.equal(opened.length,1);
  const summary=new HostNode('summary');summary.append(new HostNode('#text'));if(summary.firstChild)summary.firstChild.textContent='note.md:3';host.append(summary);resolver.decorate(host as unknown as HTMLElement,()=>true);assert.equal(summary.querySelector('a'),null);host.remove();
});
test('argument path links preserve field text and raw data without a summary control',()=> {
  const resolver=new ReferenceResolver(()=>({reason:'not loaded'}),()=>{}, {root:()=>root,navigate:()=>{}});
  const args={value:{path:'ui/web/app.ts',offset:12,content:'exact content'},truncated:false};const before=JSON.stringify(args);
  const context={bounded:(text:string)=>text,inspection:()=>new HostNode('details')} as unknown as Parameters<typeof presentArguments>[1];
  const node=presentArguments(args,context,undefined,{filePath:text=>resolver.renderFile(text,()=>true,12)}) as unknown as InstanceType<typeof HostNode>;assert.ok(node);
  assert.equal(node.querySelector('.file-reference')?.textContent,'ui/web/app.ts');assert.equal(JSON.stringify(args),before);assert.equal(node.querySelector('summary')?.querySelector('a'),null);
});
test('native source line navigation clamps, leaves no selection, saves only pixels, and clears the band',async t=> {
  const style=globalThis.getComputedStyle;globalThis.getComputedStyle=(()=>({lineHeight:'20px',paddingTop:'8px'})) as typeof getComputedStyle;t.after(()=>{globalThis.getComputedStyle=style;});
  const text=Array.from({length:100},(_,i)=>`Line ${i+1}`).join('\n'),tab:FileTab={kind:'file',rootId:'r',path:'note.ts'};let view:FileView;const saved:unknown[]=[];
  const owner=new FileOwner('w',tab,async()=>({rootId:'r',path:tab.path,text,revision:{size:text.length,mtimeMs:1,digest:'a'.repeat(64)}}),()=>view?.paint());view=new FileView(owner,undefined,value=>saved.push(value));byId('workspace').append(view.root as unknown as InstanceType<typeof HostNode>);view.root.hidden=false;view.root.inert=false;t.after(()=>view.destroy());await owner.load();await settle();
  const editor=view.editor;assert.ok(editor);view.revealLine(40);await settle();const wanted=fileLineTarget(text,40);assert.deepEqual([editor.selectionStart,editor.selectionEnd],[wanted.start,wanted.start]);const y=8+39*20-editor.scrollTop;assert.ok(y/editor.clientHeight>=.2&&y/editor.clientHeight<=.5);assert.equal(view.root.querySelector<HTMLElement>('.file-line-band')?.hidden,false);assert.ok(saved.length);assert.deepEqual(Object.keys(saved[0] as object),['scrollTop','scrollLeft']);
  editor.scrollTop++;(editor as unknown as InstanceType<typeof HostNode>).dispatch('scroll');assert.equal(view.root.querySelector<HTMLElement>('.file-line-band')?.hidden,true);
  view.revealLine(999);await settle();assert.deepEqual([editor.selectionStart,editor.selectionEnd],[fileLineTarget(text,999).start,fileLineTarget(text,999).start]);assert.equal(fileLineTarget(text,999).line,100);
  (editor as unknown as InstanceType<typeof HostNode>).dispatch('input');assert.equal(view.root.querySelector<HTMLElement>('.file-line-band')?.hidden,true);
  t.mock.timers.enable({apis:['setTimeout']});view.revealLine(10);await settle();assert.equal(view.root.querySelector<HTMLElement>('.file-line-band')?.hidden,false);t.mock.timers.tick(3000);assert.equal(view.root.querySelector<HTMLElement>('.file-line-band')?.hidden,true);
});
test('message file activation uses the existing source tab in its pane and keeps original Copy and raw text',async t=> {
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});const target={kind:'primary' as const,key:'p',epoch:1502},text='See `ui/web/app.ts:12-20`.\n\n```ts\nui/web/app.ts:99\n```';
  globalThis.fetch=async(input,init)=> {const url=new URL(String(input),'http://ui.test');if(url.pathname.endsWith('/draft')&&url.pathname.includes('/files/'))return Response.json({ok:true,data:{revision:0,draft:null}});if(url.pathname.endsWith('/text')){const source=Array.from({length:60},(_,i)=>`Line ${i+1}`).join('\n');return Response.json({ok:true,data:{rootId:'/fixture/project',path:url.searchParams.get('path'),text:source,revision:{size:source.length,mtimeMs:1,digest:'a'.repeat(64)}}});}return previous(input,init);};
  const existing:FileTab={kind:'file',rootId:'/fixture/project',path:'ui/web/app.ts'};
  const layout={focusedPane:'primary-pane',root:{kind:'split' as const,id:'file-link-split',axis:'x' as const,ratio:50,first:{kind:'pane' as const,id:'primary-pane',tabs:[{kind:'primary' as const}],active:'primary'},second:{kind:'pane' as const,id:'source-pane',tabs:[existing],active:tabKey(existing)}}};
  await arrive({workspace:{id:'file-link-app',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:layout},primaries:[primaryFixture({epoch:1502})],roster:[],targets:[targetFixture('file-link-target',target)],history:[entryFixture('file-link-ask',[{...messageFixture('file-link-question',[textPart('Question')]),role:'user'}]),entryFixture('file-link-entry',[messageFixture('file-link-message',[textPart(text)])])]});await settle();
  let copied='';const navigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async(value:string)=>{copied=value;}}}});t.after(()=>{if(navigator)Object.defineProperty(globalThis,'navigator',navigator);else Reflect.deleteProperty(globalThis,'navigator');});
  const transcript=primaryControl('transcript'),link=transcript.querySelector('.file-reference');assert.ok(link,transcript.textContent);assert.equal(transcript.querySelector('pre')?.querySelector('.file-reference'),null);const original=primaryBlocks(app.state,'p').find(entry=>entry.id==='file-link-entry');
  transcript.querySelector('.assistant-turn-actions')?.querySelectorAll('button').find(node=>node.textContent==='Copy')?.click();await settle();assert.equal(copied,text);
  link.click();await settle();const workspace=app.state.workspace;assert.ok(workspace);const tab:FileTab={kind:'file',rootId:'/fixture/project',path:'ui/web/app.ts'},view=app.filesViews.view(workspace,tab);assert.equal(workspace.conversationLayout?.focusedPane,'source-pane');assert.deepEqual(workspace.conversationLayout?.root,layout.root);assert.equal(view.root.hidden,false);assert.equal(view.preview,false);assert.equal(view.editor?.selectionStart,view.editor?.selectionEnd);assert.equal(view.editor?.selectionStart,fileLineTarget(view.editor?.value??'',12).start);assert.equal(original?.messages?.[0]?.parts[0]?.type,'text');
});
for (const [name,field,path,offset,line] of [['read','file_path','Makefile',40,40],['read','path','LICENSE',undefined,1],['edit','path','LICENSE',40,undefined],['write','path','ui/web/app.ts',40,undefined]] as const) test(`${name} open Arguments links ${path} with only its read offset`,async()=> {
  const target={kind:'primary' as const,key:'p',epoch:1503},args={[field]:path,...(offset!==undefined?{offset}:{})};
  await arrive({workspace:{id:`file-link-tool-${name}`,revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:1503})],roster:[],targets:[targetFixture(`file-link-tool-target-${name}`,target)],history:[entryFixture(`entry-${name}`,[messageFixture(`message-${name}`,[{type:'toolCall',callId:`call-${name}`,name,arguments:{value:args,truncated:false}}])])]});await settle();
  const transcript=primaryControl('transcript'),card=transcript.querySelector('.tool-card');assert.ok(card);card.open=true;card.dispatch('toggle');await settle();
  const argumentsNode=transcript.querySelector('.tool-arguments');assert.ok(argumentsNode);argumentsNode.open=true;argumentsNode.dispatch('toggle');await settle();
  const link=argumentsNode.querySelector('.file-reference');assert.ok(link,argumentsNode.textContent);assert.equal(link.textContent,path);
  const destination=JSON.parse(decodeURIComponent(String(Reflect.get(link,'href')).split('=')[1]??''));assert.deepEqual(destination,{rootId:'/fixture/project',path,...(line!==undefined?{line}:{})});assert.equal(transcript.querySelectorAll('summary').some(summary=>!!summary.querySelector('.file-reference')),false);assert.equal(argumentsNode.querySelector('pre')?.textContent,JSON.stringify(args,null,2));
});
test('missing file navigation leaves no latent line or focus after the file appears',async t=> {
  const previous=globalThis.fetch;let missing=true;t.after(()=>{globalThis.fetch=previous;});
  globalThis.fetch=async(input,init)=> {
    const url=new URL(String(input),'http://ui.test');
    if(url.pathname.includes('/files/')&&url.pathname.endsWith('/draft'))return Response.json({ok:true,data:{revision:0,draft:null}});
    if(url.pathname.endsWith('/text')) {
      if(missing)return Response.json({ok:false,error:{code:'file_missing',message:'File is missing.',retry:'read'}},{status:404});
      const text=Array.from({length:80},(_,index)=>`Line ${index+1}`).join('\n');return Response.json({ok:true,data:{rootId:'/fixture/project',path:'later.ts',text,revision:{size:text.length,mtimeMs:1,digest:'a'.repeat(64)}}});
    }
    return previous(input,init);
  };
  const target={kind:'primary' as const,key:'p',epoch:1504};
  await arrive({workspace:{id:'file-link-missing',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:1504})],roster:[],targets:[targetFixture('file-link-missing-target',target)],history:[entryFixture('missing-entry',[messageFixture('missing-message',[textPart('later.ts:40')])])]});await settle();
  primaryControl('transcript').querySelector('.file-reference')?.click();await settle();const workspace=app.state.workspace;assert.ok(workspace);const view=app.filesViews.view(workspace,{kind:'file',rootId:'/fixture/project',path:'later.ts'});assert.equal(view.owner.text,undefined);assert.match(view.root.textContent??'',/File is missing/);
  f.hostDocument.body.focus();missing=false;await view.owner.load(true);await settle();assert.ok(view.owner.text);assert.equal(view.editor?.selectionStart,0);assert.equal(view.editor?.selectionEnd,0);assert.equal(f.hostDocument.activeElement,f.hostDocument.body);assert.equal(view.root.querySelector<HTMLElement>('.file-line-band')?.hidden,true);
});
