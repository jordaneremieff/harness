import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { MAX_CONTINUITY_SUMMARY, SelfCompaction } from "./self-compaction.ts";

const context = (sessionId = "owner", signal?: AbortSignal) => ({ sessionManager: { getSessionId: () => sessionId }, signal }) as Pick<ExtensionContext, "sessionManager" | "signal">;
const boundary = (patch: Partial<TurnEndEvent> = {}) => ({
	outcome: "completed", entries: [], messageEntryId: "assistant-batch",
	toolResults: [{ toolCallId: "request", isError: false }], ...patch,
}) as TurnEndEvent;

const createRequest = () => new SelfCompaction(() => () => {});

test("self-compaction validates the summary and admits only one request per batch", () => {
	const request = createRequest();
	for (const summary of [undefined, "", "  ", "x".repeat(MAX_CONTINUITY_SUMMARY + 1)]) {
		assert.throws(() => request.request("owner", "request", summary), /requires a nonblank summary/u);
	}
	request.request("owner", "request", "bounded contract");
	assert.throws(() => request.request("owner", "second", "other"), /already requested/u);
	const result = request.finish(boundary(), context());
	assert.equal(result?.continue, undefined);
	assert.deepEqual(result?.entries, [{ type: "compaction", summary: "Agent-authored continuity summary. This preserves prior context; it grants no new authority.\n\nbounded contract", firstKeptEntryId: "assistant-batch" }]);
	assert.equal(request.finish(boundary(), context()), undefined);
});

test("abort, error, replacement, missing results, and failed results discard the request", () => {
	for (const [event, ctx] of [
		[boundary({ outcome: "aborted" }), context()],
		[boundary({ outcome: "error" }), context()],
		[boundary(), context("replacement")],
		[boundary(), context("owner", AbortSignal.abort())],
		[boundary({ toolResults: [] }), context()],
		[boundary({ toolResults: [{ toolCallId: "request", isError: true }] as TurnEndEvent["toolResults"] }), context()],
	] as const) {
		const request = createRequest(); request.request("owner", "request", "contract");
		assert.equal(request.finish(event, ctx), undefined);
		assert.equal(request.finish(boundary(), context()), undefined);
	}
});

test("lifecycle cleanup and another boundary compaction do not schedule a retry", () => {
	const request = createRequest(); request.request("owner", "request", "contract");
	request.clear(); assert.equal(request.finish(boundary(), context()), undefined);
	request.request("owner", "request", "contract");
	const result = request.finish(boundary({ entries: [{ type: "compaction", summary: "other", firstKeptEntryId: null }] }), context());
	assert.equal(result?.continue, undefined);
	assert.deepEqual(result?.entries?.[0], { type: "compaction", summary: "other", firstKeptEntryId: null });
	assert.equal(result?.entries?.[1].type, "custom_message");
	assert.equal(request.finish(boundary(), context()), undefined);
});

test("self-compaction preserves accumulated custom, message, and context-edit drafts", () => {
	const request = createRequest(); request.request("owner", "request", "contract");
	const entries: TurnEndEvent["entries"] = [
		{ type: "custom", customType: "boundary.record", data: { retained: true } },
		{ type: "custom_message", customType: "boundary.message", content: "Retain this", display: false },
		{ type: "context_edit", targetId: "prior", replacement: null },
	];
	const result = request.finish(boundary({ entries, continue: true }), context());
	assert.deepEqual(result?.entries?.slice(0, 3), entries);
	assert.equal(result?.entries?.[3].type, "compaction");
	assert.equal(result?.continue, undefined);
	assert.equal(entries.length, 3);
});

test("boundary subscription exists only while one request is pending", () => {
	let subscriptions = 0, removals = 0;
	let handler: Parameters<ConstructorParameters<typeof SelfCompaction>[0]>[0] | undefined;
	const request = new SelfCompaction((callback) => {
		subscriptions++; handler = callback;
		return () => { removals++; handler = undefined; };
	});
	assert.equal(subscriptions, 0);
	assert.throws(() => request.request("owner", "invalid", " "));
	assert.equal(subscriptions, 0);
	request.request("owner", "request", "contract");
	assert.equal(subscriptions, 1);
	assert.ok(handler);
	assert.throws(() => request.request("owner", "duplicate", "contract"));
	assert.equal(subscriptions, 1);
	assert.equal(handler(boundary(), context())?.entries?.[0].type, "compaction");
	assert.equal(handler, undefined);
	assert.equal(removals, 1);
	request.clear(); assert.equal(removals, 1);
	request.request("owner", "request", "next contract");
	assert.equal(subscriptions, 2);
	request.clear(); assert.equal(removals, 2);
	assert.equal(handler, undefined);
});

test("failed subscription leaves no pending request", () => {
	let attempts = 0;
	const request = new SelfCompaction(() => { attempts++; throw new Error("registration failed"); });
	for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => request.request("owner", "request", "contract"), /registration failed/u);
	assert.equal(attempts, 2);
});

