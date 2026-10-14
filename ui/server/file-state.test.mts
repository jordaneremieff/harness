import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,stat,readdir,rm,symlink,link,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileState} from './file-state.mts';
import {LIMITS} from '../shared/api.ts';
import {readText,encodeFileText,writeText} from './file-access.mts';
import {fileSource,type FileSave} from '../shared/files.ts';
import {FileOwner} from '../web/file-owner.ts';
const workspace = '00000000-0000-4000-8000-000000000001';
async function fixture(context:{after(fn:()=>Promise<void>):void},text:string) {
  const path = await mkdtemp(join(tmpdir(),'ui-file-edit-'));context.after(()=>rm(path,{recursive:true,force:true}));await mkdir(join(path,'state'));await mkdir(join(path,'project'));await writeFile(join(path,'project','note.md'),text,{mode:0o640});
  const state = new FileState(join(path,'state'));await state.load();const selected = await state.select(workspace,join(path,'project'),0);assert.ok(selected.root);const root = state.root(selected.root.id);return {path,state,root,file:join(path,'project','note.md')};
}
test('acknowledged drafts restore and atomic saves preserve UTF-8, BOM, separators and file mode',async context=> {
  for (const original of ['first\nλ\tlast','\ufefffirst\r\nλ\tlast','', '\ufeff']) {
    const {path,state,root,file} = await fixture(context,original), source = await readText(root,'note.md'), normalized = fileSource(source.text), before = await stat(file);
    const text = `${normalized.text}\nadded 😀`, draft = await state.putDraft(root.id,'note.md',0,source.revision,text,normalized.encoding);
    assert.equal(draft.revision,1);assert.equal(await readFile(file,'utf8'),original);await assert.rejects(state.putDraft(root.id,'note.md',0,source.revision,'stale',normalized.encoding),{code:'stale_revision'});
    const reopened = new FileState(join(path,'state'));await reopened.load();assert.deepEqual(reopened.draft(root.id,'note.md').draft,draft);assert.deepEqual(reopened.selection(workspace),state.selection(workspace));
    const saved = await reopened.saveDraft(root.id,'note.md',draft.revision);assert.equal(saved.draft.revision,2);assert.deepEqual(await readFile(file),encodeFileText(text,normalized.encoding));assert.equal((await stat(file)).mode & 0o7777,before.mode & 0o7777);assert.notEqual((await stat(file)).ino,before.ino);assert.deepEqual(await readdir(join(path,'project')),['note.md']);
    const after = new FileState(join(path,'state'));await after.load();assert.deepEqual(after.draft(root.id,'note.md'),{revision:saved.draft.revision,draft:null});assert.deepEqual(saved.source.revision,saved.draft.base);
    await assert.rejects(after.putDraft(root.id,'note.md',0,saved.source.revision,'stale',normalized.encoding),{code:'stale_revision'});
    await assert.rejects(after.saveDraft(root.id,'note.md',draft.revision),{code:'stale_revision'});
    const next = await after.putDraft(root.id,'note.md',saved.draft.revision,saved.source.revision,`${text}\nnext`,normalized.encoding);
    assert.equal(next.revision,3);assert.equal(next.text,`${text}\nnext`);
  }
});
test('disk changes refuse a save and retain an already acknowledged draft',async context=> {
  const {state,root,file} = await fixture(context,'old text'), source = await readText(root,'note.md'), normalized = fileSource(source.text), before = await stat(file);
  const draft = await state.putDraft(root.id,'note.md',0,source.revision,'my draft',normalized.encoding);
  await writeFile(file,'new text');await utimes(file,before.atime,before.mtime);
  await assert.rejects(state.saveDraft(root.id,'note.md',draft.revision),{code:'file_changed'});assert.equal(await readFile(file,'utf8'),'new text');assert.deepEqual(state.draft(root.id,'note.md').draft,draft);
  const fresh = await readText(root,'note.md'), reread = fileSource(fresh.text);const replacement = await state.putDraft(root.id,'note.md',draft.revision,fresh.revision,reread.text,reread.encoding);assert.equal(replacement.text,'new text');
});
test('a full private draft state refuses metadata growth before it changes disk',async context=> {
  const {path,state,root,file} = await fixture(context,'x');await utimes(file,0,0);const source = await readText(root,'note.md');
  const draft = await state.putDraft(root.id,'note.md',0,source.revision,'replacement',fileSource(source.text).encoding), drafts:Record<string,typeof draft> = {[JSON.stringify([root.id,'note.md'])]:draft};
  for (let i = 0;i < 6;i++) drafts[JSON.stringify([root.id,`other-${i}.txt`])] = {...draft,text:'x'.repeat(LIMITS.fileTextBytes)};
  const key = JSON.stringify([root.id,'last.txt']), data = {format:'ui.file-drafts/2',drafts};drafts[key] = {...draft,text:''};
  drafts[key].text = 'x'.repeat(LIMITS.fileResponseBytes-Buffer.byteLength(JSON.stringify(data)));
  const bytes = JSON.stringify(data);assert.equal(Buffer.byteLength(bytes),LIMITS.fileResponseBytes);await writeFile(join(path,'state','file-drafts.json'),bytes);
  const reopened = new FileState(join(path,'state'));await reopened.load();await assert.rejects(reopened.saveDraft(root.id,'note.md',draft.revision),{code:'capacity'});
  assert.equal(await readFile(file,'utf8'),'x');assert.deepEqual(reopened.draft(root.id,'note.md').draft,draft);assert.equal(await readFile(join(path,'state','file-drafts.json'),'utf8'),bytes);
});
test('explicit saves release lifetime payload without evicting acknowledged unsaved drafts',async context=> {
  const {path,state,root} = await fixture(context,'base'), source = await readText(root,'note.md');
  const retained = await state.putDraft(root.id,'note.md',0,source.revision,'unsaved\tλ',fileSource(source.text).encoding);
  for (let i = 0;i < 7;i++) {
    const name = `saved-${i}.txt`;await writeFile(join(path,'project',name),'base');const disk = await readText(root,name);
    const draft = await state.putDraft(root.id,name,0,disk.revision,'x'.repeat(LIMITS.fileTextBytes),fileSource(disk.text).encoding);
    const saved = await state.saveDraft(root.id,name,draft.revision);
    assert.equal(saved.draft.text.length,LIMITS.fileTextBytes);assert.deepEqual(state.draft(root.id,name),{revision:2,draft:null});
    assert.deepEqual(state.draft(root.id,'note.md').draft,retained);
    assert.ok((await stat(join(path,'state','file-drafts.json'))).size < 8192);
  }
  const reopened = new FileState(join(path,'state'));await reopened.load();assert.deepEqual(reopened.draft(root.id,'note.md').draft,retained);
});
test('repeated clean Save checks disk changes and retains monotonic compact revisions',async context=> {
  const {state,root,file} = await fixture(context,'base'), source = await readText(root,'note.md');
  const draft = await state.putDraft(root.id,'note.md',0,source.revision,'saved',fileSource(source.text).encoding);
  const first = await state.saveDraft(root.id,'note.md',draft.revision), inode = (await stat(file)).ino;
  const second = await state.saveDraft(root.id,'note.md',first.draft.revision);
  assert.equal(second.draft.revision,3);assert.equal(second.draft.text,'saved');assert.equal((await stat(file)).ino,inode);
  assert.deepEqual(state.draft(root.id,'note.md'),{revision:3,draft:null});
  await writeFile(file,'external');await assert.rejects(state.saveDraft(root.id,'note.md',3),{code:'file_changed'});
  assert.equal(await readFile(file,'utf8'),'external');assert.deepEqual(state.draft(root.id,'note.md'),{revision:3,draft:null});
});
test('post-rename persistence failure retains the draft and poisons mutations until restart',async context=> {
  const {path,state,root,file} = await fixture(context,'base'), source = await readText(root,'note.md');
  const draft = await state.putDraft(root.id,'note.md',0,source.revision,'saved bytes',fileSource(source.text).encoding);
  const destination = join(path,'state','file-drafts.json'), before = await readFile(destination);
  context.mock.method(state as unknown as {persist(...args:unknown[]):Promise<void>},'persist',async()=> {throw new Error('forced persistence failure');});
  await assert.rejects(state.saveDraft(root.id,'note.md',draft.revision),/forced persistence failure/);
  assert.equal(await readFile(file,'utf8'),'saved bytes');assert.deepEqual(state.draft(root.id,'note.md').draft,draft);assert.deepEqual(await readFile(destination),before);
  await assert.rejects(state.saveDraft(root.id,'note.md',draft.revision),{code:'not_ready'});
  await assert.rejects(state.putDraft(root.id,'note.md',draft.revision,source.revision,'new',draft.encoding),{code:'not_ready'});
  await assert.rejects(state.select(workspace,join(path,'project'),1),{code:'not_ready'});
  const reopened = new FileState(join(path,'state'));await reopened.load();assert.deepEqual(reopened.draft(root.id,'note.md').draft,draft);
  await assert.rejects(reopened.saveDraft(root.id,'note.md',draft.revision),{code:'file_changed'});
  assert.equal(await readFile(file,'utf8'),'saved bytes');
});
test('newer input during a captured Save becomes an acknowledged draft after compaction',async context=> {
  const {state,root,file} = await fixture(context,'base');let renamed!:(saved:FileSave)=>void, release!:()=>void;
  const diskSaved = new Promise<FileSave>(resolve=> {renamed = resolve;}), gate = new Promise<void>(resolve=> {release = resolve;});
  const owner = new FileOwner(workspace,{kind:'file',rootId:root.id,path:'note.md'},async()=>readText(root,'note.md'),()=>{}, {
    draft:async()=>state.draft(root.id,'note.md'),put:async(_workspace,_tab,revision,base,text,encoding)=>state.putDraft(root.id,'note.md',revision,base,text,encoding),
    save:async(_workspace,_tab,revision)=> {const saved = await state.saveDraft(root.id,'note.md',revision);renamed(saved);await gate;return saved;},
  });
  context.after(()=>owner.dispose());await owner.load();owner.edit('captured');const saving = owner.save(), saved = await diskSaved;
  assert.deepEqual(state.draft(root.id,'note.md'),{revision:saved.draft.revision,draft:null});owner.edit('newer input');release();await saving;await owner.drain();
  assert.equal(await readFile(file,'utf8'),'captured');assert.equal(owner.text,'newer input');assert.equal(owner.acknowledged,'newer input');
  assert.equal(state.draft(root.id,'note.md').draft?.text,'newer input');assert.equal(state.draft(root.id,'note.md').revision,saved.draft.revision+1);
});
test('private drafts accept only strict current full and compact records',async context=> {
  const {path,state,root} = await fixture(context,'base'), source = await readText(root,'note.md');
  const draft = await state.putDraft(root.id,'note.md',0,source.revision,'draft',fileSource(source.text).encoding), key = JSON.stringify([root.id,'note.md']);
  for (const data of [{format:'ui.file-drafts/1',drafts:{[key]:draft}}, {format:'ui.file-drafts/2',drafts:{[key]:{...draft,text:null}}}, {format:'ui.file-drafts/2',drafts:{[key]:{revision:2,base:draft.base,encoding:draft.encoding,extra:true}}}]) {
    await writeFile(join(path,'state','file-drafts.json'),JSON.stringify(data));await assert.rejects(new FileState(join(path,'state')).load());
  }
});
test('non-round-trippable input, wrong encoding, links and missing targets never write',async context=> {
  for (const original of ['mixed\r\nline\nlast','lone\rlast']) {
    const {state,root,file} = await fixture(context,original), source = await readText(root,'note.md'), normalized = fileSource(source.text);
    const draft = await state.putDraft(root.id,'note.md',0,source.revision,'edited',normalized.encoding);await assert.rejects(state.saveDraft(root.id,'note.md',draft.revision),{code:'unsupported'});assert.equal(await readFile(file,'utf8'),original);
  }
  assert.throws(()=>encodeFileText('\ud800',{bom:false,ending:'lf',writable:true}),{code:'unsupported'});assert.throws(()=>encodeFileText('x\r',{bom:false,ending:'lf',writable:true}),{code:'unsupported'});assert.throws(()=>encodeFileText('\u0000',{bom:false,ending:'lf',writable:true}),{code:'file_binary'});
  const {state,root,file,path} = await fixture(context,'source'), source = await readText(root,'note.md');
  await assert.rejects(writeText(root,'note.md',source.revision,'text',{bom:true,ending:'lf',writable:true}),{code:'invalid_request'});assert.equal(await readFile(file,'utf8'),'source');
  const draft = await state.putDraft(root.id,'note.md',0,source.revision,'draft',fileSource(source.text).encoding);
  await rm(file);await symlink(join(path,'state','files.json'),file);await assert.rejects(state.saveDraft(root.id,'note.md',draft.revision),{code:'file_unsafe'});
  await rm(file);await assert.rejects(state.saveDraft(root.id,'note.md',draft.revision),{code:'ENOENT'});await writeFile(file,'source');await link(file,join(path,'project','alias'));await assert.rejects(state.saveDraft(root.id,'note.md',draft.revision),{code:'file_unsafe'});
});
