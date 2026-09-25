import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { FOOTER_ENTRY, restoreFooter } from "./footer.ts";

test("native checkpoints stay in memory until the first assistant flushes the session file", () => {
	const root = mkdtempSync(join(tmpdir(), "footer-native-flush-"));
	try {
		const manager = SessionManager.create(root, join(root, "native"));
		const file = manager.getSessionFile();
		assert.ok(file);
		const saved = restoreFooter([], manager.getSessionId());
		saved.spend.cost = 0.25;
		manager.appendCustomEntry(FOOTER_ENTRY, saved);
		assert.deepEqual(restoreFooter(manager.getEntries(), manager.getSessionId()), saved);
		assert.equal(existsSync(file), false, "a custom checkpoint does not create an unflushed native file");
		manager.appendMessage(fauxAssistantMessage("done"));
		assert.equal(existsSync(file), true);
		assert.deepEqual(restoreFooter(SessionManager.open(file).getEntries(), manager.getSessionId()), saved);
		saved.spend.cost = 0.5;
		manager.appendCustomEntry(FOOTER_ENTRY, saved);
		assert.deepEqual(restoreFooter(SessionManager.open(file).getEntries(), manager.getSessionId()), saved, "later checkpoints append to the saved file");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("native primary reload, tree navigation, fork, new, and reopen keep exact-session totals", { timeout: 30_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-footer-retention-"));
	const agentDir = join(root, "agent"), cwd = join(root, "work"), child = join(root, "child");
	for (const dir of [agentDir, cwd, child]) mkdirSync(dir);
	const previous = process.env.PI_AGENT_SESSIONS_DIR;
	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = join(root, "store");
	const provider = join(root, "provider.mjs");
	const model = { id: "footer", name: "Footer", provider: "footer-retention", api: "footer-retention", baseUrl: "https://invalid.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
	writeFileSync(provider, `
		import {createAssistantMessageEventStream,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
		export default function(pi) {
			let ctx, calls = 0;
			const publish = () => pi.events.emit("harness:work-status:snapshot", {version:1,publisher:"subagent",sessionId:ctx.sessionManager.getSessionId(),available:true,active:0,cost:0,incomplete:false});
			pi.on("session_start", (_event, current) => { ctx=current; publish(); });
			pi.events.on("harness:work-status:request", request => { if(request.publisher === "subagent") publish(); });
			const stream = () => {
				const out=createAssistantMessageEventStream();
				const m=ctx.cwd===${JSON.stringify(cwd)} && calls++===0
					? fauxAssistantMessage(fauxToolCall("agent_spawn", {cwd:${JSON.stringify(child)},prompt:"test",trust:true}), {stopReason:"toolUse"})
					: fauxAssistantMessage("done");
				Object.assign(m, {api:"footer-retention",provider:"footer-retention",model:"footer",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.25,output:0,cacheRead:0,cacheWrite:0,total:.25}}});
				queueMicrotask(() => {out.push({type:"start",partial:m});out.push({type:"done",reason:m.stopReason,message:m});out.end(m);});return out;
			};
			pi.registerProvider({id:"footer-retention",name:"Footer",getModels:()=>[${JSON.stringify(model)}],auth:{apiKey:{name:"Synthetic",check:async()=>({type:"api_key"}),resolve:async()=>({auth:{}})}},stream,streamSimple:stream});
		}
	`);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [provider, fileURLToPath(new URL("./index.ts", import.meta.url))], cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	const status = new Map<string, string | undefined>();
	const errors: unknown[] = [];
	const bind = async (session: AgentSession) => session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error); }, uiContext: { setStatus: (key: string, text: string | undefined) => { status.set(key, text); } } as never });
	const runtime = await createAgentSessionRuntime(async (options) => {
		const services = await createAgentSessionServices(options);
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		const selected = services.modelRuntime.getModel("footer-retention", "footer");
		assert.ok(selected);
		return { ...await createAgentSessionFromServices({ ...options, services, model: selected, thinkingLevel: "off" }), services, diagnostics: services.diagnostics };
	}, { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(root, "native")) });
	runtime.setRebindSession(bind);
	try {
		await bind(runtime.session);
		assert.equal(status.get("agent"), "agents 0 · $0.00");
		const manager = runtime.session.sessionManager;
		const append = manager.appendCustomEntry.bind(manager);
		let attempts = 0;
		manager.appendCustomEntry = (type, data) => {
			if (type === FOOTER_ENTRY && ++attempts === 1) {
				throw new Error("controlled checkpoint append failure before in-memory mutation");
			}
			return append(type, data);
		};
		await runtime.session.prompt("start");
		const end = Date.now() + 10_000;
		while (status.get("agent") !== "agents 0 · $0.25" && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(status.get("agent"), "agents 0 · $0.25");
		await runtime.session.waitForIdle();
		assert.ok(attempts >= 2, "pre-mutation append failure does not suppress later retries");
		manager.appendCustomEntry = append;
		const sessionId = runtime.session.sessionId;
		const sessionFile = runtime.session.sessionFile;
		assert.ok(sessionFile);
		const firstUser = runtime.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
		assert.ok(firstUser);
		await runtime.session.reload();
		assert.equal(status.get("agent"), "agents 0 · $0.25");
		const saved = restoreFooter(runtime.session.sessionManager.getEntries(), sessionId);
		assert.deepEqual(saved.nested, { cost: 0, incomplete: false }, "intentional closed hosts do not create unknown spend");
		await runtime.session.navigateTree(firstUser.id, { summarize: false });
		await runtime.session.reload();
		assert.equal(status.get("agent"), "agents 0 · $0.25", "off-branch costs remain incurred");
		const checkpoints = runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === FOOTER_ENTRY);
		await runtime.session.reload();
		assert.equal(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === FOOTER_ENTRY).length, checkpoints.length, "unchanged reload appends no checkpoint");
		await runtime.fork(firstUser.id, { position: "at" });
		assert.notEqual(runtime.session.sessionId, sessionId);
		assert.equal(status.get("agent"), "agents 0 · $0.00");
		await runtime.newSession();
		assert.equal(status.get("agent"), "agents 0 · $0.00");
		await runtime.switchSession(sessionFile);
		assert.equal(runtime.session.sessionId, sessionId);
		assert.equal(status.get("agent"), "agents 0 · $0.25");
		assert.deepEqual(errors, []);
	} finally {
		await runtime.dispose();
		if (previous === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previous;
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
