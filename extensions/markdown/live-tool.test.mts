import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { compile } from "@earendil-works/pi-schema";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { LiveBridge } from "./live-bridge.ts";
import { createLiveTool, createNativeLiveTool, liveSourcePage } from "./live-tool.ts";
import { liveId, type LiveAction, type LiveCommand, type LiveResult } from "./live-protocol.ts";
import { responseDigest } from "./responses.ts";

test("the live tool validates claim fields and forwards exact claim and release actions", async () => {
	const claimId = randomUUID();
	const expiresAt = Date.now() + 90000;
	const seen: { handle: string; action: LiveAction }[] = [];
	const bridge = {
		execute: async (handle: string, action: LiveAction) => {
			seen.push({ handle, action });
			return action.op === "claim" ? { status: "claimed", claimId, expiresAt } : { status: "released", claimId };
		},
	} as unknown as LiveBridge;
	const tool = createLiveTool(async () => bridge);
	const check = compile(tool.parameters).check;
	const claim = {
		op: "claim" as const,
		handle: "exact-handle",
		baseGeneration: 3,
		baseDigest: responseDigest("🧭"),
		ranges: [{ start: 0, end: 2 }],
		label: "Review",
	};
	assert.ok(check(claim));
	for (const invalid of [
		{ ranges: [] },
		{ ranges: Array.from({ length: 17 }, () => ({ start: 0, end: 1 })) },
		{ ranges: [{ start: -1, end: 2 }] },
		{ ranges: [{ start: 0.5, end: 2 }] },
		{ ranges: [{ start: 0, end: 2, extra: true }] },
		{ label: "x".repeat(81) },
		{ extra: true },
	])
		assert.equal(check({ ...claim, ...invalid }), false);
	const signal = new AbortController().signal;
	const ctx = {} as ExtensionToolContext;
	const claimed = await tool.execute("claim", claim, signal, undefined, ctx);
	assert.deepEqual(claimed.details, { status: "claimed", claimId, expiresAt });
	assert.deepEqual(JSON.parse((claimed.content[0] as { text: string }).text), claimed.details);
	const release = { op: "release" as const, handle: claim.handle, claimId };
	assert.ok(check(release));
	const released = await tool.execute("release", release, signal, undefined, ctx);
	assert.deepEqual(released.details, { status: "released", claimId });
	assert.deepEqual(seen, [
		{
			handle: claim.handle,
			action: { op: "claim", baseGeneration: 3, baseDigest: claim.baseDigest, ranges: claim.ranges, label: "Review" },
		},
		{ handle: claim.handle, action: { op: "release", claimId } },
	]);
	for (const input of [
		{ ...claim, baseGeneration: undefined },
		{ ...claim, baseDigest: "bad" },
		{ ...claim, ranges: [{ start: 2, end: 0 }] },
		{ ...release, claimId: "bad" },
		{ ...claim, handle: undefined },
	])
		await assert.rejects(tool.execute("invalid", input, signal, undefined, ctx));
	assert.equal(seen.length, 2, "invalid actions never reach the pane");
	assert.match(tool.description, /claim.*before composing/iu);
	assert.match(tool.description, /never block the person/iu);
});
test("live source pages preserve exact UTF-16 continuation and all source bytes", () => {
	const source = `${"a".repeat(65535)}🧭${"b".repeat(65536)}\nend`;
	const result: Extract<LiveResult, { status: "ok" }> = {
		status: "ok",
		source,
		generation: 8,
		digest: responseDigest(source),
		assets: [{ reference: "./image.svg", digest: responseDigest("image") }],
	};
	const pages: string[] = [];
	let offset = 0;
	for (let step = 0; step < 4; step++) {
		const page = liveSourcePage(result, { op: "read", offset, baseGeneration: 8, baseDigest: result.digest });
		assert.equal(page.status, "ok");
		if (page.status !== "ok") throw new Error("No source page");
		assert.equal(page.offset, offset);
		assert.equal(page.totalChars, source.length);
		assert.equal(page.totalBytes, Buffer.byteLength(source));
		assert.equal(page.digest, result.digest);
		assert.deepEqual(page.assets, result.assets);
		assert.ok(Buffer.byteLength(page.source) <= 65536);
		if (step === 0) assert.equal(Buffer.byteLength(page.source), 65535, "a page does not split a surrogate pair");
		pages.push(page.source);
		if (page.nextOffset === null) break;
		assert.equal(page.nextOffset, offset + page.source.length);
		offset = page.nextOffset;
	}
	assert.ok(pages.join("") === source, "no source bytes disappear between pages");
	assert.equal(
		liveSourcePage(result, { op: "read", offset: 65535, baseGeneration: 9, baseDigest: result.digest }).status,
		"stale",
	);
	assert.equal(
		liveSourcePage(result, { op: "read", offset: 65535, baseGeneration: 8, baseDigest: responseDigest("changed") })
			.status,
		"stale",
	);
	assert.equal(liveSourcePage(result, { op: "read", offset: 65535 }).status, "stale");
	assert.throws(
		() => liveSourcePage(result, { op: "read", offset: 65536, baseGeneration: 8, baseDigest: result.digest }),
		/boundary/u,
	);
	assert.throws(
		() =>
			liveSourcePage(result, { op: "read", offset: source.length + 1, baseGeneration: 8, baseDigest: result.digest }),
		/boundary/u,
	);
	assert.equal(
		liveSourcePage(
			{ ...result, source: "short", generation: 9, digest: responseDigest("short") },
			{ op: "read", offset: 65535, baseGeneration: 8, baseDigest: result.digest },
		).status,
		"stale",
		"a shorter changed source requires a fresh read, not an invalid-page report",
	);
});
test("the native tool retains a full escaped page beyond the host's default output bound", {
	timeout: 10000,
}, async () => {
	const source = "\u0000".repeat(65536);
	const result = { status: "ok", source, generation: 1, digest: responseDigest(source), assets: [] } as const;
	const bridge = { execute: async () => result } as unknown as LiveBridge;
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	registry.install(
		Durable.defineExtension({ name: "markdown", tools: [createNativeLiveTool(Durable, async () => bridge)] }),
	);
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("markdown_live", { op: "read", handle: "exact-test-handle" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Read complete."),
		]);
		await (await conversation.submit({ type: "input", content: "Read the exact buffer." }, context)).wait(context);
		const entry = (await conversation.entries({}, 20, undefined, context)).items.find((item) =>
			Durable.ToolResultEntry.is(item),
		);
		const message = entry?.model?.[0];
		assert.ok(message?.role === "toolResult" && !message.isError);
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		assert.ok(Buffer.byteLength(text) > 65536);
		const page = JSON.parse(text);
		assert.ok(page.source === source, "the host receives every byte of the escaped source page");
		assert.equal(page.nextOffset, null);
		assert.equal(page.totalBytes, 65536);
	} finally {
		await harness.close(context);
	}
});
test("an empty live source and native failures remain exact", () => {
	const page = liveSourcePage(
		{ status: "ok", source: "", generation: 0, digest: responseDigest(""), assets: [] },
		{ op: "read" },
	);
	assert.ok(page.status === "ok" && page.source === "" && page.nextOffset === null && page.totalBytes === 0);
	assert.deepEqual(liveSourcePage({ status: "busy", message: "Composition is active." }, { op: "read" }), {
		status: "busy",
		message: "Composition is active.",
	});
});

