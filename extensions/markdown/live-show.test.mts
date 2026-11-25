import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
import { LiveBridge } from "./live-bridge.ts";
import { liveArguments } from "./live-launch.ts";
import { PANE_PROTOCOL } from "./live-protocol.ts";
import { isRecord, type LiveConfig } from "./live-protocol.ts";
import { createLiveTool, createNativeLiveTool } from "./live-tool.ts";
import type { PaneInventory } from "./pane-state.ts";
import { responseDigest } from "./responses.ts";
import { MarkdownStore } from "./store.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "markdown-show-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	const store = new MarkdownStore(join(root, "store"));
	const first = await store.create({
		title: "Plan",
		source: "Draft one",
		contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() },
	});
	const document = first.document.id;
	const second = await store.update(document, 1, {
		title: "Plan",
		source: "Draft two",
		contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() },
	});
	const identity = await store.identity();
	assert.ok(identity);
	return {
		root,
		store,
		storeId: identity.storeId,
		document,
		first: first.revision.digest,
		second: second.revision.digest,
	};
}
function pane(origin: "agent" | "operator"): PaneInventory["panes"][number] {
	const workspace = randomUUID(),
		document = randomUUID();
	return {
		handle: `${workspace}:${document}`,
		launchId: randomUUID(),
		workspace,
		document,
		origin,
		live: PANE_PROTOCOL,
		pid: process.pid,
		reportedAt: Date.now(),
		view: { kind: "scratchpad", mode: "writing", title: "Notes", dirty: false, conflict: false, follows: false },
	};
}
function recipient(inventory: PaneInventory, deliver: (handle: string, action: Record<string, unknown>) => unknown) {
	return {
		list: () => inventory.panes,
		pendingLaunches: () => inventory.pending,
		execute: async (handle: string, action: Record<string, unknown>) => deliver(handle, action),
	} as unknown as LiveBridge;
}
const forbidden = async (): Promise<never> => {
	throw new Error("Unexpected reader launch");
};
const ctx = (session = () => "original") =>
	({ sessionManager: { getSessionId: session } }) as unknown as ExtensionToolContext;
type NativeTool = ReturnType<typeof createNativeLiveTool>;
type Input = Parameters<NativeTool["execute"]>[0];
async function ordinary(tool: ReturnType<typeof createLiveTool>, input: Input, context = ctx()) {
	const result = await tool.execute("call", input, undefined, undefined, context);
	assert.ok(isRecord(result.structuredContent));
	return result.structuredContent;
}
async function native(tool: NativeTool, input: Input, api: Durable.ToolExecutionApi) {
	const result = await tool.execute(input, api, BACKGROUND_CONTEXT);
	assert.ok("structuredOutput" in result && isRecord(result.structuredOutput));
	return result.structuredOutput;
}
function task(beforeSave: (value: unknown) => void = () => {}) {
	const memos = new Map<string, unknown>();
	return {
		conversationId: "original",
		taskId: 1,
		memo: async (name: string, value: unknown, context?: unknown) => {
			if (context !== undefined && !memos.has(name)) {
				beforeSave(value);
				memos.set(name, structuredClone(value));
			}
			return structuredClone(memos.get(name));
		},
	} as unknown as Durable.ToolExecutionApi;
}

test("show requests current-follow or an exact revision, and reports only what the selected pane confirms", async (t) => {
	const { store, storeId, document, first, second } = await fixture(t);
	const agent = pane("agent"),
		operator = pane("operator"),
		next = pane("agent");
	const calls: unknown[] = [];
	const inventory = { panes: [operator, agent], pending: [] };
	const nextHandle = `${agent.workspace}:${next.document}`;
	const confirm = (revision: number, digest: string, follows: boolean) => ({
		status: "navigated" as const,
		workspace: agent.workspace,
		document: next.document,
		handle: nextHandle,
		view: {
			...agent.view,
			kind: "published" as const,
			title: "Plan",
			mode: "reading" as const,
			storeId,
			documentId: document,
			revision,
			digest,
			follows,
		},
	});
	const receipts = [
		confirm(2, second, true),
		confirm(1, first, false),
		{ status: "stale", message: "The selected document changed." },
		{ status: "uncertain", message: "Lost display acknowledgement." },
	];
	const host = recipient(inventory, (handle, action) => {
		calls.push([handle, action]);
		const receipt = receipts[calls.length - 1];
		if ("view" in receipt && receipt.view)
			inventory.panes[1] = { ...agent, handle: receipt.handle, document: receipt.document, view: receipt.view };
		return receipt;
	});
	const reports: unknown[] = [];
	const tool = createLiveTool(async () => host, {
		store,
		connection: forbidden,
		workReference: (sessionId, used) => reports.push([sessionId, used]),
	});
	const current = { op: "show", document } as const;
	assert.deepEqual(await ordinary(tool, current), receipts[0]);
	assert.deepEqual(await ordinary(tool, { ...current, revision: 1, newPane: false }), receipts[1]);
	assert.deepEqual(await ordinary(tool, current), receipts[2]);
	const uncertain = await ordinary(tool, { ...current, handle: nextHandle, newPane: false });
	assert.deepEqual(
		reports,
		[0, 1].map(() => ["original", { id: document, title: "Plan" }]),
		"each navigated show reports the document; stale and uncertain shows report nothing",
	);
	assert.equal(uncertain.status, "uncertain");
	assert.ok(String(uncertain.message).includes("Lost display acknowledgement."));
	assert.ok(!("argv" in uncertain));
	const follow = { op: "navigate", storeId, documentId: document };
	assert.deepEqual(
		calls,
		[
			follow,
			{ ...follow, revision: 1, digest: first },
			{ ...follow, currentRevision: 2 },
			{ ...follow, currentRevision: 2 },
		].map((action, i) => [i === 0 ? agent.handle : nextHandle, action]),
	);
});

