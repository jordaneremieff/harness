/**
 * Runs the registry Durable contribution in a real Harness over MemoryStorage
 * with pi-ai's faux provider. Each query kind is driven by a model-issued call,
 * so the records and the result shape are the ones the tool actually returns.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import {
	createRegistryDurableContribution,
	readContextEstimate,
	type RegistryDurableHost,
	type RegistryDurableServices,
} from "./durable.ts";
import { RegistryOutputSchema } from "./output.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { fakePublisher, publication } from "./configuration-fixtures.mts";
const settingsBus = createEventBus();

const ROOT = await mkdtemp(join(tmpdir(), "registry-durable-"));
after(async () => {
	await rm(ROOT, { recursive: true, force: true });
});

const REGISTRY_SOURCE = fileURLToPath(new URL("./index.ts", import.meta.url));
const OTHER_SOURCE = join(ROOT, "other", "extension.ts");
const ORDINARY_ONLY = join(ROOT, "ordinary-only", "extension.ts");
const CWD = join(ROOT, "workspace");
const AGENT_DIR = join(ROOT, "agent");
const SKILL_PATH = join(ROOT, "skills", "example", "SKILL.md");
const PHRASE = "distinctive durable phrase";
await mkdir(dirname(SKILL_PATH), { recursive: true });
await writeFile(
	SKILL_PATH,
	`---\nname: example-skill\ndescription: Example skill\ndisable-model-invocation: true\n---\n\nA ${PHRASE} for scanning.\n`,
);

const SKILL_SOURCE: SourceInfo = {
	path: SKILL_PATH,
	source: "local",
	scope: "temporary",
	origin: "top-level",
	baseDir: dirname(SKILL_PATH),
};
const PROMPT_SOURCE: SourceInfo = {
	path: join(ROOT, "prompts", "example.md"),
	source: "local",
	scope: "temporary",
	origin: "top-level",
};
const REGISTRY_SOURCE_INFO: SourceInfo = { path: "<inline:registry-fixture>", source: "local", scope: "temporary", origin: "top-level" };
const OTHER_SOURCE_INFO: SourceInfo = { path: "<inline:other-fixture>", source: "local", scope: "temporary", origin: "top-level" };

function resourceLoader(probes: string[] = []) {
	return {
		getSkills: () => {
			probes.push("skills");
			return {
				skills: [
					{
						name: "example-skill",
						description: "Example skill",
						filePath: SKILL_PATH,
						baseDir: dirname(SKILL_PATH),
						sourceInfo: SKILL_SOURCE,
						disableModelInvocation: true,
					},
				],
			};
		},
		getPrompts: () => {
			probes.push("prompts");
			return { prompts: [{ name: "example-prompt", description: "Example prompt", sourceInfo: PROMPT_SOURCE }] };
		},
		getAgentsFiles: () => {
			probes.push("agentsFiles");
			return { agentsFiles: [{ path: join(CWD, "AGENTS.md"), content: "fixture instructions" }] };
		},
		getExtensions: () => {
			probes.push("extensions");
			return {
				extensions: [
					{ path: REGISTRY_SOURCE, resolvedPath: REGISTRY_SOURCE, sourceInfo: REGISTRY_SOURCE_INFO },
					{ path: OTHER_SOURCE, resolvedPath: OTHER_SOURCE, sourceInfo: OTHER_SOURCE_INFO },
				],
			};
		},
		getSystemPrompt: () => {
			probes.push("systemPrompt");
			return "fixture system prompt";
		},
		getAppendSystemPrompt: () => {
			probes.push("appendSystemPrompt");
			return [];
		},
	};
}

function modelReader(models: ReturnType<typeof createModels>, probes: string[] = []) {
	return {
		getModels: () => {
			probes.push("models");
			return models.getModels();
		},
		getModel: (provider: string, modelId: string) => models.getModel(provider, modelId),
		getAvailableSnapshot: () => {
			probes.push("available");
			return models.getModels();
		},
		getError: () => {
			probes.push("error");
			return undefined;
		},
		getRegisteredProviderIds: () => {
			probes.push("providers");
			return ["faux"];
		},
		isUsingOAuth: () => false,
		isUsingSubscription: () => false,
		getProviderAuthStatus: () => ({ source: "environment" as const }),
		hasConfiguredAuth: () => {
			probes.push("auth");
			return true;
		},
	};
}

function host(services: RegistryDurableServices, signal: AbortSignal = new AbortController().signal): RegistryDurableHost {
	return {
		durable: Durable,
		services,
		cwd: CWD,
		agentDir: AGENT_DIR,
		storageId: "registry-durable-test",
		onClose: () => {},
		signal,
		inventory: {
			contributions: [
				{ name: "registry", source: REGISTRY_SOURCE, commands: [] },
				{
					name: "other",
					source: OTHER_SOURCE,
					commands: [{ name: "other-status", description: "Report the other extension status" }],
				},
			],
			ordinaryOnly: [ORDINARY_ONLY],
		},
	};
}

function objectOf(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordsOf(result: ToolResultMessage): Record<string, unknown>[] {
	const details = objectOf(result.details);
	const records = details.records;
	return Array.isArray(records) ? records.map(objectOf) : [];
}

function toolResult(messages: readonly Message[], id: string): ToolResultMessage {
	const found = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id,
	);
	assert.ok(found, `missing tool result ${id}`);
	return found;
}

function textOf(result: ToolResultMessage): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function fixture() {
	const probes: string[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux One", contextWindow: 200000, maxTokens: 8192 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const services: RegistryDurableServices = { resourceLoader: resourceLoader(probes), modelRuntime: modelReader(models, probes),
		settingsManager: { isProjectTrusted: () => true } };
	return { probes, faux, models, services };
}

async function open(models: Fixture["models"], extension: Durable.Extension) {
	const registry = Durable.createRegistry();
	registry.install(extension);
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { harness, root };
}

type Fixture = ReturnType<typeof fixture>;

test("durable registry answers model-issued queries from native Durable facts", async () => {
	const { faux, models, services } = fixture();
	const contribution = createRegistryDurableContribution(REGISTRY_SOURCE, settingsBus);
	const extension = await contribution.create(host(services));
	assert.equal(extension.name, "registry");
	assert.equal(extension.tools?.length, 1);
	const registration = extension.tools?.[0];
	assert.ok(registration);
	assert.equal(registration.name, "registry");
	assert.equal(registration.replay, "safe");
	for (const listed of extension.tools ?? []) assert.equal(listed.replay, "safe");
	assert.equal((registration as { outputSchema?: unknown }).outputSchema, RegistryOutputSchema);
	const guidance = extension.sections?.[0];
	assert.ok(guidance);
	assert.match(
		(await guidance.render({ agent: { tools: [{ name: "registry" }] } } as never, BACKGROUND_CONTEXT)) as string,
		/Discover session resources, chat models/,
	);
	assert.equal(await guidance.render({ agent: { tools: [{ name: "other" }] } } as never, BACKGROUND_CONTEXT), undefined);

	const { harness, root } = await open(models, extension);
	try {
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("registry", { kind: "tool", name: "registry", detail: true }, { id: "tool" }),
					fauxToolCall("registry", { kind: "command" }, { id: "command" }),
					fauxToolCall("registry", { kind: "skill" }, { id: "skill" }),
					fauxToolCall("registry", { kind: "prompt" }, { id: "prompt" }),
					fauxToolCall("registry", { kind: "skill", name: "example-skill", contains: PHRASE }, { id: "contains" }),
					fauxToolCall("registry", { kind: "model", name: "faux/faux-1" }, { id: "model" }),
					fauxToolCall("registry", { kind: "model", name: `unconfigured-${models.getModels().length}/missing-${models.getModels().length}` }, { id: "non-chat" }),
					fauxToolCall("registry", { kind: "context_file" }, { id: "context" }),
					fauxToolCall("registry", {}, { id: "summary" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Inspected."),
		]);
		const settled = await (await root.submit({ type: "input", content: "Inspect the registry." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done", settled.status === "unanswered" ? settled.reason : undefined);
		const { messages } = await root.context(BACKGROUND_CONTEXT);

		const tool = toolResult(messages, "tool");
		assert.equal(tool.isError, false, textOf(tool));
		assert.match(textOf(tool), /source: Durable registry snapshot/);
		const toolDetails = objectOf(tool.details);
		assert.equal(toolDetails.outcome, "ok");
		const toolRecords = recordsOf(tool);
		assert.equal(toolRecords.length, 1);
		assert.equal(toolRecords[0]?.kind, "tool");
		assert.equal(toolRecords[0]?.name, "registry");
		assert.equal(toolRecords[0]?.configured, true);
		assert.equal(toolRecords[0]?.active, true);
		assert.equal(objectOf(toolRecords[0]?.sourceInfo).path, "<inline:registry-fixture>");
		assert.ok(objectOf(toolRecords[0]?.parameters));
		assert.deepEqual(objectOf(toolDetails.structuredContent).records, toolDetails.records);

		const command = toolResult(messages, "command");
		assert.equal(command.isError, false, textOf(command));
		const commandRecords = recordsOf(command);
		assert.deepEqual(commandRecords.map((record) => record.name), ["other-status"]);
		assert.equal(commandRecords[0]?.kind, "command");
		assert.equal(objectOf(commandRecords[0]?.sourceInfo).path, "<inline:other-fixture>");
		assert.equal(Object.hasOwn(commandRecords[0] ?? {}, "invocation"), false);
		assert.match(textOf(command), /Configured extensions without a Durable form are not invokable/);

		const skill = toolResult(messages, "skill");
		assert.equal(skill.isError, false, textOf(skill));
		const skillRecords = recordsOf(skill);
		assert.equal(skillRecords[0]?.kind, "skill");
		assert.equal(skillRecords[0]?.name, "example-skill");
		assert.equal(skillRecords[0]?.invocation, "skill:example-skill");
		const modelInvocable = objectOf(skillRecords[0]?.modelInvocable);
		assert.equal(modelInvocable.value, false);
		assert.equal(modelInvocable.evidence, "observation");
		assert.equal(typeof modelInvocable.at, "number");
		assert.equal(objectOf(skillRecords[0]?.baseDir).value, SKILL_SOURCE.baseDir);

		const prompt = toolResult(messages, "prompt");
		assert.equal(prompt.isError, false, textOf(prompt));
		const promptRecords = recordsOf(prompt);
		assert.equal(promptRecords[0]?.kind, "prompt");
		assert.equal(promptRecords[0]?.name, "example-prompt");
		assert.equal(Object.hasOwn(promptRecords[0] ?? {}, "invocation"), false);

		const contains = toolResult(messages, "contains");
		assert.equal(contains.isError, false, textOf(contains));
		assert.match(textOf(contains), /distinctive durable phrase/);
		const containsDetails = objectOf(contains.details);
		assert.equal(containsDetails.outcome, "ok");
		assert.equal(containsDetails.scanned, true);
		assert.equal(containsDetails.evidence, "file_content");
		assert.ok((containsDetails.bytesRead as number) > 0);

		const model = toolResult(messages, "model");
		assert.equal(model.isError, false, textOf(model));
		const modelRecords = recordsOf(model);
		const selected = modelRecords.find((record) => record.name === "faux/faux-1");
		assert.ok(selected, JSON.stringify(modelRecords));
		assert.equal(selected.selected, true);
		assert.equal(selected.catalog, true);
		assert.equal(selected.available, true);
		assert.equal(selected.configuredAuth, true);
		assert.equal(selected.extensionProvider, true);
		assert.equal(selected.inScope, null);
		assert.equal(selected.providerHasScopedModels, null);
		assert.equal(objectOf(objectOf(model.details).settingsScope).status, "absent");
		assert.equal(typeof selected.currentThinkingLevel, "string");
		assert.match(String(objectOf(model.details).catalogBoundary), /Chat models only/);

		const nonChat = toolResult(messages, "non-chat");
		const nonChatDetails = objectOf(nonChat.details);
		assert.equal(nonChatDetails.outcome, "missing");
		assert.deepEqual(recordsOf(nonChat), []);
		assert.match(textOf(nonChat), /missing here does not establish their absence/);
		assert.match(String(nonChatDetails.catalogBoundary), /models\.getModelsOfType\("classifier"\)/);
		const scriptValue = objectOf(nonChatDetails.structuredContent);
		assert.equal(scriptValue.catalogBoundary, nonChatDetails.catalogBoundary);

		const context = toolResult(messages, "context");
		assert.equal(context.isError, false, textOf(context));
		const contextRecords = recordsOf(context);
		assert.deepEqual(contextRecords.map((record) => record.path), [join(CWD, "AGENTS.md")]);
		assert.equal(objectOf(context.details).outcome, "ok");

		const summary = toolResult(messages, "summary");
		assert.equal(summary.isError, false, textOf(summary));
		const summaryDetails = objectOf(summary.details);
		assert.equal(summaryDetails.outcome, "host_summary");
		assert.equal(summaryDetails.host, true);
		assert.deepEqual(summaryDetails.counts, { tool: 1, command: 1, skill: 1, prompt: 1 });
		assert.deepEqual(summaryDetails.availability, { tools: true, activeTools: true, commands: true });
		const summaryContext = objectOf(summaryDetails.context);
		assert.equal(summaryContext.state, "available");
		assert.equal(summaryContext.model, "faux/faux-1");
		assert.equal(summaryContext.contextWindow, 200000);
		assert.equal(typeof summaryContext.tokens, "number");
		assert.ok((summaryContext.tokens as number) > 0);
		assert.equal(summaryContext.percent, ((summaryContext.tokens as number) / 200000) * 100);
		assert.match(textOf(summary), /DURABLE COVERAGE/);
		assert.match(textOf(summary), /contributions: 2 \(registry, other\)/);
		assert.match(textOf(summary), new RegExp(ORDINARY_ONLY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(textOf(summary), /context usage: available/);
		assert.ok(textOf(summary).includes(`- cwd: ${CWD}`));
		assert.match(textOf(summary), /- storageId: registry-durable-test/);
		assert.match(textOf(summary), /- conversationId: 1(\n|$)/);
		assert.match(textOf(summary), /- agentId: <registry-durable-test>(\n|$)/);
		assert.doesNotMatch(JSON.stringify(summary), /fixture instructions|fixture system prompt/);
		assert.doesNotMatch(textOf(tool), /fixture system prompt/);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("Durable model pages carry present, absent, and unreadable settings evidence", async () => {
	for (const state of ["available", "absent", "unavailable"] as const) {
		const { faux, models, services } = fixture();
		const directory = await mkdtemp(join(ROOT, "settings-"));
		const cwd = join(directory, "workspace");
		const agentDir = join(directory, "agent");
		await mkdir(agentDir, { recursive: true });
		const selected = models.getModels()[0];
		const patterns = [`${selected.provider}/${selected.id}:high`];
		const scopeFile = join(agentDir, "settings.json");
		if (state !== "absent") await writeFile(scopeFile, state === "available" ? JSON.stringify({ enabledModels: patterns }) : "private-invalid-settings");
		const nativeHost = { ...host(services), cwd, agentDir };
		const extension = await createRegistryDurableContribution(REGISTRY_SOURCE, settingsBus).create(nativeHost);
		const { harness, root } = await open(models, extension);
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("registry", { kind: "model" }, { id: "settings" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Inspected."),
			]);
			await (await root.submit({ type: "input", content: "Inspect models." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
			const result = toolResult((await root.context(BACKGROUND_CONTEXT)).messages, "settings");
			assert.equal(result.isError, false, textOf(result));
			const details = objectOf(result.details);
			const scope = objectOf(details.settingsScope);
			assert.equal(scope.status, state);
			assert.deepEqual(scope.patterns, state === "available" ? patterns : null);
			assert.equal(typeof scope.observedAt, "number");
			assert.deepEqual(objectOf(details.structuredContent).settingsScope, scope);
			assert.ok(recordsOf(result).every((record) => record.inScope === null && record.providerHasScopedModels === null));
			assert.ok(recordsOf(result).every((record) => record.providerNamedInSettings ===
				(state === "available" ? record.provider === selected.provider : null)));
			assert.doesNotMatch(JSON.stringify(result), /private-invalid-settings/);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	}
});

test("an aborted host signal cancels the query without probing host facts", async () => {
	const probes: string[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux One", contextWindow: 200000, maxTokens: 8192 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const services: RegistryDurableServices = { resourceLoader: resourceLoader(probes), modelRuntime: modelReader(models, probes),
		settingsManager: { isProjectTrusted: () => true } };
	const aborted = new AbortController();
	aborted.abort();
	const extension = await createRegistryDurableContribution(REGISTRY_SOURCE, settingsBus).create(host(services, aborted.signal));
	const { harness, root } = await open(models, extension);
	try {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("registry", {}, { id: "cancelled" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Stopped."),
		]);
		await (await root.submit({ type: "input", content: "Inspect." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const { messages } = await root.context(BACKGROUND_CONTEXT);
		const cancelled = toolResult(messages, "cancelled");
		assert.equal(cancelled.isError, false, textOf(cancelled));
		assert.equal(objectOf(cancelled.details).outcome, "cancelled");
		assert.deepEqual(probes, []);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("reports the Durable agent identity for the root and a non-root conversation", async () => {
	const { faux, models, services } = fixture();
	const extension = await createRegistryDurableContribution(REGISTRY_SOURCE, settingsBus).create(host(services));
	const { harness, root } = await open(models, extension);
	try {
		const other = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
			BACKGROUND_CONTEXT,
		);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("registry", {}, { id: "root-summary" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Root done."),
		]);
		await (await root.submit({ type: "input", content: "Root summary." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("registry", {}, { id: "other-summary" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Other done."),
		]);
		await (await other.submit({ type: "input", content: "Other summary." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const rootText = textOf(toolResult((await root.context(BACKGROUND_CONTEXT)).messages, "root-summary"));
		const otherText = textOf(toolResult((await other.context(BACKGROUND_CONTEXT)).messages, "other-summary"));
		assert.match(rootText, /- storageId: registry-durable-test/);
		assert.match(rootText, /- conversationId: 1(\n|$)/);
		assert.match(rootText, /- agentId: <registry-durable-test>(\n|$)/);
		assert.match(otherText, new RegExp(`- conversationId: ${String(other.id)}(\\n|$)`));
		assert.match(otherText, new RegExp(`- agentId: <registry-durable-test:${String(other.id)}>(\\n|$)`));
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

const TEST_CONVERSATION = 2 as unknown as Durable.ConversationId;

function testUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantEntry(id: number, usage: Usage, stopReason: AssistantMessage["stopReason"] = "stop"): Durable.EntryRecord {
	return {
		id: id as unknown as Durable.EntryId,
		conversationId: TEST_CONVERSATION,
		kind: Durable.AssistantEntry.kind,
		model: [
			{
				role: "assistant",
				content: [{ type: "text", text: "fixture response" }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage,
				stopReason,
				timestamp: id,
			},
		],
	};
}

function headEntry(id: number, kind: string): Durable.EntryRecord {
	return {
		id: id as unknown as Durable.EntryId,
		conversationId: TEST_CONVERSATION,
		kind,
		head: id as unknown as Durable.EntryId,
	};
}

function estimateApi(entries: readonly Durable.EntryRecord[]): Durable.ToolExecutionApi {
	const tx = { scanEntries: async () => ({ items: entries, next: undefined }) };
	return {
		conversationId: TEST_CONVERSATION,
		commit: async (change: (tx: unknown) => unknown) => change(tx),
	} as unknown as Durable.ToolExecutionApi;
}

test("the Durable context estimate reads committed usage and honors context boundaries", async () => {
	const { services } = fixture();
	const durableHost = host(services);
	const agent = {
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
		extensions: [],
		tools: [],
		sections: [],
	} as unknown as Durable.Agent;
	const estimate = (entries: readonly Durable.EntryRecord[]) =>
		readContextEstimate(durableHost, estimateApi(entries), agent, 7, BACKGROUND_CONTEXT);

	const available = await estimate([assistantEntry(9, testUsage(100, 25))]);
	assert.equal(available.state, "available");
	assert.equal(available.at, 7);
	assert.equal(available.model, "faux/faux-1");
	assert.equal(available.thinkingLevel, "off");
	assert.equal(available.tokens, 125);
	assert.equal(available.contextWindow, 200000);
	assert.equal(available.percent, (125 / 200000) * 100);

	const afterReset = await estimate([headEntry(9, Durable.ResetEntry.kind), assistantEntry(8, testUsage(100, 25))]);
	assert.equal(afterReset.state, "unknown");
	assert.equal(afterReset.tokens, null);
	assert.equal(afterReset.percent, null);
	assert.equal(afterReset.contextWindow, 200000);

	const afterCompaction = await estimate([headEntry(9, Durable.CompactionEntry.kind), assistantEntry(8, testUsage(100, 25))]);
	assert.equal(afterCompaction.state, "unknown");
	assert.equal(afterCompaction.tokens, null);

	const zero = await estimate([assistantEntry(9, testUsage(0, 0))]);
	assert.equal(zero.state, "unknown");
	assert.equal(zero.tokens, null);

	const older = await estimate([assistantEntry(9, testUsage(0, 0)), assistantEntry(8, testUsage(40, 10))]);
	assert.equal(older.state, "available");
	assert.equal(older.tokens, 50);

	const empty = await estimate([]);
	assert.equal(empty.state, "unknown");
	assert.equal(empty.tokens, null);

	const failing = {
		conversationId: TEST_CONVERSATION,
		commit: async () => { throw new Error("transaction unavailable"); },
	} as unknown as Durable.ToolExecutionApi;
	const unavailable = await readContextEstimate(durableHost, failing, agent, 7, BACKGROUND_CONTEXT);
	assert.equal(unavailable.state, "unavailable");
	assert.equal(unavailable.tokens, null);
	assert.equal(unavailable.contextWindow, 200000);

	const windowlessServices: RegistryDurableServices = {
		...services,
		modelRuntime: { ...services.modelRuntime, getModel: () => undefined },
	};
	const windowless = await readContextEstimate(
		host(windowlessServices),
		estimateApi([assistantEntry(9, testUsage(1, 1))]),
		agent,
		7,
		BACKGROUND_CONTEXT,
	);
	assert.equal(windowless.state, "unavailable");
	assert.equal(windowless.contextWindow, null);
});

test("native setting queries use the captured host bus and release collection on host close", async () => {
	const { faux, models, services } = fixture();
	const bus = createEventBus();
	const directory = await mkdtemp(join(tmpdir(), "registry-native-settings-"));
	const current = publication();
	current.source = { ...current.source, path: join(directory, "harness.json"), status: "loaded" };
	current.records = [{ ...current.records[0], value: 8, origin: "file" }];
	const dispose = fakePublisher(bus, () => current);
	const close: (() => void | Promise<void>)[] = [];
	let requests = 0;
	bus.on("harness:settings:request", () => { requests++; });
	let subscriptions = 0;
	let releases = 0;
	const observedBus = { ...bus, on(channel: string, handler: (data: unknown) => void) {
		const unsubscribe = bus.on(channel, handler);
		if (channel === "harness:settings:publish") subscriptions++;
		return () => { if (channel === "harness:settings:publish") releases++; unsubscribe(); };
	} };
	const nativeHost = { ...host(services), agentDir: directory, onClose: (callback: () => void | Promise<void>) => { close.push(callback); } };
	const extension = await createRegistryDurableContribution(REGISTRY_SOURCE, observedBus).create(nativeHost);
	const { harness, root } = await open(models, extension);
	try {
		faux.setResponses([fauxAssistantMessage([fauxToolCall("registry", { kind: "setting" }, { id: "setting" })], { stopReason: "toolUse" }), fauxAssistantMessage("Inspected.")]);
		const result = await (await root.submit({ type: "input", content: "Inspect configuration." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		assert.equal(result.status, "done");
		const { messages } = await root.context(BACKGROUND_CONTEXT);
		const settings = toolResult(messages, "setting");
		const records = recordsOf(settings);
		assert.equal(records[0].kind, "setting");
		assert.equal(records[0].value, 8);
		assert.equal(records[0].origin, "file");
		assert.equal(records[0].documentPath, join(directory, "harness.json"));
		assert.equal(requests, 1);
		assert.equal(subscriptions, 1);
		assert.equal(releases, 0);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("registry", { kind: "setting" }, { id: "refresh" })], { stopReason: "toolUse" }), fauxAssistantMessage("Refreshed.")]);
		current.records[0].value = 9;
		await (await root.submit({ type: "input", content: "Inspect configuration again." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const refreshed = await root.context(BACKGROUND_CONTEXT);
		assert.equal(recordsOf(toolResult(refreshed.messages, "refresh"))[0].value, 9);
		assert.equal(requests, 2);
		assert.equal(subscriptions, 1);
		assert.deepEqual(objectOf(objectOf(settings.details).structuredContent).records, records);
		assert.match(textOf(settings), /not proof a running runtime applied/);
		assert.equal(close.length, 1);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		for (const callback of close) await callback();
		assert.equal(releases, 1);
		for (const callback of close) await callback();
		assert.equal(releases, 1);
		dispose(); bus.clear(); await rm(directory, { recursive: true, force: true });
	}
});