const snapshot = (source: string, generation = 1): Extract<LiveResult, { status: "ok" }> => ({
	status: "ok",
	source,
	generation,
	digest: responseDigest(source),
	assets: [],
});
const applyInput = (handle: string, edits: { find: string; replace: string }[]) => ({
	op: "apply" as const,
	handle,
	edits,
});
const runTool = async (
	tool: ReturnType<typeof createLiveTool>,
	input: Parameters<ReturnType<typeof createLiveTool>["execute"]>[1],
) => {
	const result = await tool.execute("call", input, undefined, undefined, {} as ExtensionToolContext);
	return JSON.parse((result.content[0] as { text: string }).text);
};
function scriptedTool(...replies: LiveResult[]) {
	const actions: LiveAction[] = [];
	const bridge = {
		resolvedEdit: () => undefined,
		execute: async (_handle: string, action: LiveAction) => {
			actions.push(action);
			const reply = replies.shift();
			assert.ok(reply, `Unexpected ${action.op} request`);
			return reply;
		},
	} as unknown as LiveBridge;
	return { actions, tool: createLiveTool(async () => bridge) };
}

test("apply schema accepts anchors and ranges separately", () => {
	const { tool } = scriptedTool();
	const check = compile(tool.parameters).check;
	const anchored = applyInput("handle", [{ find: "old", replace: "" }]);
	const range = { start: 0, end: 3, expected: "old", replacement: "" };
	assert.ok(check(anchored));
	assert.ok(check({ ...anchored, edits: [range] }));
	for (const edits of [
		[],
		[{ find: "", replace: "" }],
		[{ find: "old" }],
		[{ ...range, find: "old", replace: "" }],
		[...anchored.edits, range],
	]) {
		assert.equal(check({ ...anchored, edits }), false);
	}
});

