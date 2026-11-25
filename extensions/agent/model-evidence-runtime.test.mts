import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import * as Durable from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import register from "./index.ts";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { acquireHost, waitForHostRelease } from "./host-client.ts";
import { runtimeFixture, trackHost, waitForReceipt } from "./durable-runtime-fixture.mts";
import { DurableHost } from "./durable-host.ts";
import { createAgentContribution } from "./durable-agents.ts";
import {
	answerMessage,
	completed,
	fixtureRegistry,
	fixtureRuntime,
	hostOptions,
	toolCallMessage,
} from "./durable-host-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { trimEvidenceEntries, USAGE_ENTRY_LIMIT, type EvidenceEntries } from "./model-evidence.ts";
import { AgentManager } from "./manager.ts";
import { buildStatusOverview, type StatusOverview } from "./status-overview.ts";
import { MODEL_SELECTION_GUIDANCE } from "./control-guidance.ts";
import { page as rosterPage } from "./dashboard-test-fixture.mts";
import type { FleetStatus } from "./fleet-status.ts";

async function primaryTools(): Promise<Map<string, ToolDefinition>> {
	const tools = new Map<string, ToolDefinition>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
	} as unknown as ExtensionAPI);
	return tools;
}

it("publishes real host evidence and reads fleet status locally from ordinary and native tools", {
	timeout: 120000,
}, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const root = join(realpathSync(f.root), "fleet");
	const catalog = new AgentCatalog(root);
	const { storageId: _storageId, storagePath: _storagePath, ...input } = f.metadata;
	const metadata = hostMetadata(catalog.create(input));
	const previous = { dir: process.env.PI_AGENT_DIR, sessions: process.env.PI_AGENT_SESSIONS_DIR };
	process.env.PI_AGENT_DIR = f.agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	t.after(() => {
		if (previous.dir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous.dir;
		if (previous.sessions === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = previous.sessions;
	});
	const primary = await acquireHost(metadata, {
		env: { ...f.env("answer"), PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: root },
	});
	trackHost(t, primary.pid);
	try {
		const submission = (await primary.request("submit", {
			message: "Publish model evidence",
			requestId: "model-evidence",
			ownerId: f.ownerId,
			origin: "operator",
		})) as { submissionId: number };
		assert.equal((await waitForReceipt(primary, f.ownerId, submission.submissionId)).status, "done");
		await primary.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submission.submissionId] });
	} finally {
		await primary.close();
	}
	process.kill(primary.pid, "SIGTERM");
	await waitForHostRelease(metadata, { signal: AbortSignal.timeout(10000) });
	const view = catalog.read(metadata.storageId).view;
	assert.ok(view?.modelEvidence);
	assert.ok(
		view.modelEvidence.models.some(
			(item) =>
				item.model === `${f.metadata.model.provider}/${f.metadata.model.modelId}` &&
				item.reportedCost > 0 &&
				item.lastResponseAt !== undefined,
		),
	);

	const tools = await primaryTools();
	const status = tools.get("agent_status");
	assert.ok(status);
	const sessionManager = SessionManager.inMemory(f.cwd);
	const toolContext = { cwd: f.cwd, sessionManager } satisfies Pick<ExtensionContext, "cwd" | "sessionManager">;
	sessionManager.appendMessage(answerMessage("Caller evidence"));
	const identity = t.mock.method(sessionManager, "getSessionId", () => f.ownerId);
	const ordinary = await status.execute("fleet", { view: "fleet" }, undefined, undefined, toolContext as never);
	const fleet = ordinary.details as FleetStatus;
	assert.equal(fleet.view, "fleet");
	assert.equal(fleet.models.length, 1);
	assert.ok((fleet.models[0].usage?.last5h.responses ?? 0) > 0);
	assert.equal(fleet.models[0].usage?.last5h.tokens, fleet.models[0].usage?.last7d.tokens);
	assert.equal(fleet.usageCoverage.status, "partial");
	assert.equal(fleet.effort.membership, "catalog-owner");
	assert.equal(fleet.effort.members, 2);
	assert.equal(fleet.effort.observedMembers, 2);
	assert.equal(fleet.effort.reportedCost, answerMessage().usage.cost.total + (view.rows[0]?.cost ?? 0));
	assert.ok(Buffer.byteLength(JSON.stringify(fleet)) <= 4096);
	assert.equal(ordinary.content[0].type, "text");
	if (ordinary.content[0].type === "text") assert.equal(ordinary.content[0].text, JSON.stringify(fleet));

	let native: ToolResultMessage | undefined;
	const models = await createTestRuntime();
	const streamSimple = (_model: unknown, transcript: TranscriptContext) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") {
			native = last;
			return completed(answerMessage("Observed fleet"));
		}
		return completed(toolCallMessage("agent_status", { view: "fleet" }));
	};
	models.registerNativeProvider({
		id: testModel.provider,
		name: "Fleet fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: streamSimple,
		streamSimple,
	});
	const registry = fixtureRegistry();
	const contribution = createAgentContribution({
		configureSettings: () => {},
		source: fileURLToPath(new URL("./index.ts", import.meta.url)),
		dispatch: async () => {
			throw new Error("Fleet observation must not dispatch a host operation");
		},
	}).create({
		onClose() {},
		durable: Durable,
		storageId: "fixture-agent",
		cwd: f.cwd,
		agentDir: f.agentDir,
		catalogRoot: catalog.root,
		services: { modelRuntime: models },
	});
	registry.install(contribution);
	for (const name of ["agent_spawn", "agent_brief", "agent_configure"]) {
		const ordinaryTool = tools.get(name);
		const nativeTool = contribution.tools?.find((tool) => tool.name === name);
		assert.ok(ordinaryTool);
		assert.ok(nativeTool);
		assert.equal(
			(ordinaryTool.parameters as { properties: { model: { description: string } } }).properties.model.description,
			MODEL_SELECTION_GUIDANCE,
		);
		assert.equal(
			(nativeTool.parameters as { properties: { model: { description: string } } }).properties.model.description,
			MODEL_SELECTION_GUIDANCE,
		);
	}
	const observer = await DurableHost.open(
		hostOptions(join(f.root, "observer.sqlite"), models, registry, f.cwd),
		context,
	);
	try {
		const submitted = await observer.submit({ message: "Read fleet", requestId: "fleet-native" });
		await observer.wait(submitted.submissionId, context);
		assert.ok(native);
		assert.equal(native.isError, false, JSON.stringify(native.content));
		const nativeFleet = native.details as FleetStatus;
		assert.deepEqual(nativeFleet.models, fleet.models);
		assert.equal(nativeFleet.effort.membership, "creation-records");
		assert.equal(nativeFleet.effort.members, 1);
		assert.equal(nativeFleet.effort.missingMembers, 1);
		assert.ok(native.content.every((part) => part.type !== "text" || Buffer.byteLength(part.text) <= 4096));
	} finally {
		await observer.close();
	}
	identity.mock.restore();
	await t.test("selected status does not read caller identity", async () => {
		const unused = t.mock.method(sessionManager, "getSessionId", () => {
			throw new Error("Selected status must not read caller identity");
		});
		t.after(() => unused.mock.restore());
		const selected = await status.execute(
			"selected",
			{ sessionId: metadata.storageId },
			undefined,
			undefined,
			toolContext as never,
		);
		assert.ok(selected.details);
		assert.match(JSON.stringify(selected.details), new RegExp(metadata.storageId));
		unused.mock.restore();
	});
	await t.test("overview retains base status when optional self identity is unavailable", async () => {
		const known = (await status.execute("known", {}, undefined, undefined, toolContext as never))
			.details as StatusOverview;
		assert.equal(known.awareness?.self.id, sessionManager.getSessionId());
		assert.equal(known.awareness?.self.cwd, realpathSync(f.cwd));
		// Pi requires sessionManager; these incomplete contexts exercise observation without self identity.
		for (const unavailable of [{ cwd: f.cwd }, undefined]) {
			const unknown = (await status.execute("unknown", {}, undefined, undefined, unavailable as never))
				.details as StatusOverview;
			assert.equal(unknown.awareness, undefined);
			assert.deepEqual(unknown.sessions, known.sessions);
			assert.deepEqual(unknown.primaries, known.primaries);
			const withoutIdentity = (
				await status.execute("fleet-unknown", { view: "fleet" }, undefined, undefined, unavailable as never)
			).details as FleetStatus;
			assert.deepEqual(withoutIdentity.models, fleet.models);
		}
	});
	t.diagnostic(`Fleet sample: ${JSON.stringify(fleet)}`);
});

