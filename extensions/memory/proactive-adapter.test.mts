import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { registerProactive } from "./proactive-ordinary.ts";
import { memoryNotice } from "./proactive.ts";
import { failSelectedReads, proactiveCorpus, recallText, writeRecall } from "./proactive-fixture.mts";

test("ordinary correlation waits for admission, preserves bytes, deduplicates and resets after context loss", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-admission-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const corpus = proactiveCorpus(root);
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const hooks = new Map<string, Handler>();
	const records: unknown[] = [];
	let branch: unknown[] = [];
	const ctx = {
		signal: new AbortController().signal,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
	registerProactive(
		{
			on: (name: string, handler: Handler) => hooks.set(name, handler),
			appendEntry: (_name: string, data: unknown) => records.push(data),
		} as unknown as ExtensionAPI,
		() => ({ dir: corpus, proactive: true }),
	);
	const input = (text: string) =>
		hooks.get("input")?.({ text, source: "interactive", streamingBehavior: "steer" }, ctx);
	const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
	const contextHook = hooks.get("context");
	assert.ok(contextHook);
	const context = async (messages: AgentMessage[]) =>
		((await contextHook({ messages }, ctx)) as { messages: AgentMessage[] }).messages;
	input(recallText);
	assert.deepEqual(await context([]), []);
	const first = user(recallText, 1);
	const admitted = await context([first]);
	assert.equal(admitted.length, 2);
	assert.equal(admitted[0], first);
	assert.deepEqual(await context([first]), admitted);
	branch = [{ type: "message", message: first }];
	input(recallText);
	const second = user(recallText, 2);
	assert.equal((await context([first, second])).length, 3);
	assert.equal(records.length, 1);
	await hooks.get("session_compact")?.({}, ctx);
	branch = [{ type: "message", message: second }];
	input(recallText);
	const third = user(recallText, 3);
	const restored = await context([second, third]);
	assert.equal(restored.length, 3);
	assert.equal(restored[1], third);
	assert.equal(records.length, 2);
	input("/skill:fixture I prefer blue");
	assert.equal((await context([user("<skill> I prefer blue </skill>", 4)])).length, 1);
	await hooks.get("agent_end")?.({}, ctx);
	input("I prefer plain language");
	const storage = user("I prefer plain language", 5);
	assert.equal((await context([storage])).length, 2);
	input("I prefer plain language");
	assert.equal((await context([storage, user("I prefer plain language", 6)])).length, 3);
	await hooks.get("session_compact")?.({}, ctx);
	input(recallText);
	input(recallText);
	assert.equal((await context([user(recallText, 7)])).length, 2);
});

test("handled, rejected, aborted, transformed and expanded input never lend provenance to later equal text", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-provenance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const corpus = proactiveCorpus(root);
	const text = "I prefer durable source checks";
	for (const path of ["handled", "rejected", "aborted", "transformed", "expanded"] as const) {
		type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
		const hooks = new Map<string, Handler>();
		const records: unknown[] = [];
		const ctx = {
			signal: new AbortController().signal,
			sessionManager: { getBranch: () => [] },
		} as unknown as ExtensionContext;
		registerProactive(
			{
				on: (name: string, handler: Handler) => hooks.set(name, handler),
				appendEntry: (_name: string, data: unknown) => records.push(data),
			} as unknown as ExtensionAPI,
			() => ({ dir: corpus, proactive: true }),
		);
		const input = (value: string) => hooks.get("input")?.({ text: value, source: "interactive" }, ctx);
		const start = (value: string) => hooks.get("before_agent_start")?.({ messageType: "user", prompt: value }, ctx);
		const runContext = hooks.get("context");
		assert.ok(runContext);
		let timestamp = 0;
		const admitted = () =>
			runContext({ messages: [{ role: "user", content: text, timestamp: ++timestamp }] }, ctx) as Promise<{
				messages: unknown[];
			}>;
		input(path === "expanded" ? "/fixture" : text);
		if (path === "transformed") start("Transformed input");
		if (path === "expanded") start(text);
		if (path === "aborted") {
			start(text);
			await hooks.get("agent_end")?.({}, ctx);
		}
		assert.equal((await admitted()).messages.length, 1, path);
		// A command expansion reuses exactly the text of the discarded capture.
		input("/fixture");
		start(text);
		assert.equal((await admitted()).messages.length, 1, path);
		assert.equal(records.length, 0, path);
		await hooks.get("agent_end")?.({}, ctx);
		input(text);
		start(text);
		assert.equal((await admitted()).messages.length, 2, path);
		assert.equal(records.length, 1, path);
	}
});