test("anchors resolve together to ordered UTF-16 ranges and normalise line endings for LF", async () => {
	const base = snapshot("🧭\nA\nB😀C\nfin");
	const { tool, actions } = scriptedTool(base, {
		status: "busy",
		message: "The person has this passage open for writing. Read again after they leave it, or edit elsewhere.",
	});
	const input = applyInput("handle", [
		{ find: "fin", replace: "end" },
		{ find: "A\r\nB😀", replace: "new\rline\r\n" },
	]);
	const result = await runTool(tool, input);
	assert.equal(result.status, "busy");
	assert.match(result.message, /edit elsewhere/u);
	assert.ok(liveId(result.operationId));
	assert.deepEqual(actions, [
		{ op: "read" },
		{
			op: "apply",
			operationId: result.operationId,
			baseGeneration: 1,
			baseDigest: base.digest,
			edits: [
				{ start: 3, end: 8, expected: "A\nB😀", replacement: "new\nline\n" },
				{ start: 10, end: 13, expected: "fin", replacement: "end" },
			],
		},
	]);
	const crlf = snapshot("A\r\nB");
	const exact = scriptedTool(crlf, { status: "error", message: "Refused" });
	await runTool(exact.tool, {
		...applyInput("handle", [{ find: crlf.source, replace: "C\r\nD" }]),
		baseGeneration: crlf.generation,
		baseDigest: crlf.digest,
	});
	assert.deepEqual(exact.actions[1]?.op === "apply" && exact.actions[1].edits, [
		{ start: 0, end: 4, expected: "A\r\nB", replacement: "C\r\nD" },
	]);
	await assert.rejects(runTool(tool, { ...input, baseGeneration: 1 }), /supply both/iu);
});

test("anchor errors show exact nearby text, match locations, and escaped whitespace without editing", async () => {
	for (const [source, edits, message, fields] of [
		[
			"Heading\n  three shared words!\nthree",
			[{ find: "three shared words?", replace: "X" }],
			/anchor not found/iu,
			{ suggestion: { line: 2, text: "  three shared words!", truncated: false } },
		],
		["one\r\n\r\none", [{ find: "one", replace: "X" }], /more surrounding text/iu, { count: 2, lines: [1, 3] }],
		["aaa", [{ find: "aa", replace: "X" }], /occurs 2 times/u, { count: 2, lines: [1, 1] }],
		[
			"first\n\tsecond",
			[{ find: "first\\n\\tsecond", replace: "X" }],
			/real line breaks or tabs/u,
			{ suggestedFind: "first\n\tsecond" },
		],
		[
			"first second",
			[
				{ find: "first second", replace: "X" },
				{ find: "second", replace: "Y" },
			],
			/overlap/u,
			{},
		],
	] as const) {
		const { tool, actions } = scriptedTool(snapshot(source));
		const { status, message: actual, edit, ...diagnostic } = await runTool(tool, applyInput("handle", [...edits]));
		assert.equal(status, "error");
		assert.match(actual, message);
		assert.ok(edit > 0);
		assert.deepEqual(diagnostic, fields);
		assert.deepEqual(actions, [{ op: "read" }]);
	}
	const escapedText = scriptedTool(snapshot("first\\nsecond\nfirst\nsecond"), { status: "error", message: "Refused" });
	await runTool(escapedText.tool, applyInput("handle", [{ find: "first\\nsecond", replace: "X" }]));
	assert.equal(escapedText.actions[1]?.op === "apply" && escapedText.actions[1].edits[0]?.expected, "first\\nsecond");
});

test("only a stale refusal permits one changed apply", async () => {
	const old = snapshot("before\nold"),
		refreshed = snapshot("changed\nbefore\nold", 2),
		latest = snapshot("changed again\nbefore\nold", 3);
	const stale = { status: "stale", message: "Changed." } as const;
	const input = applyInput("handle", [{ find: "old", replace: "new" }]);
	const route = scriptedTool(old, stale, refreshed, stale, latest);
	const result = await runTool(route.tool, input);
	assert.equal(result.status, "stale");
	assert.equal(result.generation, latest.generation);
	assert.equal(result.digest, latest.digest);
	assert.equal(result.retried, true);
	assert.match(result.message, /read the exact pane and revise/iu);
	const [, first, , retry] = route.actions;
	assert.ok(first?.op === "apply" && retry?.op === "apply");
	assert.notEqual(first.operationId, retry.operationId);
	assert.equal(retry.edits[0]?.start, 15);
	assert.deepEqual(
		route.actions.map((action) => action.op),
		["read", "apply", "read", "apply", "read"],
	);
	const duplicate = snapshot("old\nold", 2);
	const ambiguous = scriptedTool(old, stale, duplicate);
	const refused = await runTool(ambiguous.tool, input);
	assert.equal(refused.status, "stale");
	assert.deepEqual(refused.lines, [1, 2]);
	assert.equal(refused.digest, duplicate.digest);
	assert.deepEqual(
		ambiguous.actions.map((action) => action.op),
		["read", "apply", "read"],
	);
	const priorBase = scriptedTool(refreshed, { status: "closed", message: "The document disconnected." });
	const closed = await runTool(priorBase.tool, { ...input, baseGeneration: old.generation, baseDigest: old.digest });
	assert.equal(closed.retried, true);
	assert.equal(closed.status, "closed");
	assert.match(closed.message, /reopen the same live document/iu);
});