it("publishes own usage across real model changes without counting a fork's inherited entries twice", async (t) => {
	const f = runtimeFixture(t);
	const models = await createTestRuntime();
	const alternate = { ...testModel, id: "alternate-model", name: "Alternate fixture" };
	const streamSimple = (model: { id: string }) => completed({ ...answerMessage(), model: model.id });
	models.registerNativeProvider({
		id: testModel.provider,
		name: "Accounting fixture",
		getModels: () => [testModel, alternate],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: streamSimple,
		streamSimple,
	});
	const host = await DurableHost.open(
		hostOptions(join(f.root, "accounting.sqlite"), models, fixtureRegistry(), f.cwd),
		context,
	);
	t.after(() => host.close());
	const first = await host.submit({ message: "First model", requestId: "first" });
	await host.wait(first.submissionId, context);
	await host.request("configure", { model: { provider: testModel.provider, modelId: alternate.id } });
	const second = await host.submit({ message: "Second model", requestId: "second" });
	await host.wait(second.submissionId, context);
	const assistant = (await host.root().entries({}, 20, undefined, context)).items.find(
		(item) => item.kind === "pi.assistant",
	);
	assert.ok(assistant);
	await host.request("fork", { entryId: assistant.id });
	const projection = await host.catalogProjection();
	assert.equal(projection.modelEvidence.coverage.conversationsVisited, 2);
	assert.deepEqual(
		projection.modelEvidence.models.map(({ model, reportedCost }) => ({ model, reportedCost })),
		[
			{ model: `${testModel.provider}/${testModel.id}`, reportedCost: 0.03 },
			{ model: `${testModel.provider}/${alternate.id}`, reportedCost: 0.03 },
		],
	);
	assert.equal(projection.rows[0].model?.modelId, alternate.id);
	assert.equal(projection.rows[0].cost, 0.06);
	assert.equal(projection.modelEvidence.toolReportedCost, 0);
	assert.equal(
		projection.modelEvidence.sampling?.samples.length,
		2,
		"the unused fork contributes no inherited usage sample",
	);
	assert.equal(projection.modelEvidence.sampling?.invalidSamples, 0);
});

