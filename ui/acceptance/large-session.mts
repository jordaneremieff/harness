import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, opendir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { launchBrave, type Page } from './cdp.mts';

export type Options = { session?: string; out: string; pi: string; maxPages: number; rich?: boolean };
const inputPath = /\/api\/(?:primaries|agents)\/[^/?]+\/inputs(?:$|\?)/;
export function isPromptInput(method: string, path: string): boolean { return method === 'POST' && inputPath.test(path); }
export function options(args: string[]): Options {
  const { values } = parseArgs({ args, options: {
    session: { type: 'string' }, out: { type: 'string' }, pi: { type: 'string', default: 'pi' },
    'max-pages': { type: 'string', default: '2000' }, help: { type: 'boolean' }, rich: {type:'boolean'},
  } });
  if (values.help) throw new Error('Use node ui/acceptance/large-session.mts [--session <file>] [--out <directory>] [--pi <executable>] [--max-pages <count>] [--rich]. Without --session, generate 25 MiB at runtime. No prompts are submitted.');
  const maxPages = Number(values['max-pages']);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10000) throw new Error('Invalid page limit');
  if (values.rich && values.session) throw new Error('Rich fixture requires synthetic input');
  return {rich:values.rich, session: values.session ? resolve(values.session) : undefined,
    out: resolve(values.out ?? join(homedir(), 'Workspace', 'dump', `large-session-${Date.now()}`)), pi: values.pi ?? 'pi', maxPages };
}
export function copySession(source: Buffer, cwd: string): Buffer {
  const newline = source.indexOf(10);
  if (newline < 0) throw new Error('Session has no entries');
  const header = JSON.parse(source.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
  if (header.type !== 'session' || header.version !== 3) throw new Error('Expected a current version 3 session header');
  header.cwd = cwd;
  delete header.parentSession;
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), source.subarray(newline + 1)]);
}
export function syntheticSession(cwd: string, targetBytes = 25 * 1024 * 1024): Buffer {
  const timestamp = new Date().toISOString();
  const lines = [JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp, cwd })];
  let bytes = Buffer.byteLength(lines[0] ?? '') + 1;
  let parentId: string | null = null;
  for (let index = 0; bytes < targetBytes; index++) {
    const id = index.toString(16).padStart(8, '0');
    const line = JSON.stringify({ type: 'message', id, parentId, timestamp,
      message: { role: 'user', content: `Retained message ${index}\n${'Plain retained transcript text. '.repeat(260)}`, timestamp: Date.now() } });
    lines.push(line); bytes += Buffer.byteLength(line) + 1; parentId = id;
  }
  const append = (id: string, message: Record<string, unknown>, parent = parentId) => {
    lines.push(JSON.stringify({type: 'message', id, parentId: parent, timestamp, message: {...message, timestamp: Date.now()}})); parentId = id;
  };
  const branchParent = parentId;
  append('fixture-inactive', {role: 'user', content: 'Inactive branch output'}, null);
  parentId = branchParent;
  append('fixture-hidden', {role: 'custom', customType: 'acceptance', display: false, content: [{type: 'text', text: 'Hidden synthetic output'}]});
  append('fixture-redacted', {role: 'assistant', api: 'openai-completions', provider: 'acceptance-fixture', model: 'acceptance-fixture', stopReason: 'stop',
    content: [{type: 'thinking', thinking: 'Redacted synthetic thinking', redacted: true}],
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}});
  append('fixture-output', {role: 'user', content: syntheticOutputText()});
  return Buffer.from(`${lines.join('\n')}\n`);
}
export function richSyntheticSession(cwd: string, targetBytes = 25 * 1024 * 1024): Buffer {
  const timestamp = new Date().toISOString(); let parentId: string | null = null;
  const lines = [JSON.stringify({type:'session',version:3,id:randomUUID(),timestamp,cwd})]; let bytes = Buffer.byteLength(lines[0] ?? '') + 1;
  const append = (id: string, message: Record<string, unknown>) => {
    const line = JSON.stringify({type:'message',id,parentId,timestamp,message:{...message,timestamp:Date.now()}});
    lines.push(line); bytes += Buffer.byteLength(line) + 1; parentId = id;
  };
  for (let index = 0; bytes < targetBytes; index++) {
    const callId = `rich-call-${index}`;
    append(`rich-user-${index}`, {role:'user',content:`Retained request ${index}`});
    append(`rich-owner-${index}`, {role:'assistant',api:'openai-completions',provider:'acceptance-fixture',model:'acceptance-fixture',stopReason:'toolUse',
      content:[{type:'thinking',thinking:`Reasoning ${index}\n${'Retained reasoning plain text. '.repeat(64)}`},{type:'toolCall',id:callId,name:'read',arguments:{path:`retained-${index}.txt`}}],
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    append(`rich-result-${index}`, {role:'toolResult',toolCallId:callId,toolName:'read',content:[{type:'text',text:'Retained tool result plain text.\n'.repeat(256)}],isError:false});
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}
async function sessionSource(config: Options, cwd: string): Promise<Buffer> {
  if (config.session) return readFile(config.session);
  return config.rich ? richSyntheticSession(cwd) : syntheticSession(cwd);
}
export function syntheticOutputText(): string {
  return `${'A'.repeat(8187)}\nBearer synthetic-page-boundary-token\n${'Unicode output ☃ plain retained text.\n'.repeat(2400)}END-OUTPUT`;
}
export function distribution(samples: number[]): { count: number; minMs: number | null; medianMs: number | null; p95Ms: number | null; maxMs: number | null } {
  if (samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid latency sample');
  const ordered = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => ordered.length ? ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? null : null;
  return { count: ordered.length, minMs: ordered[0] ?? null, medianMs: at(0.5), p95Ms: at(0.95), maxMs: ordered.at(-1) ?? null };
}

type Hashes = Record<string, string>;
async function hashDirectory(base: URL, directory: string, snapshot: {hashes: Hashes; bytes: number}) {
  let visits = 0;
  for await (const entry of await opendir(new URL(`${directory}/`, base))) {
    if (++visits > 256) throw new Error('Source directory exceeds the inventory bound');
    if (!entry.isFile() || entry.name.startsWith('.') || /\.test\./.test(entry.name) || !/\.(?:ts|mts|css|html|js)$/.test(entry.name)) continue;
    if (Object.keys(snapshot.hashes).length >= 256) throw new Error('Source inventory exceeds the file bound');
    const path = new URL(`${directory}/${entry.name}`, base);
    if ((await stat(path)).size > 1024 * 1024) throw new Error('Source file exceeds the byte bound');
    const content = await readFile(path); snapshot.bytes += content.length;
    if (content.length > 1024 * 1024 || snapshot.bytes > 16 * 1024 * 1024) throw new Error('Source inventory exceeds the byte bound');
    snapshot.hashes[`../${directory}/${entry.name}`] = createHash('sha256').update(content).digest('hex');
  }
}
export async function sourceHashes(base = new URL('../', import.meta.url)): Promise<Hashes> {
  const snapshot: {hashes: Hashes; bytes: number} = {hashes: {}, bytes: 0};
  for (const directory of ['server', 'rpc', 'agents', 'shared', 'web', 'dist/web', 'dist/shared']) await hashDirectory(base, directory, snapshot);
  return Object.fromEntries(Object.entries(snapshot.hashes).sort(([left], [right]) => left.localeCompare(right)));
}
export function hashChanges(before: Hashes, after: Hashes): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
}
export function servedAssets(hashes: Hashes): {diskPath: string; path: string; hash: string}[] {
  const assets = [{diskPath: '../web/index.html', path: '/'}, {diskPath: '../web/style.css', path: '/style.css'},
    {diskPath: '../dist/shared/api.js', path: '/shared/api.js'}];
  for (const diskPath of Object.keys(hashes)) {
    const name = /^\.\.\/dist\/web\/([a-zA-Z0-9_-]+\.js)$/.exec(diskPath)?.[1];
    if (name) assets.push({diskPath, path: `/web/${name}`});
  }
  for (const required of ['../dist/web/app.js', '../dist/web/icons.js']) if (!hashes[required]) throw new Error(`Missing served asset ${required}`);
  return assets.map(asset => {
    const hash = hashes[asset.diskPath]; if (!hash) throw new Error(`Missing served asset ${asset.diskPath}`);
    return {...asset, hash};
  }).sort((left, right) => left.path.localeCompare(right.path));
}
async function verifyServedAssets(page: Page, hashes: Hashes) {
  return page.evaluate<{allMatched: boolean; assets: unknown[]}>(`(async()=>{
    const results=[];
    for(const asset of ${literal(servedAssets(hashes))}){
      const response=await fetch(asset.path,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('Served asset HTTP '+response.status+': '+asset.path);
      const bytes=await response.arrayBuffer();if(bytes.byteLength>1048576)throw Error('Served asset exceeds byte bound');
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      const hash=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
      results.push({...asset,bytes:bytes.byteLength,servedHash:hash,matched:hash===asset.hash});
    }
    return {assets:results,allMatched:results.every(n=>n.matched)};
  })()`, 120000);
}
async function afterAssets(report: Record<string, unknown>, hashes: Hashes, page?: Page) {
  if (page) report.servedAssetsAfter = await verifyServedAssets(page, hashes).catch(error => ({allMatched:false,error:String(error)}));
}
async function closeBinding(report: Record<string, unknown>, hashes: Hashes) {
  try {
    const after = await sourceHashes(); report.testedSourceHashesAfter = after;
    const changed = hashChanges(hashes, after); report.runtimeHashesChanged = changed; report.runtimeHashesUnchanged = changed.length === 0;
  } catch (error) { report.runtimeHashesUnchanged = false; report.bindingError = String(error); }
}
function trialFailed(report: Record<string, unknown>): boolean {
  return Boolean(report.error || report.backendCleanupError || report.browserCleanupError || report.sourceUnchanged === false ||
    report.runtimeHashesUnchanged === false || (report.servedAssetsBefore as {allMatched?: boolean} | undefined)?.allMatched === false ||
    (report.servedAssetsAfter as {allMatched?: boolean} | undefined)?.allMatched === false || (report.output as {passed?: boolean} | undefined)?.passed === false);
}

const launcher = (entry: string) => `
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { startBackend, parseArgs } from ${JSON.stringify(entry)};
const histogram = monitorEventLoopDelay({resolution:1});histogram.enable();
const stages=[];
const app = await startBackend(parseArgs(process.argv.slice(2)),{measure:(stage,id,at,bytes)=>{if(stages.length<2000)stages.push({stage,id,at,bytes});}});
process.send({ready:app.launchUrl,pid:process.pid});
process.on('message',async message=>{
  try {
    if(message.action==='reset') {histogram.reset();process.send({id:message.id,result:true});}
    if(message.action==='clock') {const at=performance.now();process.send({id:message.id,result:{timeOrigin:performance.timeOrigin,at,epoch:performance.timeOrigin+at}});}
    if(message.action==='probe') setImmediate(async()=>{
      const snapshot=await app.registry.snapshot();
      process.send({id:message.id,result:{rssBytes:process.memoryUsage().rss,peakRssBytes:process.resourceUsage().maxRSS*1024,
        loopMaxMs:histogram.count?histogram.max/1e6:null,loopP95Ms:histogram.count?histogram.percentile(95)/1e6:null,loopSamples:histogram.count,
        primaries:snapshot.primaries,selectedPageEntries:snapshot.selectedPage?.items.length,pendingDialogs:snapshot.dialogs.length,stages}});
    });
    if(message.action==='close') {await app.close();histogram.disable();process.send({id:message.id,result:true},()=>process.disconnect());}
  } catch(error) {process.send({id:message.id,error:String(error)});}
});
`;
function exited(child: ChildProcess): Promise<void> {
  return new Promise(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
}
function exchange<T>(child: ChildProcess, action: string, timeoutMs = 120000): Promise<T> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', error); };
    const error = (reason: Error) => { cleanup(); reject(reason); };
    const exit = () => error(new Error(`Backend exited during ${action}`));
    const message = (value: unknown) => {
      const data = value as { id?: string; result: T; error?: string };
      if (data.id !== id) return;
      cleanup(); if (data.error) reject(new Error(data.error)); else resolve(data.result);
    };
    const timer = setTimeout(() => error(new Error(`Backend ${action} timeout`)), timeoutMs);
    child.on('message', message); child.once('exit', exit); child.once('error', error);
    child.send({ id, action }, reason => { if (reason) error(reason); });
  });
}
function ready(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', error); };
    const error = (reason: Error) => { cleanup(); reject(reason); };
    const exit = () => error(new Error('Backend exited before readiness'));
    const message = (value: unknown) => {
      const data = value as { ready?: string }; if (!data.ready) return; cleanup(); resolve(data.ready);
    };
    const timer = setTimeout(() => error(new Error('Backend readiness timeout')), 30000);
    child.on('message', message); child.once('exit', exit); child.once('error', error);
  });
}
async function stopBackend(child: ChildProcess, done: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { await exchange(child, 'close', 15000); }
  finally {
    const kill = setTimeout(() => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }, 5000);
    try { await done; } finally { clearTimeout(kill); }
  }
}
const literal = (value: unknown) => JSON.stringify(value);
async function clickText(page: Page, text: string): Promise<void> {
  await page.evaluate(`(()=>{const n=[...document.querySelectorAll('#modal button')].find(n=>n.textContent.trim()===${literal(text)});if(!n||n.disabled)throw Error('Unavailable '+${literal(text)});n.click();})()`);
}
// Capture browser-local receive times, never compare them to backend clocks.
const instrumentation = `(()=>{
  window.__large={states:[],history:[],outputs:[],inputs:[],started:null,ready:false};
  document.addEventListener('ui-ready',()=>{window.__large.ready=true;});
  const Original=window.EventSource;
  window.EventSource=class extends Original {constructor(...args){super(...args);this.addEventListener('primary.state',event=>{
    const data=JSON.parse(event.data);window.__large.states.push({at:performance.now(),lifecycle:data.data?.lifecycle??data.data?.primary?.lifecycle,hasSession:typeof data.data?.sessionId==='string'});
  });}};
  const original=window.fetch.bind(window);
  window.fetch=async(...args)=>{
    const path=String(args[0]),method=args[1]?.method??'GET';
    if(method==='POST'&&${inputPath}.test(path)){window.__large.inputs.push(path);throw Error('Prompt prohibited');}
    const start=performance.now();const response=await original(...args);
    if(path.includes('/history')&&!path.includes('/history/output')) {
      const data=await response.clone().json();const received=performance.now();
      window.__large.history.push({start,received,path,status:response.status,data});
      window.dispatchEvent(new Event('large-history'));
    }
    if(path.includes('/history/output')) {
      const data=await response.clone().json();window.__large.outputs.push({path,start,status:response.status,data});
    }
    return response;
  };
})()`;

