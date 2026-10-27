import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionServices,
	createEventBus,
	formatSkillsForPrompt,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { type CheckRecord, checkReply, REPAIR_BLOCK, replyRulesText, unavailableText } from "./check.ts";
import {
	CHECK_ENTRY,
	createDraftDurableExtension,
	type DraftDurableContribution,
	type DraftDurableHost,
	draftDurableContribution,
} from "./durable.ts";
import draft from "./index.ts";
import { filler } from "./scripts/test-kit.mts";
import { promptGuidelines } from "./tool.ts";

const context = BACKGROUND_CONTEXT;
const RECORD: CheckRecord = {
	trigger: "hard",
	hard: 1,
	scored: 0,
	sq: 0,
	band: null,
	reliable: false,
	words: 3,
	rules: { "punctuation.em-dash": 1 },
};
async function start(t: { after(fn: () => Promise<void>): void }, checker = checkReply) {
	const dir = await mkdtemp(join(tmpdir(), "draft-durable-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const bus = createEventBus();
	let contribution: DraftDurableContribution | undefined;
	bus.on("durable:contribution", (value) => {
		contribution = value as DraftDurableContribution;
	});
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: dir,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			eventBus: bus,
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [draft],
		},
	});
	assert.ok(contribution);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let opened: Durable.Harness | undefined;
	const closers: (() => void | Promise<void>)[] = [];
	const host: DraftDurableHost = {
		durable: Durable,
		agentDir: dir,
		services,
		get harness() {
			if (!opened) throw new Error("harness not open");
			return opened;
		},
		onClose: (close) => {
			closers.push(close);
		},
	};
	const registry = createRegistry();
	registry.install(contribution.create(host));
	if (checker !== checkReply) registry.install(createDraftDurableExtension(host, checker));
	registry.install(
		Durable.defineExtension({
			name: "resources",
			sections: [{ key: "skills", render: () => formatSkillsForPrompt(services.resourceLoader.getSkills().skills) }],
		}),
	);
	opened = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await opened.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: dir } });
	const open = opened;
	t.after(async () => {
		await open.close(context);
		for (const close of closers) await close();
	});
	const runInput = async (input: Durable.InputSubmissionDraft, ...replies: FauxResponseStep[]) => {
		faux.setResponses(replies);
		const settled = await (await root.submit(input, context)).wait(context);
		assert.equal(settled.status, "done", settled.status === "unanswered" ? settled.reason : "");
	};
	const run = (...replies: FauxResponseStep[]) => runInput({ type: "input", content: "question" }, ...replies);
	const transcript = async () =>
		(await root.context(context)).messages
			.map((message: Message) =>
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
			)
			.join("\n---\n");
	return { run, runInput, root, harness: open, transcript, faux, services, registry, dir };
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("contribution names the draft extension and its entrypoint", () => {
	const source = fileURLToPath(new URL("./index.ts", import.meta.url));
	const contribution = draftDurableContribution(source, createEventBus(), () => {});
	assert.equal(contribution.name, "draft");
	assert.equal(contribution.source, source);
});
test("real findings continue once and the next run resets the guard", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run(fauxAssistantMessage("A dash — here"), fauxAssistantMessage("Another dash — here"));
	assert.equal(count(await h.transcript(), "The prose meter found problems"), 1);
	await h.run(fauxAssistantMessage("A dash — again"), fauxAssistantMessage("The parser rejects an empty file."));
	assert.equal(count(await h.transcript(), "The prose meter found problems"), 2);
});
test("tools are blocked in the repair turn and the check is recorded outside model context", {
	timeout: 30000,
}, async (t) => {
	const h = await start(t);
	let blocked = "";
	await h.run(
		fauxAssistantMessage("A dash \u2014 here"),
		fauxAssistantMessage(fauxToolCall("draft", { text: "A note.", kind: "prose" }), { stopReason: "toolUse" }),
		(request) => {
			blocked = JSON.stringify(request.messages.findLast((message) => message.role === "toolResult"));
			return fauxAssistantMessage("The parser rejects an empty file.");
		},
	);
	assert.ok(blocked.includes(REPAIR_BLOCK), blocked);
	const page = await h.root.entries({}, 200, undefined, context);
	const checks = page.items.filter((entry: Durable.EntryRecord) => entry.kind === CHECK_ENTRY);
	assert.equal(checks.length, 1);
	assert.equal(checks[0]?.model, undefined);
	const record = checks[0]?.data as CheckRecord | undefined;
	assert.deepEqual(record?.rules, { "punctuation.em-dash": 1 });
	await h.run(
		fauxAssistantMessage(fauxToolCall("draft", { text: "A note.", kind: "prose" }), { stopReason: "toolUse" }),
		(request) => {
			const result = JSON.stringify(request.messages.findLast((message) => message.role === "toolResult"));
			assert.ok(!result.includes(REPAIR_BLOCK), result);
			assert.match(result, /Verdict: pass/u);
			return fauxAssistantMessage("The parser rejects an empty file.");
		},
	);
});
test("application input skips the checker even after operator conversation history", { timeout: 30000 }, async (t) => {
	let checks = 0;
	const h = await start(t, async () => {
		checks += 1;
		return { kind: "repair", text: "Please repair.", record: RECORD } as const;
	});
	await h.run(fauxAssistantMessage("Operator answer"), fauxAssistantMessage("Repaired answer"));
	assert.equal(checks, 1);
	await h.runInput(
		{ type: "input", content: "Peer task", entry: { kind: "test.request", data: { author: "peer" } } },
		fauxAssistantMessage("A dash — here"),
	);
	assert.equal(checks, 1);
	assert.equal(h.faux.state.callCount, 3);
});
test("passive user-role notices do not mask operator input or cause another repair", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	const notice: FauxResponseStep = async () => {
		await h.root.submit(
			{
				type: "write",
				entry: { kind: "test.notice", model: [{ role: "user", content: "A passive notice", timestamp: 0 }] },
			},
			context,
		);
		return fauxAssistantMessage("A dash — here");
	};
	await h.run(notice, notice);
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(count(await h.transcript(), "The prose meter found problems"), 1);
});
test("unsubmitted pi.user writes do not enable checking on an application run", { timeout: 30000 }, async (t) => {
	let checks = 0;
	const h = await start(t, async () => {
		checks += 1;
		return { kind: "clean" };
	});
	await h.runInput({ type: "input", content: "Peer task", entry: { kind: "test.request" } }, async () => {
		await h.root.submit(
			{
				type: "write",
				entry: { kind: "pi.user", model: [{ role: "user", content: "Not an input submission", timestamp: 0 }] },
			},
			context,
		);
		return fauxAssistantMessage("A dash — here");
	});
	assert.equal(checks, 0);
});
test("queued operator input does not check the preceding application answer", { timeout: 30000 }, async (t) => {
	const checked: string[] = [];
	const h = await start(t, async (text) => {
		checked.push(text);
		return { kind: "clean" };
	});
	let queued: Durable.Submission | undefined;
	await h.runInput(
		{ type: "input", content: "Peer task", entry: { kind: "test.request" } },
		async () => {
			queued = await h.root.submit({ type: "input", content: "Operator task", whenBusy: "followUp" }, context);
			return fauxAssistantMessage("Peer answer");
		},
		fauxAssistantMessage("Operator answer"),
	);
	assert.ok(queued);
	assert.equal((await queued.wait(context)).status, "done");
	assert.deepEqual(checked, ["Operator answer"]);
});
test("operator input placed at a tool boundary enables checking in a mixed run", { timeout: 30000 }, async (t) => {
	const checked: string[] = [];
	const h = await start(t, async (text) => {
		checked.push(text);
		return { kind: "clean" };
	});
	let steer: Durable.Submission | undefined;
	await h.runInput(
		{ type: "input", content: "Peer task", entry: { kind: "test.request" } },
		async () => {
			steer = await h.root.submit({ type: "input", content: "Operator correction", whenBusy: "steer" }, context);
			return fauxAssistantMessage(fauxToolCall("draft", { text: "A note.", kind: "prose" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Mixed answer"),
	);
	assert.ok(steer);
	assert.equal((await steer.wait(context)).status, "done");
	assert.deepEqual(checked, ["Mixed answer"]);
});
test("exact input lookup survives a new context head", { timeout: 30000 }, async (t) => {
	let checks = 0;
	const h = await start(t, async () => {
		checks += 1;
		return { kind: "repair", text: "Please repair.", record: RECORD } as const;
	});
	const replaceContext: FauxResponseStep = async () => {
		await h.harness.commit(async (tx) => {
			await tx.appendEntry(h.root.id, {
				kind: "test.summary",
				head: "self",
				model: [{ role: "user", content: "Summary", timestamp: 0 }],
			});
		}, context);
		return fauxAssistantMessage("A dash — here");
	};
	await h.run(replaceContext, replaceContext);
	assert.equal(checks, 1);
	assert.equal(h.faux.state.callCount, 2);
});
test("a clean answer adds no findings", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run(fauxAssistantMessage("The parser rejects an empty file."));
	assert.equal(count(await h.transcript(), "prose meter"), 0);
});
test("native replies skip repair for spelling and reliable green findings", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run(fauxAssistantMessage("The color and behavior changed."));
	await h.run(fauxAssistantMessage("The pivotal design uses color."));
	await h.run(fauxAssistantMessage(`${filler(200)} A pivotal design is robust.`));
	assert.equal(h.faux.state.callCount, 3);
	assert.equal(count(await h.transcript(), "The prose meter found problems"), 0);
});
test("an unavailable meter adds one notice until analysis succeeds", { timeout: 30000 }, async (t) => {
	let unavailable = true;
	const h = await start(t, async () =>
		unavailable
			? { kind: "unavailable", reason: "failed", text: unavailableText("failed", "rule data unavailable") }
			: { kind: "clean" },
	);
	await h.run(fauxAssistantMessage("First reply"));
	await h.run(fauxAssistantMessage("Second reply"));
	assert.equal(count(await h.transcript(), "The prose meter check did not run"), 1);
	unavailable = false;
	await h.run(fauxAssistantMessage("The parser rejects an empty file."));
	unavailable = true;
	await h.run(fauxAssistantMessage("Third reply"));
	assert.equal(count(await h.transcript(), "The prose meter check did not run"), 2);
});
test("native composition supplies the skill, tool, saved file access and usage guidance", {
	timeout: 30000,
}, async (t) => {
	const h = await start(t);
	assert.equal(
		h.services.resourceLoader.getSkills().skills.find((skill) => skill.name === "draft")?.filePath,
		fileURLToPath(new URL("./SKILL.md", import.meta.url)),
	);
	assert.equal(
		h.registry
			.snapshot()
			.tools()
			.find((entry) => entry.tool.name === "draft")?.tool.replay,
		"safe",
	);
	await writeFile(join(h.dir, "note.md"), "A line — here.");
	await h.run(
		(request) => {
			const system = getCurrentSystemPrompt(request.messages) ?? "";
			assert.match(system, /<name>draft<\/name>/u);
			assert.match(system, /after facts, evidence and position are settled/u);
			assert.ok(system.includes(replyRulesText()));
			for (const guideline of promptGuidelines) assert.ok(system.includes(guideline));
			return fauxAssistantMessage(fauxToolCall("draft", { path: "note.md", kind: "prose" }), { stopReason: "toolUse" });
		},
		(request) => {
			const result = request.messages.findLast((message) => message.role === "toolResult");
			assert.match(JSON.stringify(result), /punctuation.em-dash/u);
			assert.match(JSON.stringify(result), /Calibration:/u);
			return fauxAssistantMessage("The parser rejects an empty file.");
		},
	);
	assert.equal(h.faux.state.callCount, 2);
});