it("keeps default manager status byte-equivalent to its established overview and selected-session path", async (t) => {
	const f = runtimeFixture(t);
	const selected = { conversation: { fixture: "unchanged" } };
	const manager = new AgentManager({
		root: f.root,
		agentDir: f.agentDir,
		packageDir: f.root,
		observe: async (_record, method, params) => {
			assert.equal(method, "status");
			assert.equal(params.sessionId, f.metadata.storageId);
			return selected;
		},
	});
	t.after(() => manager.close());
	const page = { ...rosterPage([]), observedAt: "2026-01-01T00:00:00.000Z" };
	t.mock.method(manager, "dashboardPage", async () => page);
	assert.equal(JSON.stringify(await manager.status()), JSON.stringify(buildStatusOverview(page, [], [])));
	assert.equal(await manager.status(f.metadata.storageId), selected);
	await assert.rejects(manager.status(f.metadata.storageId, "fleet"), /omit sessionId/u);
});

it("a projection reads again only the conversations named as changed and returns the complete rows and evidence", async (t) => {
	const f = runtimeFixture(t);
	const host = await DurableHost.open(
		hostOptions(join(f.root, "projection.sqlite"), await fixtureRuntime("answer"), fixtureRegistry(), f.cwd),
		context,
	);
	t.after(() => host.close());
	const first = await host.submit({ message: "First request", requestId: "first" });
	await host.wait(first.submissionId, context);
	const assistant = (await host.root().entries({}, 20, undefined, context)).items.find(
		(item) => item.kind === "pi.assistant",
	);
	assert.ok(assistant);
	await host.request("fork", { entryId: assistant.id });
	const before = await host.catalogProjection();
	assert.equal(before.rows.length, 2);

	const second = await host.submit({ message: "Second request", requestId: "second" });
	await host.wait(second.submissionId, context);
	const read: number[] = [];
	const conversation = host.harness.conversation.bind(host.harness);
	t.mock.method(host.harness, "conversation", (...args: Parameters<typeof conversation>) => {
		read.push(args[0]);
		return conversation(...args);
	});
	const partial = await host.catalogProjection(context, new Set([Durable.ROOT_CONVERSATION_ID]));
	assert.deepEqual([...new Set(read)], [Durable.ROOT_CONVERSATION_ID], "the unchanged fork is not read again");
	assert.equal(partial.rows[1], before.rows[1], "the unchanged fork keeps its row");
	assert.notDeepEqual(partial.rows[0], before.rows[0], "the changed root has a new row");

	const complete = await host.catalogProjection();
	const dated = (value: unknown): unknown =>
		JSON.parse(JSON.stringify(value).replaceAll(complete.updatedAt, partial.updatedAt));
	assert.deepEqual(partial.rows, complete.rows);
	assert.deepEqual(partial.modelEvidence, dated(complete.modelEvidence));
	assert.equal(partial.modelEvidence.sampling?.samples.length, 2);
});