async function resume(page: Page, cwd: string, session: string): Promise<unknown> {
  await page.evaluate(`document.querySelector('#project-button').click()`);
  await page.waitFor(`document.querySelector('#modal[open] input')`);
  if (await page.evaluate<boolean>(`Boolean(document.querySelector('#picker-project'))`)) {
    await clickText(page, 'Open saved session path…');
    await page.waitFor(`document.querySelector('#picker-session-path')`);
  }
  await page.evaluate(`(()=>{const fields=[...document.querySelectorAll('#modal input')].filter(n=>n.type!=='checkbox');fields[0].value=${literal(cwd)};fields[0].dispatchEvent(new Event('input',{bubbles:true}));fields[1].value=${literal(session)};fields[1].dispatchEvent(new Event('input',{bubbles:true}));})()`);
  let checkbox = await page.evaluate<boolean>(`Boolean(document.querySelector('#modal input[type=checkbox]'))`);
  if (!checkbox) await clickText(page, 'Resume saved session');
  checkbox = await page.evaluate<boolean>(`Boolean(document.querySelector('#modal input[type=checkbox]'))`);
  if (checkbox) await page.evaluate(`document.querySelector('#modal input[type=checkbox]').click()`);
  const resumeLabel = await page.evaluate<string>(`[...document.querySelectorAll('#modal button')].find(n=>['Resume saved session','No other writer · Resume','Resume'].includes(n.textContent.trim()))?.textContent.trim()`);
  return page.evaluate(`new Promise((resolve,reject)=>{
    const state=window.__large;state.started=performance.now();state.resumeMode=${literal(checkbox ? 'writerReleased checkbox' : 'writer-release confirmation')};
    let transcriptPaint=null,composerUsable=null,finished=false;
    const cleanup=()=>{observer.disconnect();clearTimeout(timer);};
    const check=()=>{
      if(finished)return;
      const transcript=document.querySelector('#primary-transcript [data-entry-id]');
      const editor=document.querySelector('#primary-editor');
      if(transcriptPaint===null&&transcript&&transcript.getClientRects().length) {
        transcriptPaint=-1;requestAnimationFrame(()=>requestAnimationFrame(()=>{transcriptPaint=performance.now();check();}));
      }
      if(composerUsable===null&&state.states.some(n=>n.lifecycle==='ready')&&editor&&!editor.disabled&&!editor.readOnly&&editor.getClientRects().length) {
        editor.focus();if(document.activeElement===editor)composerUsable=performance.now();
      }
      if(transcriptPaint>0&&composerUsable!==null){finished=true;cleanup();resolve({resumeMode:state.resumeMode,
        clickToTranscriptPaintMs:transcriptPaint-state.started,clickToUsableComposerMs:composerUsable-state.started,
        browserTimeOrigin:performance.timeOrigin,paintAt:transcriptPaint,
        stateToPaintMs:state.states.length?transcriptPaint-state.states.at(-1).at:null,
        getStateDerivedEventToPaintMs:state.states.find(n=>n.hasSession)?transcriptPaint-state.states.find(n=>n.hasSession).at:null,
        firstReadyStateToPaintMs:state.states.find(n=>n.lifecycle==='ready')?transcriptPaint-state.states.find(n=>n.lifecycle==='ready').at:null,stateEvents:state.states.length});}
    };
    const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
    const timer=setTimeout(()=>{finished=true;cleanup();resolve({resumeMode:state.resumeMode,clickToTranscriptPaintMs:null,stateToPaintMs:null,
      clickToUsableComposerMs:composerUsable===null?null:composerUsable-state.started,deadlineMs:10000,
      failure:'No transcript paint before deadline',entries:document.querySelectorAll('#primary-transcript [data-entry-id]').length,
      modal:document.querySelector('#modal')?.open,error:document.querySelector('#modal-error')?.textContent,states:state.states});},10000);
    const button=[...document.querySelectorAll('#modal button')].find(n=>n.textContent.trim()===${literal(resumeLabel)});
    if(!button||button.disabled){cleanup();reject(Error('Resume unavailable'));return;}button.click();check();
  })`, 122000);
}

