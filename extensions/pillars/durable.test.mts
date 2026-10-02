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
import { VERSION } from "@earendil-works/pi-coding-agent";
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

function testHost(durable: typeof Durable, fixture: Fixture, signal: AbortSignal) {
	const disposers: Array<() => void | Promise<void>> = [];
	const host: DurableContributionHost = {
		durable,
		services: {} as DurableContributionHost["services"],
		cwd: fixture.corpus,
		agentDir: join(fixture.root, "agent"),
		storageId: "pillars-durable-test",
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

async function openHarness(
	extension: Durable.Extension,
	corpus: string,
	options: { readonly storage?: Durable.Storage; readonly extra?: readonly Durable.Extension[] } = {},
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	registry.install(CodingTools);
	registry.install(extension);
	for (const extra of options.extra ?? []) registry.install(extra);
	const harness = await Durable.Harness.open(
		options.storage ?? new Durable.MemoryStorage(),
		{
			models,
			registry,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			env: () => new NodeExecutionEnv({ cwd: corpus }),
		},
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: faux.provider.id, modelId: "faux-1" } },
	});
	return { faux, harness, root };
}

function toolResults(messages: readonly { role: string }[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function textOf(message: ToolResultMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function structuredSchema(message: ToolResultMessage): string | undefined {
	return (message.details as { structuredContent?: { schema?: string } } | undefined)?.structuredContent?.schema;
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

test("a model-issued call reaches each tool and both declare safe replay", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const controller = new AbortController();
	t.after(() => controller.abort());
	const contribution = pillarsDurableContribution(ENTRY_SOURCE);
	const { host } = testHost(Durable, fixture, controller.signal);
	const extension = await contribution.create(host);
	const tools = extension.tools ?? [];
	assert.equal(tools.find((tool) => tool.name === "pillars")?.replay, "safe");
	assert.equal(tools.find((tool) => tool.name === "pillars_usage")?.replay, "safe");
	assert.ok("outputSchema" in (tools.find((tool) => tool.name === "pillars") ?? {}));
	const { faux, harness, root } = await openHarness(extension, fixture.corpus);
	try {
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
		assert.equal(structuredSchema(source), "pillars-source");
		const usage = results.find((result) => result.toolCallId === "usage-call");
		assert.ok(usage);
		assert.equal(JSON.parse(textOf(usage)).schema, "pillars-usage-response");
		assert.equal(structuredSchema(usage), "pillars-usage-response");
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
		const cells = await storedCells(fixture.store);
		assert.equal(sumCounter(cells, "readRequests"), 2);
		assert.equal(sumCounter(cells, "readResults"), 2);
		assert.equal(sumCounter(cells, "bodyVerifiedAtObservation"), 2);
		assert.ok(cells.every((cell) => cell.piVersion === VERSION));
		assert.ok(cells.every((cell) => cell.model === `${faux.provider.id}/faux-1`));
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("a draft returns one assessment diagnostic beside the unchanged source page", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const controller = new AbortController();
	t.after(() => controller.abort());
	const contribution = pillarsDurableContribution(ENTRY_SOURCE);
	const { host } = testHost(Durable, fixture, controller.signal);
	const extension = await contribution.create(host);
	const { faux, harness, root } = await openHarness(extension, fixture.corpus);
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
		assert.equal(structuredSchema(result), "pillars-source");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("a stored-safe call reruns after process loss and records one completed observation", async (t) => {
	const fixture = await makeFixture(t);
	useFixtureEnvironment(t, fixture);
	const database = join(fixture.root, "session.sqlite");
	const controller = new AbortController();
	t.after(() => controller.abort());
	const firstContribution = pillarsDurableContribution(ENTRY_SOURCE);
	const firstHost = testHost(Durable, fixture, controller.signal);
	const firstExtension = await firstContribution.create(firstHost.host);
	const sourceTool = (firstExtension.tools ?? []).find((tool) => tool.name === "pillars");
	assert.ok(sourceTool);
	const blocker = blockingExtension(sourceTool);
	const first = await openHarness(firstExtension, fixture.corpus, {
		storage: await openNodeSqliteStorage(database),
		extra: [blocker.extension],
	});
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
	await firstHost.closeAll();

	const secondContribution = pillarsDurableContribution(ENTRY_SOURCE);
	const secondHost = testHost(Durable, fixture, controller.signal);
	const secondExtension = await secondContribution.create(secondHost.host);
	const second = await openHarness(secondExtension, fixture.corpus, {
		storage: await openNodeSqliteStorage(database),
		extra: [blocker.extension],
	});
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
		assert.equal(structuredSchema(result), "pillars-source");
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
	const controller = new AbortController();
	t.after(() => controller.abort());
	const contribution = pillarsDurableContribution(ENTRY_SOURCE);
	const { host, closeAll } = testHost(Durable, fixture, controller.signal);
	const extension = await contribution.create(host);
	const sourceTool = (extension.tools ?? []).find((tool) => tool.name === "pillars");
	assert.ok(sourceTool);
	const blocker = blockingExtension(sourceTool);
	const { faux, harness, root } = await openHarness(extension, fixture.corpus, { extra: [blocker.extension] });
	try {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("pillars", { resource: "principle-one" }, { id: "pending-call" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Interrupted."),
		]);
		await root.submit({ type: "input", content: "Consult the corpus." }, BACKGROUND_CONTEXT);
		await blocker.started;
		await harness.close(BACKGROUND_CONTEXT);
		assert.equal((await storedCells(fixture.store)).length, 0, "the interrupted round left its observation pending");
		await closeAll();
		assert.equal(
			sumCounter(await storedCells(fixture.store), "readRequests"),
			1,
			"the close flush stored the pending request",
		);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});
