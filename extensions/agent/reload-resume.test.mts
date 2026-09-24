import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ProjectTrustStore, SessionManager, type AgentSession, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ASSOCIATION_ENTRY, associatedSessions } from "./associations.ts";
import { AgentStore } from "./store.ts";
import type { AgentManager } from "./index.ts";
import type { AgentWorkerSession } from "./worker.ts";

interface Event { type: string; sessionId: string; cwd: string; version: number; [key: string]: unknown }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

async function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-reload-")));
	const agentDir = join(root, "agent"), cwd = join(root, "parent"), child = join(root, "child"), store = join(root, "store");
	for (const dir of [agentDir, cwd, child]) mkdirSync(dir);
	const previous = { agentDir: process.env.PI_AGENT_DIR, store: process.env.PI_AGENT_SESSIONS_DIR };
	process.env.PI_AGENT_DIR = agentDir; process.env.PI_AGENT_SESSIONS_DIR = store;
	const key = `reload${randomUUID()}`;
	const release = deferred();
	const events: Event[] = [], listeners = new Set<() => void>();
	const state = { omit: false, release: release.promise, event: (event: Event) => { events.push(event); for (const listener of listeners) listener(); } };
	const globals = globalThis as unknown as Record<string, unknown>;
	globals[key] = state;
	const provider = join(root, "provider.mjs"), entry = join(root, "agent-entry.mjs");
	writeFileSync(entry, `import agent from ${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))};
		export default pi => { if(globalThis[${JSON.stringify(key)}].omit) throw new Error("controlled agent factory omission"); agent(pi); };`);
	const writeProvider = (version: number) => writeFileSync(provider, `
		import {createAssistantMessageEventStream,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
		import {Type} from "typebox";
		export default pi => {
			const state=globalThis[${JSON.stringify(key)}],version=${version}; let ctx,open=true,calls=0;
			const event=(type,extra={})=>state.event({type,sessionId:ctx.sessionManager.getSessionId(),cwd:ctx.cwd,version,...extra});
			pi.on("session_start",(_event,current)=>{ctx=current;event("start");});
			pi.on("session_shutdown",()=>{open=false;state.event({type:"shutdown",version});});
			pi.registerCommand("replace", {handler:(_args,ctx)=>ctx.newSession()});
			pi.registerTool({name:"hold",label:"Hold",description:"Controlled hold",parameters:Type.Object({}),async execute(_id,_args,signal){
				event("tool"); await new Promise((resolve,reject)=>{const abort=()=>{event("abort");reject(new Error("aborted"));};
					if(signal?.aborted) return abort(); signal?.addEventListener("abort",abort,{once:true});
					state.release.then(()=>{signal?.removeEventListener("abort",abort);resolve();});});
				if(!open) throw new Error("child resource closed");
				pi.appendEntry("fixture.resource",{version}); event("resource");return {content:[{type:"text",text:"TOOL_DONE"}],details:{}};
			}});
			const stream=(model,context)=>{if(!open) throw new Error("provider resource closed");pi.getThinkingLevel();
				event("model",{context:JSON.stringify(context)});const text=JSON.stringify(context.messages);
				const hold=ctx.cwd===${JSON.stringify(child)} && calls++===0 && text.includes("HOLD");
				const m=hold ? fauxAssistantMessage(fauxToolCall("hold",{}),{stopReason:"toolUse"}) : fauxAssistantMessage("DONE-v"+version);
				Object.assign(m,{api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.25,output:0,cacheRead:0,cacheWrite:0,total:.25}}});
				const out=createAssistantMessageEventStream();queueMicrotask(()=>{out.push({type:"start",partial:m});out.push({type:"done",reason:m.stopReason,message:m});out.end(m);});return out;};
			pi.registerProvider({id:"reload-local",name:"Reload",getModels:()=>[{id:"controlled",name:"Controlled",provider:"reload-local",api:"reload-local",baseUrl:"https://invalid.test",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}],auth:{apiKey:{name:"Synthetic",check:async()=>({type:"api_key"}),resolve:async()=>({auth:{}})}},stream,streamSimple:stream});
		}`);
	writeProvider(1);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [provider, entry], cacheWarming: { mode: "off" }, retry: { enabled: false }, autoCompact: false }));
	const statuses: Array<string | undefined> = [], errors: unknown[] = [], notices: string[] = [];
	const bind = async (session: AgentSession) => session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error); }, uiContext: { setStatus: (_key: string, text: string | undefined) => { statuses.push(text); for (const listener of listeners) listener(); }, notify: (text: string) => notices.push(text) } as never });
	const runtimes: AgentSessionRuntime[] = [];
	const create = async (sessionManager = SessionManager.create(cwd, join(root, "native"))) => {
		const runtime = await createAgentSessionRuntime(async (options) => {
			const services = await createAgentSessionServices({ ...options, resourceLoaderOptions: { noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true } });
			assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
			const model = services.modelRuntime.getModel("reload-local", "controlled"); assert.ok(model);
			return { ...await createAgentSessionFromServices({ ...options, services, model, thinkingLevel: "off" }), services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager });
		runtime.setRebindSession(bind); runtimes.push(runtime); await bind(runtime.session); return runtime;
	};
	const runtime = await create();
	const owners = globalThis as unknown as { [key: symbol]: { managers: Map<string, AgentManager> } };
	const owner = () => owners[Symbol.for("pi.extension.agent.owners")].managers.get(store);
	const wait = (predicate: () => boolean) => predicate() ? Promise.resolve() : new Promise<void>((resolve, reject) => {
		const check = () => { if (predicate()) { clearTimeout(timer); listeners.delete(check); resolve(); } };
		const timer = setTimeout(() => { listeners.delete(check); reject(new Error("native fixture timeout")); }, 10_000);
		listeners.add(check);
	});
	const tool = async (name: string, params: Record<string, unknown>, session = runtime.session) => {
		const runner = session.extensionRunner, definition = runner.getToolDefinition(name); assert.ok(definition, name);
		const result = await definition.execute("fixture", params, new AbortController().signal, undefined, runner.createContext());
		return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
	};
	const spawn = async (prompt?: string) => {
		const text = await tool("agent_spawn", { cwd: child, trust: true, ...(prompt ? { prompt } : {}) });
		const id = /agent session ([^ :]+)/u.exec(text)?.[1]; assert.ok(id); return id;
	};
	const inspect = async (id: string) => JSON.parse(await tool("agent_inspect", { sessionId: id })) as { liveOwner: boolean; execution: { current: { id: string } | null }; result?: { text: string } };
	const claims = () => readdirSync(join(store, "native", ".claims"));
	const worker = (id: string): AgentWorkerSession => {
		const worker = (owner() as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(id); assert.ok(worker); return worker;
	};
	const childSession = (id: string) => (worker(id) as unknown as { runtime: AgentSessionRuntime }).runtime.session;
	return { worker, childSession, root, agentDir, cwd, child, store, runtime, create, state, events, errors, notices, statuses, writeProvider, owner, wait, tool, spawn, inspect, claims, release: release.resolve,
		close: async () => {
			release.resolve();
			for (const runtime of runtimes.reverse()) await runtime.dispose();
			// Factory omission removes the native cleanup hook. The fixture owns explicit cleanup.
			await owner()?.unregisterPrimary(runtime.session.sessionId);
			assert.equal(owner(), undefined); assert.equal(claims().length, 0);
			if (previous.agentDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previous.agentDir;
			if (previous.store === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previous.store;
			delete globals[key]; rmSync(root, { recursive: true, force: true });
		},
	};
}

test("native parent reload retains active execution, native queues, claims, costs, and child resources", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVE_PARENT");
		const id = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		const before = await f.inspect(id), owner = f.owner(), claims = f.claims();
		assert.ok(before.execution.current); assert.match(f.statuses.at(-1) ?? "", /agents 1/u);
		const parent = f.runtime.session.sessionManager;
		assert.deepEqual([...associatedSessions(parent.getEntries(), parent.getSessionId(), f.store)], [id]);
		assert.equal(JSON.stringify(parent.buildSessionContext().messages).includes(ASSOCIATION_ENTRY), false);
		await f.tool("agent_steer", { sessionId: id, message: "QUEUE_SURVIVES" });
		f.writeProvider(2);
		await f.runtime.session.reload();
		assert.equal(f.owner(), owner); assert.deepEqual(f.claims(), claims);
		assert.deepEqual((await f.inspect(id)).execution.current, before.execution.current);
		assert.equal(f.events.filter((event) => event.type === "abort").length, 0);
		f.release(); await f.wait(() => /agents 0/u.test(f.statuses.at(-1) ?? ""));
		const result = (await f.inspect(id)).result; assert.ok(result);
		assert.equal(JSON.parse(result.text).status, "completed");
		assert.ok(f.events.some((event) => event.type === "resource" && event.sessionId === id && event.version === 1));
		assert.ok(f.events.some((event) => event.type === "model" && event.sessionId === id && String(event.context).includes("QUEUE_SURVIVES")));
		await f.tool("agent_send", { sessionId: id, message: "EXPLICIT_CONTINUE" });
		await f.wait(() => f.events.some((event) => event.type === "model" && event.sessionId === id && String(event.context).includes("EXPLICIT_CONTINUE")));
		assert.equal(f.events.filter((event) => event.type === "model" && event.sessionId === id).every((event) => event.version === 1), true);
		const fresh = await f.spawn("NEW_CHILD"); await f.wait(() => f.events.some((event) => event.type === "model" && event.sessionId === fresh));
		assert.ok(f.events.some((event) => event.type === "model" && event.sessionId === fresh && event.version === 2));
		await f.runtime.session.prompt("NEW_PARENT");
		assert.ok(f.events.some((event) => event.type === "model" && event.cwd === f.cwd && event.version === 2));
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

for (const followup of ["retry", "quit"] as const) test(`rejected native reload preserves the child before ${followup}`, { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const id = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		const before = await f.inspect(id), owner = f.owner(), claims = f.claims();
		const failure = t.mock.method(f.runtime.services.resourceLoader, "reload", async () => { throw new Error("controlled resource reload rejection"); });
		await assert.rejects(f.runtime.session.reload(), /controlled resource reload rejection/u);
		assert.equal(f.owner(), owner); assert.deepEqual(f.claims(), claims);
		assert.equal(f.events.filter((event) => event.type === "abort").length, 0);
		failure.mock.restore();
		if (followup === "retry") {
			await f.runtime.session.reload();
			assert.deepEqual((await f.inspect(id)).execution.current, before.execution.current);
			f.release(); await f.wait(() => /agents 0/u.test(f.statuses.at(-1) ?? ""));
		} else {
			await f.runtime.dispose(); assert.equal(f.owner(), undefined); assert.equal(f.claims().length, 0);
			assert.equal(f.events.filter((event) => event.type === "abort").length, 1);
		}
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

for (const followup of ["reload", "quit"] as const) test(`factory omission removes control and cleanup hooks before ${followup}`, { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const id = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		const owner = f.owner(), claims = f.claims();
		f.state.omit = true; await f.runtime.session.reload();
		assert.equal(f.runtime.session.extensionRunner.getToolDefinition("agent_status"), undefined);
		assert.match(JSON.stringify(f.runtime.services.resourceLoader.getExtensions().errors), /controlled agent factory omission/u);
		assert.equal(f.owner(), owner); assert.deepEqual(f.claims(), claims);
		assert.equal(f.events.filter((event) => event.type === "abort").length, 0);
		if (followup === "reload") {
			f.state.omit = false; await f.runtime.session.reload();
			assert.equal((await f.inspect(id)).liveOwner, true);
			f.release(); await f.wait(() => /agents 0/u.test(f.statuses.at(-1) ?? ""));
		} else {
			await f.runtime.dispose();
			assert.equal(f.owner(), owner, "Pi has no retained-extension finalizer after factory omission");
			assert.deepEqual(f.claims(), claims, "quit cannot dispatch an omitted extension's cleanup hook");
			assert.equal(f.events.filter((event) => event.type === "abort").length, 0);
			f.release(); await f.wait(() => f.events.some((event) => event.type === "resource"));
		}
	} finally { await f.close(); }
});

test("exact saved parent reopens its children idle without replay or unrelated ownership", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVE_PARENT");
		const id = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		f.release(); await f.wait(() => /agents 0/u.test(f.statuses.at(-1) ?? ""));
		const parentId = f.runtime.session.sessionId, file = f.runtime.session.sessionFile; assert.ok(file); assert.ok(existsSync(file));
		const before = await f.inspect(id), calls = f.events.filter((event) => event.type === "model").length;
		await f.runtime.dispose(); assert.equal(f.owner(), undefined);
		const resumed = await f.create(SessionManager.open(file));
		assert.equal(resumed.session.sessionId, parentId);
		const after = JSON.parse(await f.tool("agent_inspect", { sessionId: id }, resumed.session));
		assert.equal(after.liveOwner, true); assert.equal(after.execution.current, null); assert.deepEqual(after.result, before.result);
		assert.equal(f.events.filter((event) => event.type === "model").length, calls);
		assert.equal(f.events.filter((event) => event.type === "tool").length, 1);
		await f.tool("agent_send", { sessionId: id, message: "EXPLICIT_CONTINUE" }, resumed.session);
		await f.wait(() => f.events.some((event) => event.type === "model" && event.sessionId === id && String(event.context).includes("EXPLICIT_CONTINUE")));
		assert.ok(f.events.some((event) => event.type === "model" && event.sessionId === id && String(event.context).includes("TOOL_DONE")));
		assert.equal(f.events.filter((event) => event.type === "tool").length, 1);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("a result in the reload gap reaches the fresh parent exactly once in this process", { timeout: 30_000 }, async (t) => {
	const f = await fixture(), entered = deferred(), finishReload = deferred();
	try {
		const id = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		const operation = (await f.inspect(id)).execution.current; assert.ok(operation);
		const operationId = operation.id;
		const loader = f.runtime.services.resourceLoader, reload = loader.reload.bind(loader);
		t.mock.method(loader, "reload", async (...args: Parameters<typeof reload>) => { entered.resolve(); await finishReload.promise; return reload(...args); });
		const pending = f.runtime.session.reload(); await entered.promise;
		f.release(); await f.worker(id).waitForIdle();
		const messages = () => f.runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "agent.peer" && (entry.details as { operationId?: string })?.operationId === operationId);
		assert.equal(messages().length, 0);
		finishReload.resolve(); await pending; await f.runtime.session.waitForIdle();
		assert.equal(messages().length, 1);
		assert.equal(f.statuses.at(-1), "agents 0 · $0.50");
		await f.runtime.session.reload(); assert.equal(messages().length, 1);
		assert.equal(f.statuses.at(-1), "agents 0 · $0.50");
		assert.deepEqual(f.errors, []);
	} finally { finishReload.resolve(); await f.close(); }
});

test("true quit cleans retained owners when the fresh runner fails before startup", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		await assert.rejects(f.runtime.session.reload({ beforeSessionStart: async () => { throw new Error("before startup failure"); } }), /before startup failure/u);
		assert.ok(f.owner()); assert.equal(f.claims().length, 1);
		await f.runtime.dispose(); assert.equal(f.owner(), undefined); assert.equal(f.claims().length, 0);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("nested and shared associations restore once, refuse cycles, and exclude unrelated sessions", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVE_PARENT");
		const first = await f.spawn();
		const text = await f.tool("agent_spawn", { cwd: f.child, trust: true }, f.childSession(first));
		const shared = /agent session ([^ :]+)/u.exec(text)?.[1]; assert.ok(shared);
		await f.tool("agent_attach", { sessionId: shared, trust: true });
		await assert.rejects(f.tool("agent_attach", { sessionId: first, trust: true }, f.childSession(shared)), /cycle/u);
		const owner = f.owner(); assert.ok(owner);
		const unrelated = await owner.spawn({ cwd: f.child, trust: true }, { cwd: f.cwd, model: { provider: "reload-local", id: "controlled" } });
		const file = f.runtime.session.sessionFile; assert.ok(file);
		await f.runtime.dispose();
		const count = f.events.length, resumed = await f.create(SessionManager.open(file));
		const starts = f.events.slice(count).filter((event) => event.type === "start" && event.cwd === f.child);
		assert.deepEqual(starts.map((event) => event.sessionId).sort(), [first, shared].sort());
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: unrelated.sessionId }, resumed.session)).liveOwner, false);
		assert.equal(f.claims().length, 2);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("read-only tools and the dashboard sources do not establish saved ownership", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const owner = f.owner(); assert.ok(owner);
		const id = (await owner.spawn({ cwd: f.child }, { cwd: f.cwd, model: { provider: "reload-local", id: "controlled" } })).sessionId;
		await f.tool("agent_list", {}); await f.tool("agent_status", { sessionId: id }); await f.tool("agent_inspect", { sessionId: id });
		await owner.sessionSummaries();
		const native = f.runtime.session.sessionManager;
		assert.equal(associatedSessions(native.getEntries(), native.getSessionId(), f.store).size, 0);
		await f.runtime.session.sendUserMessage(`/agent attach ${id}`, { expandPromptTemplates: true });
		assert.deepEqual([...associatedSessions(native.getEntries(), native.getSessionId(), f.store)], [id]);
		assert.equal(f.events.filter((event) => event.type === "model").length, 0);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("native child replacement updates the parent association before later restoration", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVE_PARENT");
		const old = await f.spawn();
		const result = JSON.parse(await f.tool("agent_command", { sessionId: old, name: "replace" }));
		assert.ok(result.sessionId); assert.notEqual(result.sessionId, old);
		const native = f.runtime.session.sessionManager;
		assert.deepEqual([...associatedSessions(native.getEntries(), native.getSessionId(), f.store)], [result.sessionId]);
		const file = f.runtime.session.sessionFile; assert.ok(file); await f.runtime.dispose();
		const resumed = await f.create(SessionManager.open(file));
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: result.sessionId }, resumed.session)).liveOwner, true);
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: old }, resumed.session)).liveOwner, false);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("unflushed and in-memory parents retain same-process hosts without a saved-parent promise", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const id = await f.spawn();
		const file = f.runtime.session.sessionFile; assert.ok(file); assert.equal(existsSync(file), false);
		await f.runtime.session.reload(); assert.equal((await f.inspect(id)).liveOwner, true); assert.equal(existsSync(file), false);
		await f.runtime.dispose();
		const memory = await f.create(SessionManager.inMemory(f.cwd));
		const text = await f.tool("agent_spawn", { cwd: f.child, trust: true }, memory.session);
		const child = /agent session ([^ :]+)/u.exec(text)?.[1]; assert.ok(child);
		assert.equal(memory.session.sessionFile, undefined);
		await memory.session.reload();
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: child }, memory.session)).liveOwner, true);
		assert.equal(memory.session.sessionFile, undefined);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("replacement and detach during the reload gap update saved ownership without new admission", { timeout: 30_000 }, async (t) => {
	const f = await fixture(), entered = deferred(), finishReload = deferred();
	try {
		await f.runtime.session.prompt("SAVE_PARENT");
		const replaced = await f.spawn(), detached = await f.spawn(), owner = f.owner(); assert.ok(owner);
		const parent = f.runtime.session.sessionManager, parentId = parent.getSessionId();
		const loader = f.runtime.services.resourceLoader, reload = loader.reload.bind(loader);
		t.mock.method(loader, "reload", async (...args: Parameters<typeof reload>) => { entered.resolve(); await finishReload.promise; return reload(...args); });
		const pending = f.runtime.session.reload(); await entered.promise;
		await assert.rejects(owner.withAssociationParent(parentId, () => owner.spawn({ cwd: f.child, trust: true, prompt: "HOLD" }, { cwd: f.cwd, model: { provider: "reload-local", id: "controlled" } })), /no active association writer/u);
		const result = await owner.runCommand(replaced, "replace", ""); assert.notEqual(result.sessionId, replaced);
		await (owner as unknown as { release(id: string): Promise<void> }).release(detached);
		assert.equal(f.claims().length, 1);
		finishReload.resolve(); await pending;
		assert.deepEqual([...associatedSessions(parent.getEntries(), parentId, f.store)], [result.sessionId]);
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: detached })).liveOwner, false);
		assert.equal(f.events.filter((event) => event.type === "tool").length, 0);
		assert.deepEqual(f.errors, []);
	} finally { finishReload.resolve(); await f.close(); }
});