test("ambiguous, obsolete and operator handles never authorise a fallback pane", async (t) => {
	const { store, document } = await fixture(t);
	const operator = pane("operator"),
		inventory = { panes: [operator, pane("agent"), pane("agent")], pending: [] };
	let dispatches = 0;
	const host = recipient(inventory, () => {
		dispatches++;
	});
	const tool = createLiveTool(async () => host, { store, connection: forbidden });
	const show = { op: "show", document } as const;
	for (const [request, status] of [
		[show, "busy"],
		[{ ...show, handle: operator.handle }, "error"],
		[{ ...show, handle: pane("agent").handle }, "closed"],
	] as const) {
		const result = await ordinary(tool, request);
		assert.equal(result.status, status);
		assert.ok(!("argv" in result));
	}
	const unavailable = await ordinary(
		createLiveTool(async () => host),
		show,
	);
	assert.equal(unavailable.status, "error");
	assert.ok(!("argv" in unavailable));
	assert.equal(dispatches, 0);
});

test("switching or shutting down the invoking ordinary session prevents navigation", async (t) => {
	const { store, document } = await fixture(t);
	const inventory = { panes: [pane("agent")], pending: [] };
	for (const change of ["switch", "shutdown"]) {
		const controller = new AbortController();
		let id = "original",
			effects = 0;
		const tool = createLiveTool(
			async () => {
				if (change === "switch") id = "another";
				else controller.abort(new Error("Session closed"));
				return recipient(inventory, () => {
					effects++;
				});
			},
			{
				store,
				lifecycle: () => controller.signal,
				connection: async () => {
					effects++;
					return forbidden();
				},
			},
		);
		const result = ordinary(
			tool,
			{ op: "show", document },
			ctx(() => id),
		);
		if (change === "shutdown") await assert.rejects(result, /Session closed/u);
		else {
			const refused = await result;
			assert.equal(refused.status, "error");
			assert.ok(!("argv" in refused));
		}
		assert.equal(effects, 0);
	}
});

async function launchFixture(t: TestContext, root: string) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const app = join(root, "Reader.app"),
		resources = join(app, "Contents", "Resources");
	await mkdir(resources, { recursive: true });
	await writeFile(
		join(resources, "build.json"),
		JSON.stringify({ contract: 1, pane: 1, paneProtocol: PANE_PROTOCOL, paneRevision: 1 }),
	);
	const server = new LiveBridge({ submit: async () => ({ status: "requested" }) });
	t.after(() => server.close());
	const live = await server.start();
	return { app, server, live };
}

