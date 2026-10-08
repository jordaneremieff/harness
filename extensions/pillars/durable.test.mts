import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createEventBus, VERSION } from "@earendil-works/pi-coding-agent";
import { collectSettings, publishSettings } from "../../settings/index.ts";
import { settings } from "./settings.ts";
import { utcDay } from "./collector.ts";
import { type DurableContributionHost, pillarsDurableContribution } from "./durable.ts";
import { PillarsStore } from "./store.ts";

const ENTRY_SOURCE = fileURLToPath(new URL("./index.ts", import.meta.url));

interface Fixture {
	root: string;
	corpus: string;
	store: string;
}

interface TestScope {
	after(fn: () => void | Promise<void>): void;
}

async function makeFixture(t: TestScope): Promise<Fixture> {
	const root = await mkdtemp(join(process.cwd(), ".pillars-durable-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const corpus = join(root, "corpus");
	await mkdir(corpus, { recursive: true });
	await writeFile(
		join(corpus, "README.md"),
		"# Inventory\n\n- [Governance](GOVERNANCE.md)\n- [Principle one](principle-one.md)\n",
	);
	await writeFile(join(corpus, "GOVERNANCE.md"), "# Governance\n\nRead the matching body.\n");
	await writeFile(join(corpus, "principle-one.md"), "# Principle one\n\nChecked evidence.\n");
	return { root, corpus, store: join(root, "store") };
}

function useFixtureEnvironment(t: TestScope, fixture: Fixture): void {
	const previous = {
		corpus: process.env.PI_PILLARS_CORPUS,
		dir: process.env.PI_PILLARS_DIR,
		collect: process.env.PI_PILLARS_COLLECT,
	};
	process.env.PI_PILLARS_CORPUS = fixture.corpus;
	process.env.PI_PILLARS_DIR = fixture.store;
	process.env.PI_PILLARS_COLLECT = "1";
	t.after(() => {
		for (const [key, value] of [
			["PI_PILLARS_CORPUS", previous.corpus],
			["PI_PILLARS_DIR", previous.dir],
			["PI_PILLARS_COLLECT", previous.collect],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

function testHost(durable: typeof Durable, fixture: Fixture, harness: Durable.Harness, signal: AbortSignal) {
	const disposers: Array<() => void | Promise<void>> = [];
	const host: DurableContributionHost = {
		durable,
		services: {} as DurableContributionHost["services"],
		cwd: fixture.corpus,
		agentDir: join(fixture.root, "agent"),
		storageId: "pillars-durable-test",
		harness,
		signal,
		onClose(dispose) {
			disposers.push(dispose);
		},
		inventory: { contributions: [{ name: "pillars", source: ENTRY_SOURCE, commands: [] }], ordinaryOnly: [] },
	};
	return {
		host,
		async closeAll(): Promise<void> {
			for (const dispose of [...disposers].reverse()) await dispose();
		},
	};
}

/** Open the host's Harness first, then install the contribution, matching the host bootstrap. */
async function openContribution(
	fixture: Fixture,
	options: { readonly storage?: Durable.Storage; readonly extra?: readonly Durable.Extension[]; readonly publisher?: Parameters<typeof pillarsDurableContribution>[1] } = {},
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	registry.install(CodingTools);
	for (const extra of options.extra ?? []) registry.install(extra);
	const harness = await Durable.Harness.open(
		options.storage ?? new Durable.MemoryStorage(),
		{
			models,
			registry,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			env: () => new NodeExecutionEnv({ cwd: fixture.corpus }),
		},
		BACKGROUND_CONTEXT,
	);
	const controller = new AbortController();
	const { host, closeAll } = testHost(Durable, fixture, harness, controller.signal);
	const bus = createEventBus();
	const publisher = options.publisher ?? {
		bus,
		stopFactory: publishSettings(bus, settings, { agentDir: host.agentDir }),
	};
	const contribution = pillarsDurableContribution(ENTRY_SOURCE, publisher);
	const extension = await contribution.create(host);
	const publications = collectSettings(publisher.bus);
	try { assert.equal(publications.snapshots().length, 1); }
	finally { publications.dispose(); }
	registry.install(extension);
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: faux.provider.id, modelId: "faux-1" } },
	});
	return { faux, harness, root, host, closeAll, controller, contribution, extension, registry };
}

function toolResults(messages: readonly { role: string }[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function textOf(message: ToolResultMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function detailsSchema(message: ToolResultMessage): string | undefined {
	return (message.details as { schema?: string } | undefined)?.schema;
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined) return new Promise(() => {});
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Wrap one tool so its first execution blocks after intent until the harness closes. */
function blockingExtension(sourceTool: Durable.ToolRegistration) {
	let blockNext = true;
	const state = { entered: 0, blocked: 0, executed: 0 };
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		release = resolve;
	});
	const extension = Durable.defineExtension({
		name: "pillars-test-blocker",
		wraps: [
			Durable.wrapTool(sourceTool, (tool) => ({
				...tool,
				execute: async (args, api, context) => {
					state.entered += 1;
					if (blockNext) {
						blockNext = false;
						state.blocked += 1;
						release();
						await aborted(context.abortSignal);
						return {};
					}
					state.executed += 1;
					return tool.execute(args, api, context);
				},
			})),
		],
	});
	return { extension, started, state };
}

async function storedCells(store: string) {
	const snapshot = await new PillarsStore(store).capture(utcDay());
	return Object.values(snapshot.shards).flatMap((shard) => shard.cells);
}

function sumCounter(
	cells: Awaited<ReturnType<typeof storedCells>>,
	counter: "readRequests" | "readResults" | "bodyVerifiedAtObservation",
): number {
	return cells.reduce((total, cell) => total + cell.counters[counter], 0);
}

test("native settings replace the factory snapshot with the host agent directory", async (t) => {
	const fixture = await makeFixture(t);
	const keys = ["PI_PILLARS_CORPUS", "PI_PILLARS_DIR", "PI_PILLARS_COLLECT", "PI_HARNESS_FILE"] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	for (const key of keys) delete process.env[key];
	t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	const nativeDir = join(fixture.root, "agent");
	const factoryDir = join(fixture.root, "factory-agent");
	await mkdir(nativeDir);
	await mkdir(factoryDir);
	await writeFile(join(factoryDir, "harness.json"), JSON.stringify({ version: 1, pillars: { corpus: join(fixture.root, "absent"), collect: true } }));
	await writeFile(join(nativeDir, "harness.json"), JSON.stringify({ version: 1, pillars: { corpus: fixture.corpus, collect: false } }));
	const bus = createEventBus();
	const collected = collectSettings(bus);
	const stopFactory = publishSettings(bus, settings, { agentDir: factoryDir, env: {} });
	assert.equal(collected.snapshots()[0].source.path, join(factoryDir, "harness.json"));
	const opened = await openContribution(fixture, { publisher: { bus, stopFactory } });
	try {
		collected.refresh();
		const snapshots = collected.snapshots();
		assert.equal(snapshots.length, 1);
		assert.equal(snapshots[0].source.path, join(nativeDir, "harness.json"));
		assert.equal(snapshots[0].records.find((record) => record.key === "dir")?.value, join(nativeDir, "pillars"));
		assert.equal(snapshots[0].records.find((record) => record.key === "corpus")?.value, fixture.corpus);
		opened.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("pillars", { resource: "principle-one" }), fauxToolCall("pillars_usage", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Consulted."),
		]);
		const result = await (await opened.root.submit({ type: "input", content: "Consult." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		assert.equal(result.status, "done");
		const results = toolResults((await opened.root.context(BACKGROUND_CONTEXT)).messages);
		assert.ok(results.some((message) => detailsSchema(message) === "pillars-source"));
		const usage = results.find((message) => detailsSchema(message) === "pillars-usage-response");
		assert.ok(usage);
		assert.equal(JSON.parse(textOf(usage)).enabled, false);
		await opened.closeAll();
		collected.refresh();
		assert.deepEqual(collected.snapshots(), []);
	} finally {
		opened.controller.abort();
		await opened.harness.close(BACKGROUND_CONTEXT);
		stopFactory();
		collected.dispose();
	}
});

test("a model-issued call reaches each tool and both declare safe replay", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const opened = await openContribution(fixture);
	t.after(() => opened.controller.abort());
	const { faux, harness, root } = opened;
	try {
		const tools = opened.extension.tools ?? [];
		assert.equal(tools.find((tool) => tool.name === "pillars")?.replay, "safe");
		assert.equal(tools.find((tool) => tool.name === "pillars_usage")?.replay, "safe");
		assert.equal("outputSchema" in (tools.find((tool) => tool.name === "pillars") ?? {}), false);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("pillars", { resource: "principle-one" }, { id: "source-call" }),
					fauxToolCall("pillars_usage", {}, { id: "usage-call" }),
					fauxToolCall("read", { path: "principle-one.md" }, { id: "read-call" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Consulted."),
		]);
		const settled = await (
			await root.submit({ type: "input", content: "Consult the corpus." }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");
		const results = toolResults((await root.context(BACKGROUND_CONTEXT)).messages);
		assert.equal(results.length, 3);
		const source = results.find((result) => result.toolCallId === "source-call");
		assert.ok(source);
		const page = JSON.parse(textOf(source));
		assert.equal(page.schema, "pillars-source");
		assert.equal(page.resource, "principle-one");
		assert.equal(detailsSchema(source), "pillars-source");
		assert.equal((source.details as { structuredContent?: unknown }).structuredContent, undefined);
		const usage = results.find((result) => result.toolCallId === "usage-call");
		assert.ok(usage);
		assert.equal(JSON.parse(textOf(usage)).schema, "pillars-usage-response");
		assert.equal(detailsSchema(usage), "pillars-usage-response");
		const read = results.find((result) => result.toolCallId === "read-call");
		assert.ok(read);
		assert.match(textOf(read), /Checked evidence/u);
		const system = (await root.context(BACKGROUND_CONTEXT)).messages.find(
			(message) => message.role === "system" && typeof message.sections?.pillars === "string",
		);
		assert.ok(system && system.role === "system");
		assert.match(system.sections?.pillars ?? "", /Call pillars at judgment moments/u);
		assert.equal(
			results.some((result) => textOf(result).includes("<harness>")),
			false,
			"a call without a draft delivers no assessment diagnostic",
		);
		const resolved = await root.agent(BACKGROUND_CONTEXT);
		const cells = await storedCells(fixture.store);
		assert.equal(sumCounter(cells, "readRequests"), 2);
		assert.equal(sumCounter(cells, "readResults"), 2);
		assert.equal(sumCounter(cells, "bodyVerifiedAtObservation"), 2);
		assert.ok(cells.every((cell) => cell.piVersion === VERSION));
		assert.equal(resolved.model?.provider, faux.provider.id);
		assert.ok(cells.every((cell) => cell.model === `${resolved.model?.provider}/${resolved.model?.modelId}`));
		assert.ok(cells.every((cell) => cell.reasoning === resolved.thinkingLevel));
		assert.notEqual(resolved.thinkingLevel, "unknown");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("a draft returns one assessment diagnostic beside the unchanged source page", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const opened = await openContribution(fixture);
	t.after(() => opened.controller.abort());
	const { faux, harness, root } = opened;
	try {
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"pillars",
						{ resource: "principle-one", draft: "Ship the change unchecked." },
						{ id: "draft-call" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Corrected."),
		]);
		const settled = await (await root.submit({ type: "input", content: "Check this plan." }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled.status, "done");
		const [result] = toolResults((await root.context(BACKGROUND_CONTEXT)).messages);
		assert.equal(result.isError, false);
		assert.equal(JSON.parse(textOf(result).split("<harness>")[0]).schema, "pillars-source");
		assert.match(textOf(result), /Pillars extension assessment task/u);
		assert.match(textOf(result), /Ship the change unchecked/u);
		assert.equal(detailsSchema(result), "pillars-source");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("the pillars command steers the judgment prompt and reuses one invocation", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const opened = await openContribution(fixture);
	t.after(() => opened.controller.abort());
	const { faux, harness, root, host } = opened;
	try {
		const command = opened.contribution.commands?.find((entry) => entry.name === "pillars");
		assert.ok(command);
		const call = {
			args: "check the proposed error handling",
			conversation: root,
			harness,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "judgment-invocation",
		};
		faux.setResponses([fauxAssistantMessage("Checked.")]);
		const result = await command.run(call);
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.match(result, /Submitted the Pillars check request as submission \d+\./u);
		const users = (await root.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "user");
		assert.equal(users.length, 1);
		const prompt = users[0];
		assert.ok(typeof prompt.content === "string");
		assert.match(prompt.content, /operator invoked \/pillars check/u);
		assert.match(prompt.content, /proposed error handling/u);
		const again = await command.run(call);
		assert.equal(again, result, "the same invocation reuses its submission");
		assert.equal(
			(await root.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "user").length,
			1,
			"the repeated invocation submits no second prompt",
		);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("the pillars command joins an active run as a steer", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const opened = await openContribution(fixture);
	t.after(() => opened.controller.abort());
	const { faux, harness, root, host } = opened;
	try {
		const command = opened.contribution.commands?.find((entry) => entry.name === "pillars");
		assert.ok(command);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let steered = false;
		faux.setResponses([
			async () => {
				entered();
				await held;
				return fauxAssistantMessage("Held.");
			},
			(context) => {
				steered = JSON.stringify(context.messages).includes("busy hint");
				return fauxAssistantMessage("Steered.");
			},
		]);
		const active = await root.submit({ type: "input", content: "Hold the run." }, BACKGROUND_CONTEXT);
		await started;
		await command.run({
			args: "derive busy hint",
			conversation: root,
			harness,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "busy-invocation",
		});
		release();
		await active.wait(BACKGROUND_CONTEXT);
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(steered, true);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("a stored-safe call reruns after process loss and records one completed observation", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const database = join(fixture.root, "session.sqlite");
	const first = await openContribution(fixture, { storage: await openNodeSqliteStorage(database) });
	t.after(() => first.controller.abort());
	const sourceTool = (first.extension.tools ?? []).find((tool) => tool.name === "pillars");
	assert.ok(sourceTool);
	const blocker = blockingExtension(sourceTool);
	first.registry.install(blocker.extension);
	first.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("pillars", { resource: "principle-one" }, { id: "recover-call" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("First attempt."),
	]);
	const submissionId = (await first.root.submit({ type: "input", content: "Consult the corpus." }, BACKGROUND_CONTEXT))
		.id;
	await blocker.started;
	await first.harness.close(BACKGROUND_CONTEXT);
	await first.closeAll();

	const second = await openContribution(fixture, {
		storage: await openNodeSqliteStorage(database),
		extra: [blocker.extension],
	});
	t.after(() => second.controller.abort());
	try {
		second.faux.setResponses([fauxAssistantMessage("Recovered.")]);
		const submission = await second.harness.submission(submissionId, BACKGROUND_CONTEXT);
		assert.ok(submission);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");
		assert.equal(blocker.state.entered, 2, "the stored-safe call ran again after reopen");
		assert.equal(blocker.state.blocked, 1);
		assert.equal(blocker.state.executed, 1, "the interrupted attempt did not execute the tool");
		const [result] = toolResults((await second.root.context(BACKGROUND_CONTEXT)).messages);
		assert.equal(result.isError, false);
		assert.equal(detailsSchema(result), "pillars-source");
		const cells = await storedCells(fixture.store);
		const entry = cells.filter((cell) => cell.resourceClass === "entry" && cell.resourceId === "principle-one");
		assert.equal(sumCounter(entry, "readResults"), 1, "the recovered result is observed once");
		assert.equal(sumCounter(entry, "bodyVerifiedAtObservation"), 1);
	} finally {
		await second.harness.close(BACKGROUND_CONTEXT);
	}
});

test("the close flush completes before onClose resolves", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const opened = await openContribution(fixture);
	t.after(() => opened.controller.abort());
	const sourceTool = (opened.extension.tools ?? []).find((tool) => tool.name === "pillars");
	assert.ok(sourceTool);
	const blocker = blockingExtension(sourceTool);
	opened.registry.install(blocker.extension);
	try {
		opened.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("pillars", { resource: "principle-one" }, { id: "pending-call" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Interrupted."),
		]);
		await opened.root.submit({ type: "input", content: "Consult the corpus." }, BACKGROUND_CONTEXT);
		await blocker.started;
		await opened.harness.close(BACKGROUND_CONTEXT);
		assert.equal((await storedCells(fixture.store)).length, 0, "the interrupted round left its observation pending");
		await opened.closeAll();
		assert.equal(
			sumCounter(await storedCells(fixture.store), "readRequests"),
			1,
			"the close flush stored the pending request",
		);
	} finally {
		await opened.harness.close(BACKGROUND_CONTEXT);
	}
});