it("an exact inspection of an entry outside the conversation names the call that reaches it", async (t) => {
	const f = runtimeFixture(t);
	const host = await DurableHost.open(
		hostOptions(join(f.root, "exact.sqlite"), await fixtureRuntime("answer"), fixtureRegistry(), f.cwd),
		context,
	);
	t.after(() => host.close());
	const first = await host.submit({ message: "First request", requestId: "first" });
	await host.wait(first.submissionId, context);
	const assistant = (await host.root().entries({}, 20, undefined, context)).items.find(
		(item) => item.kind === "pi.assistant",
	);
	assert.ok(assistant);
	const fork = (await host.request("fork", { entryId: assistant.id })) as {
		conversationId: Durable.ConversationId;
		identity: string;
	};
	const branch = await host.submit({
		message: "Branch request",
		requestId: "branch",
		conversationId: fork.conversationId,
	});
	await host.wait(branch.submissionId, context);
	const conversation = await host.harness.conversation(fork.conversationId, context);
	assert.ok(conversation);
	const branchEntry = (await conversation.entries({}, 1, undefined, context)).items[0];
	assert.ok(branchEntry && branchEntry.conversationId === fork.conversationId);

	await assert.rejects(
		host.request("inspect", { view: "exact", entryId: branchEntry.id }),
		new RegExp(
			`entry ${branchEntry.id} is not visible from conversation 1: it belongs to conversation ${fork.conversationId} of this storage\\. Repeat the call with sessionId ${fork.identity}\\.`,
			"u",
		),
	);
	await assert.rejects(
		host.request("inspect", { view: "exact", entryId: 99_999 }),
		/entry 99999 is not visible from conversation 1: storage \S+ holds no entry 99999\. An entry ID is valid only with the sessionId of the conversation whose activity, history or search view returned it/u,
	);
	const exact = (await host.request("inspect", {
		view: "exact",
		entryId: branchEntry.id,
		sessionId: fork.identity,
	})) as { entryId: number };
	assert.equal(exact.entryId, branchEntry.id);
});