type PageSample = { latencyMs: number; responseMs: number; entries: number; nextCursor: string | null; status: number; error?: unknown; coverage?: unknown; anchor?: unknown };
const anchorExpression = `(()=>{const node=document.querySelector('#primary-transcript'),rect=node.getBoundingClientRect();
  const row=[...node.querySelectorAll('[data-entry-id]')].find(n=>{const r=n.getBoundingClientRect();return r.bottom>rect.top+1&&r.top<rect.bottom;});
  return row?{id:row.dataset.entryId,offsetPx:rect.top-row.getBoundingClientRect().top}:null;})()`;
async function earlier(page: Page): Promise<PageSample> {
  return page.evaluate(`new Promise((resolve,reject)=>{
    const start=performance.now(),before=window.__large.history.length;let settled=false;
    const cleanup=()=>{clearTimeout(timer);window.removeEventListener('large-history',received);};
    const received=()=>{
      if(settled||window.__large.history.length<=before)return;settled=true;cleanup();
      const sample=window.__large.history.at(-1);
      requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({latencyMs:performance.now()-start,responseMs:sample.received-start,
        entries:sample.data.data?.items?.length??0,nextCursor:sample.data.data?.nextCursor??null,status:sample.status,
        error:sample.data.error,coverage:sample.data.data?.coverage})));
    };
    const timer=setTimeout(()=>{cleanup();reject(Error('Earlier page timeout'));},120000);
    window.addEventListener('large-history',received);document.querySelector('#primary-earlier').click();
  })`, 122000);
}
async function scrollFrames(page: Page): Promise<unknown> {
  return page.evaluate(`new Promise(resolve=>{
    const node=document.querySelector('#primary-transcript'),gaps=[];let previous=null,index=0;
    const frame=at=>{if(previous!==null)gaps.push(at-previous);previous=at;
      const step=index<60?index/59:1-(index-60)/59;node.scrollTop=(node.scrollHeight-node.clientHeight)*step;
      node.dispatchEvent(new Event('scroll'));if(++index<120)requestAnimationFrame(frame);else requestAnimationFrame(at=>{
        gaps.push(at-previous);resolve({count:gaps.length,maxMs:Math.max(...gaps),framesOver50Ms:gaps.filter(n=>n>50).length,
          mountedEntries:node.querySelectorAll('[data-entry-id]').length,scrollHeight:node.scrollHeight});});
    };requestAnimationFrame(frame);
  })`, 120000);
}

