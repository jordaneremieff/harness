import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { LiveBridge, LiveBridges, type LivePrompt, type LivePublisher, type LiveRoute } from "./live-bridge.ts";
import { nativeConversationConnection } from "./live-host.ts";
import { LIVE_LIFETIME, LIVE_PROMPT_BYTES, LIVE_WIRE_BYTES, type LiveConfig } from "./live-protocol.ts";
import type { LaunchTarget } from "./pane-command.ts";

const pane = () => ({ workspace: randomUUID(), document: randomUUID() });
const question = () => {
	const requestId = randomUUID();
	return { requestId, threadId: requestId, root: "/repo", text: "Question" };
};
const requested = async () => ({ status: "requested" as const });
const offer = { version: 1, navigate: 1 };
const target: LaunchTarget = { root: "/repo", path: "src/example.ts", line: 3, end: 5, view: "file" };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function post(
	config: LiveConfig,
	path: string,
	body: object,
	headers: Record<string, string> = {},
	method = "POST",
): Promise<{ status: number; json: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const encoded = JSON.stringify(body);
		const req = request(
			`${config.endpoint}${path}`,
			{
				method,
				agent: false,
				headers: {
					Authorization: `Bearer ${config.token}`,
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(encoded)),
					...headers,
				},
			},
			(response) => {
				let text = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					text += chunk;
				});
				response.once("error", reject);
				response.once("end", () => {
					try {
						resolve({ status: response.statusCode ?? 0, json: JSON.parse(text) });
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.once("error", reject);
		req.setTimeout(2000, () => req.destroy(new Error("Test request timed out.")));
		req.end(encoded);
	});
}

async function setup(t: TestContext, route: LiveRoute = { submit: requested }, commandMs = 1000) {
	const bridge = new LiveBridge(route, commandMs, 30);
	t.after(() => bridge.close());
	const config = await bridge.start();
	const connect = async (binding = pane()) => {
		const response = await post(config, "/connect", { ...binding, ...offer });
		assert.equal(response.status, 200);
		const { handle } = response.json;
		assert.equal(typeof handle, "string");
		return { ...binding, handle: String(handle) };
	};
	return { bridge, config, connect };
}

function command(reply: { json: Record<string, unknown> }): Record<string, unknown> {
	const value = reply.json.command;
	assert.ok(value && typeof value === "object");
	return value as Record<string, unknown>;
}
function state(reply: { json: Record<string, unknown> }): Record<string, unknown> {
	const value = reply.json.state;
	assert.ok(value && typeof value === "object");
	return value as Record<string, unknown>;
}

test("the loopback wire checks authorization, identity, version and the JSON limit", { timeout: 5000 }, async (t) => {
	const { bridge, config } = await setup(t, { submit: requested, label: "Test conversation" });
	assert.match(config.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
	assert.match(config.token, /^[a-f0-9]{64}$/u);
	const binding = pane();
	const body = { ...binding, ...offer };
	const invalidHeaders: Record<string, string>[] = [
		{ Authorization: `Bearer ${"0".repeat(64)}` },
		{ Origin: "http://127.0.0.1" },
		{ Host: "localhost" },
		{ "Content-Type": "text/plain" },
	];
	for (const headers of invalidHeaders) {
		const reply = await post(config, "/connect", body, headers);
		assert.equal(reply.status, 403);
		assert.equal(reply.json.ok, false);
	}
	assert.equal((await post(config, "/connect", body, {}, "PUT")).status, 403);
	assert.equal((await post(config, "/connect?version=1", body)).status, 404);
	assert.equal((await post(config, "/connect", { ...body, navigate: 2 })).status, 409);
	assert.equal((await post(config, "/connect", { ...body, workspace: "bad" })).status, 409);
	const oversized = await post(config, "/connect", { ...body, padding: "x".repeat(LIVE_WIRE_BYTES) }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ECONNRESET" && error.code !== "EPIPE") throw error;
			return null;
		},
	);
	if (oversized) {
		assert.equal(oversized.status, 409);
		assert.deepEqual(oversized.json, { ok: false, error: "The Explorer request exceeds its size limit." });
	}
	assert.deepEqual(bridge.list(), []);
	const reply = await post(config, "/connect", body);
	assert.deepEqual(reply.json, {
		ok: true,
		handle: `${binding.workspace}:${binding.document}`,
		label: "Test conversation",
	});
	assert.deepEqual((await post(config, "/poll", { ...binding, after: 0 })).json, {
		ok: true,
		command: null,
		state: { sequence: 0, status: "idle", text: "", truncated: false },
	});
});

