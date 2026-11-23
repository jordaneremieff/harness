import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { LiveBridge, LiveBridges, type PaneClosure } from "./live-bridge.ts";
import {
	readLiveAction,
	readLiveConfig,
	readLiveResult,
	type LiveConfig,
	type LiveBinding,
	type LiveCommand,
	type LiveState,
} from "./live-protocol.ts";
import { connectTestPane } from "./test-live-pane.mts";
import { responseDigest, SOURCE_BYTES } from "./responses.ts";
const binding = () => ({ workspace: randomUUID().toUpperCase(), document: randomUUID().toUpperCase() });
async function post(config: LiveConfig, path: string, body: unknown, headers: Record<string, string> = {}) {
	const result = await fetch(config.endpoint + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}`, ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5000),
	});
	return responseData(result);
}
async function connect(config: LiveConfig, pane: LiveBinding, overrides?: object) {
	return responseData(await connectTestPane(config, pane, overrides));
}
async function responseData(result: Response) {
	return {
		status: result.status,
		data: (await result.json()) as {
			handle: string;
			command: LiveCommand;
			state: LiveState;
			status: string;
			retryable?: boolean;
			message?: string;
		},
	};
}
test("the broker binds prompts and unsaved reads to one authenticated conversation", { timeout: 10000 }, async () => {
	const calls: string[] = [];
	const bridge = new LiveBridge({
		submit: async (text) => {
			calls.push(text);
			return { status: "admitted", submissionId: "7" };
		},
	});
	const config = await bridge.start();
	const pane = binding();
	try {
		assert.equal((await post(config, "/connect", pane, { Origin: "http://other.invalid" })).status, 403);
		assert.equal((await post({ ...config, token: "0".repeat(64) }, "/connect", pane)).status, 403);
		const connected = await connect(config, pane);
		const handle = connected.data.handle;
		const operationId = randomUUID();
		const prompt = { ...pane, operationId, text: "Fix this paragraph." };
		assert.deepEqual((await post(config, "/prompt", prompt)).data, { ok: true, status: "admitted", submissionId: "7" });
		await post(config, "/prompt", prompt);
		assert.equal(calls.length, 1);
		assert.match(calls[0], new RegExp(handle));
		assert.equal((await post(config, "/prompt", { ...prompt, text: "Different" })).data.status, "rejected");
		const read = bridge.execute(handle, { op: "read" });
		const command = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		assert.equal(command.op, "read");
		const source = "# Unsaved 😀\n";
		const result = { status: "ok", source, generation: 2, digest: responseDigest(source), assets: [] };
		assert.equal((await post(config, "/result", { ...pane, requestId: command.requestId, result })).status, 200);
		assert.deepEqual(await read, result);
		assert.equal((await post(config, "/result", { ...pane, requestId: command.requestId, result })).status, 200);
		assert.equal((await post(config, "/poll", { ...pane, document: randomUUID(), after: 0 })).status, 409);
	} finally {
		bridge.close();
	}
});
test("a new loader keeps the listener but fences unknown receipts until its reader reports its view", {
	timeout: 10000,
}, async () => {
	let submissions = 0;
	const submit = async () => {
		submissions++;
		return { status: "requested" as const };
	};
	const old = new LiveBridge({ submit }),
		current = new LiveBridge({ submit });
	const config = await old.start(),
		pane = binding();
	try {
		await connect(config, pane);
		const prompt = { ...pane, operationId: randomUUID(), text: "Where was the first request admitted?" };
		assert.equal((await post(config, "/prompt", prompt)).data.status, "requested");
		const record = old.release();
		assert.ok(record);
		Object.assign(record.state, { version: 2 });
		assert.equal((await post(config, "/prompt", { ...prompt, operationId: randomUUID() })).status, 503);
		const adopted = await current.start(record);
		assert.equal(adopted.endpoint, config.endpoint);
		assert.equal(adopted.token, config.token);
		assert.deepEqual(current.list(), []);
		assert.equal((await connect(config, pane)).status, 200);
		assert.equal((await post(config, "/prompt", prompt)).data.status, "uncertain");
		assert.equal(submissions, 1);
		assert.equal((await post(config, "/prompt", { ...prompt, operationId: randomUUID() })).data.status, "requested");
		assert.equal(submissions, 2);
		const unknown = current.release();
		assert.ok(unknown);
		Object.assign(unknown, { version: 2 });
		await assert.rejects(new LiveBridge({ submit }).start(unknown), /Reopen/u);
		assert.equal(unknown.server.listening, false);
	} finally {
		old.close();
		current.close();
	}
});

test("the broker forwards a large batch as one prompt and enforces the UTF-8 limit", { timeout: 10000 }, async () => {
	const calls: string[] = [];
	const bridge = new LiveBridge({
		submit: async (text) => {
			calls.push(text);
			return { status: "requested" };
		},
	});
	const config = await bridge.start(),
		pane = binding();
	try {
		await connect(config, pane);
		const text = "😀".repeat(32768);
		const request = { ...pane, operationId: randomUUID(), text };
		assert.equal((await post(config, "/prompt", request)).data.status, "requested");
		assert.equal((await post(config, "/prompt", request)).data.status, "requested");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].slice(-text.length), text);
		const refusal = await post(config, "/prompt", { ...request, operationId: randomUUID(), text: `${text}!` });
		assert.equal(refusal.data.status, "rejected");
		assert.equal(calls.length, 1);
	} finally {
		bridge.close();
	}
});

test("uncertain edits retain their ID and reconcile a lost acknowledgement without a second edit", {
	timeout: 10000,
}, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 100);
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await connect(config, pane)).data.handle;
		const action = {
			op: "apply" as const,
			operationId: randomUUID(),
			baseGeneration: 0,
			baseDigest: responseDigest("old"),
			edits: [{ start: 0, end: 3, expected: "old", replacement: "new" }],
		};
		const first = bridge.execute(handle, action);
		const command = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		assert.equal((await first).status, "uncertain");
		const repeated = bridge.execute(handle, action);
		const redelivery = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		assert.deepEqual(redelivery, command);
		const result = {
			status: "applied",
			operationId: action.operationId,
			generation: 1,
			digest: responseDigest("new"),
			retained: true,
		};
		await post(config, "/result", { ...pane, requestId: command.requestId, result });
		assert.deepEqual(await repeated, result);
		assert.deepEqual(await bridge.execute(handle, action), result);
		await assert.rejects(
			bridge.execute(handle, { ...action, edits: [{ ...action.edits[0], replacement: "other" }] }),
			/different live edit/u,
		);
		assert.equal(
			(await post(config, "/result", { ...pane, requestId: command.requestId, result: { ...result, retained: false } }))
				.status,
			409,
		);
	} finally {
		bridge.close();
	}
});
test("selection deactivates a handle without retiring its prompt receipts, while close retires it", {
	timeout: 10000,
}, async () => {
	const registry = new LiveBridges();
	let submitted = 0;
	const bridge = await registry.get("exact", () => ({
		submit: async () => {
			submitted++;
			return { status: "requested" };
		},
	}));
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await connect(config, pane)).data.handle;
		const prompt = { ...pane, operationId: randomUUID(), text: "Keep this request" };
		await post(config, "/prompt", prompt);
		const waiting = bridge.execute(handle, { op: "read" });
		const other = { ...pane, document: randomUUID() };
		await connect(config, other);
		assert.equal((await waiting).status, "closed");
		assert.equal((await bridge.execute(handle, { op: "read" })).status, "closed");
		bridge.publish("answer", "Answer while deselected", prompt.operationId);
		const deselected = (await post(config, "/poll", { ...other, after: 0 })).data.state;
		assert.equal(deselected.text, "Answer while deselected");
		assert.equal(deselected.operationId, prompt.operationId);
		assert.equal(deselected.document, pane.document);
		const separate = binding();
		const separateHandle = (await connect(config, separate)).data.handle;
		const separateRead = bridge.execute(separateHandle, { op: "read" });
		const separatePoll = (await post(config, "/poll", { ...separate, after: 0 })).data;
		assert.equal(separatePoll.state.status, "idle");
		assert.equal(separatePoll.state.text, "");
		await post(config, "/close", { ...separate, pane: true });
		await separateRead;
		assert.equal((await connect(config, pane)).status, 200);
		await post(config, "/prompt", prompt);
		assert.equal(submitted, 1);
		await connect(config, other);
		assert.equal((await post(config, "/close", pane)).status, 200, "a deselected document can close");
		assert.equal((await post(config, "/close", pane)).status, 200, "close is idempotent");
		assert.equal((await connect(config, pane)).status, 409, "a closed document never reconnects by its old identity");
		assert.equal(bridge.list()[0].handle, `${other.workspace}:${other.document}`);
		registry.close();
		await assert.rejects(
			registry.get("exact", () => ({ submit: async () => ({ status: "requested" }) })),
			/host closed/u,
		);
	} finally {
		registry.close();
	}
});
test("a delivered edit stays uncertain through selection and accepts its original receipt on return", {
	timeout: 10000,
}, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 2000);
	const config = await bridge.start();
	const pane = binding();
	const other = { ...pane, document: randomUUID() };
	try {
		const handle = (await connect(config, pane)).data.handle;
		const action = {
			op: "apply" as const,
			operationId: randomUUID(),
			baseGeneration: 0,
			baseDigest: responseDigest("old"),
			edits: [{ start: 0, end: 3, expected: "old", replacement: "new" }],
		};
		const first = bridge.execute(handle, action);
		const command = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		const result = {
			status: "applied",
			operationId: action.operationId,
			generation: 1,
			digest: responseDigest("new"),
			retained: true,
		};
		const receipt = { requestId: command.requestId, result };
		await connect(config, other);
		assert.equal((await first).status, "uncertain");
		assert.equal((await bridge.execute(handle, action)).status, "uncertain");
		assert.equal((await post(config, "/result", { ...pane, ...receipt })).status, 409);
		await post(config, "/result", { ...other, ...receipt });
		await connect(config, pane);
		assert.equal((await post(config, "/result", { ...pane, ...receipt })).status, 200);
		assert.deepEqual(await bridge.execute(handle, action), result);
	} finally {
		bridge.close();
	}
});

test("a retry after selection redelivers the exact unconfirmed command", { timeout: 10000 }, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 2000, 500);
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await connect(config, pane)).data.handle;
		const action = {
			op: "apply" as const,
			operationId: randomUUID(),
			baseGeneration: 0,
			baseDigest: responseDigest("old"),
			edits: [{ start: 0, end: 3, expected: "old", replacement: "new" }],
		};
		const first = bridge.execute(handle, action);
		const command = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		await connect(config, { ...pane, document: randomUUID() });
		await first;
		await connect(config, pane);
		assert.equal(
			(await post(config, "/poll", { ...pane, after: 0 })).data.command,
			null,
			"reconnection is not a retry",
		);
		const repeated = bridge.execute(handle, action);
		assert.deepEqual((await post(config, "/poll", { ...pane, after: 0 })).data.command, command);
		const result = {
			status: "applied",
			operationId: action.operationId,
			generation: 1,
			digest: responseDigest("new"),
			retained: true,
		};
		assert.equal((await post(config, "/result", { ...pane, requestId: command.requestId, result })).status, 200);
		assert.deepEqual(await repeated, result);
	} finally {
		bridge.close();
	}
});

test("failed connection startup permits a fresh route without retaining a rejected registry entry", {
	timeout: 10000,
}, async () => {
	const registry = new LiveBridges();
	try {
		await assert.rejects(
			registry.get("exact", () => ({
				submit: async () => ({ status: "requested" }),
				observe: async () => {
					throw new Error("Temporary observation failure");
				},
			})),
			/progress connection failed/u,
		);
		assert.equal(await registry.find("exact"), undefined);
		const bridge = await registry.get("exact", () => ({ submit: async () => ({ status: "requested" }) }));
		assert.equal(await registry.find("exact"), bridge);
		assert.equal((await connect(await bridge.start(), binding())).status, 200);
	} finally {
		registry.close();
	}
});
test("failed idempotent admission retries the same ID but ordinary uncertainty never resubmits", {
	timeout: 10000,
}, async () => {
	for (const retryFailedSubmission of [true, false]) {
		const ids: string[] = [];
		const bridge = new LiveBridge({
			retryFailedSubmission,
			submit: async (_text, id) => {
				ids.push(id);
				if (ids.length === 1) throw new Error("Admission response unavailable");
				return { status: "admitted", submissionId: "7" };
			},
		});
		const config = await bridge.start();
		try {
			const pane = binding();
			await connect(config, pane);
			const prompt = { ...pane, operationId: randomUUID(), text: "An exact request" };
			const first = (await post(config, "/prompt", prompt)).data;
			assert.equal(first.status, "uncertain");
			assert.equal(first.retryable, retryFailedSubmission);
			const retry = (await post(config, "/prompt", prompt)).data;
			assert.equal(retry.status, retryFailedSubmission ? "admitted" : "uncertain");
			await post(config, "/prompt", prompt);
			assert.deepEqual(ids, retryFailedSubmission ? [prompt.operationId, prompt.operationId] : [prompt.operationId]);
		} finally {
			bridge.close();
		}
	}
});
test("definite prompt rejection is a final receipt without another admission attempt", { timeout: 10000 }, async () => {
	let submitted = 0;
	const bridge = new LiveBridge({
		retryFailedSubmission: true,
		submit: async () => {
			submitted++;
			return { status: "rejected", message: "No admission was attempted." };
		},
	});
	const config = await bridge.start();
	try {
		const pane = binding();
		await connect(config, pane);
		const prompt = { ...pane, operationId: randomUUID(), text: "A rejected request" };
		assert.equal((await post(config, "/prompt", prompt)).data.status, "rejected");
		assert.equal((await post(config, "/prompt", prompt)).data.status, "rejected");
		assert.equal(submitted, 1);
	} finally {
		bridge.close();
	}
});
test("timed-out reads release queue slots and late replies do not block a healthy pane", {
	timeout: 10000,
}, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 50);
	const config = await bridge.start();
	try {
		const lost = binding(),
			healthy = binding();
		const handle = (await connect(config, lost)).data.handle;
		const other = (await connect(config, healthy)).data.handle;
		const pending = bridge.execute(handle, { op: "read" });
		const command = (await post(config, "/poll", { ...lost, after: 0 })).data.command;
		assert.equal((await pending).status, "error");
		for (let count = 0; count < 17; count++) {
			const result = await bridge.execute(handle, { op: "read" });
			assert.equal(result.status, "error");
			assert.ok("message" in result && result.message.includes("Retry the read"));
		}
		assert.equal(
			(
				await post(config, "/result", {
					...lost,
					requestId: command.requestId,
					result: { status: "error", message: "Late read" },
				})
			).status,
			200,
		);
		const read = bridge.execute(other, { op: "read" });
		const next = (await post(config, "/poll", { ...healthy, after: 0 })).data.command;
		await post(config, "/result", {
			...healthy,
			requestId: next.requestId,
			result: { status: "ok", source: "healthy", generation: 0, digest: responseDigest("healthy"), assets: [] },
		});
		assert.equal((await read).status, "ok");
	} finally {
		bridge.close();
	}
});
test("native source integrity, retention and edit bounds fail without truncation", () => {
	assert.throws(
		() => readLiveConfig({ version: 1, endpoint: "http://localhost:1234", token: "0".repeat(64) }),
		/Invalid/u,
	);
	assert.throws(
		() => readLiveConfig({ version: 1, endpoint: "http://127.0.0.1:99999", token: "0".repeat(64) }),
		/Invalid/u,
	);
	const source = "\u0000".repeat(SOURCE_BYTES);
	assert.equal(
		readLiveResult({ status: "ok", source, generation: 0, digest: responseDigest(source), assets: [] }, { op: "read" })
			.status,
		"ok",
	);
	assert.throws(
		() =>
			readLiveResult(
				{ status: "ok", source: `${source}x`, generation: 0, digest: responseDigest(`${source}x`), assets: [] },
				{ op: "read" },
			),
		/failed/u,
	);
	assert.throws(
		() =>
			readLiveResult(
				{ status: "ok", source: "wrong", generation: 0, digest: responseDigest("other"), assets: [] },
				{ op: "read" },
			),
		/failed/u,
	);
	const action = {
		op: "apply",
		operationId: randomUUID(),
		baseGeneration: 0,
		baseDigest: responseDigest("old"),
		edits: [{ start: 0, end: 2, expected: "old", replacement: "new" }],
	};
	assert.throws(() => readLiveAction(action), /UTF-16/u);
});
test("the host refuses older pane versions and preserves exact claim and release receipts", {
	timeout: 10000,
}, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) });
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await connect(config, pane)).data.handle;
		const claim = {
			op: "claim" as const,
			baseGeneration: 4,
			baseDigest: responseDigest("exact"),
			ranges: [{ start: 0, end: 5 }],
			label: "Revise passage",
		};
		for (const live of [undefined, 1, 2]) assert.equal((await post(config, "/connect", { ...pane, live })).status, 426);
		assert.equal(bridge.list()[0].live, 3);
		const claimId = randomUUID();
		const results = [
			{
				status: "busy",
				message:
					"The person has this passage open for writing (UTF-16 0–5). Read again after they leave it, or edit elsewhere.",
			},
			{ status: "stale", message: "The base changed." },
			{ status: "claimed", claimId, expiresAt: Date.now() + 90000 },
		];
		for (const result of results) {
			const waiting = bridge.execute(handle, claim);
			const command = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
			assert.deepEqual(command, { ...pane, ...claim, requestId: command.requestId });
			assert.equal((await post(config, "/result", { ...pane, requestId: command.requestId, result })).status, 200);
			assert.deepEqual(await waiting, result);
		}
		const release = bridge.execute(handle, { op: "release", claimId });
		const command = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		assert.equal(command.op, "release");
		assert.ok(command.op === "release" && command.claimId === claimId);
		assert.equal(
			(
				await post(config, "/result", {
					...pane,
					requestId: command.requestId,
					result: { status: "released", claimId: randomUUID() },
				})
			).status,
			409,
		);
		await post(config, "/result", { ...pane, requestId: command.requestId, result: { status: "released", claimId } });
		assert.deepEqual(await release, { status: "released", claimId });
	} finally {
		bridge.close();
	}
});
test("unconfirmed claims release queue slots without changing apply retry identities", { timeout: 10000 }, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 10);
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await connect(config, pane)).data.handle;
		for (let index = 0; index < 17; index++) {
			const result = await bridge.execute(handle, {
				op: "claim",
				baseGeneration: 0,
				baseDigest: responseDigest("x"),
				ranges: [{ start: 0, end: 1 }],
			});
			assert.equal(result.status, "uncertain");
		}
		const controller = new AbortController();
		const waiting = bridge.execute(handle, { op: "release", claimId: randomUUID() }, controller.signal);
		controller.abort();
		assert.equal((await waiting).status, "uncertain");
	} finally {
		bridge.close();
	}
});
test("claim and release decoders check bases, UTF-16 ranges, labels and receipts", () => {
	const claim = {
		op: "claim" as const,
		baseGeneration: 0,
		baseDigest: responseDigest("🧭text"),
		ranges: [
			{ start: 0, end: 2 },
			{ start: 2, end: 6 },
		],
		label: "a".repeat(80),
	};
	assert.deepEqual(readLiveAction(claim), claim);
	for (const invalid of [
		{ baseGeneration: -1 },
		{ baseGeneration: Number.MAX_SAFE_INTEGER + 1 },
		{ baseDigest: "bad" },
		{ ranges: [] },
		{ ranges: Array.from({ length: 17 }, (_, i) => ({ start: i, end: i + 1 })) },
		{ ranges: [{ start: 1, end: 0 }] },
		{
			ranges: [
				{ start: 0, end: 2 },
				{ start: 1, end: 3 },
			],
		},
		{ ranges: [{ start: 0.5, end: 1 }] },
		{ ranges: [{ start: 0, end: Infinity }] },
		{ label: "a".repeat(81) },
		{ label: "bad\nlabel" },
		{ label: "\uD800" },
	])
		assert.throws(() => readLiveAction({ ...claim, ...invalid }));
	assert.throws(() => readLiveAction({ op: "release", claimId: "bad" }));
	const claimId = randomUUID();
	assert.deepEqual(readLiveAction({ op: "release", claimId }), { op: "release", claimId });
	assert.deepEqual(readLiveResult({ status: "claimed", claimId, expiresAt: 90000 }, claim), {
		status: "claimed",
		claimId,
		expiresAt: 90000,
	});
	for (const invalid of [
		{ claimId: "bad" },
		{ expiresAt: 0 },
		{ expiresAt: 1.5 },
		{ expiresAt: Number.MAX_SAFE_INTEGER + 1 },
	])
		assert.throws(() => readLiveResult({ status: "claimed", claimId, expiresAt: 90000, ...invalid }, claim));
	assert.throws(() => readLiveResult({ status: "released", claimId }, claim));
	assert.throws(() => readLiveResult({ status: "claimed", claimId, expiresAt: 90000 }, { op: "read" }));
	assert.deepEqual(readLiveResult({ status: "uncertain", message: "No receipt." }, claim), {
		status: "uncertain",
		message: "No receipt.",
	});
});
test("a live poll wakes on progress and cancelled commands do not dispatch", { timeout: 10000 }, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) });
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await connect(config, pane)).data.handle;
		const readController = new AbortController();
		const read = bridge.execute(handle, { op: "read" }, readController.signal);
		readController.abort();
		assert.equal((await read).status, "uncertain");
		assert.equal((await post(config, "/poll", { ...pane, after: 1 })).data.state.text, "");
		const operationId = randomUUID();
		await post(config, "/prompt", { ...pane, operationId, text: "Ask about this buffer." });
		const polling = post(config, "/poll", { ...pane, after: 1 });
		bridge.publish("answer", "Current answer", operationId);
		const result = await polling;
		assert.equal(result.data.command, null);
		assert.equal(result.data.state.text, "Current answer");
		assert.equal(result.data.state.operationId, operationId);
	} finally {
		bridge.close();
	}
});
test("a slow reader receives each question's answer even if another question finishes between polls", async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) });
	const config = await bridge.start(),
		pane = binding();
	const first = randomUUID(),
		second = randomUUID();
	try {
		await connect(config, pane);
		for (const operationId of [first, second])
			await post(config, "/prompt", { ...pane, operationId, text: "Explain." });
		bridge.publish("working", "Earlier progress", first);
		bridge.publish("answer", "First answer", first);
		bridge.publish("answer", "Second answer", second);
		const a = (await post(config, "/poll", { ...pane, after: 0 })).data.state;
		assert.deepEqual([a.operationId, a.text], [first, "First answer"]);
		const b = (await post(config, "/poll", { ...pane, after: a.sequence })).data.state;
		assert.deepEqual([b.operationId, b.text], [second, "Second answer"]);
	} finally {
		bridge.close();
	}
});
test("an explicit identical edit retry restores delivery after an aborted lost-poll wait", {
	timeout: 10000,
}, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) });
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await connect(config, pane)).data.handle;
		const action = {
			op: "apply" as const,
			operationId: randomUUID(),
			baseGeneration: 0,
			baseDigest: responseDigest("old"),
			edits: [{ start: 0, end: 3, expected: "old", replacement: "new" }],
		};
		const controller = new AbortController();
		const first = bridge.execute(handle, action, controller.signal);
		const lost = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		controller.abort();
		assert.equal((await first).status, "uncertain");
		const retry = bridge.execute(handle, action);
		const delivered = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		assert.deepEqual(delivered, lost);
		await post(config, "/result", {
			...pane,
			requestId: delivered.requestId,
			result: { status: "error", message: "Applied locally; retention failed. Retry this operation." },
		});
		assert.equal((await retry).status, "error");
		const retentionRetry = bridge.execute(handle, action);
		const retained = (await post(config, "/poll", { ...pane, after: 0 })).data.command;
		assert.equal(retained.op, "apply");
		assert.ok(retained.op === "apply" && retained.operationId === action.operationId);
		await post(config, "/result", {
			...pane,
			requestId: retained.requestId,
			result: {
				status: "applied",
				operationId: action.operationId,
				generation: 1,
				digest: responseDigest("new"),
				retained: true,
			},
		});
		assert.equal((await retentionRetry).status, "applied");
	} finally {
		bridge.close();
	}
});
/** A bridge that records each settled pane closure; `next` resolves with the following report. */
function closureBridge(graceMs: number) {
	const reports: PaneClosure[] = [];
	let notify: (() => void) | undefined;
	const bridge = new LiveBridge(
		{
			submit: async () => ({ status: "requested" }),
			panesClosed: (closure) => {
				reports.push(closure);
				notify?.();
			},
		},
		undefined,
		undefined,
		graceMs,
	);
	const next = () =>
		new Promise<PaneClosure>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("No pane closure was reported.")), 2000);
			const seen = reports.length;
			notify = () => {
				if (reports.length === seen) return;
				clearTimeout(timer);
				notify = undefined;
				resolve(reports[seen]);
			};
		});
	return { bridge, reports, next };
}
const settled = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("a pane that closes and stays away is reported once with the panes that remain", { timeout: 10000 }, async () => {
	const { bridge, reports, next } = closureBridge(30);
	const config = await bridge.start();
	const [first, second] = [binding(), binding()];
	try {
		await connect(config, first);
		await connect(config, second);
		const [firstPane, secondPane] = [first, second].map((x) =>
			bridge.list().find((entry) => entry.workspace === x.workspace),
		);
		let report = next();
		await post(config, "/close", first);
		assert.equal(bridge.list().length, 1, "the count drops at once; only the report waits");
		assert.deepEqual(await report, { closed: 1, connected: 1, panes: [firstPane] });
		report = next();
		await post(config, "/close", second);
		assert.deepEqual(await report, { closed: 1, connected: 0, panes: [secondPane] });
		await settled(100);
		assert.equal(reports.length, 2);
	} finally {
		bridge.close();
	}
});
test("a pane that switches documents is not reported as closed", { timeout: 10000 }, async () => {
	const { bridge, reports } = closureBridge(30);
	const config = await bridge.start();
	const pane = binding();
	try {
		await connect(config, pane);
		// A pane closes its shown document and connects the next one at once.
		await post(config, "/close", pane);
		await connect(config, { ...pane, document: randomUUID().toUpperCase() });
		await settled(150);
		assert.deepEqual(reports, []);
		assert.equal(bridge.list().length, 1);
	} finally {
		bridge.close();
	}
});
test("panes that close together are reported together", { timeout: 10000 }, async () => {
	const { bridge, reports, next } = closureBridge(60);
	const config = await bridge.start();
	const panes = [binding(), binding(), binding()];
	try {
		for (const pane of panes) await connect(config, pane);
		const departed = panes.slice(0, 2).map((x) => bridge.list().find((entry) => entry.workspace === x.workspace));
		const report = next();
		await post(config, "/close", panes[0]);
		await post(config, "/close", panes[1]);
		const closed = await report;
		assert.equal(closed.closed, 2);
		assert.equal(closed.connected, 1);
		assert.deepEqual(new Set(closed.panes), new Set(departed));
		await settled(150);
		assert.equal(reports.length, 1);
	} finally {
		bridge.close();
	}
});
test("closing the conversation's bridge reports no pane closure", { timeout: 10000 }, async () => {
	const { bridge, reports } = closureBridge(30);
	const config = await bridge.start();
	const pane = binding();
	await connect(config, pane);
	await post(config, "/close", pane);
	bridge.close();
	await settled(150);
	assert.deepEqual(reports, []);
});
test("a route that refuses the closure report leaves the bridge working", { timeout: 10000 }, async () => {
	let calls = 0;
	const bridge = new LiveBridge(
		{
			submit: async () => ({ status: "requested" }),
			panesClosed: () => {
				calls++;
				throw new Error("The conversation is gone.");
			},
		},
		undefined,
		undefined,
		20,
	);
	const config = await bridge.start();
	const pane = binding();
	try {
		await connect(config, pane);
		await post(config, "/close", pane);
		await settled(150);
		assert.equal(calls, 1);
		const other = binding();
		assert.equal((await connect(config, other)).status, 200);
		assert.equal(bridge.list().length, 1);
	} finally {
		bridge.close();
	}
});

const target = {
	storeId: "a".repeat(32),
	documentId: `md-${"b".repeat(20)}`,
	revision: 2,
	digest: responseDigest("Published revision"),
};
const navigate = { op: "navigate" as const, ...target };
const shown = {
	kind: "published",
	title: "Target",
	mode: "reading",
	dirty: false,
	conflict: false,
	follows: false,
	...target,
};

test("only the original agent pane and exact target receipt confirm navigation", { timeout: 10000 }, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 2000, 50);
	const config = await bridge.start();
	const operator = binding(),
		source = binding(),
		destination = { ...source, document: randomUUID() };
	try {
		const operatorHandle = (await connect(config, operator)).data.handle;
		const denied = await bridge.execute(operatorHandle, navigate);
		assert.equal(denied.status, "error");
		assert.equal((await post(config, "/poll", { ...operator, after: 0 })).data.command, null);

		const launchId = randomUUID();
		const original = (await connect(config, source, { origin: "agent", launchId })).data.handle;
		const before = bridge.list().find((pane) => pane.handle === original);
		assert.ok(before);
		const reconnect = { ...source, launchId, pid: process.pid, live: 3, serial: 2, view: before.view };
		for (const changed of [{ launchId: randomUUID() }, { pid: process.ppid }]) {
			assert.equal((await post(config, "/connect", { ...reconnect, ...changed })).status, 409);
		}
		const draft = { ...before.view, dirty: true };
		assert.equal((await post(config, "/state", { ...source, serial: 3, view: draft })).status, 200);
		await post(config, "/state", { ...source, serial: 2, view: before.view });
		assert.deepEqual(bridge.list().find((pane) => pane.handle === original)?.view, draft);
		await post(config, "/state", { ...source, serial: 4, view: before.view });

		const pending = bridge.execute(original, navigate);
		const command = (await post(config, "/poll", { ...source, after: 0 })).data.command;
		assert.deepEqual(command, { ...source, ...navigate, requestId: command.requestId });
		const handle = `${destination.workspace}:${destination.document}`;
		const result = { status: "navigated", ...destination, handle, view: shown };
		const receipt = { requestId: command.requestId, serial: 5, result };
		await post(config, "/result", { ...operator, ...receipt });
		assert.ok(bridge.list().some((pane) => pane.handle === original));
		assert.equal(
			(await post(config, "/result", { ...source, ...receipt, result: { ...result, view: { ...shown, revision: 1 } } }))
				.status,
			409,
		);
		assert.ok(bridge.list().some((pane) => pane.handle === original));
		assert.equal((await post(config, "/result", { ...source, ...receipt })).status, 200);
		assert.deepEqual(await pending, result);
		assert.equal((await post(config, "/result", { ...source, ...receipt })).status, 200);
		assert.equal((await post(config, "/state", { ...source, view: draft, serial: 6 })).status, 409);
		await post(config, "/connect", reconnect);
		const installed = bridge.list().find((pane) => pane.workspace === source.workspace);
		assert.equal(installed?.handle, handle);
		assert.deepEqual(installed?.view, shown);
		assert.equal(installed?.origin, "agent");
		assert.equal(installed?.pid, process.pid);
		assert.ok(Number.isSafeInteger(installed?.reportedAt));
		assert.equal((await bridge.execute(original, { op: "read" })).status, "closed");
	} finally {
		bridge.close();
	}
});

test("a pane departure distinguishes undelivered navigation from a lost receipt", { timeout: 10000 }, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 2000, 40);
	const config = await bridge.start();
	try {
		for (const delivered of [false, true]) {
			const source = binding(),
				other = { ...source, document: randomUUID() };
			const handle = (await connect(config, source, { origin: "agent" })).data.handle;
			const pending = bridge.execute(handle, navigate);
			if (delivered) assert.equal((await post(config, "/poll", { ...source, after: 0 })).data.command.op, "navigate");
			await connect(config, other);
			assert.equal((await pending).status, delivered ? "uncertain" : "closed");
			assert.equal((await post(config, "/poll", { ...other, after: 0 })).data.command, null);
			await connect(config, source);
			assert.equal((await post(config, "/poll", { ...source, after: 0 })).data.command, null);
			await post(config, "/close", { ...source, pane: true });
		}
	} finally {
		bridge.close();
	}
});

test("a killed reader releases a delivered edit without another poll or command timeout", {
	timeout: 6000,
}, async () => {
	const { bridge, next } = closureBridge(20);
	const config = await bridge.start();
	const reader = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	const exit = once(reader, "exit");
	const pane = binding();
	try {
		await once(reader, "spawn");
		const handle = (await connect(config, pane, { pid: reader.pid })).data.handle;
		const pending = bridge.execute(handle, {
			op: "apply",
			operationId: randomUUID(),
			baseGeneration: 0,
			baseDigest: responseDigest("x"),
			edits: [{ start: 0, end: 1, expected: "x", replacement: "y" }],
		});
		assert.equal((await post(config, "/poll", { ...pane, after: 0 })).data.command.op, "apply");
		const closure = next();
		reader.kill("SIGKILL");
		const [outcome, closed] = await Promise.all([pending, closure]);
		assert.equal(outcome.status, "uncertain");
		assert.equal(closed.panes[0]?.handle, handle);
		assert.equal(closed.panes[0]?.pid, reader.pid);
		assert.equal(closed.connected, 0);
		assert.deepEqual(bridge.list(), []);
	} finally {
		reader.kill();
		await exit;
		bridge.close();
	}
});
