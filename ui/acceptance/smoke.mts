import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Bootstrap, PrimaryView } from "../shared/api.ts";
import { launchBrave, type Page } from "./cdp.mts";

export type Options = { url: string; out: string; fake: boolean; cwd?: string; session?: string; prompt: string; dialogPrompt?: string };
export function options(args: string[]): Options {
  const { values } = parseArgs({ args, options: {
    url: { type: "string" }, out: { type: "string" }, fake: { type: "boolean", default: false },
    cwd: { type: "string" }, session: { type: "string" }, prompt: { type: "string", default: "acceptance smoke no-dialog" },
    "dialog-prompt": { type: "string" },
  } });
  if (!values.url || !values.out) throw new Error("Use --url <launch URL> --out <capture directory> [--fake --cwd <project>]");
  const url = new URL(values.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new Error("Smoke URL must be HTTP on 127.0.0.1 with an explicit port");
  }
  if (values.session && !values.fake) throw new Error("Automatic session setup requires --fake");
  if (values.cwd && !values.fake) throw new Error("Automatic project setup requires --fake");
  return { url: values.url, out: resolve(values.out), fake: values.fake, cwd: values.cwd,
    session: values.session, prompt: values.prompt, dialogPrompt: values["dialog-prompt"] };
}

const usage = `Usage: node ui/acceptance/smoke.mts --url <launch URL> --out <capture directory>

  --help                  Print this help without browser startup.
  --url <launch URL>      HTTP on 127.0.0.1 with an explicit port.
  --out <directory>       Write screenshots and report.json here.
  --fake                  Enable deterministic fixture checks only.
  --cwd <project>         Open a disposable fixture project; requires --fake.
  --session <saved path>  Resume a saved fixture session instead of a new one.
                          Use with --fake --cwd and no other Pi writer.
  --prompt <text>         Fixture trigger; default: acceptance smoke no-dialog.
  --dialog-prompt <text>  Optional fixture dialog trigger.

The default run submits no model prompts. Fixture mode checks the selected provider.
`;

class Unavailable extends Error {}
type Check = { name: string; status: "passed" | "failed" | "unavailable"; scope: "browser" | "fixture" | "real"; detail?: string };
type Report = { browser: unknown; viewport: { width: number; height: number }; mode: string;
  checks: Check[]; screenshots: string[]; timings: Record<string, unknown>; boundaries: string[]; inputRequests?: unknown[]; roster?: Bootstrap["roster"] };
