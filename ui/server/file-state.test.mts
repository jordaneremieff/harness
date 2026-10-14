import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,stat,readdir,rm,symlink,link,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileState} from './file-state.mts';
import {LIMITS} from '../shared/api.ts';
import {readText,encodeFileText,writeText} from './file-access.mts';
import {fileSource} from '../shared/files.ts';
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
    const after = new FileState(join(path,'state'));await after.load();assert.deepEqual(after.draft(root.id,'note.md').draft,saved.draft);assert.deepEqual(saved.source.revision,saved.draft.base);
  }
});
test('disk changes refuse a save and retain an acknowledged draft, including a stale first draft',async context=> {
  const {state,root,file} = await fixture(context,'old text'), source = await readText(root,'note.md'), normalized = fileSource(source.text), before = await stat(file);
  await writeFile(file,'new text');await utimes(file,before.atime,before.mtime);
  const draft = await state.putDraft(root.id,'note.md',0,source.revision,'my draft',normalized.encoding);
  await assert.rejects(state.saveDraft(root.id,'note.md',draft.revision),{code:'file_changed'});assert.equal(await readFile(file,'utf8'),'new text');assert.deepEqual(state.draft(root.id,'note.md').draft,draft);
  const fresh = await readText(root,'note.md'), reread = fileSource(fresh.text);const replacement = await state.putDraft(root.id,'note.md',draft.revision,fresh.revision,reread.text,reread.encoding);assert.equal(replacement.text,'new text');
});
test('a full private draft state refuses metadata growth before it changes disk',async context=> {
  const {path,state,root,file} = await fixture(context,'x');await utimes(file,0,0);const source = await readText(root,'note.md');
  const draft = await state.putDraft(root.id,'note.md',0,source.revision,'replacement',fileSource(source.text).encoding), drafts:Record<string,typeof draft> = {[JSON.stringify([root.id,'note.md'])]:draft};
  for (let i = 0;i < 6;i++) drafts[JSON.stringify([root.id,`other-${i}.txt`])] = {...draft,text:'x'.repeat(LIMITS.fileTextBytes)};
  const key = JSON.stringify([root.id,'last.txt']), data = {format:'ui.file-drafts/1',drafts};drafts[key] = {...draft,text:''};
  drafts[key].text = 'x'.repeat(LIMITS.fileResponseBytes-Buffer.byteLength(JSON.stringify(data)));
  const bytes = JSON.stringify(data);assert.equal(Buffer.byteLength(bytes),LIMITS.fileResponseBytes);await writeFile(join(path,'state','file-drafts.json'),bytes);
  const reopened = new FileState(join(path,'state'));await reopened.load();await assert.rejects(reopened.saveDraft(root.id,'note.md',draft.revision),{code:'capacity'});
  assert.equal(await readFile(file,'utf8'),'x');assert.deepEqual(reopened.draft(root.id,'note.md').draft,draft);assert.equal(await readFile(join(path,'state','file-drafts.json'),'utf8'),bytes);
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
