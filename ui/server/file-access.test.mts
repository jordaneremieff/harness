import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,link,symlink,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LIMITS} from '../shared/api.ts';
import {decodeText,filePath,registerRoot,readText,directoryPage} from './file-access.mts';
import {FileState} from './file-state.mts';
const workspace = '00000000-0000-4000-8000-000000000001';
test('text reads retain exact BOM and mixed separators without project writes',async context=> {
  const path = await mkdtemp(join(tmpdir(),'ui-file-read-'));context.after(()=>rm(path,{recursive:true,force:true}));
  const source = '\ufefffirst\r\nsecond\rthird\nlast';await writeFile(join(path,'note.md'),source);
  const root = await registerRoot(path,'root'), before = await readdir(path);
  const text = await readText(root,'note.md');assert.equal(text.text,source);assert.equal(text.revision.size,Buffer.byteLength(source));assert.match(text.revision.digest,/^[a-f0-9]{64}$/);
  assert.equal('writable' in text,false);assert.deepEqual(await readdir(path),before);assert.equal((await readFile(join(path,'note.md'))).toString(),source);
  await writeFile(join(path,'binary'),Buffer.from([0,1]));await assert.rejects(readText(root,'binary'),{code:'file_binary'});
  await writeFile(join(path,'large'),Buffer.alloc(LIMITS.fileTextBytes+1,65));await assert.rejects(readText(root,'large'),{code:'payload_too_large'});
  await assert.rejects(readText(root,'missing'),{code:'ENOENT'});
  assert.throws(()=>decodeText(Buffer.from([0xc3,0x28])),{code:'file_binary'});
});
test('paths and descriptors reject traversal, links and replaced roots',async context=> {
  for (const path of ['../secret','/outside','a//b','a/./b','a/../b','a\\b','.git/config','%2foutside','%252e/../x','x\u0000','\ud800']) assert.throws(()=>filePath(path,false),{code:'invalid_request'});
  const path = await mkdtemp(join(tmpdir(),'ui-file-safe-'));context.after(()=>rm(path,{recursive:true,force:true}));
  await mkdir(join(path,'project'));await writeFile(join(path,'outside'),'secret');await writeFile(join(path,'project','note'),'text');
  const root = await registerRoot(join(path,'project'),'root');
  await symlink(join(path,'outside'),join(path,'project','escape'));await assert.rejects(readText(root,'escape'),{code:'file_unsafe'});
  await link(join(path,'project','note'),join(path,'project','alias'));await assert.rejects(readText(root,'note'),{code:'file_unsafe'});
  await rename(join(path,'project'),join(path,'previous'));await mkdir(join(path,'project'));await writeFile(join(path,'project','note'),'different');await assert.rejects(readText(root,'note'),{code:'file_changed'});
});
test('directory pages bind cursors to root, path, revision and page size',async context=> {
  const path = await mkdtemp(join(tmpdir(),'ui-file-page-'));context.after(()=>rm(path,{recursive:true,force:true}));
  await mkdir(join(path,'.git'));await mkdir(join(path,'folder'));await writeFile(join(path,'.hidden'),'h');await writeFile(join(path,'z'),'z');
  const root = await registerRoot(path,'root'), first = await directoryPage(root,'',1);
  assert.equal(first.entries[0]?.name,'folder');assert.ok(first.nextCursor);assert.equal(first.coverage.complete,true);
  const next = await directoryPage(root,'',1,first.nextCursor);assert.equal(next.entries[0]?.name,'.hidden');
  await assert.rejects(directoryPage(root,'',2,first.nextCursor),{code:'file_changed'});
  await writeFile(join(path,'new'),'x');await assert.rejects(directoryPage(root,'',1,first.nextCursor),{code:'file_changed'});
  await assert.rejects(directoryPage(root,'',201),{code:'invalid_request'});
});
test('private root selection is revisioned and retains old registered identities after restart',async context=> {
  const path = await mkdtemp(join(tmpdir(),'ui-file-state-'));context.after(()=>rm(path,{recursive:true,force:true}));
  await mkdir(join(path,'state'));await mkdir(join(path,'a'));await mkdir(join(path,'b'));
  const state = new FileState(join(path,'state'));await state.load();assert.deepEqual(state.selection(workspace),{revision:0,root:null});
  const a = await state.select(workspace,join(path,'a'),0);assert.ok(a.root);
  await assert.rejects(state.select(workspace,join(path,'b'),0),{code:'stale_revision'});
  const b = await state.select(workspace,join(path,'b'),1);assert.notEqual(b.root?.id,a.root.id);
  const reopened = new FileState(join(path,'state'));await reopened.load();assert.deepEqual(reopened.selection(workspace),b);assert.equal(reopened.root(a.root.id).path,a.root.path);
  assert.deepEqual(await readdir(join(path,'a')),[]);assert.deepEqual(await readdir(join(path,'b')),[]);
});