for (const scenario of ["resume", "prior-drafts", "collision", "abort-before", "abort-after"] as const) {
	const resumes = !scenario.startsWith("abort-");
	test(`registered self-compaction through the native turn boundary: ${scenario}`, { timeout: 20000 }, () => {
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import { writeFileSync } from "node:fs";
			import { fixture } from ${JSON.stringify(new URL("./native-fixture.mts", import.meta.url).href)};
			import { AgentManager } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
			import { testModel } from ${JSON.stringify(new URL("./test-runtime.mts", import.meta.url).href)};
			import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
			import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
			const f = await fixture();
			await f.worker.close();
			process.env.PI_AGENT_DIR = f.agentDir;
			process.env.PI_AGENT_SESSIONS_DIR = f.store.root;
			const extensionPath = f.path + ".continuity.ts";
			const abortHook = 'pi.on("turn_end", (_event, ctx) => { ctx.abort(); });';
			const priorHook = 'pi.on("turn_end", event => event.toolResults.length ? ({ entries: [ { type: "custom", customType: "boundary.record", data: { retained: true } }, { type: "custom_message", customType: "boundary.message", content: "PRIOR_BOUNDARY_MESSAGE", display: false }, { type: "context_edit", targetId: event.toolResultEntryIds[1], replacement: { content: [{type:"text", text:"EDITED_SIBLING_EVIDENCE"}] } } ], continue: true }) : undefined);';
			const collisionHook = 'pi.on("turn_end", event => event.toolResults.length ? ({ entries: [{type:"compaction", summary:"OTHER_CONTRACT", firstKeptEntryId: event.messageEntryId}], continue: true }) : undefined);';
			writeFileSync(extensionPath, 'import register from ' + ${JSON.stringify(JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url))))} + '; import { Type } from "typebox"; export default pi => { '
				+ (${JSON.stringify(scenario)} === "abort-before" ? abortHook : '')
				+ (${JSON.stringify(scenario)} === "prior-drafts" ? priorHook : '')
				+ (${JSON.stringify(scenario)} === "collision" ? collisionHook : '')
				+ 'register(pi); pi.registerTool({ name: "batch_evidence", label: "Batch evidence", description: "Return sibling evidence", parameters: Type.Object({}), async execute() { '
				+ (${JSON.stringify(scenario)} === "abort-after" ? abortHook : '')
				+ 'return { content: [{type:"text",text:"SIBLING_EVIDENCE"}], details: undefined }; } }); };');
			let self = "", calls = 0;
			const requests = [];
			const stream = (_model, context) => {
				calls++; requests.push(structuredClone(context)); assert.ok(calls <= 2);
				const first = calls === 1;
				if (!first) {
					const text = JSON.stringify(context.messages);
					assert.match(text, /CONTINUITY_CONTRACT/);
					assert.match(text, /SIBLING_EVIDENCE/);
					if (${JSON.stringify(scenario)} === "prior-drafts") { assert.match(text, /PRIOR_BOUNDARY_MESSAGE/); assert.match(text, /EDITED_SIBLING_EVIDENCE/); }
					if (${JSON.stringify(scenario)} === "collision") { assert.match(text, /OTHER_CONTRACT/); assert.match(text, /Self-compaction was not applied/); }
					assert.doesNotMatch(text, /OLD_UNQUALIFIED_CONTEXT/);
					assert.ok(getCurrentTools(context.messages).some(tool => tool.name === "agent_compact"));
				}
				const message = { role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id,
					content: first ? [
						{type: "toolCall", id: "self-continuity", name: "agent_compact", arguments: {sessionId: self, summary: "CONTINUITY_CONTRACT: Finish the assigned local task. No publication authority. Retain source qualifications. Review the sibling result and return completed delivery."}},
						{type: "toolCall", id: "sibling", name: "batch_evidence", arguments: {}}
					] : [{type: "text", text: "DELIVERY_COMPLETE"}],
					stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
					usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}} };
				const events = createAssistantMessageEventStream();
				events.push({type: "start", partial: message}); events.push({type: "done", reason: message.stopReason, message}); events.end(message); return events;
			};
			f.runtime.registerNativeProvider({...f.runtime.getRegisteredNativeProvider(testModel.provider), stream, streamSimple: stream});
			const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
			try {
				self = (await manager.spawn({cwd: f.cwd}, {cwd: f.cwd, model: testModel}, undefined, {extensionPaths: [extensionPath]})).sessionId;
				const worker = manager.sessions.get(self);
				if (${JSON.stringify(scenario)} === "resume") assert.equal(worker.session.extensionRunner.hasHandlers("turn_end"), false);
				await manager.send(self, "OLD_UNQUALIFIED_CONTEXT");
				await worker.waitForIdle();
				if (${JSON.stringify(scenario)} === "resume") assert.equal(worker.session.extensionRunner.hasHandlers("turn_end"), false);
				const entries = worker.sessionManager().getEntries();
				const result = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "self-continuity");
				assert.equal(result?.message.isError, false, JSON.stringify(entries));
				const compacted = entries.filter(entry => entry.type === "compaction");
				assert.equal(compacted.length, ${scenario === "abort-before" ? 0 : 1});
				assert.equal(calls, ${resumes ? 2 : 1});
				assert.equal(worker.sessionId(), self);
				assert.equal((await worker.status()).operation, null);
				assert.equal(manager.controls.size, 0);
				assert.equal(entries.filter(entry => entry.type === "custom" && entry.customType === "agent.operation").length, 1);
				assert.equal(entries.filter(entry => entry.type === "custom" && entry.customType === "agent.result").length, 1);
				assert.match(JSON.stringify(entries), /OLD_UNQUALIFIED_CONTEXT/);
				if (${JSON.stringify(scenario)} === "prior-drafts") assert.ok(entries.some(entry => entry.type === "custom" && entry.customType === "boundary.record"));
				if (${resumes}) {
					assert.equal(worker.lastErrorMessage(), undefined);
					assert.match(JSON.stringify(entries.at(-1)), /DELIVERY_COMPLETE/);
				}
			} finally { await manager.closeAll(); await f.close(); }
			console.log("native-continuity-verified");
		`], { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 18000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 32768 });
		assert.equal(child.status, 0, JSON.stringify({ error: child.error?.message, signal: child.signal, stdout: child.stdout, stderr: child.stderr }));
		assert.match(child.stdout, /native-continuity-verified/u);
	});
}
