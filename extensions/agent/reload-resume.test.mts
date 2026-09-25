import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, ProjectTrustStore, SessionManager, type AgentSession, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
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
	const state = { omit: false, stopOnStart: false, response: undefined as string | undefined, request: undefined as { sessionId: string; name: string; args: Record<string, unknown> } | undefined, release: release.promise, event: (event: Event) => { events.push(event); for (const listener of listeners) listener(); } };
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
			pi.on("session_start",(_event,current)=>{ctx=current;event("start");if(state.stopOnStart && ctx.cwd===${JSON.stringify(child)}) ctx.shutdown();});
			pi.on("session_shutdown",()=>{open=false;state.event({type:"shutdown",version});});
			pi.registerCommand("replace", {handler:(_args,ctx)=>ctx.newSession()});
			pi.registerCommand("replace-fail", {handler:(_args,ctx)=>ctx.newSession({setup:()=>{throw new Error("replacement setup failed");}})});
			pi.registerCommand("stop-host", {handler:(_args,ctx)=>ctx.shutdown()});
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
				const request=state.request?.sessionId===ctx.sessionManager.getSessionId() ? state.request : undefined;
				if(request) state.request=undefined;
				const m=request ? fauxAssistantMessage(fauxToolCall(request.name,request.args),{stopReason:"toolUse"}) : hold ? fauxAssistantMessage(fauxToolCall("hold",{}),{stopReason:"toolUse"}) : fauxAssistantMessage(state.response ?? "DONE-v"+version);
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
	const refreshes = new Set<ReturnType<ModelRuntime["refresh"]>>(), refreshFailures: unknown[] = [];
	const refresh = ModelRuntime.prototype.refresh;
	const refreshMock = mock.method(ModelRuntime.prototype, "refresh", function (this: ModelRuntime, ...args: Parameters<ModelRuntime["refresh"]>) {
		const pending = refresh.apply(this, args); refreshes.add(pending);
		void pending.then(() => { refreshes.delete(pending); }, (error) => { refreshes.delete(pending); refreshFailures.push(error); });
		return pending;
	});
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
			try {
				release.resolve();
				for (const runtime of runtimes.reverse()) await runtime.dispose();
				// Factory omission removes the native cleanup hook. The fixture owns explicit cleanup.
				await owner()?.unregisterPrimary(runtime.session.sessionId);
				assert.equal(owner(), undefined); assert.equal(claims().length, 0);
				// Provider registration starts refreshes that outlive native session disposal.
				while (refreshes.size > 0) await Promise.allSettled([...refreshes]);
			} finally { refreshMock.mock.restore(); }
			if (previous.agentDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previous.agentDir;
			if (previous.store === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previous.store;
			delete globals[key]; rmSync(root, { recursive: true, force: true });
			assert.deepEqual(refreshFailures, []);
		},
	};
}

