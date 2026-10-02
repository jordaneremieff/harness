import assert from "node:assert/strict";
import { test } from "node:test";
import { getCurrentTools, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { primaryFixture, type PrimaryScenario } from "./primary-fixture.mts";
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

for (const scenario of ["resume", "prior-drafts", "collision", "abort-before", "abort-after"] as const satisfies readonly PrimaryScenario[]) {
	const resumes = !scenario.startsWith("abort-");
	test(`registered self-compaction through the native turn boundary: ${scenario}`, { timeout: 30000 }, async (t) => {
		const f = await primaryFixture(t, scenario);
		await f.run("OLD_UNQUALIFIED_CONTEXT");
		const entries = f.sessionManager.getEntries();
		const results = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
		}
		assert.equal(results.get("self-continuity")?.isError, false, JSON.stringify(entries));
		assert.equal(results.get("sibling")?.isError, false, JSON.stringify(entries));
		assert.equal(entries.filter((entry) => entry.type === "compaction").length, scenario === "abort-before" ? 0 : 1);
		assert.equal(f.requests.length, resumes ? 2 : 1);
		assert.equal(f.session.isIdle, true);
		assert.match(JSON.stringify(entries), /OLD_UNQUALIFIED_CONTEXT/u);
		if (scenario === "prior-drafts") assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "boundary.record"));
		if (!resumes) return;
		assert.match(JSON.stringify(entries.at(-1) ?? null), /DELIVERY_COMPLETE/u);
		const second = f.requests[1];
		assert.ok(second);
		const text = JSON.stringify(second.messages);
		assert.match(text, /CONTINUITY_CONTRACT/u);
		assert.match(text, /SIBLING_EVIDENCE/u);
		if (scenario === "prior-drafts") {
			assert.match(text, /PRIOR_BOUNDARY_MESSAGE/u);
			assert.match(text, /EDITED_SIBLING_EVIDENCE/u);
		}
		if (scenario === "collision") {
			assert.match(text, /OTHER_CONTRACT/u);
			assert.match(text, /Self-compaction was not applied/u);
		}
		assert.doesNotMatch(text, /OLD_UNQUALIFIED_CONTEXT/u);
		assert.ok(getCurrentTools(second.messages).some((tool) => tool.name === "agent_compact"));
	});
}
