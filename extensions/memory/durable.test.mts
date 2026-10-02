import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import type { AgentSessionServices, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryDurableContribution, MemoryDurableContributionHost } from "./durable.ts";
import memory from "./index.ts";
import { memorySearchOutputSchema } from "./search-output.ts";

function emitContribution(): MemoryDurableContribution {
	const contributions: unknown[] = [];
	memory({
		registerTool: () => {},
		on: () => () => {},
		events: {
			emit: (channel: string, data: unknown) => {
				if (channel === "durable:contribution") contributions.push(data);
			},
		},
	} as unknown as ExtensionAPI);
	assert.equal(contributions.length, 1);
	return contributions[0] as MemoryDurableContribution;
}

function hostFor(
	contribution: MemoryDurableContribution,
	cwd: string,
	harness: Durable.Harness,
): MemoryDurableContributionHost {
	return {
		durable: Durable,
		// The slice reads no service field; the empty object proves the host contract holds without one.
		services: {} as AgentSessionServices,
		cwd,
		agentDir: cwd,
		storageId: "memory-durable-test",
		harness,
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: {
			contributions: [{ name: contribution.name, source: contribution.source, commands: [] }],
			ordinaryOnly: [],
		},
	};
}

function note(title: string): string {
	return [
		"---",
		`title: "${title}"`,
		'tags: ["editor"]',
		'status: "active"',
		'created: "2026-01-01"',
		'updated: "2026-01-01"',
		"verified: false",
		"verified_date: null",
		"supersedes: []",
		"superseded_by: null",
		"---",
		"",
		`# ${title}`,
		"",
		"## Summary",
		"",
		"Use editor A.",
		"",
		"## Details",
		"",
		"Original detail.",
		"",
		"## Sources",
		"",
		"- Operator statement.",
		"",
	].join("\n");
}

function sourceDigest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function messageText(message: ToolResultMessage): string {
	return message.content.map((item) => (item.type === "text" ? item.text : "")).join("");
}

/** The native details object, which equals the ordinary tool details. */
function nativeDetails(message: ToolResultMessage): Record<string, unknown> {
	assert.ok(message.details !== undefined, "tool result carries details");
	return message.details as Record<string, unknown>;
}

function sectionsOf(messages: readonly { role: string; sections?: Record<string, string | null> }[]) {
	const sections: Record<string, string> = {};
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const [key, value] of Object.entries(message.sections ?? {})) {
			if (value === null) delete sections[key];
			else sections[key] = value;
		}
	}
	return sections;
}

async function toolResults(conversation: Durable.Conversation) {
	const page = await conversation.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	const results: Array<{ name: string; message: ToolResultMessage }> = [];
	for (const entry of [...page.items].reverse()) {
		if (!Durable.ToolResultEntry.is(entry)) continue;
		const message = entry.model?.[0];
		assert.ok(message !== undefined && message.role === "toolResult");
		results.push({ name: message.toolName, message });
	}
	return results;
}

