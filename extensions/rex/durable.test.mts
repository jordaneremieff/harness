import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { rexContribution } from "./durable.ts";
import { beginOwnership, requestDigest } from "./ownership.ts";
import type { RexResult } from "./core.ts";

const server = { endpoint: "unix:///synthetic-rex", hostId: "host", instanceId: "instance", selection: "test" };
const target = { server, source: "explicit" as const, sessionId: "session:00000000-0000-0000-0000-000000000001", blockId: "block:00000000-0000-0000-0000-000000000002" };
const ok = (data: unknown): RexResult => ({ ok: true, outcome: "test_snapshot", data, effects: { state: "none" }, coverage: { bounded: true } });

function resultValues(entries: readonly Durable.EntryRecord[]): RexResult[] {
	return entries.flatMap((entry) => (entry.model ?? []).flatMap((message) => {
		if (message.role !== "toolResult") return [];
		const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		try { return [JSON.parse(text) as RexResult]; } catch { return []; }
	}));
}

test("native tools use real model calls, structured channels, unsafe replay and fork-isolated ownership", { timeout: 30000 }, async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "rex-native-"));
	const previousRecords = process.env.PI_REX_MAX_RECORDS;
	const previousOutput = process.env.PI_REX_MAX_OUTPUT_BYTES;
	process.env.PI_REX_MAX_RECORDS = "128";
	process.env.PI_REX_MAX_OUTPUT_BYTES = "32768";
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	const controller = new AbortController();
	const closers: Array<() => void | Promise<void>> = [];
	let disposed = 0;
	const owners: string[] = [];
	const endedCalls: Array<() => boolean | undefined> = [];
	const contribution = rexContribution("/test/rex/index.ts", createEventBus(), () => {}, {
		createCore: (options) => ({
			dispose: () => { disposed++; },
			execute: async (request, context) => {
				owners.push(context.ownerId);
				assert.equal(options.isCallActive?.(context.ownerId, context.callId), true);
				endedCalls.push(() => options.isCallActive?.(context.ownerId, context.callId));
				if (request.op === "create") {
					const now = new Date().toISOString();
					await options.store.update(context.ownerId, (state) => beginOwnership(state, { ownerId: context.ownerId, callId: context.callId, requestDigest: requestDigest(request), server, operation: "create", phase: "pending", resources: [], createdAt: now, updatedAt: now }));
					const retained = await options.store.read(context.ownerId);
					assert.equal(retained.records[0]?.phase, "pending", "native commit resolves before the external-effect boundary");
				}
				if (request.op === "owned") return ok(await options.store.read(context.ownerId));
				if (request.op === "inspect" && request.view === "status") return { ...ok({ payload: "s".repeat(200000) }), outcome: "snapshot", target, coverage: { bounded: true, note: "Native status source qualification." } };
				if (request.op === "input") return {
					...ok({ payload: "x".repeat(80000) }), outcome: "input_delivered", target,
					records: [{ recordId: context.callId, server, resources: [{ kind: "block", sessionId: target.sessionId, blockId: target.blockId }] }],
					effects: { state: "confirmed", recordId: context.callId, note: "Input delivery does not prove application success." },
					coverage: { bounded: true, truncated: false, note: "Source observation qualification." },
				};
				if (request.op === "native" && request.code === "fail") return { ...ok({ layer: "script" }), ok: false, outcome: "script_failed", error: "synthetic failure", effects: { state: "unknown" } };
				return { ...ok({ operation: request.op }), target };
			},
		}),
	});
	try {
		const extension = await contribution.create({ durable: Durable, cwd: agentDir, agentDir, storageId: "test-storage", harness, signal: controller.signal, onClose: (close) => closers.push(close) });
		assert.ok(extension.tools?.every((tool) => tool.replay === "unsafe"));
		assert.ok(extension.tools?.every((tool) => tool.structuredOutputSchema !== undefined));
		registry.install(extension);
		let nested: Durable.NestedToolExecutionResult | undefined;
		let concurrentRecords = 0;
		registry.install(Durable.defineExtension({ name: "test-caller", tools: [Durable.defineTool({
			name: "test_nested", description: "Exercise concurrent commits and the native structured error channel.", parameters: Type.Object({}), replay: "safe",
			execute: async (_args, api, context) => {
				const created = await Promise.all([
					api.executeTool("rex_terminal", { op: "create", kind: "session", label: "parallel-one" }, context),
					api.executeTool("rex_terminal", { op: "create", kind: "session", label: "parallel-two" }, context),
				]);
				assert.ok(created.every((result) => !result.isError), JSON.stringify(created));
				const owned = await api.executeTool("rex_owned", { op: "owned" }, context);
				concurrentRecords = ((owned.structuredOutput as unknown as RexResult).data as { records: unknown[] }).records.length;
				nested = await api.executeTool("rex_native", { op: "native", kind: "lua", code: "fail" }, context);
				return { output: [{ type: "text", text: "Nested results inspected." }] };
			},
		})] }));
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("rex_environment", { op: "environment" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("rex_terminal", { op: "create", kind: "session", label: "owned-repl" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("rex_terminal", { op: "input", text: "large observation", observe: true }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("rex_wait", { op: "wait", condition: "child_exit" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("rex_native", { op: "native", kind: "catalog" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("rex_owned", { op: "owned" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("rex_status", { op: "snapshot", target: { server: server.endpoint, session: target.sessionId, block: target.blockId } }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("test_nested", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Complete."),
		]);
		await (await root.submit({ type: "input", content: "Exercise the Rex contracts." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const entries = (await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
		const values = resultValues(entries);
		assert.equal(values.length, 7);
		assert.ok(values.every((value) => value.ok));
		const observedInput = values.find((value) => value.outcome === "input_delivered");
		assert.ok(observedInput);
		assert.equal((observedInput.data as { payload: string }).payload.length, 80000);
		assert.ok(Buffer.byteLength(JSON.stringify(observedInput), "utf8") > 50 * 1024, "the native declaration preserves complete JSON beyond the host default");
		assert.equal(observedInput.effects.state, "confirmed");
		assert.equal(observedInput.effects.recordId, observedInput.records?.[0]?.recordId);
		assert.match(observedInput.effects.note ?? "", /does not prove application success/);
		assert.match(observedInput.coverage.note ?? "", /Source observation qualification/);
		const status = values.find((value) => value.outcome === "snapshot");
		assert.ok(status);
		assert.equal((status.data as { omitted?: boolean }).omitted, true);
		assert.equal(status.coverage.dataOmitted, true);
		assert.match(status.coverage.note ?? "", /Native status source qualification/);
		assert.match(status.coverage.note ?? "", /not permission, ownership or task acceptance/);
		assert.equal((values.find((value) => (value.data as { version?: number })?.version === 1)?.data as { records: unknown[] }).records.length, 1);
		const nestedCall = entries.flatMap((entry) => entry.model ?? []).find((message) => message.role === "toolResult" && message.toolName === "test_nested");
		assert.ok(nestedCall?.role === "toolResult", "the model-issued nested caller returned a result");
		assert.equal(nestedCall.isError, false, JSON.stringify(nestedCall));
		assert.equal(concurrentRecords, 3, "concurrent native updates preserve both new pending records");
		assert.equal(nested?.isError, true);
		assert.equal((nested?.structuredOutput as unknown as RexResult).outcome, "script_failed");
		assert.equal((nested?.structuredOutput as unknown as RexResult).effects.state, "unknown");
		assert.deepEqual(nested?.details, { outcome: "script_failed", effects: "unknown" });
		assert.ok(owners.every((owner) => owner === `test-storage:${root.id}`));
		const last = entries.at(-1);
		assert.ok(last);
		const fork = await root.fork(last.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage(fauxToolCall("rex_owned", { op: "owned" }), { stopReason: "toolUse" }), fauxAssistantMessage("No inherited claims.")]);
		await (await fork.submit({ type: "input", content: "Inspect my own resources." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const forkValues = resultValues((await fork.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items);
		assert.equal((forkValues.at(-1)?.data as { records: unknown[] }).records.length, 0);
		assert.ok(owners.includes(`test-storage:${fork.id}`));
		assert.ok(disposed >= 8);
		assert.ok(endedCalls.every((active) => active() === false), "native finally releases each invocation after settlement");
	} finally {
		controller.abort();
		for (const close of closers.reverse()) await close();
		await harness.close(BACKGROUND_CONTEXT);
		await rm(agentDir, { recursive: true, force: true });
		if (previousRecords === undefined) delete process.env.PI_REX_MAX_RECORDS;
		else process.env.PI_REX_MAX_RECORDS = previousRecords;
		if (previousOutput === undefined) delete process.env.PI_REX_MAX_OUTPUT_BYTES;
		else process.env.PI_REX_MAX_OUTPUT_BYTES = previousOutput;
	}
});