for (const failure of ["teardown", "setup"] as const) test(`failed replacement ${failure} retires the host before stored observation and fresh control`, { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const originalId = await f.spawn(), worker = f.worker(originalId), outgoing = f.childSession(originalId);
		await outgoing.prompt("SAVED_WORK"); await worker.waitForIdle();
		const modelCalls = () => f.events.filter((event) => event.type === "model" && event.cwd === f.child).length;
		const calls = modelCalls();
		if (failure === "teardown") {
			const dispose = outgoing.dispose.bind(outgoing); let attempts = 0;
			t.mock.method(outgoing, "dispose", () => { if (++attempts === 1) throw new Error("replacement teardown failed"); dispose(); });
		}
		await assert.rejects(f.tool("agent_command", { sessionId: originalId, name: failure === "teardown" ? "replace" : "replace-fail" }), new RegExp(`replacement ${failure} failed`, "u"));
		const id = worker.sessionId();
		assert.equal(id === originalId, failure === "teardown");
		assert.equal(f.claims().length, 0);
		assert.match(await f.tool("agent_status", { sessionId: id }), /read-only capture/u);
		const inspection = JSON.parse(await f.tool("agent_inspect", { sessionId: id }));
		assert.equal(inspection.liveOwner, false); assert.equal(inspection.capture.available, true);
		assert.equal(inspection.execution.current, null);
		const manager = f.owner() as unknown as { sessions: Map<string, AgentWorkerSession>; associationParents: Map<string, unknown>; retiredFooterStates: unknown[] };
		const owners = (globalThis as unknown as { [key: symbol]: { workers: Set<string> } })[Symbol.for("pi.extension.agent.owners")];
		for (const retiredId of [originalId, id]) {
			assert.equal(manager.sessions.has(retiredId), false);
			assert.equal(manager.associationParents.has(retiredId), false);
			assert.equal(owners.workers.has(retiredId), false);
		}
		assert.equal(manager.retiredFooterStates.length, 1);
		assert.equal(f.statuses.at(-1), "agents 0 · $0.25");
		const foreign = new AgentStore({ sessionsRoot: f.store });
		try {
			const metadata = foreign.locate(id); assert.ok(metadata); await foreign.open(metadata);
			await assert.rejects(f.tool("agent_attach", { sessionId: id }), /exclusive writer claim/u);
			assert.equal((await f.inspect(id)).liveOwner, false); assert.equal(f.claims().length, 1);
		} finally { await foreign.close(); }
		assert.match(await f.tool("agent_attach", { sessionId: id }), /attached/u);
		const reopened = f.worker(id); assert.notEqual(reopened, worker);
		assert.equal(modelCalls(), calls, "attach never replays work");
		assert.equal(f.claims().length, 1); assert.equal(owners.workers.has(id), true);
		assert.equal(f.statuses.at(-1), "agents 0 · $0.25");
		await f.tool("agent_send", { sessionId: id, message: "EXPLICIT_CONTINUE" }); await reopened.waitForIdle();
		assert.equal(modelCalls(), calls + 1);
		await reopened.close(); await reopened.close();
		assert.equal(manager.retiredFooterStates.length, 2);
		assert.equal(f.statuses.at(-1), "agents 0 · $0.50");
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

for (const failure of ["stopping", "dispose", "claim-release", "replacement-claim-release"] as const) test(`${failure} refuses observations and controls without work or claim removal`, { timeout: 30_000 }, async (t) => {
	const f = await fixture(), release = deferred(), entered = deferred();
	let pending: Promise<void> | undefined;
	let restore: (() => void) | undefined;
	try {
		const id = await f.spawn(), worker = f.worker(id), outgoing = f.childSession(id);
		const manager = f.owner() as unknown as { sessions: Map<string, AgentWorkerSession>; associationParents: Map<string, unknown>; retiredFooterStates: unknown[]; detachedRuns: { start(): Promise<never> } };
		const launch = t.mock.method(manager.detachedRuns, "start", async () => { throw new Error("unexpected detached launch"); });
		if (failure === "stopping") {
			const abort = outgoing.abort.bind(outgoing);
			const mocked = t.mock.method(outgoing, "abort", async () => { entered.resolve(); await release.promise; await abort(); });
			restore = () => mocked.mock.restore(); pending = worker.close(); await entered.promise;
		} else {
			const held = (worker as unknown as { held: { close(): Promise<void> } }).held;
			const mocked = failure === "dispose"
				? t.mock.method(outgoing, "dispose", () => { throw new Error("native disposal failed"); })
				: t.mock.method(held, "close", async () => { throw new Error("claim release failed"); });
			restore = () => mocked.mock.restore();
			await assert.rejects(failure === "replacement-claim-release" ? f.tool("agent_command", { sessionId: id, name: "replace" }) : worker.close(), /cleanup/u);
		}
		const state = failure === "stopping" ? "stopping" : "cleanup-incomplete";
		const claims = f.claims(), entries = outgoing.sessionManager.getEntries(), starts = f.events.filter((event) => event.type === "start").length;
		assert.equal(claims.length, 1);
		const refused = (error: unknown) => {
			assert.ok(error instanceof Error); assert.ok(error.message.includes(id));
			assert.ok(error.message.includes(`state: ${state}`)); assert.match(error.message, /requested operation did not run/u);
			if (state === "cleanup-incomplete") { assert.match(error.message, /Writer claims remain retained/u); assert.doesNotMatch(error.message, /Use agent_attach|manual removal/u); }
			return true;
		};
		const calls: Array<[string, Record<string, unknown>]> = [
			["agent_status", {}], ["agent_inspect", {}], ["agent_send", { message: "REFUSED" }], ["agent_steer", { message: "REFUSED" }],
			["agent_attach", {}], ["agent_attach", { model: "reload-local/controlled" }], ["agent_detach", { prompt: "REFUSED" }],
			["agent_command", { name: "replace" }], ["agent_abort", {}], ["agent_compact", {}], ["agent_fork", {}],
			["agent_rewind", { entryId: "unused", correction: "REFUSED" }],
		];
		for (const [name, params] of calls) await assert.rejects(f.tool(name, { sessionId: id, ...params }), refused, name);
		await assert.rejects(worker.start("REFUSED"), refused);
		assert.equal(launch.mock.callCount(), 0); assert.deepEqual(outgoing.sessionManager.getEntries(), entries);
		assert.equal(f.events.filter((event) => event.type === "model").length, 0);
		assert.equal(f.events.filter((event) => event.type === "start").length, starts);
		assert.deepEqual(f.claims(), claims); assert.equal(manager.sessions.get(id), worker);
		assert.equal(manager.associationParents.has(id), true); assert.equal(manager.retiredFooterStates.length, 0);
		const owners = (globalThis as unknown as { [key: symbol]: { workers: Set<string> } })[Symbol.for("pi.extension.agent.owners")];
		assert.equal(owners.workers.has(id), true);
		restore(); release.resolve(); await pending; await worker.close();
		assert.equal(f.claims().length, 0); assert.equal(manager.sessions.has(id), false);
		assert.equal(manager.associationParents.has(id), false); assert.equal(owners.workers.has(id), false);
		assert.equal(manager.retiredFooterStates.length, 1);
		assert.match(await f.tool("agent_status", { sessionId: id }), /read-only capture/u);
		assert.deepEqual(f.errors, []);
	} finally { restore?.(); release.resolve(); await pending; await f.close(); }
});

test("self shutdown retires a held host and startup shutdown never admits it", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const id = await f.spawn(), worker = f.worker(id);
		await f.tool("agent_command", { sessionId: id, name: "stop-host" }); await worker.close();
		assert.equal((await f.inspect(id)).liveOwner, false); assert.equal(f.claims().length, 0);
		f.state.stopOnStart = true;
		await assert.rejects(f.spawn(), /closed during startup/u);
		const manager = f.owner() as unknown as { sessions: Map<string, AgentWorkerSession>; associationParents: Map<string, unknown>; retiredFooterStates: unknown[] };
		const owners = (globalThis as unknown as { [key: symbol]: { workers: Set<string> } })[Symbol.for("pi.extension.agent.owners")];
		for (const event of f.events.filter((event) => event.type === "start" && event.cwd === f.child)) {
			assert.equal(manager.sessions.has(event.sessionId), false);
			assert.equal(manager.associationParents.has(event.sessionId), false); assert.equal(owners.workers.has(event.sessionId), false);
		}
		assert.equal(manager.retiredFooterStates.length, 1); assert.equal(f.claims().length, 0);
		assert.equal(f.events.filter((event) => event.type === "model").length, 0);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("a close error retires the host when native cleanup and claim release still succeed", { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const id = await f.spawn(), worker = f.worker(id);
		const runtime = (worker as unknown as { runtime: AgentSessionRuntime }).runtime;
		t.mock.method(runtime, "dispose", async () => { throw new Error("shutdown failed"); });
		await assert.rejects(worker.close(), /cleanup failed/u);
		assert.equal(f.claims().length, 0); assert.equal((await f.inspect(id)).liveOwner, false);
		assert.match(await f.tool("agent_status", { sessionId: id }), /read-only capture/u);
		await f.tool("agent_attach", { sessionId: id }); assert.notEqual(f.worker(id), worker);
		await worker.close(); assert.equal(f.claims().length, 1, "repeat close never retires the fresh host");
		assert.equal((await f.inspect(id)).liveOwner, true); assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

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

test("native self and ancestor messages preserve queues without ownership backedges", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const parent = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		const childText = await f.tool("agent_spawn", { cwd: f.child, trust: true }, f.childSession(parent));
		const child = /agent session ([^ :]+)/u.exec(childText)?.[1]; assert.ok(child);
		const grandchildText = await f.tool("agent_spawn", { cwd: f.child, trust: true }, f.childSession(child));
		const grandchild = /agent session ([^ :]+)/u.exec(grandchildText)?.[1]; assert.ok(grandchild);
		await f.tool("agent_steer", { sessionId: parent, message: "SELF_STEER" }, f.childSession(parent));
		await f.tool("agent_send", { sessionId: parent, message: "SELF_SEND" }, f.childSession(parent));
		await f.tool("agent_send", { sessionId: parent, message: "ANCESTOR_SEND" }, f.childSession(grandchild));
		await f.tool("agent_steer", { sessionId: parent, message: "ANCESTOR_STEER" }, f.childSession(child));
		assert.deepEqual([...associatedSessions(f.worker(parent).sessionManager().getEntries(), parent, f.store)], [child]);
		assert.equal(associatedSessions(f.worker(grandchild).sessionManager().getEntries(), grandchild, f.store).size, 0);
		await assert.rejects(f.tool("agent_attach", { sessionId: parent }, f.childSession(grandchild)), /cycle/u);
		await assert.rejects(f.tool("agent_abort", { sessionId: parent }, f.childSession(parent)), /Owner-wait/u);
		await assert.rejects(f.tool("agent_command", { sessionId: parent, name: "replace" }, f.childSession(parent)), /Owner-wait/u);
		const owner = f.owner(); assert.ok(owner);
		await assert.rejects(owner.compact(parent, undefined, undefined, parent), /Owner-wait/u);
		f.release(); await f.worker(parent).waitForIdle();
		const context = f.events.filter((event) => event.type === "model" && event.sessionId === parent).map((event) => String(event.context)).join("\n");
		for (const message of ["SELF_STEER", "SELF_SEND", "ANCESTOR_SEND", "ANCESTOR_STEER"]) assert.ok(context.includes(message), message);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("post-mutation association failure blocks retries and reload without further native writes", { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVED_PARENT_CONTEXT");
		const owner = f.owner(), native = f.runtime.session.sessionManager, file = f.runtime.session.sessionFile; assert.ok(owner); assert.ok(file);
		const candidate = (await owner.spawn({ cwd: f.child }, { cwd: f.cwd, model: { provider: "reload-local", id: "controlled" } })).sessionId;
		const saved = SessionManager.open(file).getEntries(), context = SessionManager.open(file).buildSessionContext().messages;
		const persist = native._persist.bind(native); let attempts = 0;
		t.mock.method(native, "_persist", (entry: Parameters<typeof persist>[0]) => {
			if (entry.type === "custom" && entry.customType === ASSOCIATION_ENTRY) { attempts++; throw new Error("post-mutation persistence failure"); }
			persist(entry);
		});
		await assert.rejects(f.tool("agent_attach", { sessionId: candidate }), /post-mutation persistence failure/u);
		assert.ok(associatedSessions(native.getEntries(), native.getSessionId(), f.store).has(candidate), "native memory advanced before persistence failed");
		for (const name of ["agent_attach", "agent_send"]) await assert.rejects(f.tool(name, { sessionId: candidate, message: "REFUSED" }), /association write failed/u);
		await assert.rejects(f.spawn("REFUSED"), /association write failed/u);
		const remote = t.mock.method(owner as unknown as { detachedOwner(id: string): never }, "detachedOwner", () => { throw new Error("detached route selected"); });
		for (const name of ["agent_steer", "agent_compact", "agent_command"]) {
			await assert.rejects(f.tool(name, { sessionId: "remote-session", message: "REFUSED", name: "replace" }), /association write failed/u);
		}
		assert.equal(remote.mock.callCount(), 0, "caller refusal precedes local/detached route selection"); remote.mock.restore();
		await f.runtime.session.reload();
		await assert.rejects(f.tool("agent_send", { sessionId: candidate, message: "REFUSED_AFTER_RELOAD" }), /association write failed/u);
		assert.equal(attempts, 1);
		assert.deepEqual(SessionManager.open(file).getEntries(), saved);
		assert.deepEqual(SessionManager.open(file).buildSessionContext().messages, context);
		assert.equal((await f.inspect(candidate)).execution.current, null);
		await f.runtime.dispose();
		const reopened = await f.create(SessionManager.open(file));
		assert.deepEqual(reopened.session.sessionManager.buildSessionContext().messages, context);
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: candidate }, reopened.session)).liveOwner, false);
		await f.tool("agent_attach", { sessionId: candidate }, reopened.session);
		assert.deepEqual(SessionManager.open(file).buildSessionContext().messages, context);
		assert.ok(associatedSessions(SessionManager.open(file).getEntries(), native.getSessionId(), f.store).has(candidate));
		assert.equal(JSON.parse(await f.tool("agent_inspect", { sessionId: candidate }, reopened.session)).execution.current, null);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

for (const settlement of ["complete", "abort"] as const) test(`association refusal preserves ${settlement}, live totals, and pending results without primary writes`, { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVED_PARENT_CONTEXT");
		const active = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool"));
		const owner = f.owner(), native = f.runtime.session.sessionManager, file = f.runtime.session.sessionFile; assert.ok(owner); assert.ok(file);
		const candidate = (await owner.spawn({ cwd: f.child }, { cwd: f.cwd, model: { provider: "reload-local", id: "controlled" } })).sessionId;
		const saved = SessionManager.open(file).getEntries(), persist = native._persist.bind(native);
		t.mock.method(native, "_persist", (entry: Parameters<typeof persist>[0]) => {
			if (entry.type === "custom" && entry.customType === ASSOCIATION_ENTRY) throw new Error("post-mutation persistence failure");
			persist(entry);
		});
		await assert.rejects(f.tool("agent_attach", { sessionId: candidate }), /association write failed/u);
		await assert.rejects(owner.send(native.getSessionId(), "REFUSED_PEER", active), /association write failed/u);
		await assert.rejects(owner.runCommand(active, "replace", ""), /association write failed/u);
		await assert.rejects((owner as unknown as { release(id: string): Promise<void> }).release(active), /association write failed/u);
		assert.equal(f.worker(active).sessionId(), active); assert.equal(f.claims().length, 2);
		if (settlement === "abort") {
			await f.runtime.session.reload();
			await f.tool("agent_abort", { sessionId: active });
			const result = (await f.inspect(active)).result; assert.ok(result);
			assert.equal(JSON.parse(result.text).status, "aborted");
		} else f.release();
		await f.worker(active).waitForIdle();
		assert.equal(f.statuses.at(-1), settlement === "abort" ? "agents 0 · $0.25" : "agents 0 · $0.50");
		const primaries = (owner as unknown as { primary: Map<string, { pending: Map<string, unknown> }> }).primary;
		assert.equal(primaries.get(native.getSessionId())?.pending.size, 1);
		await f.runtime.session.reload();
		assert.equal(primaries.get(native.getSessionId())?.pending.size, 1);
		assert.deepEqual(SessionManager.open(file).getEntries(), saved, "agent footer and delivery do not append through the uncertain leaf");
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

for (const action of ["replace", "detach"] as const) test(`post-mutation ${action} association failure preserves truthful native ownership`, { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVED_PARENT_CONTEXT"); const id = await f.spawn();
		const owner = f.owner(), native = f.runtime.session.sessionManager, file = f.runtime.session.sessionFile; assert.ok(owner); assert.ok(file);
		const saved = SessionManager.open(file).getEntries(), persist = native._persist.bind(native); let attempts = 0;
		t.mock.method(native, "_persist", (entry: Parameters<typeof persist>[0]) => {
			if (entry.type === "custom" && entry.customType === ASSOCIATION_ENTRY) { attempts++; throw new Error("post-mutation persistence failure"); }
			persist(entry);
		});
		if (action === "replace") {
			await assert.rejects(owner.runCommand(id, "replace", ""), /command completed on session .*saved parent association failed/u);
			const sessions = (owner as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions;
			assert.equal(sessions.has(id), false); assert.equal(sessions.size, 1);
			const current = [...sessions.values()][0]; assert.notEqual(current.sessionId(), id);
			assert.equal((await current.status()).operation, null); assert.equal(f.claims().length, 1);
		} else {
			await assert.rejects((owner as unknown as { release(id: string): Promise<void> }).release(id), /closed; saved parent association update failed; no detached run started/u);
			assert.equal((await f.inspect(id)).liveOwner, false); assert.equal(f.claims().length, 0);
		}
		await f.runtime.session.reload();
		await assert.rejects(f.tool("agent_attach", { sessionId: id }), /association write failed/u);
		assert.equal(attempts, 1); assert.deepEqual(SessionManager.open(file).getEntries(), saved);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

for (const action of ["replace", "detach"] as const) test(`deferred ${action} association failure refuses replay across later reload`, { timeout: 30_000 }, async (t) => {
	const f = await fixture(), entered = deferred(), finishReload = deferred();
	try {
		await f.runtime.session.prompt("SAVED_PARENT_CONTEXT"); const id = await f.spawn();
		const owner = f.owner(), native = f.runtime.session.sessionManager, file = f.runtime.session.sessionFile; assert.ok(owner); assert.ok(file);
		const loader = f.runtime.services.resourceLoader, reload = loader.reload.bind(loader);
		t.mock.method(loader, "reload", async (...args: Parameters<typeof reload>) => { entered.resolve(); await finishReload.promise; return reload(...args); });
		const pending = f.runtime.session.reload(); await entered.promise;
		if (action === "replace") await owner.runCommand(id, "replace", "");
		else await (owner as unknown as { release(id: string): Promise<void> }).release(id);
		const saved = SessionManager.open(file).getEntries(), persist = native._persist.bind(native); let attempts = 0;
		t.mock.method(native, "_persist", (entry: Parameters<typeof persist>[0]) => {
			if (entry.type === "custom" && entry.customType === ASSOCIATION_ENTRY) { attempts++; throw new Error("deferred persistence failure"); }
			persist(entry);
		});
		finishReload.resolve(); await pending;
		await assert.rejects(f.tool("agent_attach", { sessionId: id }), /association write failed/u);
		await f.runtime.session.reload();
		await assert.rejects(f.spawn("REFUSED"), /association write failed/u);
		assert.equal(attempts, 1); assert.deepEqual(SessionManager.open(file).getEntries(), saved);
		assert.equal((owner as unknown as { associationChanges: Map<string, unknown[]> }).associationChanges.get(native.getSessionId())?.length, 1);
		assert.ok(f.notices.some((notice) => notice.includes("deferred persistence failure"))); assert.deepEqual(f.errors, []);
	} finally { finishReload.resolve(); await f.close(); }
});

for (const target of ["primary", "worker"] as const) test(`native ${target} tool-result continuation exposes the unrepaired history boundary`, { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const id = target === "worker" ? await f.spawn() : f.runtime.session.sessionId;
		const session = target === "worker" ? f.childSession(id) : f.runtime.session;
		await session.prompt("SAVED_CONTEXT_BEFORE_FAULT"); await session.waitForIdle();
		const owner = f.owner(), native = session.sessionManager, file = session.sessionFile; assert.ok(owner); assert.ok(file);
		const candidate = (await owner.spawn({ cwd: f.child }, { cwd: f.cwd, model: { provider: "reload-local", id: "controlled" } })).sessionId;
		const saved = SessionManager.open(file).buildSessionContext().messages;
		assert.ok(JSON.stringify(saved).includes("SAVED_CONTEXT_BEFORE_FAULT"));
		const persist = native._persist.bind(native); let failedId = "", calls = 0;
		t.mock.method(native, "_persist", (entry: Parameters<typeof persist>[0]) => {
			if (entry.type === "custom" && entry.customType === ASSOCIATION_ENTRY) { failedId = entry.id; calls++; throw new Error("native tool persistence failure"); }
			persist(entry);
		});
		f.state.request = { sessionId: id, name: "agent_attach", args: { sessionId: candidate } };
		if (target === "worker") f.state.response = "RESULT_TEXT_".repeat(1500);
		await session.prompt("REQUEST_ATTACH"); await session.waitForIdle();
		if (target === "worker") await f.worker(id).waitForIdle();
		const disk = SessionManager.open(file), entries = disk.getEntries();
		assert.ok(failedId); assert.equal(disk.getEntry(failedId), undefined);
		assert.ok(entries.some((entry) => entry.parentId === failedId), "native continuation persisted an orphan child after the failed append");
		assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError));
		assert.equal(JSON.stringify(disk.buildSessionContext().messages).includes("SAVED_CONTEXT_BEFORE_FAULT"), false);
		assert.equal(associatedSessions(entries, id, f.store).has(candidate), false);
		if (target === "worker") {
			const inspection = JSON.parse(await f.tool("agent_inspect", { sessionId: id }));
			assert.match(inspection.resultPersistence, /not saved/u);
			let complete = inspection.result.text, next = inspection.result.nextOffset;
			assert.equal(inspection.result.truncated, true);
			while (next !== null) {
				const page = JSON.parse(await f.tool("agent_inspect", { sessionId: id, offset: next }));
				assert.equal(page.resultOffset, next); complete += page.result.text; next = page.result.nextOffset;
			}
			const result = JSON.parse(complete); assert.equal(result.status, "failed"); assert.equal(result.text, f.state.response);
			assert.match(result.error.message, /Operation result not saved/u);
			assert.deepEqual(await f.worker(id).operationResult(result.operationId), result);
			assert.equal(entries.some((entry) => entry.type === "custom" && entry.customType === "agent.result" && (entry.data as { operationId?: string })?.operationId === result.operationId), false);
			await assert.rejects(f.tool("agent_send", { sessionId: id, message: "REFUSED" }), /association write failed/u);
			const count = native.getEntries().length;
			assert.throws(() => (f.worker(id) as unknown as { begin(): string }).begin(), /association write failed/u);
			assert.equal(native.getEntries().length, count);
			assert.equal((await f.worker(id).status()).operation, null);
		}
		await session.reload();
		await assert.rejects(f.tool("agent_send", { sessionId: candidate, message: "REFUSED" }, session), /association write failed/u);
		await assert.rejects(f.tool("agent_compact", { sessionId: id, summary: "REFUSED" }, session), /association write failed/u);
		assert.equal(calls, 1); assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("healthy callers can abort an active target after its own association failure", { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const id = await f.spawn("HOLD"); await f.wait(() => f.events.some((event) => event.type === "tool" && event.sessionId === id));
		const owner = f.owner(); assert.ok(owner);
		const candidate = (await owner.spawn({ cwd: f.child }, { cwd: f.cwd, model: { provider: "reload-local", id: "controlled" } })).sessionId;
		const worker = f.worker(id), session = f.childSession(id), native = session.sessionManager, persist = native._persist.bind(native);
		t.mock.method(native, "_persist", (entry: Parameters<typeof persist>[0]) => {
			if (entry.type === "custom" && entry.customType === ASSOCIATION_ENTRY) throw new Error("active target association failure");
			persist(entry);
		});
		await assert.rejects(f.tool("agent_attach", { sessionId: candidate }, session), /association write failed/u);
		assert.equal(owner.associationFailure(f.runtime.session.sessionId), undefined);
		assert.ok(owner.associationFailure(id));
		const before = await f.inspect(id), claims = f.claims(); assert.ok(before.execution.current);
		await assert.rejects(f.tool("agent_detach", { sessionId: id, prompt: "REFUSED" }), /association write failed/u);
		assert.deepEqual((await f.inspect(id)).execution.current, before.execution.current);
		assert.match(await f.tool("agent_abort", { sessionId: id }), /abort requested/u);
		await worker.waitForIdle();
		const after = JSON.parse(await f.tool("agent_inspect", { sessionId: id }));
		assert.equal(after.liveOwner, true); assert.equal(after.execution.current, null);
		assert.match(after.resultPersistence, /not saved/u); assert.equal(JSON.parse(after.result.text).status, "aborted");
		assert.equal(f.worker(id), worker); assert.deepEqual(f.claims(), claims);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("healthy callers cannot transfer a failed target or discard its unsaved result", { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		await f.runtime.session.prompt("SAVED_PRIMARY");
		const id = await f.spawn(), worker = f.worker(id), session = f.childSession(id);
		await session.prompt("SAVED_WORKER"); await worker.waitForIdle();
		const owner = f.owner(); assert.ok(owner);
		const candidate = (await owner.spawn({ cwd: f.child }, { cwd: f.cwd, model: { provider: "reload-local", id: "controlled" } })).sessionId;
		const native = session.sessionManager, persist = native._persist.bind(native);
		t.mock.method(native, "_persist", (entry: Parameters<typeof persist>[0]) => {
			if (entry.type === "custom" && entry.customType === ASSOCIATION_ENTRY) throw new Error("target association failure");
			persist(entry);
		});
		f.state.request = { sessionId: id, name: "agent_attach", args: { sessionId: candidate } };
		await session.prompt("REQUEST_ATTACH"); await worker.waitForIdle();
		assert.equal(owner.associationFailure(f.runtime.session.sessionId), undefined);
		const failure = owner.associationFailure(id); assert.ok(failure);
		const before = JSON.parse(await f.tool("agent_inspect", { sessionId: id })), claims = f.claims();
		assert.equal(before.liveOwner, true); assert.match(before.resultPersistence, /not saved/u);
		assert.equal(JSON.parse(before.result.text).status, "failed");
		const close = t.mock.method(worker, "close");
		const launch = t.mock.method((owner as unknown as { detachedRuns: { start(): Promise<never> } }).detachedRuns, "start", async () => { throw new Error("unexpected detached launch"); });
		const calls: Array<[string, Record<string, unknown>]> = [
			["agent_detach", { prompt: "REFUSED" }], ["agent_attach", {}], ["agent_attach", { model: "reload-local/controlled" }],
			["agent_fork", {}], ["agent_rewind", { entryId: "unused", correction: "REFUSED" }],
			["agent_send", { message: "REFUSED" }], ["agent_steer", { message: "REFUSED" }],
			["agent_compact", {}], ["agent_command", { name: "replace", args: "" }],
		];
		for (const [name, params] of calls) await assert.rejects(f.tool(name, { sessionId: id, ...params }), /association write failed/u, name);
		assert.match(await f.tool("agent_abort", { sessionId: id }), /no active operation/u);
		assert.equal(launch.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0);
		assert.equal(f.worker(id), worker); assert.deepEqual(f.claims(), claims);
		assert.equal(owner.associationFailure(id), failure);
		assert.deepEqual(JSON.parse(await f.tool("agent_inspect", { sessionId: id })), before);
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