test("the ordinary factory emits one memory contribution with native contracts", async () => {
	const contribution = emitContribution();
	assert.equal(contribution.name, "memory");
	assert.equal(contribution.source, fileURLToPath(new URL("./index.ts", import.meta.url)));

	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(
		new Durable.MemoryStorage(),
		{ models: createModels(), registry },
		BACKGROUND_CONTEXT,
	);
	try {
		const extension = await contribution.create(hostFor(contribution, process.cwd(), harness));
		assert.deepEqual(
			extension.sections?.map((section) => section.key),
			["memory", "memory_index"],
		);
		assert.deepEqual(
			(extension.tools ?? []).map((tool) => [tool.name, tool.replay]),
			[
				["memory_search", "safe"],
				["memory_read", "safe"],
				["memory_history", "safe"],
				["memory_write", "unsafe"],
				["memory_edit", "unsafe"],
				["memory_review", "unsafe"],
				["memory_retire", "unsafe"],
			],
		);
		const search = (extension.tools ?? []).find((tool) => tool.name === "memory_search") as
			| { outputSchema?: unknown }
			| undefined;
		assert.equal(search?.outputSchema, memorySearchOutputSchema);
		for (const tool of extension.tools ?? []) {
			if (tool.name !== "memory_search") assert.equal(Object.hasOwn(tool, "outputSchema"), false);
		}
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("drives one model-issued call per memory tool in a real Harness over MemoryStorage", async () => {
	const root = mkdtempSync(join(tmpdir(), "memory-durable-"));
	const corpus = join(root, "corpus");
	mkdirSync(corpus);
	writeFileSync(join(corpus, "README.md"), "# Memory corpus\n");
	writeFileSync(join(corpus, "editor-choice.md"), note("Editor choice"));
	const previous = process.env.PI_MEMORY_DIR;
	process.env.PI_MEMORY_DIR = corpus;

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);

	// MemoryStorage is closed by Harness.close(), so an in-process recovery rerun
	// cannot be exercised. The probe records the replay policy of the committed
	// tool intent, which is the durable input to rerun classification.
	const intents: Array<{ name: string; replay?: string }> = [];
	try {
		const contribution = emitContribution();
		const extension = await contribution.create(hostFor(contribution, corpus, harness));
		registry.install(extension);
		registry.install(
			Durable.defineExtension({
				name: "memory-durable-probe",
				hooks: [
					Durable.hook(Durable.ToolTask, {
						afterTool: async (call, _result, api, context) => {
							const task = await harness.getTask(api.taskId, context);
							const checkpoint = (task?.state as { checkpoint?: { replay?: string } } | undefined)?.checkpoint;
							intents.push({ name: call.name, replay: checkpoint?.replay });
							return undefined;
						},
					}),
				],
			}),
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});
		const requests: TranscriptContext[] = [];

		const drive = async (name: string, args: Record<string, JsonValue>) => {
			faux.setResponses([
				(context) => {
					requests.push(context);
					return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("done"),
			]);
			const settled = await (
				await conversation.submit({ type: "input", content: `call ${name}` }, BACKGROUND_CONTEXT)
			).wait(BACKGROUND_CONTEXT);
			assert.equal(settled.status, "done");
		};

		await drive("memory_search", {});
		await drive("memory_read", { slug: "editor-choice" });
		await drive("memory_history", { slug: "editor-choice" });
		await drive("memory_write", {
			slug: "durable-note",
			title: "Durable note",
			tags: ["durable"],
			summary: "A note created by a durable tool call.",
			details: "Original detail.",
			sources: "- Durable test.",
			verified: false,
		});
		const notePath = join(corpus, "durable-note.md");
		await drive("memory_edit", {
			slug: "durable-note",
			expectedDigest: sourceDigest(notePath),
			verified: true,
			edits: [{ oldText: "Original detail.", newText: "Edited detail." }],
		});
		await drive("memory_review", {
			slug: "durable-note",
			expectedDigest: sourceDigest(notePath),
			outcome: "confirmed",
			sources: "Current source inspected by the durable test.",
		});
		await drive("memory_retire", {
			slug: "durable-note",
			expectedDigest: sourceDigest(notePath),
			reason: "The durable test withdraws the note.",
			sources: "Durable test.",
		});

		const sections = sectionsOf(requests[0]?.messages ?? []);
		assert.match(sections.memory ?? "", /^<memory>\n- Consult memory before/);
		assert.match(sections.memory_index ?? "", /editor-choice: Editor choice/);

		const results = await toolResults(conversation);
		assert.deepEqual(
			results.map((result) => result.name),
			["memory_search", "memory_read", "memory_history", "memory_write", "memory_edit", "memory_review", "memory_retire"],
		);
		for (const result of results) {
			assert.equal(result.message.isError, false);
			assert.doesNotMatch(messageText(result.message), /<harness>/);
		}
		const byName = new Map(results.map((result) => [result.name, result.message]));
		const resultFor = (name: string): ToolResultMessage => {
			const message = byName.get(name);
			assert.ok(message, `missing ${name} tool result`);
			return message;
		};
		const search = resultFor("memory_search");
		const read = resultFor("memory_read");
		const history = resultFor("memory_history");
		const write = resultFor("memory_write");
		const mutations = ["memory_write", "memory_edit", "memory_review", "memory_retire"].map(resultFor);

		const searchPage = JSON.parse(messageText(search)) as Record<string, unknown>;
		assert.equal(searchPage.kind, "index");
		assert.deepEqual(nativeDetails(search).structuredContent, searchPage);
		assert.deepEqual(nativeDetails(search), { ...searchPage, structuredContent: searchPage });

		const readPage = JSON.parse(messageText(read)) as Record<string, unknown>;
		assert.equal(readPage.kind, "note");
		assert.deepEqual(nativeDetails(read), readPage);
		assert.equal(Object.hasOwn(nativeDetails(read), "structuredContent"), false);

		const historyPage = JSON.parse(messageText(history)) as Record<string, unknown>;
		assert.equal(historyPage.kind, "history");
		assert.deepEqual(nativeDetails(history), historyPage);
		assert.equal(Object.hasOwn(nativeDetails(history), "structuredContent"), false);

		for (const message of mutations) {
			const details = nativeDetails(message);
			assert.equal(details.ok, true);
			assert.equal(Object.hasOwn(details, "structuredContent"), false);
			assert.ok(messageText(message).endsWith(JSON.stringify(details)));
		}
		assert.match(messageText(write), /^Memory updated: durable-note\.md\n/);

		const retired = readFileSync(notePath, "utf8");
		assert.match(retired, /Edited detail\./);
		assert.match(retired, /status: "retired"/);
		assert.doesNotMatch(retired, /Original detail\./);

		assert.deepEqual(intents, [
			{ name: "memory_search", replay: "safe" },
			{ name: "memory_read", replay: "safe" },
			{ name: "memory_history", replay: "safe" },
			{ name: "memory_write", replay: "unsafe" },
			{ name: "memory_edit", replay: "unsafe" },
			{ name: "memory_review", replay: "unsafe" },
			{ name: "memory_retire", replay: "unsafe" },
		]);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		if (previous === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
