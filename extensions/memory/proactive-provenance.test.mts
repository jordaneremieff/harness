import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, InputSource } from "@earendil-works/pi-coding-agent";
import { registerProactive } from "./proactive-ordinary.ts";
import { failSelectedReads, proactiveCorpus, recallText } from "./proactive-fixture.mts";

const text = `${recallText}. I prefer durable source checks`;
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "memory-input-provenance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const corpus = proactiveCorpus(root);
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const hooks = new Map<string, Handler>();
	const records: Array<{ kind: string }> = [];
	let branch: unknown[] = [];
	const ctx = {
		signal: new AbortController().signal,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
	registerProactive(
		{
			on: (name: string, handler: Handler) => hooks.set(name, handler),
			appendEntry: (_name: string, value: { kind: string }) => records.push(value),
		} as unknown as ExtensionAPI,
		() => ({ dir: corpus, proactive: true }),
	);
	const contextHook = hooks.get("context");
	assert.ok(contextHook);
	return {
		records,
		input(value: string, source: InputSource = "interactive", streamingBehavior?: "steer" | "followUp") {
			hooks.get("input")?.({ text: value, source, streamingBehavior }, ctx);
		},
		start(prompt: string) {
			hooks.get("before_agent_start")?.({ messageType: "user", prompt }, ctx);
		},
		end() {
			hooks.get("agent_end")?.({}, ctx);
		},
		async context(messages: AgentMessage[]) {
			const result = (await contextHook({ messages }, ctx)) as { messages: AgentMessage[] };
			branch = messages.map((message) => ({ type: "message", message }));
			return result.messages;
		},
	};
}
function user(timestamp: number, content = text): AgentMessage {
	return { role: "user", content, timestamp };
}
function notices(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "custom" && message.customType === "memory_notice" ? [String(message.content)] : [],
	);
}

test("staggered identical extension steering and interactive follow-up retain recall without borrowing storage provenance", async (t) => {
	const f = fixture(t);
	f.input(text, "extension", "steer");
	f.input(text, "interactive", "followUp");
	const steer = user(1);
	const first = notices(await f.context([steer]));
	assert.equal(first.length, 1);
	assert.match(first[0], /Memory candidate/);
	assert.match(first[0], /ambiguous queued or raw input/);
	assert.doesNotMatch(first[0], /direct interactive|Memory check:/);
	const followUp = user(2);
	const later = notices(await f.context([steer, followUp]));
	assert.deepEqual(later, first);
	const fault = failSelectedReads(t);
	assert.deepEqual(notices(await f.context([steer, followUp])), first);
	assert.equal(fault.failures(), 0, "historical ambiguous input is not rescored on later tool rounds");
	fault.restore();
	assert.deepEqual(
		f.records.map((record) => record.kind),
		["recall"],
	);
});

test("opaque command and skill markers withhold queued storage cues without withholding content recall", async (t) => {
	for (const marker of ["/template", "/skill:fixture", '<skill name="fixture">I prefer quoted code</skill>']) {
		const f = fixture(t);
		f.input(text, "interactive", "steer");
		f.input(marker, "extension", "followUp");
		const delivered = notices(await f.context([user(1)]));
		assert.equal(delivered.length, 1);
		assert.match(delivered[0], /Memory candidate/);
		assert.match(delivered[0], /queued input; admission source is not resolved/);
		assert.doesNotMatch(delivered[0], /Memory check:|direct interactive/);
	}
});

test("earlier unresolved command expansions cannot borrow a later interactive capture's storage provenance", async (t) => {
	for (const marker of ["/fixture", "/skill:fixture", '<skill name="fixture">I prefer quoted code</skill>']) {
		const f = fixture(t);
		f.input(marker, "extension", "steer");
		f.input(text, "interactive", "followUp");
		const delivered = notices(await f.context([user(1)]));
		assert.equal(delivered.length, 1);
		assert.match(delivered[0], /Memory candidate/);
		assert.match(delivered[0], /queued input; admission source is not resolved/);
		assert.doesNotMatch(delivered[0], /Memory check:|queued interactive input/);
	}
	const f = fixture(t);
	const preference = "I prefer concise answers";
	f.input("/fixture", "extension", "steer");
	f.input(preference, "interactive", "followUp");
	assert.equal(notices(await f.context([user(1, preference)])).length, 0);
	assert.deepEqual(f.records, []);
});

test("opaque marker expiry at run end restores confirmed idle storage", async (t) => {
	const f = fixture(t);
	f.input("/fixture", "extension", "steer");
	f.input(text);
	f.start(text);
	const first = user(1);
	const blocked = notices(await f.context([first]));
	assert.equal(blocked.length, 1);
	assert.doesNotMatch(blocked[0], /Memory check:/);
	f.end();
	f.input(text);
	f.start(text);
	const restored = notices(await f.context([first, user(2)]));
	assert.equal(restored.length, 2);
	assert.match(restored[1], /Memory check:/);
});

test("idle admission proves storage provenance while unconfirmed captures expire at the next input", async (t) => {
	for (const path of ["handled", "rejected", "transformed"]) {
		const f = fixture(t);
		f.input(text);
		if (path === "transformed") f.start("Different admitted text");
		f.input("/template", "extension");
		f.start(text);
		assert.equal(notices(await f.context([user(1)])).length, 0, path);
		f.end();
		f.input(text, "rpc");
		f.start(text);
		const delivered = notices(await f.context([user(2)]));
		assert.equal(delivered.length, 1);
		assert.match(delivered[0], /Source class: direct rpc input/);
		assert.match(delivered[0], /Memory check:/);
	}
});

test("unresolved raw provenance permits recall but queued captures expire at run end", async (t) => {
	const f = fixture(t);
	f.input(text);
	const unresolved = notices(await f.context([user(1)]));
	assert.equal(unresolved.length, 1);
	assert.match(unresolved[0], /unresolved raw input/);
	assert.doesNotMatch(unresolved[0], /Memory check:/);
	f.end();
	f.input(text, "interactive", "steer");
	f.end();
	assert.equal(notices(await f.context([user(2)])).length, 0);
});

test("unique queued provenance is labelled queued and extension input stays recall-only", async (t) => {
	for (const source of ["extension", "interactive", "rpc"] as const) {
		const f = fixture(t);
		f.input(text, source, "steer");
		const delivered = notices(await f.context([user(1)]));
		assert.equal(delivered.length, 1);
		assert.match(delivered[0], /Source class: queued/);
		assert.doesNotMatch(delivered[0], /Source class: direct/);
		assert.equal(delivered[0].includes("Memory check:"), source !== "extension");
	}
});

test("capture overflow withholds unproved queued storage while preserving bounded recall", async (t) => {
	const f = fixture(t);
	for (let i = 0; i < 32; i++) f.input(`Unrelated queued input ${i}`, "interactive", "steer");
	f.input(text, "interactive", "followUp");
	const first = user(1);
	const delivered = notices(await f.context([first]));
	assert.equal(delivered.length, 1);
	assert.match(delivered[0], /Memory candidate/);
	assert.doesNotMatch(delivered[0], /Memory check:/);
	f.end();
	f.input(text);
	f.start(text);
	const restored = notices(await f.context([first, user(2)]));
	assert.equal(restored.length, 2);
	assert.match(restored[1], /Memory check:/);
});