async function measurePages(page: Page, maxPages: number): Promise<PageSample[]> {
  const pages: PageSample[] = [];
  for (let index = 0; index < maxPages; index++) {
    if (await page.evaluate<boolean>(`document.querySelector('#primary-earlier').hidden`)) break;
    const before = await page.evaluate<{ id: string; offsetPx: number } | null>(anchorExpression);
    const sample = await earlier(page);
    const after = await page.evaluate<{ id: string; offsetPx: number } | null>(anchorExpression);
    sample.anchor = { before, after, preserved: before?.id === after?.id && Math.abs((before?.offsetPx ?? 0) - (after?.offsetPx ?? 0)) <= 2 };
    pages.push(sample);
    if (sample.status !== 200 || !sample.nextCursor) break;
  }
  return pages;
}

type ClockSample = { epoch: number; start: number; end: number; timeOrigin: number };
type Calibration = { backend: ClockSample; browser: ClockSample };
export function calibratedSpan(ackEpoch: number, paintEpoch: number, samples: Calibration[]) {
  if (!samples.length || !Number.isFinite(ackEpoch) || !Number.isFinite(paintEpoch)) throw new Error('Invalid clock calibration');
  const low: number[] = [], high: number[] = [];
  for (const {backend, browser} of samples) {
    for (const sample of [backend, browser]) if (![sample.epoch, sample.start, sample.end].every(Number.isFinite) || sample.end < sample.start) throw new Error('Invalid clock calibration');
    low.push((browser.epoch - browser.end) - (backend.epoch - backend.start));
    high.push((browser.epoch - browser.start) - (backend.epoch - backend.end));
  }
  const relativeOffsetMinMs = Math.min(...low), relativeOffsetMaxMs = Math.max(...high);
  const lowerMs = paintEpoch - ackEpoch - relativeOffsetMaxMs - 2;
  const upperMs = paintEpoch - ackEpoch - relativeOffsetMinMs + 2;
  return { estimateMs: (lowerMs + upperMs) / 2, lowerMs, upperMs, uncertaintyMs: (upperMs - lowerMs) / 2,
    relativeOffsetMinMs, relativeOffsetMaxMs, quantizationAllowanceMs: 2,
    method: 'Backend IPC and browser CDP timestamps bracketed by runner monotonic time before and after Resume; assumes stable relative clock rate during the short trial.' };
}
async function calibrate(child: ChildProcess, page: Page): Promise<Calibration> {
  const start = performance.now();
  const backend = await exchange<{epoch: number; timeOrigin: number}>(child, 'clock');
  const end = performance.now(), browserStart = performance.now();
  const browser = await page.evaluate<{epoch: number; timeOrigin: number}>(`({epoch:performance.timeOrigin+performance.now(),timeOrigin:performance.timeOrigin})`);
  return { backend: {...backend, start, end}, browser: {...browser, start: browserStart, end: performance.now()} };
}
async function outputTrial(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(async()=>{
    const state=window.__large,encoder=new TextEncoder(),node=document.querySelector('#primary-transcript');
    const entry=document.querySelector('[data-entry-id="fixture-output"]'),section=entry?.querySelector('.output-pages');
    if(!section)throw Error('No explicit Load more output control');
    node.scrollTop=entry.offsetTop-node.offsetTop;node.dispatchEvent(new Event('scroll'));
    const frames=()=>new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame));await frames();
    const anchor=()=>${anchorExpression};
    const beforeAnchor=anchor(),samples=[],texts=[];
    const retained=state.history.flatMap(n=>n.data.data?.items??[]).find(n=>n.id==='fixture-output');
    const preview=retained?.messages?.[0]?.parts?.[0];if(!preview?.more)throw Error('No protected continuation metadata');
    let offset=preview.more.offset;
    const click=async label=>{
      const button=[...section.querySelectorAll('button')].find(n=>n.textContent===label);
      if(!button||button.disabled)throw Error('Unavailable output control '+label);
      button.focus({preventScroll:true});const count=state.outputs.length;button.click();
      await new Promise((resolve,reject)=>{
        const check=()=>state.outputs.length>count&&!section.querySelectorAll('button')[0]?.disabled;
        const cleanup=()=>{clearTimeout(timer);observer.disconnect();};
        const observer=new MutationObserver(()=>{if(check()){cleanup();resolve(true);}});
        const timer=setTimeout(()=>{cleanup();reject(Error('Output UI timeout'));},10000);
        observer.observe(section,{subtree:true,attributes:true,childList:true,characterData:true});if(check()){cleanup();resolve(true);}
      });await frames();return state.outputs.at(-1);
    };
    let matched=true,bounded=true,contiguous=true,last;
    for(let index=0;index<64&&offset!==null;index++){
      const response=await click(index===0?'Load more output':'Next output');const data=response.data.data;
      if(!data||response.status!==200)throw Error('Output read refused: '+JSON.stringify({path:response.path,status:response.status,error:response.data.error}));
      const text=section.querySelector('.output-page').textContent,bytes=encoder.encode(data.text).length;
      matched&&=text===data.text;bounded&&=bytes<=8192&&encoder.encode(text).length<=8192;
      contiguous&&=Number(new URL(response.path,location.href).searchParams.get('offset'))===offset&&data.entryId==='fixture-output'&&data.part===0;
      samples.push({offset,bytes,nextOffset:data.nextOffset,totalBytes:data.totalBytes});texts.push(data.text);offset=data.nextOffset;last=response;
    }
    const afterAnchor=anchor(),anchorPreserved=beforeAnchor?.id===afterAnchor?.id&&Math.abs((beforeAnchor?.offsetPx??0)-(afterAnchor?.offsetPx??0))<=2;
    const all=preview.text+texts.join(''),reconstructedTextMatches=all===${literal(syntheticOutputText().replace('Bearer synthetic-page-boundary-token', 'Bearer [redacted]'))};
    const previous=await click('Previous output'),previousMatches=section.querySelector('.output-page').textContent===texts.at(-2);
    await (async()=>{[...section.querySelectorAll('button')].find(n=>n.textContent==='Start over').click();await frames();})();
    const startOverCleared=section.querySelector('.output-page').hidden&&section.querySelector('.output-page').textContent==='';
    const url=new URL(last.path,location.href),checks=[];
    for(const [name,fields] of [['stale-epoch',{epoch:String(Number(url.searchParams.get('epoch'))+1)}],['invalid-offset',{offset:'-1'}],['missing-entry',{entry:'absent-entry',offset:'0'}],['inactive-branch',{entry:'fixture-inactive',offset:'0'}],['hidden-output',{entry:'fixture-hidden',offset:'0'}],['redacted-thinking',{entry:'fixture-redacted',offset:'0'}]]){
      const target=new URL(url);for(const [key,value] of Object.entries(fields))target.searchParams.set(key,value);
      const response=await fetch(target.pathname+target.search),data=await response.json();checks.push({name,status:response.status,code:data.error?.code,refused:!data.ok});
    }
    return {pages:samples,pageCount:samples.length,complete:offset===null,matched,bounded,contiguous,
      reconstructedBytes:encoder.encode(all).length,reconstructedTextMatches,
      protected:!all.includes('synthetic-page-boundary-token')&&all.includes('Bearer [redacted]'),endMarker:all.endsWith('END-OUTPUT'),
      previousMatches,previousStatus:previous.status,startOverCleared,beforeAnchor,afterAnchor,anchorPreserved,checks,
      passed:offset===null&&matched&&bounded&&contiguous&&reconstructedTextMatches&&previousMatches&&startOverCleared&&anchorPreserved&&checks.every(n=>n.refused)&&!all.includes('synthetic-page-boundary-token')};
  })()`, 120000);
}

async function syntheticOutput(config: Options, page: Page, report: Record<string, unknown>) {
  if (config.session || config.rich) return;
  report.output = await outputTrial(page).catch(error => ({passed:false,error:String(error)}));
}
async function batchTrial(rich: boolean, page: Page): Promise<unknown> {
  if (!rich) return undefined;
  const beforeDom = await page.send('Memory.getDOMCounters'), beforeHeap = await page.send('Runtime.getHeapUsage');
  await page.evaluate(`(()=>{
    const node=document.querySelector('#primary-transcript');node.scrollTop=0;node.dispatchEvent(new Event('scroll'));
    window.__batch={samples:[]};return new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame));
  })()`);
  const samples: unknown[] = [];
  for (const label of ['Expand loaded tools', 'Show thinking']) {
    await page.evaluate(`(()=>{
      const state=window.__batch,node=document.querySelector('#primary-transcript'),row=node.querySelector('[data-entry-id]');
      row.tabIndex=-1;row.focus({preventScroll:true});state.focus=row;state.focusId=row.dataset.entryId;
      const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT),text=walker.nextNode();if(!text)throw Error('No selection text');
      const range=document.createRange();range.setStart(text,0);range.setEnd(text,Math.min(text.length,12));getSelection().removeAllRanges();getSelection().addRange(range);state.selection=getSelection().toString();
      document.querySelector('#session-actions').click();[...document.querySelectorAll('#modal button')].find(n=>n.textContent==='Conversation view…').click();
    })()`);
    const sample = await page.evaluate<Record<string, unknown>>(`(async()=>{
      const node=document.querySelector('#primary-transcript'),state=window.__batch,frames=[],tasks=[];
      const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(n=>n.duration)));observer.observe({type:'longtask'});
      const snapshot=()=>{const rows=[...node.querySelectorAll('[data-entry-id]')],rect=node.getBoundingClientRect(),height=node.clientHeight;
        const viewport=row=>{const r=row.getBoundingClientRect();return r.bottom>rect.top-2*height&&r.top<rect.bottom+2*height;};
        const viewportRows=rows.filter(viewport).length,outsideFocusSelectionPins=rows.filter(row=>!viewport(row)&&(row.contains(document.activeElement)||row.contains(getSelection().anchorNode)||row.contains(getSelection().focusNode))).length;
        return {mountedRows:rows.length,viewportRows,outsideFocusSelectionPins,expectedMountedBound:viewportRows+outsideFocusSelectionPins,offscreenCacheEntryBound:32,
          domElements:node.querySelectorAll('*').length,openTools:node.querySelectorAll('.tool-card[open]').length,openThinking:node.querySelectorAll('.thinking[open]').length};};
      const before=snapshot();let start=0,previous=0,paintAt;
      const done=new Promise(resolve=>{let index=0;const frame=at=>{frames.push(at-previous);previous=at;if(++index===2)paintAt=at;
        if(index<20)requestAnimationFrame(frame);else resolve(true);};requestAnimationFrame(frame);});
      const control=[...document.querySelectorAll('#modal button')].find(n=>n.textContent===${literal(label)});if(!control)throw Error('Missing batch control');start=performance.now();previous=start;control.click();await done;
      tasks.push(...observer.takeRecords().map(n=>n.duration));observer.disconnect();
      return {label:${literal(label)},controlToPaintMs:paintAt-start,maxFrameMs:Math.max(...frames),maxLongTaskMs:tasks.length?Math.max(...tasks):0,longTasks:tasks.length,
        before,after:snapshot(),focusPreserved:document.activeElement===state.focus,selectionPreserved:getSelection().toString()===state.selection};
    })()`, 120000);
    samples.push({...sample,domCounters:await page.send('Memory.getDOMCounters'),heapUsage:await page.send('Runtime.getHeapUsage')});
  }
  const scrollback = await page.evaluate(`(async()=>{
    const node=document.querySelector('#primary-transcript'),frames=()=>new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame));
    const first=node.querySelector('.tool-card'),firstId=first?.dataset.disclosure;getSelection().removeAllRanges();document.querySelector('#primary-editor').focus();
    const samples=[];for(const fraction of [1,0.5,0]){node.scrollTop=(node.scrollHeight-node.clientHeight)*fraction;node.dispatchEvent(new Event('scroll'));await frames();
      const cards=[...node.querySelectorAll('.tool-card')],thoughts=[...node.querySelectorAll('.thinking')];samples.push({fraction,rows:node.querySelectorAll('[data-entry-id]').length,
        tools:cards.length,thinking:thoughts.length,toolsOpen:cards.every(n=>n.open),thinkingOpen:thoughts.every(n=>n.open),firstOwnerMounted:cards.some(n=>n.dataset.disclosure===firstId)});}
    return {firstId,samples,savedIntent:samples.every(n=>n.toolsOpen&&n.thinkingOpen)};
  })()`, 120000);
  const cohort = await page.evaluate(`(()=>{const entries=[...new Map(window.__large.history.flatMap(n=>n.data.data?.items??[]).map(n=>[n.id,n])).values()];const parts=entries.flatMap(n=>(n.messages??[]).flatMap(m=>m.parts));return {entries:entries.length,toolCalls:parts.filter(n=>n.type==='toolCall').length,thinkingParts:parts.filter(n=>n.type==='thinking').length};})()`);
  return {cohort,beforeDom,beforeHeap,samples,scrollback,afterDom:await page.send('Memory.getDOMCounters'),afterHeap:await page.send('Runtime.getHeapUsage'),cacheProxy:'CDP DOM counters include detached nodes; no exact private cache count'};
}
function ackSpan(report: Record<string, unknown>, samples: Calibration[]) {
  const stages = (report.backendAfterResume as {stages: {stage: string; id: string; at: number}[]}).stages;
  const ack = stages.find(n => n.stage === 'rpc.ack' && n.id.endsWith(':rpc-1'));
  const painted = report.resume as {browserTimeOrigin?: number; paintAt?: number};
  if (!ack || !painted.paintAt || !painted.browserTimeOrigin) return null;
  return {...calibratedSpan((samples.at(-1) as Calibration).backend.timeOrigin + ack.at, painted.browserTimeOrigin + painted.paintAt, samples),commandId:ack.id};
}
export async function runLargeSession(config: Options): Promise<Record<string, unknown>> {
  await mkdir(config.out, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(config.out, 'trial-'));
  const cwd = join(root, 'project'), agentDir = join(root, 'agent'), stateDir = join(root, 'state');
  const sessionDir = join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const source = await sessionSource(config, cwd);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const copied = copySession(source, cwd), session = join(sessionDir, config.session ? basename(config.session) : 'synthetic.jsonl');
  await writeFile(session, copied, { mode: 0o600 });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], promptTemplates: [], themes: [] }), { mode: 0o600 });
  const launchFile = join(root, 'backend-probe.mts');
  await writeFile(launchFile, launcher(new URL('../server/main.mts', import.meta.url).href), { mode: 0o600 });
  const hashes = await sourceHashes(); servedAssets(hashes);
  const report: Record<string, unknown> = {richFixture:config.rich === true, testedSourceHashes: hashes, mode: config.session ? 'copied-real' : 'synthetic', sourceBytes: source.length,
    copiedBytes: copied.length, sourceHash, sourceName: config.session ? basename(config.session) : 'synthetic25MiB',
    root, node: process.version, pages: [], limitations: [
      'One cold trial per invocation; no population percentile for resume.',
      'Paint means two animation-frame callbacks after visible transcript DOM, not hardware display confirmation.',
      'RSS includes the backend only, not Pi or browser. Peak RSS is the process lifetime high-water mark.',
      'Event-loop histogram resolution is 1 ms; includes runtime and probe overhead, not causal attribution.',
      'State-to-paint uses the latest browser-received primary.state before paint, not a synchronized backend clock.',
      'Rich-fixture DOM counters include detached DOM and act as a cache proxy, not an exact cache count.',
    ] };
  const child = spawn(process.execPath, [launchFile, '--cwd', cwd, '--state-dir', stateDir, '--port', '0', '--pi', config.pi], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_SESSIONS_DIR: join(agentDir, 'agent-sessions') },
  });
  const done = exited(child);
  let stderr = ''; child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); }); child.stdout?.resume();
  let browser: Awaited<ReturnType<typeof launchBrave>> | undefined;
  try {
    const url = await ready(child); report.backendPid = child.pid;
    browser = await launchBrave(); report.browser = browser.version;
    const page = browser.page;
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
    await page.navigate(url);
    await page.evaluate(`new Promise((resolve,reject)=>{if(window.__large.ready){resolve(true);return;}const timer=setTimeout(()=>reject(Error('UI readiness timeout')),10000);document.addEventListener('ui-ready',()=>{clearTimeout(timer);resolve(true);},{once:true});})`);
    report.servedAssetsBefore = await verifyServedAssets(page, hashes);
    if (!(report.servedAssetsBefore as {allMatched: boolean}).allMatched) throw new Error('Served assets differ from the source snapshot');
    report.backendBefore = await exchange(child, 'probe'); await exchange(child, 'reset');
    const beforeClocks = await calibrate(child, page);
    report.resume = await resume(page, cwd, session);
    const afterClocks = await calibrate(child, page); report.clockCalibration = [beforeClocks, afterClocks];
    report.backendAfterResume = await exchange(child, 'probe');
    report.getStateAckToPaint = ackSpan(report, [beforeClocks, afterClocks]);
    if ((report.resume as { failure?: string }).failure) {
      report.nativeDom = await page.evaluate(`({entries:document.querySelectorAll('#primary-transcript [data-entry-id]').length,editorTag:document.querySelector('#primary-editor')?.tagName,editorDisabled:document.querySelector('#primary-editor')?.disabled,modalOpen:document.querySelector('#modal')?.open,earlierHidden:document.querySelector('#primary-earlier')?.hidden,history:window.__large.history.map(n=>({status:n.status,entries:n.data.data?.items?.length}))})`);
      const start = performance.now();
      await page.navigate(await page.evaluate<string>('location.href'));
      await page.waitFor(`document.querySelector('#primary-transcript [data-entry-id]')`);
      await page.evaluate('new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame))');
      report.postRefresh = { refreshToPaintMs: performance.now() - start, reason: 'Explicit refresh after native Resume did not paint history' };
      await page.evaluate(`document.querySelector('#primary-editor').focus()`);
    }
    await syntheticOutput(config, page, report);
    await page.evaluate(`document.querySelector('#primary-editor').focus()`);
    await page.send('Input.insertText', { text: 'Private composer echo, never submitted.' });
    report.composerEcho = await page.evaluate(`new Promise(requestAnimationFrame).then(()=>({usable:document.querySelector('#primary-editor').value==='Private composer echo, never submitted.'}))`);
    await page.waitFor(`window.__large.history.length>0 || !document.querySelector('#primary-earlier').hidden`);
    await page.evaluate(`(()=>{const node=document.querySelector('#primary-transcript');node.scrollTop=Math.max(0,node.scrollTop-node.clientHeight/2);node.dispatchEvent(new Event('scroll'));return new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame));})()`);
    report.anchorMode = 'Deliberate reading position above the tail before Earlier pages';
    const pages = await measurePages(page, config.maxPages);
    report.pages = pages; report.earlierLatency = distribution(pages.map(sample => sample.latencyMs));
    report.earlierAnchorFailures = pages.filter(sample => !(sample.anchor as {preserved: boolean}).preserved).length;
    report.reachedTop = await page.evaluate<boolean>(`document.querySelector('#primary-earlier').hidden`);
    report.pageLimitReached = pages.length === config.maxPages && !report.reachedTop;
    report.backendAfterPages = await exchange(child, 'probe');
    report.batch = await batchTrial(config.rich === true, page);
    report.scroll = await scrollFrames(page);
    report.backendAfterScroll = await exchange(child, 'probe');
    report.inputRequests = await page.evaluate('window.__large.inputs');
    report.initialHistory = await page.evaluate(`window.__large.history[0]?{entries:window.__large.history[0].data.data?.items?.length,coverage:window.__large.history[0].data.data?.coverage,status:window.__large.history[0].status}:null`);
    report.browserMeasures = await page.evaluate(`performance.getEntriesByType('measure').map(n=>({name:n.name,durationMs:n.duration}))`);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.backendAtFailure = await exchange(child, 'probe').catch(() => null);
    report.domAtFailure = await browser?.page.evaluate(`({body:document.body.innerText.slice(0,12000),outputs:window.__large?.outputs.map(n=>({path:n.path,status:n.status,error:n.data.error})),history:window.__large?.history.map(n=>({status:n.status,entries:n.data.data?.items?.length,error:n.data.error}))})`).catch(() => null);
  }
  finally {
    report.backendFinal = await exchange(child, 'probe').catch(() => null);
    await afterAssets(report, hashes, browser?.page);
    await browser?.close().catch(error => { report.browserCleanupError = String(error); });
    await stopBackend(child, done).catch(error => { report.backendCleanupError = String(error); });
    await closeBinding(report, hashes);
    report.backendExited = child.exitCode !== null || child.signalCode !== null;
    report.backendExitCode = child.exitCode; report.backendExitSignal = child.signalCode;
    if (config.session) report.sourceUnchanged = sourceHash === createHash('sha256').update(await readFile(config.session)).digest('hex');
    if (stderr) await writeFile(join(root, 'backend-stderr.txt'), stderr, { mode: 0o600 });
    await writeFile(join(config.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runLargeSession(options(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (trialFailed(report)) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
