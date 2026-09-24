import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "subagent-footer-host-"));
const agentDir = join(root, "agent");
const dirs = [join(root, "root"), join(root, "child"), join(root, "grandchild")];
for (const path of [agentDir, ...dirs]) mkdirSync(path);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = root;
const key = Symbol.for("subagent-test.footer-host");
let release = () => {};
const held = new Promise<void>((resolve) => { release = resolve; });
const snapshots = new Map<string, Array<Record<string, unknown>>>();
const sessionIds = new Map<string, string>();
const errors: unknown[] = [];
const status = new Map<string, string | undefined>();
const checkpoints = new Map<string, () => Array<{ data: unknown }>>();
const state = { held, snapshots, sessionIds, dirs, checkpoints };
const globalState = globalThis as Record<symbol, typeof state | undefined>;
globalState[key] = state;
let owner: AgentSession | undefined;
const watchdog = setTimeout(() => { console.error("footer host timeout", errors); process.exit(1); }, 35_000);
async function until(check: () => boolean, label: string) {
	const deadline = Date.now() + 15_000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), `${label}: ${JSON.stringify([...snapshots].map(([cwd, rows]) => [cwd, rows.slice(-3)]))}; errors=${JSON.stringify(errors)}`);
}
const model = {
	id: "footer-model", name: "Footer Model", api: "footer-fixture-api", provider: "footer-fixture",
	baseUrl: "http://localhost:0", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_000,
};
const fixture = join(agentDir, "footer-fixture.mjs");
writeFileSync(fixture, `
import { AssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
export default function(pi) {
  const state = globalThis[Symbol.for("subagent-test.footer-host")];
  let cwd;
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    state.sessionIds.set(cwd, ctx.sessionManager.getSessionId());
    state.snapshots.set(cwd, []);
    state.checkpoints.set(cwd, () => ctx.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "subagent.footer"));
  });
  pi.events.on("harness:work-status:snapshot", value => { state.snapshots.get(cwd)?.push(value); });
  pi.registerTool({name:"fixture_hold", label:"Fixture Hold", description:"Hold a synthetic request.", parameters:Type.Object({}),
    async execute() { await state.held; return {content:[{type:"text",text:"released"}],details:{}}; }});
  const faux = fauxProvider({api:${JSON.stringify(model.api)},provider:${JSON.stringify(model.provider)},models:[${JSON.stringify(model)}]});
  let count = 0;
  const response = () => {
    const level = state.dirs.indexOf(cwd);
    const message = ++count === 1
      ? fauxAssistantMessage(fauxToolCall(level < 2 ? "subagent" : "fixture_hold", level < 2 ? {task:"Nested footer child",cwd:state.dirs[level+1],deadlineMinutes:0} : {}), {stopReason:"toolUse"})
      : fauxAssistantMessage("idle");
    return message;
  };
  faux.setResponses(Array.from({length:16}, () => response));
  pi.registerProvider({...faux.provider, streamSimple(model, context, options) {
    const output = new AssistantMessageEventStream();
    void (async () => {
      for await (const event of faux.provider.streamSimple(model, context, options)) {
        if (event.type === "done") event.message.usage.cost = {input:0.125,output:0.125,cacheRead:0,cacheWrite:0,total:0.25};
        output.push(event);
      }
      output.end();
    })();
    return output;
  }});
}
`);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [fixture] }));
try {
	const sub = await import("./index.ts");
	const { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const settingsManager = SettingsManager.create(dirs[0], agentDir);
	const bus = createEventBus();
	const loader = new DefaultResourceLoader({ cwd: dirs[0], agentDir, settingsManager, eventBus: bus,
		additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")] });
	await loader.reload();
	owner = (await createAgentSession({ cwd: dirs[0], agentDir, settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.create(dirs[0]), model: model as never, thinkingLevel: "off" })).session;
	await owner.bindExtensions({ onError: (error) => errors.push(error), uiContext: { setStatus: (key: string, text: string | undefined) => status.set(key, text) } as never });
	const ownerId = owner.sessionManager.getSessionId();
	await owner.prompt("Start nested footer work");
	const latest = () => snapshots.get(dirs[0])?.at(-1);
	await until(() => sub.listWorkers().length === 2 && latest()?.active === 1 && latest()?.cost === 0.75, "idle parent plus executing grandchild");
	assert.equal(latest()?.incomplete, false);
	assert.equal(sessionIds.size, 3, "three distinct working directories load session-owned publishers");
	for (const [cwd, read] of checkpoints) {
		const entries = read();
		assert.ok(entries.length < 20, `${cwd}: changed observations append bounded checkpoints, got ${entries.length}`);
		for (let index = 1; index < entries.length; index++) assert.notDeepEqual(entries[index].data, entries[index - 1].data, "synchronous entry observers do not append duplicate checkpoints");
	}
	assert.equal(sub.sharedWorkerState.statusActivity.size, 2);
	assert.equal(sub.sharedWorkerState.statusObservers.size, 3);
	bus.emit("harness:work-status:request", {version:1,publisher:"subagent",sessionId:ownerId});
	assert.equal(latest()?.cost, 0.75, "a request replaces the snapshot without another charge");
	release();
	await until(() => latest()?.active === 0 && latest()?.cost === 1, "both retained workers settle without active work");
	assert.equal(sub.listWorkers().filter((record) => record.state === "running").length, 2, "retained running records are not active");
	for (const read of checkpoints.values()) {
		const entries = read();
		assert.ok(entries.length < 20, "settlement appends bounded changed checkpoints");
		for (let index = 1; index < entries.length; index++) assert.notDeepEqual(entries[index].data, entries[index - 1].data);
	}
	console.log("changed checkpoint counts", JSON.stringify(dirs.map((cwd) => checkpoints.get(cwd)?.().length)));
	assert.equal(latest()?.incomplete, false);
	await owner.reload();
	bus.emit("harness:work-status:request", {version:1,publisher:"subagent",sessionId:ownerId});
	assert.equal(latest()?.cost, 1, "same-session reload restores the cumulative raw total");
	assert.equal(latest()?.incomplete, false);
	assert.equal(sub.sharedWorkerState.statusObservers.size, 1, "reload releases child publishers");
	const checkpointCount = owner.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent.footer").length;
	const firstUser = owner.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(firstUser);
	await owner.navigateTree(firstUser.id, { summarize: false });
	await owner.reload();
	bus.emit("harness:work-status:request", {version:1,publisher:"subagent",sessionId:ownerId});
	assert.equal(latest()?.cost, 1, "off-branch costs remain incurred");
	assert.equal(owner.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "subagent.footer").length, checkpointCount, "unchanged observations append no checkpoints");
	const manager = owner.sessionManager;
	const append = manager.appendCustomEntry.bind(manager);
	for (const partial of [false, true]) {
		let attempts = 0;
		manager.appendCustomEntry = (type, data) => {
			if (type !== "subagent.footer") return append(type, data);
			attempts++;
			if (attempts === 1) {
				if (partial) append(type, data);
				throw new Error("controlled checkpoint append failure");
			}
			return append(type, data);
		};
		bus.emit("harness:work-status:snapshot", {version:1,publisher:"agent",sessionId:ownerId,available:true,active:0,cost:partial ? 3 : 2,incomplete:false});
		assert.equal(attempts, 1);
		bus.emit("harness:work-status:request", {version:1,publisher:"subagent",sessionId:ownerId});
		assert.equal(attempts, 2, "failed appends remain retryable, including native in-memory partial writes");
		bus.emit("harness:work-status:request", {version:1,publisher:"subagent",sessionId:ownerId});
		assert.equal(attempts, 2, "successful retries restore checkpoint deduplication");
	}
	manager.appendCustomEntry = append;
	const before = checkpoints.get(dirs[0])?.().length ?? 0;
	let updateDuringAppend = true;
	const unsubscribe = owner.subscribe((event) => {
		if (event.type !== "entry_appended" || event.entry.type !== "custom" || event.entry.customType !== "subagent.footer" || !updateDuringAppend) return;
		updateDuringAppend = false;
		bus.emit("harness:work-status:snapshot", {version:1,publisher:"agent",sessionId:ownerId,available:true,active:0,cost:4.5,incomplete:false});
	});
	bus.emit("harness:work-status:snapshot", {version:1,publisher:"agent",sessionId:ownerId,available:true,active:0,cost:4,incomplete:false});
	unsubscribe();
	const changed = checkpoints.get(dirs[0])?.() ?? [];
	assert.equal(changed.length - before, 2, "a changed synchronous observation appends once after the current append returns");
	const last = changed.at(-1);
	assert.ok(last);
	assert.equal((last.data as { agent: { cost: number } }).agent.cost, 4.5);
	assert.equal(status.get("subagent"), "subagents 0 · $5.50", "display reflects the latest synchronous observation");
	await owner.extensionRunner?.emit({type:"session_shutdown", reason:"quit"});
	await until(() => sub.sharedWorkerState.statusActivity.size === 0 && sub.sharedWorkerState.statusObservers.size === 0, "shutdown releases cross-instance observations");
	assert.equal(latest()?.available, false);
	const count = snapshots.get(dirs[0])?.length;
	bus.emit("harness:work-status:request", {version:1,publisher:"subagent",sessionId:ownerId});
	assert.equal(snapshots.get(dirs[0])?.length, count, "shutdown removes the request listener");
	assert.deepEqual(errors, []);
	console.log("footer host: PASS");
} finally {
	release();
	owner?.dispose();
	delete globalState[key];
	clearTimeout(watchdog);
	rmSync(root, {recursive:true,force:true});
}