test("navigation needs an exact acknowledgement from the pane that received it", { timeout: 5000 }, async (t) => {
	const { bridge, config, connect } = await setup(t);
	const first = await connect();
	const second = await connect();
	assert.deepEqual(bridge.list(), [{ handle: first.handle }, { handle: second.handle }]);
	const moved = bridge.navigate(second.handle, target);
	const delivery = command(await post(config, "/poll", { ...second, after: 0 }));
	const requestId = delivery.requestId;
	assert.deepEqual(delivery, {
		workspace: second.workspace,
		document: second.document,
		requestId,
		op: "navigate",
		target,
	});
	assert.equal(typeof requestId, "string");
	const ack = { requestId, result: { status: "ok" } };
	await post(config, "/result", { ...first, ...ack });
	await post(config, "/result", { ...second, ...ack, requestId: randomUUID() });
	assert.equal((await post(config, "/result", { ...second, requestId, result: { status: "other" } })).status, 409);
	assert.equal((await post(config, "/poll", { ...second, after: 0 })).json.command, null);
	await post(config, "/result", { ...second, requestId, result: { status: "error", message: "File is unavailable." } });
	assert.deepEqual(await moved, { status: "error", message: "File is unavailable." });
	const next = bridge.navigate(second.handle, target);
	const nextDelivery = command(await post(config, "/poll", { ...second, after: 0 }));
	assert.notEqual(nextDelivery.requestId, requestId);
	await post(config, "/result", { ...second, requestId: nextDelivery.requestId, result: { status: "ok" } });
	assert.deepEqual(await next, { status: "ok" });
});

test("close and abort distinguish undelivered navigation from unconfirmed delivery", { timeout: 5000 }, async (t) => {
	const { bridge, config, connect } = await setup(t);
	const binding = await connect();
	const abort = new AbortController();
	const undelivered = bridge.navigate(binding.handle, target, abort.signal);
	abort.abort();
	assert.equal((await undelivered).status, "closed");
	assert.equal((await post(config, "/poll", { ...binding, after: 0 })).json.command, null);
	const delivered = bridge.navigate(binding.handle, target);
	command(await post(config, "/poll", { ...binding, after: 0 }));
	const queued = bridge.navigate(binding.handle, target);
	assert.deepEqual((await post(config, "/close", binding)).json, { ok: true });
	assert.equal((await delivered).status, "uncertain");
	assert.equal((await queued).status, "closed");
	assert.equal((await bridge.navigate(binding.handle, target)).status, "closed");
	assert.deepEqual(bridge.list(), []);
	assert.equal((await post(config, "/connect", { ...binding, ...offer })).status, 409);
});

test("a command timeout does not assert success or redeliver a command", { timeout: 5000 }, async (t) => {
	const { bridge, config, connect } = await setup(t, { submit: requested }, 250);
	const binding = await connect();
	assert.equal((await bridge.navigate(binding.handle, target)).status, "closed");
	const delivered = bridge.navigate(binding.handle, target);
	const { requestId } = command(await post(config, "/poll", { ...binding, after: 0 }));
	assert.equal((await delivered).status, "uncertain");
	await post(config, "/result", { ...binding, requestId, result: { status: "ok" } });
	assert.equal((await post(config, "/poll", { ...binding, after: 0 })).json.command, null);
});

test("exact prompt retries share admission and preserve the original text", { timeout: 5000 }, async (t) => {
	const calls: LivePrompt[] = [];
	const entered = deferred<void>();
	const admission = deferred<Awaited<ReturnType<LiveRoute["submit"]>>>();
	const { config, connect } = await setup(t, {
		submit: async (prompt) => {
			calls.push(prompt);
			entered.resolve();
			return admission.promise;
		},
	});
	const first = await connect();
	const second = await connect();
	const text = "  Review the café 🧪.\r\n\n  Preserve this indent.\n";
	const input = { ...question(), text, noteIds: [`n-${"a".repeat(20)}`, `n-${"b".repeat(20)}`] };
	const initial = post(config, "/prompt", { ...first, ...input });
	await entered.promise;
	const retry = post(config, "/prompt", { ...first, ...input });
	for (const changed of [
		{ ...first, ...input, text: text.trim() },
		{ ...first, ...input, threadId: randomUUID() },
		{ ...first, ...input, root: "/repo/nested" },
		{ ...first, ...input, noteIds: [...input.noteIds].reverse() },
		{ ...first, ...input, noteIds: undefined },
		{ ...second, ...input },
	]) {
		assert.equal((await post(config, "/prompt", changed)).json.status, "rejected");
	}
	admission.resolve({ status: "admitted", submissionId: "34" });
	const receipt = { ok: true, status: "admitted", submissionId: "34" };
	assert.deepEqual((await initial).json, receipt);
	assert.deepEqual((await retry).json, receipt);
	assert.deepEqual((await post(config, "/prompt", { ...first, ...input })).json, receipt);
	assert.deepEqual(calls, [{ text, requestId: input.requestId, threadId: input.threadId, root: input.root }]);
});