test("the Durable registration runs anchored applies with an omitted operation ID", { timeout: 10000 }, async () => {
	const base = snapshot("🧭 old");
	const actions: LiveAction[] = [];
	const bridge = {
		resolvedEdit: () => undefined,
		execute: async (_handle: string, action: LiveAction) => {
			actions.push(action);
			if (action.op === "read") return base;
			assert.equal(action.op, "apply");
			return {
				status: "applied",
				operationId: action.operationId,
				generation: 2,
				digest: responseDigest("🧭 new"),
				retained: true,
			};
		},
	} as unknown as LiveBridge;
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	registry.install(
		Durable.defineExtension({ name: "markdown", tools: [createNativeLiveTool(Durable, async () => bridge)] }),
	);
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("markdown_live", applyInput("handle", [{ find: "old", replace: "new" }])), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Edit complete."),
		]);
		await (await conversation.submit({ type: "input", content: "Edit the exact buffer." }, context)).wait(context);
		const entry = (await conversation.entries({}, 20, undefined, context)).items.find((item) =>
			Durable.ToolResultEntry.is(item),
		);
		const message = entry?.model?.[0];
		assert.ok(message?.role === "toolResult" && !message.isError);
		const result = JSON.parse(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
		assert.equal(result.status, "applied");
		assert.ok(liveId(result.operationId));
		assert.deepEqual(actions, [
			{ op: "read" },
			{
				op: "apply",
				operationId: result.operationId,
				baseGeneration: 1,
				baseDigest: base.digest,
				edits: [{ start: 3, end: 6, expected: "old", replacement: "new" }],
			},
		]);
	} finally {
		await harness.close(context);
	}
});

test("retry after an unconfirmed refreshed edit keeps its exact native command", { timeout: 10000 }, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 1000, 400);
	const config = await bridge.start();
	const binding = { workspace: randomUUID(), document: randomUUID() };
	const post = async (path: string, body: object = {}) => {
		const response = await fetch(config.endpoint + path, {
			method: "POST",
			headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...binding, ...body }),
			signal: AbortSignal.timeout(2000),
		});
		assert.equal(response.status, 200);
		return response.json() as Promise<{ handle: string; command: LiveCommand }>;
	};
	const next = async () => {
		const result = await post("/poll", { after: 0 });
		assert.ok(result.command, "a command reached the pane");
		return result.command;
	};
	const reply = (command: LiveCommand, result: LiveResult) => post("/result", { requestId: command.requestId, result });
	try {
		const { handle } = await post("/connect", { live: 2 });
		const input = applyInput(handle, [{ find: "old", replace: "new" }]);
		const tool = createLiveTool(async () => bridge);
		const pending = runTool(tool, input);
		await reply(await next(), snapshot("old"));
		await reply(await next(), { status: "stale", message: "Changed." });
		await reply(await next(), snapshot("edited\nold", 2));
		const apply = await next();
		assert.ok(apply.op === "apply");
		assert.equal(apply.edits[0]?.start, 7);
		const uncertain = await pending;
		assert.equal(uncertain.status, "uncertain");
		assert.equal(uncertain.retried, true);
		assert.equal(uncertain.operationId, apply.operationId);
		await assert.rejects(
			runTool(tool, { ...input, operationId: apply.operationId, edits: [{ find: "old", replace: "other" }] }),
			/different live edit/u,
		);
		const retry = runTool(tool, { ...input, operationId: uncertain.operationId });
		assert.deepEqual(await next(), apply, "the tool reconciles the original command without another read");
		await reply(apply, {
			status: "applied",
			operationId: apply.operationId,
			generation: 3,
			digest: responseDigest("edited\nnew"),
			retained: true,
		});
		assert.deepEqual(await retry, {
			status: "applied",
			operationId: apply.operationId,
			generation: 3,
			digest: responseDigest("edited\nnew"),
			retained: true,
			retried: true,
		});
	} finally {
		bridge.close();
	}
});