const editor = "#primary-editor";
const literal = (value: unknown): string => JSON.stringify(value);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
type PickerPage = Pick<Page, "evaluate" | "waitFor">;
async function click(page: PickerPage, selector: string): Promise<void> {
  await page.evaluate(`(()=>{const node=document.querySelector(${literal(selector)});if(!node||node.disabled||node.hidden)throw new Error('Control unavailable: '+${literal(selector)});node.click();})()`);
}
async function button(page: PickerPage, text: string): Promise<void> {
  await page.evaluate(`(()=>{const node=Array.from(document.querySelectorAll('button')).find(n=>n.textContent.trim()===${literal(text)}&&!n.closest('[hidden]'));if(!node)throw new Error('Button unavailable: '+${literal(text)});node.click();})()`);
}
async function text(page: PickerPage, selector: string, value: string): Promise<void> {
  await page.evaluate(`(()=>{const node=document.querySelector(${literal(selector)});if(!node)throw new Error('Editor unavailable');node.focus();node.value=${literal(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function field(page: PickerPage, label: string, value: string): Promise<void> {
  await page.evaluate(`(()=>{const caption=Array.from(document.querySelectorAll('#modal[open] label')).find(n=>n.textContent===${literal(label)});const node=caption&&document.getElementById(caption.htmlFor);if(!node)throw new Error('Field unavailable: '+${literal(label)});node.focus();node.value=${literal(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function snapshot(page: PickerPage): Promise<Bootstrap> {
  return page.evaluate(`(async()=>{const workspace=new URL(location.href).searchParams.get('workspace');const response=await fetch('/api/bootstrap'+(workspace?'?workspace='+encodeURIComponent(workspace):''));const result=await response.json();if(!result.ok)throw new Error(result.error.message);return result.data;})()`);
}
async function waitRoster(page: Page): Promise<void> {
  await page.evaluate(`new Promise((resolve,reject)=>{
    const source=window.__acceptanceStreams?.at(-1);
    if(!source){reject(new Error('No browser event stream for roster readiness'));return;}
    const cleanup=()=>{clearTimeout(timer);source.removeEventListener('agent.roster',received);};
    const done=()=>{cleanup();resolve(true);};
    const received=event=>{try{const scan=JSON.parse(event.data).data.scan;if(scan.state==='ready'||scan.state==='failed')done();}catch(error){cleanup();reject(error);}};
    const timer=setTimeout(()=>{cleanup();reject(new Error('Roster discovery readiness timeout'));},10000);
    source.addEventListener('agent.roster',received);
    const workspace=new URL(location.href).searchParams.get('workspace');
    fetch('/api/bootstrap'+(workspace?'?workspace='+encodeURIComponent(workspace):''))
      .then(response=>response.json()).then(result=>{if(!result.ok)throw new Error(result.error.message);const scan=result.data.roster.scan;if(scan.state==='ready'||scan.state==='failed')done();})
      .catch(error=>{cleanup();reject(error);});
  })`, 11000);
}

async function collectInputs(page: Page, report: Report): Promise<void> {
  const items = await page.evaluate<unknown[]>("(()=>{const items=window.__acceptanceInputs??[];window.__acceptanceInputs=[];return items;})()").catch(() => []);
  report.inputRequests = [...report.inputRequests ?? [], ...items];
}
function primary(data: Bootstrap): PrimaryView {
  const value = data.primaries.find((item) => item.key === data.workspace.primaryKey);
  if (!value) throw new Error("No selected primary");
  return value;
}
export function requireFake(data: Bootstrap): void {
  assert.equal(primary(data).model?.provider, "acceptance-fixture", "Refuse prompts: selected primary is not the deterministic acceptance fixture");
}
export function assertFixturePresentation(value: { emptyToolResultHeaders: number; inputReceipt: string; controlReceipt?: string }): void {
  assert.equal(value.emptyToolResultHeaders, 0, "An empty toolResult message header remains visible");
  assert(!value.inputReceipt.includes("Send not confirmed"), "Admitted fixture input has an unconfirmed send notice");
  assert(!value.controlReceipt?.includes("Target exited before a receipt arrived"), "Completed fixture control retained a provisional error");
}
async function fixturePresentation(page: Page): Promise<void> {
  const value = await page.evaluate<{ emptyToolResultHeaders: number; inputReceipt: string; controlReceipt: string }>(`(()=>({
    emptyToolResultHeaders:Array.from(document.querySelectorAll('#primary-transcript .message')).filter(node=>
      node.querySelector('.message-header span')?.textContent==='toolResult' &&
      node.querySelector('.message-body')?.childElementCount===0 && node.querySelector('.message-error')?.hidden).length,
    inputReceipt:document.querySelector('#primary-receipt')?.textContent??'',
    controlReceipt:document.querySelector('#primary-receipt')?.textContent??''
  }))()`);
  assertFixturePresentation(value);
}
async function saved(page: Page, value: string): Promise<void> {
  await page.waitFor(`document.querySelector('#primary-save')?.textContent.startsWith('Saved') || document.querySelector('#primary-save')?.textContent.includes('Draft changed in another tab')`);
  const status = await page.evaluate<string>("document.querySelector('#primary-save').textContent");
  assert.match(status, /^Saved(?: ·|$)/, "Single-tab draft persistence did not reach a saved acknowledgment");
  const state = await snapshot(page); const target = primary(state);
  const draft = state.targets?.find((item) => item.target.kind === "primary" && item.target.key === target.key && item.target.epoch === target.epoch)?.draft;
  assert.equal(draft?.text, value, "Backend draft does not match the editor");
}
async function prompt(page: Page, value: string): Promise<void> {
  requireFake(await snapshot(page));
  await text(page, editor, value);
  await saved(page, value);
  await page.waitFor(`!document.querySelector('#primary-send')?.disabled`);
  await click(page, "#primary-send");
  await page.waitFor(`document.querySelector('#primary-save')?.textContent.includes('Admitted') || document.querySelector('#primary-receipt')?.textContent.includes('Send not confirmed') || document.querySelector('#primary-receipt')?.textContent.includes('refused')`);
  const receipt = await page.evaluate<string>("document.querySelector('#primary-save').textContent+' '+document.querySelector('#primary-receipt').textContent");
  assert(receipt.includes("Admitted"), `Fixture input not admitted: ${receipt}`);
}

type RunCheck = (name: string, action: () => Promise<void>, scope?: Check["scope"]) => Promise<void>;
export async function openProject(page: PickerPage, config: Options, check: RunCheck): Promise<void> {
  if (!config.fake || !config.cwd) return;
  await check("7.1 explicit disposable project/session open", async () => {
    await click(page, "#project-button");
    await page.waitFor(`document.querySelector('#modal[open] #picker-project')`);
    await text(page, "#picker-project", config.cwd ?? "");
    await button(page, "Continue");
    await page.waitFor(`document.querySelector('#modal[open] #picker-search')`);
    if (config.session) {
      await button(page, "Open saved session path…");
      await page.waitFor(`document.querySelector('#modal[open] #picker-session-path')`);
      await field(page, "Project directory", config.cwd ?? "");
      await field(page, "Saved session path", config.session);
      await button(page, "Resume saved session");
      await button(page, "No other writer · Resume");
    } else await button(page, "Start new session");
    await page.waitFor(`!document.querySelector('#model-button')?.disabled`);
    requireFake(await snapshot(page));
  }, "fixture");
}

async function handoff(page: Page, config: Options, check: RunCheck, capture: (name: string) => Promise<void>): Promise<void> {
  await check("7.6 handoff action presents an explicit boundary", async () => {
    await click(page, "#session-actions"); await button(page, "Continue in terminal…");
    await page.waitFor(`document.querySelector('#modal[open]')`);
    await capture("07-terminal-handoff");
  });
  if (config.fake) await check("7.6 outgoing fixture handoff waits for primary process exit", async () => {
    const before = primary(await snapshot(page)); requireFake(await snapshot(page));
    assert(before.sessionFile, "Fixture has no saved session file");
    await button(page, "Release for terminal");
    await page.waitFor(`document.querySelector('#modal-title')?.textContent==='Ready for terminal' || Boolean(document.querySelector('#modal-error')?.textContent)`);
    const refusal = await page.evaluate<string>("document.querySelector('#modal-error').textContent");
    if (/saved session|saved file|persisted session/i.test(refusal)) throw new Unavailable(refusal);
    assert.equal(refusal, "", "Fixture handoff refused");
    const after = primary(await snapshot(page)); assert.equal(after.lifecycle, "stopped");
    assert.equal(after.sessionFile, before.sessionFile);
    if (before.pid) assert.throws(() => process.kill(before.pid ?? 0, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    const command = await page.evaluate<string>("document.querySelector('#modal pre').textContent");
    assert(command.includes(before.sessionFile), "Terminal command does not name the saved fixture session");
    await capture("07-fixture-released");
    await fixturePresentation(page);
  }, "fixture");
  await click(page, "#modal-close");
}

async function fixtureControls(page: Page, config: Options, check: RunCheck): Promise<void> {
  if (!config.fake) return;
  await check("7.5 fixture model and thinking applied results", async () => {
    requireFake(await snapshot(page));
    await click(page, "#model-button");
    await page.waitFor(`Array.from(document.querySelectorAll('#modal button')).some(n=>n.textContent==='acceptance-fixture/alternate')`);
    await button(page, "acceptance-fixture/alternate");
    await page.waitFor(`document.querySelector('#model-button')?.textContent.includes('/alternate')`);
    assert.equal(primary(await snapshot(page)).model?.id, "alternate");
    await click(page, "#thinking-button");
    await page.waitFor(`Array.from(document.querySelectorAll('#modal button')).some(n=>n.textContent==='off')`);
    await button(page, "off");
    await page.waitFor(`document.querySelector('#thinking-button')?.textContent.includes('off')`);
    assert.equal(primary(await snapshot(page)).thinkingLevel, "off");
  }, "fixture");
  await check("7.5 fixture compaction reports its real event boundary", async () => {
    requireFake(await snapshot(page));
    await page.evaluate("window.__acceptanceRecoveries=[]");
    await click(page, "#session-actions"); await button(page, "Compact…"); await button(page, "Compact");
    await page.waitFor(`!document.querySelector('#modal[open]')`);
    const events = await page.evaluate<{data: {kind: string; phase: string}}[]>("window.__acceptanceRecoveries");
    assert(events.some((event) => event.data.kind === "compaction" && event.data.phase === "start"));
    assert(events.some((event) => event.data.kind === "compaction" && event.data.phase === "end"));
  }, "fixture");
}

export async function runSmoke(config: Options): Promise<Report> {
  await mkdir(config.out, { recursive: true });
  const browser = await launchBrave(); const page = browser.page;
  const report: Report = { browser: browser.version, viewport: { width: 1440, height: 900 },
    mode: config.fake ? "deterministic fixture, not real integration acceptance" : "no-prompt browser inspection",
    checks: [], screenshots: [], timings: {}, boundaries: [
      "Headless Brave only. Safari and foreground display acceptance remain unavailable.",
      "No paid provider prompts. Fixture results do not establish real Pi model, tool, extension, or Durable behavior.",
      "No native agent input or abort without an authorized disposable agent fixture.",
      "No terminal process starts. Actual terminal identity and sole-writer handoff remain unavailable.",
      "No backend event-to-paint p95 claim: cross-process timestamp accounting is not supplied.",
    ] };
  const check = async (name: string, action: () => Promise<void>, scope: Check["scope"] = "browser") => {
    try { await action(); report.checks.push({ name, status: "passed", scope }); }
    catch (error) { report.checks.push({ name, status: error instanceof Unavailable ? "unavailable" : "failed", scope, detail: errorMessage(error) }); }
  };
  const unavailable = (name: string, detail: string) => report.checks.push({ name, status: "unavailable", scope: "real", detail });
  const capture = async (name: string) => {
    const file = join(config.out, `brave-${name}.png`); await page.screenshot(file); report.screenshots.push(file);
  };
  try {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{
      window.__acceptanceInputs=[];
      const nativeFetch=window.fetch.bind(window);window.fetch=async(...args)=>{
        const path=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href).pathname;
        const input=/^\\/api\\/primaries\\/[^/]+\\/inputs$/.test(path)&&args[1]?.method==='POST';
        const record=input?{path,body:JSON.parse(args[1].body)}:undefined;
        if(record)window.__acceptanceInputs.push(record);
        const response=await nativeFetch(...args);
        if(record){const result=await response.clone().json();record.status=response.status;record.error=result.ok?undefined:result.error;}
        return response;
      };
      const Native=window.EventSource;window.__acceptanceStreams=[];window.__acceptanceRecoveries=[];
      window.EventSource=class extends Native{constructor(...args){super(...args);window.__acceptanceStreams.push(this);this.addEventListener('primary.recovery',event=>{window.__acceptanceRecoveries.push(JSON.parse(event.data));});}};
      window.__acceptanceLongTasks=[];
      try{new PerformanceObserver(list=>window.__acceptanceLongTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});}catch{}
    })()` });
    await page.navigate(config.url);
    await page.waitFor(`!location.hash.includes('launch=') && (document.querySelector('#modal[open]') || !document.querySelector('#model-button')?.disabled)`);
    await check("7.1 launch capability disappears from browser history", async () => {
      assert.equal(await page.evaluate("location.hash"), "");
      assert.equal(await page.evaluate("document.body.textContent.includes('Pair device')"), false);
    });
    await openProject(page, config, check);
    const initial = await snapshot(page);
    const selected = initial.primaries.find((item) => item.key === initial.workspace.primaryKey);
    if (!selected) {
      unavailable("7.1 primary draft and session checks", "No selected primary; provide --fake --cwd for a deterministic backend.");
      await capture("01-primary-roster");
      return report;
    }
    if (config.fake) requireFake(initial);
    const originalDraft = await page.evaluate<string>("document.querySelector('#primary-editor').value");
    const draftText = config.fake ? "Acceptance primary draft\nSecond line" : originalDraft;
    if (config.fake) await check("7.1 multiline editor and backend draft persistence", async () => {
      await text(page, editor, "Acceptance primary draft");
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", modifiers: 8 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", modifiers: 8 });
      await page.send("Input.insertText", { text: "Second line" });
      assert.equal(await page.evaluate("document.querySelector('#primary-editor').value"), draftText);
      await saved(page, draftText);
    }, "fixture");
    await check("7.1 primary remains separate from the agent panel", async () => {
      const hidden = await page.evaluate<boolean>("document.querySelector('#agent-panel').hidden");
      if (hidden) await click(page, "#agents-button");
      await page.waitFor(`!document.querySelector('#agent-panel')?.hidden`);
      assert.equal(await page.evaluate("document.querySelector('#primary-editor').value"), draftText);
      assert.equal(primary(await snapshot(page)).key, selected.key);
    });
    await capture("01-primary-roster");
    if (config.fake) {
      await check("7.2 fixture prompt admission, thinking and tool output", async () => {
        await prompt(page, config.prompt);
        await page.waitFor(`document.querySelector('#primary-transcript .tool-card') && document.querySelector('#primary-transcript .thinking')`);
        await page.waitFor(`document.querySelector('#primary-save')?.textContent.includes('Admitted')`);
        await page.evaluate(`(()=>{const thinking=document.querySelector('#primary-transcript .thinking');const tool=document.querySelector('#primary-transcript .tool-card');for(const card of [thinking,tool]){const trigger=card.querySelector('summary,button');if(trigger)trigger.click();}})()`);
        await fixturePresentation(page);
      }, "fixture");
      await capture("02-stream-tool");
      if (config.dialogPrompt) await check("7.2 extension fixture dialog cancellation and focus return", async () => {
        await prompt(page, config.dialogPrompt ?? "");
        await page.waitFor(`document.querySelector('#modal[open]')`);
        await capture("03-extension-dialog");
        await click(page, "#modal-close");
        await page.waitFor(`!document.querySelector('#modal[open]')`);
        assert.equal(await page.evaluate("document.activeElement?.id"), "primary-editor");
      }, "fixture");
      else unavailable("7.2 real extension dialog", "No prepared extension dialog trigger supplied; a mock screenshot does not replace the real path.");
    } else unavailable("7.2 prompt/tool/dialog", "Read-only run does not submit real prompts.");
    await check("7.3 retained agent detail and primary target isolation", async () => {
      await waitRoster(page);
      const roster = (await snapshot(page)).roster;
      report.roster = roster;
      if (roster.scan.state === "failed") throw new Unavailable(`Roster discovery failed: ${roster.error?.message ?? "no usable catalog baseline"}`);
      if (!roster.rows.length) throw new Unavailable(`No selectable retained agent in the cached roster; omitted ${roster.scan.omitted}, discovery complete ${roster.scan.complete}`);
      await page.evaluate(`(()=>{const row=document.querySelector('#roster .row-select');if(!row)throw new Error('No selectable roster row');row.click();})()`);
      await page.waitFor(`!document.querySelector('#agent-detail')?.hidden && document.querySelector('#agent-identity')?.textContent`);
      const identity = await page.evaluate<string>("document.querySelector('#agent-identity').textContent");
      assert(roster.rows.some((row) => row.identity === identity), "Full known agent identity is not visible");
      assert.equal(primary(await snapshot(page)).key, selected.key);
      if (config.fake) {
        await text(page, editor, draftText); await saved(page, draftText);
        await text(page, "#agent-editor", "Distinct agent draft, never sent");
        assert.equal(await page.evaluate("document.querySelector('#primary-editor').value"), draftText);
      }
      await capture("04-agent-detail");
    }, config.fake ? "fixture" : "browser");
    unavailable("7.3 native steer/follow-up/abort and frame scroll stability", "Requires a prepared compatible disposable Durable agent and separately authorized native operations.");
    if (config.fake) await check("7.4 refresh preserves primary identity and saved draft", async () => {
      await text(page, editor, draftText); await saved(page, draftText);
      const url = await page.evaluate<string>("location.href");
      await collectInputs(page, report);
      await page.navigate(url);
      await page.waitFor(`document.querySelector('#primary-editor')?.value===${literal(draftText)}`);
      const state = await snapshot(page); assert.equal(primary(state).key, selected.key); assert.equal(primary(state).epoch, selected.epoch);
    }, "fixture");
    await check("7.4 browser event transport disconnect and explicit reconnect", async () => {
      await page.evaluate(`(()=>{for(const source of window.__acceptanceStreams){source.close();source.dispatchEvent(new Event('error'));}})()`);
      await page.waitFor(`!document.querySelector('#connection')?.hidden`);
      assert.equal(await page.evaluate("document.querySelector('#primary-editor').value"), draftText);
      await capture("05-reconnect");
      await button(page, "Reconnect");
      await page.waitFor(`document.querySelector('#connection')?.hidden`);
      assert.equal(primary(await snapshot(page)).key, selected.key);
    });
    unavailable("7.4 uncertain input, replay gap and host mismatch", "No deterministic transport injection for these states supplied; disconnect alone does not establish them.");
    await check("7.5 model and thinking menus expose controls", async () => {
      await click(page, "#model-button"); await page.waitFor(`document.querySelector('#modal[open] .options button')`); await click(page, "#modal-close");
      const shown = await page.evaluate<boolean>("!document.querySelector('#thinking-button').hidden");
      if (shown) { await click(page, "#thinking-button"); await page.waitFor(`document.querySelector('#modal[open] .options button')`); await click(page, "#modal-close"); }
    });
    await check("7.5 compact layouts preserve target and draft without page overflow", async () => {
      for (const width of [1024, 800]) {
        await page.viewport(width, 900);
        await page.evaluate("new Promise(requestAnimationFrame)");
        assert.equal(await page.evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Page overflow at ${width}`);
        assert.equal(await page.evaluate("document.querySelector('#primary-editor').value"), draftText);
        assert.equal(primary(await snapshot(page)).key, selected.key);
      }
      await capture("06-compact-layout");
      await page.viewport(1440, 900);
    });
    await fixtureControls(page, config, check);
    unavailable("7.5 real fork, model/thinking, compaction and visual contrast", "Fixture control results do not establish real Pi transitions. Geometry does not establish visual contrast.");
    unavailable("7.6 terminal handoff and tab-close process continuity", "No authorized terminal driver or real saved-session writer trial; do not infer sole writer from HTTP success.");
    await handoff(page, config, check, capture);
    report.timings.longTasks = await page.evaluate("window.__acceptanceLongTasks");
    report.timings.browserMeasures = await page.evaluate("performance.getEntriesByType('measure').map(e=>({name:e.name,durationMs:e.duration}))");
    if (config.fake) {
      report.timings.editorEcho = await page.timing(`(()=>{const node=document.querySelector('#primary-editor');node.focus();node.value=${literal(draftText)};node.dispatchEvent(new Event('input',{bubbles:true}));return node.value;})()`);
    }
    return report;
  } catch (error) {
    report.checks.push({ name: "smoke setup", status: "failed", scope: "browser", detail: errorMessage(error) });
    await capture("failure").catch(() => {});
    return report;
  } finally {
    await collectInputs(page, report)
      .then(() => writeFile(join(config.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`))
      .finally(() => browser.close());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) console.log(usage);
  else {
    try {
      const report = await runSmoke(options(args));
      const counts = { passed: 0, failed: 0, unavailable: 0 };
      for (const check of report.checks) counts[check.status]++;
      console.log(JSON.stringify({ ...counts, screenshots: report.screenshots, boundaries: report.boundaries }, null, 2));
      if (counts.failed) process.exitCode = 1;
    } catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
  }
}