test("a native Ask keeps its final-answer instruction and returns the admitted submission's reply", {
	timeout: 10000,
}, async (t) => {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	let modelInput: string | undefined;
	faux.setResponses([
		({ messages }) => {
			const content = messages.findLast((message) => message.role === "user")?.content;
			modelInput =
				typeof content === "string"
					? content
					: content?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			return fauxAssistantMessage("Native answer");
		},
	]);
	const harness = await Durable.Harness.open(
		new Durable.MemoryStorage(),
		{ models, registry: Durable.createRegistry() },
		BACKGROUND_CONTEXT,
	);
	const close: (() => void | Promise<void>)[] = [];
	t.after(async () => {
		for (const dispose of close) await dispose();
		await harness.close(BACKGROUND_CONTEXT);
	});
	const conversation = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	const config = await nativeConversationConnection(
		{ durable: Durable, agentDir: "/agent", cwd: "/repo", harness, onClose: (dispose) => close.push(dispose) },
		conversation,
	);
	const binding = pane();
	const input = question();
	assert.equal((await post(config, "/connect", { ...binding, ...offer })).status, 200);
	assert.equal((await post(config, "/prompt", { ...binding, ...input })).json.status, "admitted");
	let current = state(await post(config, "/poll", { ...binding, after: 0 }));
	while (current.status === "queued" || current.status === "working") {
		current = state(await post(config, "/poll", { ...binding, after: current.sequence }));
	}
	assert.equal(current.status, "answer");
	assert.equal(current.text, "Native answer");
	assert.equal(current.requestId, input.requestId);
	assert.equal(
		modelInput,
		`This question (${input.requestId}) comes from the live Explorer pane. Answer in your final message; the pane shows it under this question.\n\n${input.text}`,
	);
});

test("only a retryable uncertainty permits exact resubmission", { timeout: 5000 }, async (t) => {
	for (const mode of ["retryable", "thrown", "unsafe", "rejected"] as const) {
		let calls = 0;
		const { config, connect } = await setup(t, {
			retryFailedSubmission: mode === "thrown",
			submit: async () => {
				if (++calls > 1) return { status: "requested" };
				if (mode === "retryable") return { status: "uncertain", retryable: true, message: "No receipt." };
				if (mode === "rejected") return { status: "rejected", message: "Not admitted." };
				throw new Error("No receipt.");
			},
		});
		const body = { ...(await connect()), ...question() };
		const first = (await post(config, "/prompt", body)).json;
		assert.equal(first.status, mode === "rejected" ? "rejected" : "uncertain");
		const second = (await post(config, "/prompt", body)).json;
		if (mode === "retryable" || mode === "thrown") {
			assert.equal(first.retryable, true);
			assert.equal(second.status, "requested");
			assert.equal(calls, 2);
		} else {
			assert.deepEqual(second, first);
			assert.equal(calls, 1);
		}
	}
});

test("prompt validation measures UTF-8 bytes and rejects invalid Unicode and note IDs", {
	timeout: 5000,
}, async (t) => {
	const { config, connect } = await setup(t);
	const body = { ...(await connect()), ...question() };
	for (const input of [
		{ text: "\n \t" },
		{ text: "\ud800" },
		{ text: "🧪".repeat(LIVE_PROMPT_BYTES / 4 + 1) },
		{ noteIds: [`n-${"A".repeat(20)}`] },
		{ noteIds: null },
		{ threadId: "invalid" },
		{ root: "relative" },
		{ root: "/\0" },
	]) {
		assert.equal((await post(config, "/prompt", { ...body, ...input })).json.status, "rejected");
	}
	const missingRoot = (await post(config, "/prompt", { ...body, root: undefined })).json;
	assert.equal(missingRoot.status, "rejected");
	assert.match(String(missingRoot.message), /\/explorer update.*reopen the pane/u);
	assert.deepEqual((await post(config, "/prompt", { ...body, text: "🧪".repeat(LIVE_PROMPT_BYTES / 4) })).json, {
		ok: true,
		status: "requested",
	});
});