it("the evidence that a host keeps between projections covers no more entries than one collector visits", async (t) => {
	const f = runtimeFixture(t);
	const host = await DurableHost.open(
		hostOptions(join(f.root, "retention.sqlite"), await fixtureRuntime("answer"), fixtureRegistry(), f.cwd),
		context,
	);
	t.after(() => host.close());
	const first = await host.submit({ message: "First request", requestId: "first" });
	await host.wait(first.submissionId, context);
	const assistant = (await host.root().entries({}, 20, undefined, context)).items.find(
		(item) => item.kind === "pi.assistant",
	);
	assert.ok(assistant);
	const fork = (await host.request("fork", { entryId: assistant.id })) as { conversationId: Durable.ConversationId };
	const append = (conversationId: Durable.ConversationId, count: number) =>
		host.harness.commit(async (tx) => {
			for (let index = 0; index < count; index++)
				await tx.appendEntry(Durable.AssistantEntry, conversationId, { model: [answerMessage()] });
		}, context);
	// Each conversation holds most of the entries that one collector visits; together they hold more.
	const most = Math.floor(USAGE_ENTRY_LIMIT * 0.75);
	await append(Durable.ROOT_CONVERSATION_ID, most);
	await append(fork.conversationId, most);
	const kept = (
		host as unknown as { projectedConversations: Map<Durable.ConversationId, { evidence: EvidenceEntries }> }
	).projectedConversations;
	const keptAssistants = () => [...kept.values()].reduce((total, value) => total + value.evidence.assistants.length, 0);
	const dated = (value: unknown, from: string, to: string): unknown =>
		JSON.parse(JSON.stringify(value).replaceAll(from, to));

	const complete = await host.catalogProjection();
	assert.equal(complete.modelEvidence.sampling?.entriesVisited, USAGE_ENTRY_LIMIT);
	assert.ok(
		keptAssistants() <= USAGE_ENTRY_LIMIT,
		`the host keeps ${keptAssistants()} assistant entries of ${2 * most} for a collector that visits ${USAGE_ENTRY_LIMIT} entries`,
	);

	// The root grows, so the collector takes fewer entries of the fork: the kept fork gives them up.
	await append(Durable.ROOT_CONVERSATION_ID, 500);
	const forkBefore = kept.get(fork.conversationId)?.evidence.covered ?? 0;
	const grown = await host.catalogProjection(context, new Set([Durable.ROOT_CONVERSATION_ID]));
	assert.equal(kept.get(fork.conversationId)?.evidence.covered, forkBefore - 500);
	assert.ok(keptAssistants() <= USAGE_ENTRY_LIMIT);
	const afterGrowth = await host.catalogProjection();
	assert.deepEqual(grown.rows, afterGrowth.rows);
	assert.deepEqual(grown.modelEvidence, dated(afterGrowth.modelEvidence, afterGrowth.updatedAt, grown.updatedAt));

	// A kept conversation whose reduction covers fewer entries than the collector now takes is read again. The
	// conversations before it can shrink, for example after a compaction.
	const forkKept = kept.get(fork.conversationId);
	assert.ok(forkKept);
	kept.set(fork.conversationId, { ...forkKept, evidence: trimEvidenceEntries(forkKept.evidence, 10) });
	const read: number[] = [];
	const conversation = host.harness.conversation.bind(host.harness);
	t.mock.method(host.harness, "conversation", (...args: Parameters<typeof conversation>) => {
		read.push(args[0]);
		return conversation(...args);
	});
	const reread = await host.catalogProjection(context, new Set([Durable.ROOT_CONVERSATION_ID]));
	assert.deepEqual([...new Set(read)].sort(), [Durable.ROOT_CONVERSATION_ID, fork.conversationId].sort());
	assert.deepEqual(reread.modelEvidence, dated(afterGrowth.modelEvidence, afterGrowth.updatedAt, reread.updatedAt));
	assert.ok(keptAssistants() <= USAGE_ENTRY_LIMIT);
});
