import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { LiveBridge, LiveBridges } from "./live-bridge.ts";
import {
	readLiveAction,
	readLiveConfig,
	readLiveResult,
	type LiveConfig,
	type LiveCommand,
	type LiveState,
} from "./live-protocol.ts";
import { responseDigest, SOURCE_BYTES } from "./responses.ts";
const binding = () => ({ workspace: randomUUID().toUpperCase(), document: randomUUID().toUpperCase() });
async function post(config: LiveConfig, path: string, body: unknown, headers: Record<string, string> = {}) {
	const result = await fetch(config.endpoint + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}`, ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5000),
	});
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
		const connected = await post(config, "/connect", pane);
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
test("uncertain edits retain their ID and reconcile a lost acknowledgement without a second edit", {
	timeout: 10000,
}, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) }, 100);
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await post(config, "/connect", pane)).data.handle;
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
		const handle = (await post(config, "/connect", pane)).data.handle;
		const prompt = { ...pane, operationId: randomUUID(), text: "Keep this request" };
		await post(config, "/prompt", prompt);
		const waiting = bridge.execute(handle, { op: "read" });
		const other = { ...pane, document: randomUUID() };
		await post(config, "/connect", other);
		assert.equal((await waiting).status, "closed");
		assert.equal((await bridge.execute(handle, { op: "read" })).status, "closed");
		bridge.publish("answer", "Answer while deselected", prompt.operationId);
		assert.equal((await post(config, "/connect", pane)).status, 200);
		const deselected = (await post(config, "/poll", { ...pane, after: 0 })).data.state;
		assert.equal(deselected.text, "Answer while deselected");
		assert.equal(deselected.operationId, prompt.operationId);
		await post(config, "/prompt", prompt);
		assert.equal(submitted, 1);
		await post(config, "/connect", other);
		assert.equal((await post(config, "/close", pane)).status, 200, "a deselected document can close");
		assert.equal((await post(config, "/close", pane)).status, 200, "close is idempotent");
		assert.equal(
			(await post(config, "/connect", pane)).status,
			409,
			"a closed document never reconnects by its old identity",
		);
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
		assert.equal((await post(await bridge.start(), "/connect", binding())).status, 200);
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
			await post(config, "/connect", pane);
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
		await post(config, "/connect", pane);
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
		const handle = (await post(config, "/connect", lost)).data.handle;
		const other = (await post(config, "/connect", healthy)).data.handle;
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
test("claims and releases forward only to a version 2 pane and preserve held outcomes", {
	timeout: 10000,
}, async () => {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) });
	const config = await bridge.start();
	const pane = binding();
	try {
		const handle = (await post(config, "/connect", pane)).data.handle;
		const claim = {
			op: "claim" as const,
			baseGeneration: 4,
			baseDigest: responseDigest("exact"),
			ranges: [{ start: 0, end: 5 }],
			label: "Revise passage",
		};
		assert.equal(bridge.list()[0].live, 1);
		assert.equal((await bridge.execute(handle, claim)).status, "error");
		assert.equal((await bridge.execute(handle, { op: "release", claimId: randomUUID() })).status, "error");
		assert.equal((await post(config, "/connect", { ...pane, live: 3 })).status, 409);
		await post(config, "/connect", { ...pane, live: 2 });
		assert.equal(bridge.list()[0].live, 2);
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
		const handle = (await post(config, "/connect", { ...pane, live: 2 })).data.handle;
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
		const handle = (await post(config, "/connect", pane)).data.handle;
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
		await post(config, "/connect", pane);
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
		const handle = (await post(config, "/connect", pane)).data.handle;
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