test("polls deliver only the pane's request states and retain both kinds of terminal answer", {
	timeout: 5000,
}, async (t) => {
	let publish: LivePublisher = () => assert.fail("Missing publisher");
	const { config, connect } = await setup(t, {
		submit: requested,
		observe: async (emit) => {
			publish = emit;
			return () => {};
		},
	});
	const first = await connect();
	const second = await connect();
	const a = question();
	const b = question();
	await post(config, "/prompt", { ...first, ...a });
	const queued = state(await post(config, "/poll", { ...first, after: 0 }));
	assert.deepEqual(queued, {
		requestId: a.requestId,
		threadId: a.threadId,
		sequence: 1,
		status: "queued",
		text: "",
		truncated: false,
	});
	publish("working", "Draft", a.requestId);
	const working = state(await post(config, "/poll", { ...first, after: queued.sequence }));
	assert.equal(working.text, "Draft");
	assert.equal(working.status, "working");
	await post(config, "/prompt", { ...first, ...b });
	publish("answer", "Answer A", a.requestId);
	publish("error", "Error B", b.requestId);
	publish("working", "Late progress A", a.requestId);
	publish("answer", "Late answer B", b.requestId);
	publish("answer", "Not owned by a pane", randomUUID());
	const aFinal = state(await post(config, "/poll", { ...first, after: working.sequence }));
	const bFinal = state(await post(config, "/poll", { ...first, after: aFinal.sequence }));
	assert.deepEqual(aFinal, {
		requestId: a.requestId,
		threadId: a.threadId,
		sequence: 4,
		status: "answer",
		text: "Answer A",
		truncated: false,
	});
	assert.deepEqual(bFinal, {
		requestId: b.requestId,
		threadId: b.threadId,
		sequence: 5,
		status: "error",
		text: "Error B",
		truncated: false,
	});
	assert.equal(state(await post(config, "/poll", { ...second, after: 0 })).sequence, 0);
	assert.deepEqual(state(await post(config, "/poll", { ...first, after: bFinal.sequence })), bFinal);
});

test("shutdown during bind or observer setup retires the capability", { timeout: 5000 }, async (t) => {
	const bridge = new LiveBridge({ submit: requested });
	t.after(() => bridge.close());
	const starting = bridge.start();
	bridge.close();
	await assert.rejects(starting, /closed/u);

	const observing = deferred<void>();
	const detach = deferred<() => void>();
	const observed = new LiveBridge({
		submit: requested,
		observe: async () => {
			observing.resolve();
			return detach.promise;
		},
	});
	t.after(() => observed.close());
	const waiting = observed.start();
	await observing.promise;
	observed.close();
	let detaches = 0;
	detach.resolve(() => {
		detaches++;
	});
	await assert.rejects(waiting, /closed/u);
	assert.equal(detaches, 1);
});

test("a registry shares startup per conversation and closes independent capabilities", { timeout: 5000 }, async (t) => {
	const bridges = new LiveBridges();
	t.after(() => bridges.close());
	let detach = 0;
	const [first, same] = await Promise.all([
		bridges.get("a", () => ({
			submit: requested,
			observe: async () => () => {
				detach++;
			},
		})),
		bridges.get("a", () => assert.fail("Created the same route twice")),
	]);
	assert.equal(first, same);
	assert.equal(await bridges.find("a"), first);
	const second = await bridges.get("b", () => ({ submit: requested }));
	const [a, b] = await Promise.all([first.start(), second.start()]);
	assert.notEqual(a.endpoint, b.endpoint);
	assert.notEqual(a.token, b.token);
	assert.equal((await post({ ...b, token: a.token }, "/connect", { ...pane(), ...offer })).status, 403);
	bridges.close();
	assert.equal(detach, 1);
	assert.equal(a[LIVE_LIFETIME]?.aborted, true);
	assert.equal(b[LIVE_LIFETIME]?.aborted, true);
	assert.equal(await bridges.find("a"), undefined);
	await assert.rejects(first.start(), /closed/u);
	await assert.rejects(
		bridges.get("a", () => ({ submit: requested })),
		/closed/u,
	);
});