test("multiple primaries retain one child and separate price baselines across reload", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const id = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		const second = await f.create();
		await f.tool("agent_attach", { sessionId: id, trust: true }, second.session);
		const owner = f.owner(), operation = (await f.inspect(id)).execution.current;
		await f.runtime.session.reload(); await second.session.reload();
		assert.equal(f.owner(), owner); assert.equal(f.claims().length, 1);
		assert.deepEqual((await f.inspect(id)).execution.current, operation);
		assert.equal(f.events.filter((event) => event.type === "start" && event.sessionId === id).length, 1);
		f.release(); await f.worker(id).waitForIdle();
		const primaries = (owner as unknown as { primary: Map<string, { footer: { saved: { spend: { cost: number } } } }> }).primary;
		assert.equal(primaries.get(f.runtime.session.sessionId)?.footer.saved.spend.cost, .5);
		assert.equal(primaries.get(second.session.sessionId)?.footer.saved.spend.cost, .25);
		await f.runtime.dispose(); assert.equal(f.owner(), owner); assert.equal(f.claims().length, 1);
		await second.dispose(); assert.equal(f.owner(), undefined); assert.equal(f.claims().length, 0);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("a failed association append refuses the task and releases its native claim", { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const native = f.runtime.session.sessionManager, append = native.appendCustomEntry.bind(native);
		t.mock.method(native, "appendCustomEntry", (name: string, data: unknown) => {
			if (name === ASSOCIATION_ENTRY) throw new Error("association write refused");
			return append(name, data);
		});
		await assert.rejects(f.spawn("HOLD"), /association write refused/u);
		assert.equal(f.events.filter((event) => event.type === "model" || event.type === "tool").length, 0);
		assert.equal(f.claims().length, 0);
		assert.equal(associatedSessions(native.getEntries(), native.getSessionId(), f.store).size, 0);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("native parent forks and new sessions do not inherit copied ownership entries", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVE_PARENT");
		const id = await f.spawn(), parentId = f.runtime.session.sessionId, file = f.runtime.session.sessionFile; assert.ok(file);
		await f.runtime.dispose();
		const fork = await f.create(SessionManager.forkFrom(file, f.cwd, join(f.root, "native")));
		assert.notEqual(fork.session.sessionId, parentId);
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: id }, fork.session)).liveOwner, false);
		assert.equal(f.claims().length, 0); await fork.dispose();
		const fresh = await f.create(); assert.notEqual(fresh.session.sessionId, parentId);
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: id }, fresh.session)).liveOwner, false);
		assert.equal(f.claims().length, 0); assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("restoration applies the current project trust decision without replay", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const extensions = join(f.child, ".pi", "extensions"); mkdirSync(extensions, { recursive: true });
		writeFileSync(join(extensions, "probe.ts"), `import {Type} from "typebox"; export default pi => pi.registerTool({name:"trusted_probe",label:"Probe",description:"Trust probe",parameters:Type.Object({}),async execute(){return {content:[],details:{}};}});`);
		await f.runtime.session.prompt("SAVE_PARENT");
		const id = await f.spawn(); assert.ok(f.childSession(id).extensionRunner.getToolDefinition("trusted_probe"));
		const file = f.runtime.session.sessionFile; assert.ok(file); await f.runtime.dispose();
		new ProjectTrustStore(f.agentDir).set(f.child, false);
		const calls = f.events.filter((event) => event.type === "model").length;
		const resumed = await f.create(SessionManager.open(file));
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: id }, resumed.session)).liveOwner, true);
		assert.equal(f.childSession(id).extensionRunner.getToolDefinition("trusted_probe"), undefined);
		assert.equal(f.events.filter((event) => event.type === "model").length, calls);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("restoration contains missing models, missing sessions, foreign claims, and corrupt cycles", { timeout: 30_000 }, async () => {
	const f = await fixture();
	const foreign = new AgentStore({ sessionsRoot: f.store });
	try {
		await f.runtime.session.prompt("SAVE_PARENT");
		const healthy = await f.spawn(), unavailable = await f.spawn(), claimed = await f.spawn();
		f.worker(unavailable).sessionManager().appendModelChange("missing-provider", "missing-model");
		const parent = f.runtime.session.sessionManager, parentSessionId = parent.getSessionId();
		parent.appendCustomEntry(ASSOCIATION_ENTRY, { version: 1, parentSessionId, storeRoot: f.store, childSessionId: "missing-session", attached: true });
		f.worker(healthy).sessionManager().appendCustomEntry(ASSOCIATION_ENTRY, { version: 1, parentSessionId: healthy, storeRoot: f.store, childSessionId: parentSessionId, attached: true });
		const file = f.runtime.session.sessionFile; assert.ok(file); await f.runtime.dispose();
		const metadata = foreign.locate(claimed); assert.ok(metadata); await foreign.open(metadata);
		const calls = f.events.filter((event) => event.type === "model").length;
		const resumed = await f.create(SessionManager.open(file));
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: healthy }, resumed.session)).liveOwner, true);
		for (const id of [unavailable, claimed]) assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: id }, resumed.session)).liveOwner, false);
		for (const expected of ["association cycle refused", unavailable, "missing-session", claimed, "exclusive writer claim"]) assert.ok(f.notices.some((notice) => notice.includes(expected)), expected);
		assert.equal(f.events.filter((event) => event.type === "model").length, calls);
		assert.equal(f.claims().length, 2, "only the restored child and foreign owner hold claims");
		assert.deepEqual(f.errors, []);
	} finally { await foreign.close(); await f.close(); }
});
