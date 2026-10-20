import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {FileMentionMenu} from './file-mention.ts';
import type {FileSearchResult, FileSearchRow} from '../shared/files.ts';
class Node {
  id = ''; tag = ''; className = ''; value = ''; hidden = false; disabled = false; title = ''; selectionStart = 0; selectionEnd = 0; scrolled = false; scrollTop = 0;
  children: Node[] = []; attrs = new Map<string,string>(); handlers = new Map<string,Array<(event: Record<string,unknown>)=>void>>(); text = '';
  classList = {add: (name: string) => {this.className += ` ${name}`;}};
  get textContent(): string {return this.text + this.children.map(node=>node.textContent).join('');}
  set textContent(text: string) {this.text = text; this.children = [];}
  append(...nodes: Node[]): void {this.children.push(...nodes);}
  replaceChildren(...nodes: Node[]): void {this.text = ''; this.children = nodes;}
  setAttribute(key: string, value: string): void {this.attrs.set(key,value);}
  removeAttribute(key: string): void {this.attrs.delete(key);}
  querySelectorAll(selector: string): Node[] {return this.children.flatMap(node=>[...(selector === '[role="option"]' && node.attrs.get('role') === 'option' ? [node] : []),...node.querySelectorAll(selector)]);}
  contains(node: Node): boolean {return this === node || this.children.some(child=>child.contains(node));}
  scrollIntoView(): void {this.scrolled = true;}
  addEventListener(key: string, fn: (event: Record<string,unknown>)=>void): void {this.handlers.set(key,[...this.handlers.get(key) ?? [],fn]);}
  removeEventListener(key: string, fn: (event: Record<string,unknown>)=>void): void {this.handlers.set(key,(this.handlers.get(key) ?? []).filter(item=>item !== fn));}
  fire(key: string, event: Record<string,unknown> = {}): void {for(const fn of this.handlers.get(key) ?? [])fn(event);}
}
const original = Object.getOwnPropertyDescriptor(globalThis,'document');
afterEach(()=>{if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');});
const row = (name: string, kind: 'file'|'directory' = 'file'): FileSearchRow => ({name,path:`src/${name}`,kind});
const result = (rows: FileSearchRow[], complete = true): FileSearchResult => ({rows,more:!complete,coverage:{complete,visited:rows.length,...(complete?{}:{reason:'Search limit reached.'})}} as FileSearchResult);
function fixture(context: test.TestContext) {
  context.mock.timers.enable({apis:['setTimeout']}); const editor = new Node(),menu = new Node(),announcement = new Node();menu.id = 'files';
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>Object.assign(new Node(),{tag}),createElementNS:(_ns:string,tag:string)=>Object.assign(new Node(),{tag}),getElementById:()=>announcement}});
  let pending = Promise.withResolvers<FileSearchResult>();const calls: Array<{query:string;signal:AbortSignal}> = [],accepted: FileSearchRow[] = [];
  const controller = new FileMentionMenu(editor as unknown as HTMLTextAreaElement,menu as unknown as HTMLElement,{search(query,signal){calls.push({query,signal});return pending.promise;},accept(_token,item){accepted.push(item);}});
  const text = (value:string)=>{editor.value=value;editor.selectionStart=editor.selectionEnd=value.length;editor.fire('focus');controller.update();context.mock.timers.tick(80);};
  const key = (key:string,extra = {})=>{const event={key,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};return controller.key(event as unknown as KeyboardEvent);};
  const settle = async(value:FileSearchResult)=>{pending.resolve(value);await pending.promise;await Promise.resolve();};
  return {editor,menu,controller,calls,accepted,announcement,text,key,settle,next(){pending=Promise.withResolvers<FileSearchResult>();return pending;}};
}
test('file headers never enter option indexes, active references or pointer acceptance',async context=>{
  const f=fixture(context);f.text('@comp');await f.settle(result([row('composer.ts'),row('composer.test.mts')]));
  const header=f.menu.children[0];assert.equal(header?.textContent,'Working-folder files');assert.equal(header?.attrs.get('role'),'presentation');assert.equal(header?.attrs.get('aria-hidden'),'true');
  const options=f.menu.querySelectorAll('[role="option"]');assert.equal(options.length,2);assert.equal(f.editor.attrs.get('aria-activedescendant'),options[0]?.id);assert.equal(header?.scrolled,false);
  f.menu.scrollTop=120; f.key('Escape'); assert.equal(f.menu.scrollTop,0); f.controller.reset(); f.text('@comp'); await f.settle(result([row('composer.ts'),row('composer.test.mts')]));
  f.key('ArrowDown');let active=f.menu.querySelectorAll('[role="option"]')[1];assert.equal(f.editor.attrs.get('aria-activedescendant'),active?.id);assert.equal(active?.scrolled,true);f.key('ArrowUp');f.key('Tab');assert.equal(f.accepted[0]?.name,'composer.ts');
  f.controller.reset();f.text('@comp');await f.settle(result([row('composer.ts'),row('composer.test.mts')]));active=f.menu.querySelectorAll('[role="option"]')[1];let prevented=false;active?.fire('pointerdown',{preventDefault(){prevented=true;}});active?.fire('click');assert.equal(prevented,true);assert.equal(f.accepted[1]?.name,'composer.test.mts');assert.equal(f.editor.value,'@comp');
});
test('file names emphasize literal fragments only and retain path descriptions and directory semantics',async context=>{
  const f=fixture(context);f.text('@src/comp');await f.settle(result([row('Composer.ts'),row('cmp.ts'),row('components','directory')]));
  const options=f.menu.querySelectorAll('[role="option"]');const labels=options.map(node=>node.children[0]?.children[1]);
  assert.equal(labels[0]?.children.find(node=>node.tag==='mark')?.textContent,'Comp');assert.equal(labels[1]?.children.some(node=>node.tag==='mark'),false);assert.equal(labels[2]?.textContent,'components/');
  assert.equal(options[0]?.title,'src/Composer.ts');assert.equal(options[0]?.attrs.get('aria-describedby'),`${options[0]?.id}-directory`);assert.equal(options[2]?.attrs.get('aria-label'),'Folder src/components');
});
test('literal highlights use original Unicode offsets and treat query punctuation as text',async context=>{
  const f=fixture(context);f.text('@comp');await f.settle(result([row('İComposer.ts'),row('😀Composer.ts')]));
  const labels=()=>f.menu.querySelectorAll('[role="option"]').map(node=>node.children[0]?.children[1]);
  assert.deepEqual(labels().map(label=>label?.children.find(node=>node.tag==='mark')?.textContent),['Comp','Comp']);
  assert.deepEqual(labels().map(label=>label?.textContent),['İComposer.ts','😀Composer.ts']);
  f.next();f.text('@[x].');await f.settle(result([row('İ[x].ts'),row('x.ts')]));
  assert.equal(labels()[0]?.children.find(node=>node.tag==='mark')?.textContent,'[x].');assert.equal(labels()[0]?.textContent,'İ[x].ts');assert.equal(labels()[1]?.children.some(node=>node.tag==='mark'),false);
  f.next();f.text('@İ');await f.settle(result([row('İfile.ts')]));assert.equal(labels()[0]?.children.find(node=>node.tag==='mark')?.textContent,'İ');assert.equal(labels()[0]?.textContent,'İfile.ts');
});
test('searching, complete absence, partial absence and failure remain distinct non-options',async context=>{
  const f=fixture(context);f.text('@x');assert.match(f.menu.textContent,/Searching/);assert.equal(f.menu.querySelectorAll('[role="option"]').length,0);await f.settle(result([]));assert.match(f.menu.textContent,/No matching files/);
  f.next();f.text('@xy');await f.settle(result([],false));assert.match(f.menu.textContent,/No matches in the searched part.*Search limit/);assert.match(f.menu.textContent,/More matches/);assert.equal(f.editor.attrs.has('aria-activedescendant'),false);
  const failed=f.next();f.text('@xyz');failed.reject(Error('Read failed'));await failed.promise.catch(()=>{});await Promise.resolve();assert.match(f.menu.textContent,/Read failed/);assert.doesNotMatch(f.menu.textContent,/No matching files/);assert.equal(f.menu.querySelectorAll('[role="option"]').length,0);
});
test('Escape, composition and target reset cancel pending queries without reviving old options',async context=>{
  const f=fixture(context);f.text('@old');const first=f.calls[0];f.key('Escape');assert.equal(first?.signal.aborted,true);await f.settle(result([row('old')]));assert.equal(f.menu.hidden,true);
  const late=f.next();f.text('@later');f.controller.reset();assert.equal(f.calls.at(-1)?.signal.aborted,true);late.resolve(result([row('later')]));await late.promise;await Promise.resolve();assert.equal(f.menu.hidden,true);assert.equal(f.menu.children.length,0);
  f.next();f.text('@new');f.editor.fire('compositionstart');assert.equal(f.menu.hidden,true);assert.equal(f.key('Enter',{isComposing:true}),false);assert.deepEqual(f.accepted,[]);f.controller.destroy();
});