test("distinct queued captures each retain a notice while duplicate provenance remains ambiguous", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-queued-provenance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const corpus = proactiveCorpus(root);
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const hooks = new Map<string, Handler>();
	const ctx = {
		signal: new AbortController().signal,
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;
	registerProactive(
		{
			on: (name: string, handler: Handler) => hooks.set(name, handler),
			appendEntry: () => {},
		} as unknown as ExtensionAPI,
		() => ({ dir: corpus, proactive: true }),
	);
	const older = "I prefer the older text";
	const newer = "I prefer the newer text";
	for (const text of [older, newer])
		hooks.get("input")?.({ text, source: "interactive", streamingBehavior: "steer" }, ctx);
	const result = (await hooks.get("context")?.(
		{
			messages: [
				{ role: "user", content: older, timestamp: 1 },
				{ role: "user", content: newer, timestamp: 2 },
			],
		},
		ctx,
	)) as { messages: Array<{ content: string }> };
	assert.equal(result.messages.length, 4);
	assert.equal(result.messages[2].content, newer);
	const repeated = "I prefer an unambiguous source";
	for (const source of ["extension", "interactive"])
		hooks.get("input")?.({ text: repeated, source, streamingBehavior: "steer" }, ctx);
	const ambiguous = (await hooks.get("context")?.(
		{
			messages: [
				{ role: "user", content: repeated, timestamp: 3 },
				{ role: "user", content: repeated, timestamp: 3 },
			],
		},
		ctx,
	)) as { messages: unknown[] };
	assert.equal(ambiguous.messages.length, 2);
});

test("a failed selected read preserves earlier ordinary notices and later requests recover", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-source-failure-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const corpus = proactiveCorpus(root);
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const hooks = new Map<string, Handler>();
	let branch: unknown[] = [];
	const ctx = {
		signal: new AbortController().signal,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
	registerProactive(
		{
			on: (name: string, handler: Handler) => hooks.set(name, handler),
			appendEntry: () => {},
		} as unknown as ExtensionAPI,
		() => ({ dir: corpus, proactive: true }),
	);
	const messages: AgentMessage[] = [];
	const contextHook = hooks.get("context");
	assert.ok(contextHook);
	const submit = async (timestamp: number) => {
		hooks.get("input")?.({ text: recallText, source: "interactive" }, ctx);
		hooks.get("before_agent_start")?.({ messageType: "user", prompt: recallText }, ctx);
		messages.push({ role: "user", content: recallText, timestamp });
		const result = (await contextHook({ messages }, ctx)) as { messages: AgentMessage[] };
		branch = messages.map((message) => ({ type: "message", message }));
		return result.messages;
	};
	const first = await submit(1);
	assert.equal(first.length, 2);
	writeRecall(corpus, "Changed source before a failed full read.");
	const fault = failSelectedReads(t);
	const failed = await submit(2);
	assert.ok(fault.failures() > 0);
	assert.equal(failed[1], first[1]);
	assert.equal(failed.length, 3);
	fault.restore();
	const recovered = await submit(3);
	assert.equal(recovered[1], first[1]);
	assert.equal(recovered.length, 5);
});

test("successful own reads satisfy recall; failed reads do not", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-read-satisfaction-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const corpus = proactiveCorpus(root);
	const notice = await memoryNotice(corpus, recallText, "direct input", false, new Set());
	assert.ok(notice);
	for (const isError of [false, true]) {
		type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
		const hooks = new Map<string, Handler>();
		const ctx = {
			signal: new AbortController().signal,
			sessionManager: { getBranch: () => [] },
		} as unknown as ExtensionContext;
		registerProactive(
			{
				on: (name: string, handler: Handler) => hooks.set(name, handler),
				appendEntry: () => {},
			} as unknown as ExtensionAPI,
			() => ({ dir: corpus, proactive: true }),
		);
		await hooks.get("tool_result")?.(
			{ toolName: "memory_read", isError, details: { slug: notice.slug, digest: notice.digest } },
			ctx,
		);
		hooks.get("input")?.({ text: recallText, source: "interactive" }, ctx);
		hooks.get("before_agent_start")?.({ messageType: "user", prompt: recallText }, ctx);
		const result = (await hooks.get("context")?.(
			{ messages: [{ role: "user", content: recallText, timestamp: 1 }] },
			ctx,
		)) as { messages: unknown[] };
		assert.equal(result.messages.length, isError ? 2 : 1);
	}
});