async function post(live: LiveConfig, path: string, body: object) {
	const response = await fetch(live.endpoint + path, {
		method: "POST",
		headers: { authorization: `Bearer ${live.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(2000),
	});
	await response.body?.cancel();
	return response.status;
}

function privatePath(argv: unknown) {
	assert.ok(Array.isArray(argv));
	assert.equal(argv.at(-2), "--live");
	const path: unknown = argv.at(-1);
	assert.ok(typeof path === "string");
	return path;
}

test("only show accepts newPane, and true rejects an exact handle", async () => {
	const ordinaryTool = createLiveTool(forbidden);
	const nativeTool = createNativeLiveTool(Durable, forbidden);
	const show = { op: "show", document: `md-${"a".repeat(20)}` } as const;
	for (const tool of [ordinaryTool, nativeTool]) {
		const check = compile(tool.parameters).check;
		assert.ok(check({ ...show, newPane: true }));
		assert.ok(check({ ...show, newPane: false }));
		assert.equal(check({ ...show, newPane: "true" }), false);
	}
	for (const execute of [
		(input: Input) => ordinary(ordinaryTool, input),
		(input: Input) => native(nativeTool, input, task()),
	]) {
		for (const newPane of [false, true]) {
			const result = await execute({ op: "list", newPane });
			assert.equal(result.status, "error");
			assert.match(String(result.message), /Only show accepts newPane/u);
		}
		const result = await execute({ ...show, handle: pane("agent").handle, newPane: true });
		assert.equal(result.status, "error");
		assert.match(String(result.message), /not both/u);
	}
});

test("explicit new launches preserve connected panes and still use one pending reservation", {
	timeout: 10000,
}, async (t) => {
	const { root, store, storeId, document, first } = await fixture(t);
	const { app, server, live } = await launchFixture(t, root);
	const tool = createLiveTool(async () => server, { store, app, connection: async () => live });
	const durable = createNativeLiveTool(Durable, async () => server, { store, app, connection: async () => live });
	const { workspace, document: liveDocument, view, pid } = pane("agent");
	const original = await liveArguments(["reader"], live, { origin: "agent" });
	const binding = {
		workspace,
		document: liveDocument,
		view,
		pid,
		launchId: original.launchId,
		live: PANE_PROTOCOL,
		serial: 1,
	};
	assert.equal(await post(live, "/starting", binding), 200);
	assert.equal(await post(live, "/connect", binding), 200);
	const existing = server.list();
	assert.equal(existing.length, 1);
	assert.equal(existing[0].origin, "agent");
	await assert.rejects(liveArguments(["reader"], live, { origin: "agent", newPane: false }), /refused/u);

	const show = { op: "show", document, revision: 1, newPane: true } as const;
	const offer = await ordinary(tool, show);
	assert.equal(offer.status, "launch", String(offer.message));
	assert.equal(offer.documentId, document);
	assert.equal(offer.revision, 1);
	assert.ok(typeof offer.expiresAt === "number");
	assert.match(String(offer.message), /before \d{4}-\d{2}-\d{2}T/u);
	const path = privatePath(offer.argv);
	assert.deepEqual(offer.argv, [
		join(app, "Contents", "MacOS", "MarkdownReader"),
		"--pane",
		"--store",
		store.root,
		document,
		"--revision",
		"1",
		"--digest",
		first,
		"--live",
		path,
	]);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal(JSON.parse(await readFile(path, "utf8")).launchId, offer.launchId);
	assert.deepEqual(server.list(), existing);

	const pending = await native(durable, show, task());
	assert.equal(pending.status, "pending");
	assert.ok(!("argv" in pending));
	assert.deepEqual(pending.pending, [
		{
			status: "offered",
			origin: "agent",
			documentId: document,
			revision: 1,
			launchId: offer.launchId,
			expiresAt: offer.expiresAt,
		},
	]);
	await assert.rejects(liveArguments(["reader"], live, { origin: "agent", newPane: true }), /refused/u);
	assert.deepEqual(server.pendingLaunches(), pending.pending);

	const separate = {
		...binding,
		workspace: randomUUID(),
		document: randomUUID(),
		launchId: offer.launchId,
		view: {
			...view,
			kind: "published",
			mode: "reading",
			storeId,
			documentId: document,
			revision: 1,
			digest: first,
			follows: false,
		},
	};
	assert.equal(await post(live, "/starting", separate), 200);
	assert.equal(await post(live, "/connect", separate), 200);
	assert.equal(await post(live, "/connect", { ...separate, workspace: randomUUID() }), 410);
	await assert.rejects(stat(path), { code: "ENOENT" });
	assert.equal(server.list().length, 2);
	assert.deepEqual(server.list()[0], existing[0]);
	const ambiguous = await ordinary(tool, { ...show, newPane: false });
	assert.equal(ambiguous.status, "busy");

	const api = task();
	const another = await native(durable, show, api);
	assert.equal(another.status, "launch", String(another.message));
	const replay = await native(durable, show, api);
	assert.equal(replay.status, "uncertain");
	assert.ok(!("argv" in replay));
	assert.equal(server.pendingLaunches().length, 1);
});

test("an operator pane permits one initial agent offer, never a second argv on task recovery", {
	timeout: 10000,
}, async (t) => {
	const { root, store, document } = await fixture(t);
	const { app, server, live } = await launchFixture(t, root);
	const operator = pane("operator");
	let calls = 0;
	const host = {
		list: () => [operator],
		pendingLaunches: () => server.pendingLaunches(),
		execute: forbidden,
	} as unknown as LiveBridge;
	const tool = createNativeLiveTool(
		Durable,
		async (id) => {
			assert.equal(id, "original");
			calls++;
			return host;
		},
		{
			store,
			app,
			connection: async (id) => {
				assert.equal(id, "original");
				return live;
			},
		},
	);
	const show = { op: "show", document } as const,
		api = task();
	const offer = await native(tool, show, api);
	assert.equal(offer.status, "launch", String(offer.message));
	assert.ok(Array.isArray(offer.argv) && typeof offer.launchId === "string");
	const replay = await native(tool, show, api);
	assert.equal(replay.status, "uncertain");
	assert.ok(!("argv" in replay));
	assert.equal(calls, 1);
	const pending = async (status: "offered" | "launching") => {
		const again = await native(tool, show, task());
		assert.equal(again.status, "pending");
		assert.ok(!("argv" in again));
		assert.ok(Array.isArray(again.pending));
		assert.equal(again.pending.length, 1);
		const [row] = again.pending;
		assert.ok(isRecord(row));
		assert.equal(row.status, status);
		assert.equal(row.launchId, offer.launchId);
	};
	await pending("offered");
	assert.equal(await post(live, "/starting", { launchId: offer.launchId, pid: process.pid }), 200);
	await pending("launching");
});

test("an interrupted show never navigates a replacement pane on task recovery", async (t) => {
	const { store, document } = await fixture(t);
	const inventory = { panes: [pane("agent")], pending: [] };
	const dispatched: string[] = [];
	const host = recipient(inventory, (handle) => {
		dispatched.push(handle);
		return { status: "uncertain", message: "No page acknowledgement." };
	});
	const tool = createNativeLiveTool(Durable, async () => host, { store, connection: forbidden });
	const api = task((value) => {
		if (isRecord(value)) throw new Error("Interrupted before receipt commit");
	});
	const input = { op: "show", document } as const;
	const original = inventory.panes[0].handle;
	await assert.rejects(native(tool, input, api), /Interrupted before receipt commit/u);
	inventory.panes.splice(0, 1, pane("agent"));
	const recovered = await native(tool, input, api);
	assert.equal(recovered.status, "uncertain");
	assert.ok(!("argv" in recovered));
	assert.deepEqual(dispatched, [original]);
});

test("a completed comment change returns its exact saved receipt on task recovery", async () => {
	const original = pane("agent"),
		inventory = { panes: [original], pending: [] };
	const input = {
		op: "setComment",
		handle: original.handle,
		commentId: `${randomUUID()}:1`,
		expectedVersion: 6,
		commentState: "closed",
	} as const;
	const receipt = { status: "commentSet", commentId: input.commentId, commentState: "closed", version: 7 };
	const calls: unknown[] = [];
	const host = recipient(inventory, (handle, action) => {
		calls.push([handle, action]);
		return receipt;
	});
	const tool = createNativeLiveTool(Durable, async () => host),
		api = task();
	assert.deepEqual(await native(tool, input, api), receipt);
	inventory.panes.splice(0, 1, pane("agent"));
	assert.deepEqual(await native(tool, input, api), receipt);
	const { handle, ...action } = input;
	assert.deepEqual(calls, [[handle, action]]);
});

test("an edit in a pane that shows a stored document reports it; scratchpads and refusals report nothing", async (t) => {
	const { store, storeId, document } = await fixture(t);
	const stored = {
		...pane("agent"),
		view: {
			kind: "published" as const,
			mode: "writing" as const,
			title: "Plan",
			dirty: false,
			conflict: false,
			storeId,
			documentId: document,
			revision: 2,
		},
	};
	const scratch = pane("agent");
	const inventory = { panes: [stored, scratch], pending: [] };
	let refuse = false;
	const host = recipient(inventory, () =>
		refuse
			? { status: "stale", message: "The buffer changed." }
			: { status: "applied", generation: 2, digest: "next", retained: true },
	);
	const reports: unknown[] = [];
	const tool = createLiveTool(async () => host, {
		store,
		connection: forbidden,
		workReference: (sessionId, used) => reports.push([sessionId, used]),
	});
	const edit = (handle: string): Input => ({
		op: "apply",
		handle,
		operationId: randomUUID(),
		baseGeneration: 1,
		baseDigest: responseDigest("Draft two"),
		edits: [{ start: 0, end: 1, expected: "D", replacement: "d" }],
	});
	assert.equal((await ordinary(tool, edit(stored.handle))).status, "applied");
	assert.equal((await ordinary(tool, edit(scratch.handle))).status, "applied");
	refuse = true;
	assert.notEqual((await ordinary(tool, edit(stored.handle))).status, "applied");
	assert.deepEqual(reports, [["original", { id: document, title: "Plan" }]]);
});
