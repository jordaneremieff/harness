import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, getCurrentSystemPrompt, getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createEventBus, type AgentSessionServices } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DISTILL_SYSTEM_PROMPT } from "./distill.ts";
import { type StashDurableContribution, type StashDurableHost, stashDurableContribution } from "./durable.ts";
import { captureHint, type DistillInput, type IndependentCommandInput, readDistillInput } from "./launch.ts";
import { mergeRedactionReports, redactSecretsWithReport } from "./redact.ts";
import { listStashes, readStash, writeStash } from "./store.ts";

const context = BACKGROUND_CONTEXT;
const oldHarnessFile = process.env.PI_HARNESS_FILE;
before(() => { delete process.env.PI_HARNESS_FILE; });
after(() => {
	if (oldHarnessFile === undefined) delete process.env.PI_HARNESS_FILE;
	else process.env.PI_HARNESS_FILE = oldHarnessFile;
});

interface TestHarness {
	readonly launches: IndependentCommandInput[];
	readonly harness: Durable.Harness;
	readonly root: Durable.Conversation;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly host: StashDurableHost;
	readonly contribution: StashDurableContribution;
	readonly extension: Durable.Extension;
	readonly storeDir: string;
	readonly workdir: string;
}

async function startHarness(
	t: { after(fn: () => void | Promise<void>): void },
	contextWindow?: number,
): Promise<TestHarness> {
	const launches: IndependentCommandInput[] = [];
	const storeDir = await mkdtemp(join(tmpdir(), "stash-durable-store-"));
	const workdir = await mkdtemp(join(tmpdir(), "stash-durable-work-"));
	t.after(async () => {
		delete process.env.PI_STASH_DIR;
		await rm(storeDir, { recursive: true, force: true });
		await rm(workdir, { recursive: true, force: true });
	});
	process.env.PI_STASH_DIR = storeDir;
	const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const host: StashDurableHost = {
		durable: Durable,
		services: { modelRuntime: models } as unknown as AgentSessionServices,
		cwd: workdir,
		agentDir: workdir,
		storageId: "stash-durable-test",
		launchIndependent: async (input) => {
			launches.push(input);
			return {
				sessionId: "worker",
				cwd: input.cwd,
				admission: { name: "stash", conversationId: 1, identity: "worker", text: "admitted" },
			};
		},
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [], ordinaryOnly: [] },
	};
	const contribution = stashDurableContribution(fileURLToPath(new URL("./index.ts", import.meta.url)), createEventBus(), () => {});
	const extension = contribution.create(host);
	const registry = createRegistry();
	registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workdir },
	});
	t.after(async () => {
		await harness.close(context);
	});
	return { harness, root, faux, host, contribution, extension, storeDir, workdir, launches };
}

function messageText(message: Message | undefined): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function modelText(conversation: Durable.Conversation): Promise<string> {
	const view = await conversation.context(context);
	return view.messages.map((message) => messageText(message)).join("\n");
}

async function toolResults(
	conversation: Durable.Conversation,
): Promise<Array<{ name: string; text: string; isError: boolean }>> {
	const view = await conversation.context(context);
	return view.messages.flatMap((message) =>
		message.role === "toolResult"
			? [{ name: message.toolName, text: messageText(message), isError: message.isError === true }]
			: [],
	);
}

async function answerWith(
	conversation: Durable.Conversation,
	faux: ReturnType<typeof fauxProvider>,
	responses: AssistantMessage[],
	prompt: string,
): Promise<void> {
	faux.setResponses(responses);
	const submission = await conversation.submit({ type: "input", content: prompt }, context);
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done", settled.status === "unanswered" ? settled.reason : "");
}

function capacityOff(t: { after(fn: () => void): void }): void {
	process.env.PI_STASH_CAPACITY = "0";
	t.after(() => {
		delete process.env.PI_STASH_CAPACITY;
	});
}

function occurrences(text: string, needle: string): number {
	let count = 0;
	let index = text.indexOf(needle);
	while (index >= 0) {
		count += 1;
		index = text.indexOf(needle, index + needle.length);
	}
	return count;
}

test("drives every stash tool from model-issued calls", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	capacityOff(t);

	await answerWith(
		h.root,
		h.faux,
		[
			fauxAssistantMessage(
				fauxToolCall("stash_write", { title: "Durable handover", summary: "State.", nextActions: ["resume"] }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("stashed"),
		],
		"write the handover",
	);
	const written = await listStashes(h.storeDir, {});
	assert.equal(written.length, 1, "stash_write publishes one artifact");
	const id = written[0]?.meta.id;
	assert.ok(id, "stash_write returns a discoverable id");
	let results = await toolResults(h.root);
	assert.ok(
		results.some((result) => result.name === "stash_write" && !result.isError && result.text.includes(id)),
		"the model receives the write result",
	);

	await answerWith(
		h.root,
		h.faux,
		[fauxAssistantMessage(fauxToolCall("stash_list", {}), { stopReason: "toolUse" }), fauxAssistantMessage("listed")],
		"list the handovers",
	);
	results = await toolResults(h.root);
	assert.ok(
		results.some((result) => result.name === "stash_list" && !result.isError && result.text.includes(id)),
		"the model receives the list result",
	);

	await answerWith(
		h.root,
		h.faux,
		[fauxAssistantMessage(fauxToolCall("stash_read", { id }), { stopReason: "toolUse" }), fauxAssistantMessage("read")],
		"read the handover",
	);
	results = await toolResults(h.root);
	assert.ok(
		results.some(
			(result) => result.name === "stash_read" && !result.isError && result.text.includes("Durable handover"),
		),
		"the model receives the read result",
	);

	const readResult = results.findLast((result) => result.name === "stash_read");
	const expectedDigest = readResult?.text.match(/Artifact digest: ([a-f0-9]{64})/)?.[1];
	assert.ok(expectedDigest, "the model receives the complete artifact revision");
	const edit = { id, expectedDigest, edits: [{ oldText: "State.", newText: "State with new information." }] };
	await answerWith(
		h.root,
		h.faux,
		[fauxAssistantMessage(fauxToolCall("stash_edit", edit), { stopReason: "toolUse" }), fauxAssistantMessage("edited")],
		"amend the handover",
	);
	results = await toolResults(h.root);
	assert.ok(
		results.some((result) => result.name === "stash_edit" && !result.isError && result.text.includes("Updated stash")),
	);
	const updated = await readStash(h.storeDir, id);
	assert.ok(updated.ok);
	assert.match(updated.content, /State with new information\./);
	assert.notEqual(updated.digest, expectedDigest);
	await answerWith(
		h.root,
		h.faux,
		[
			fauxAssistantMessage(fauxToolCall("stash_edit", edit), { stopReason: "toolUse" }),
			fauxAssistantMessage("stale revision refused"),
		],
		"try the stale edit",
	);
	results = await toolResults(h.root);
	assert.ok(results.findLast((result) => result.name === "stash_edit")?.isError);
	assert.deepEqual(await readStash(h.storeDir, id), updated);

	await answerWith(
		h.root,
		h.faux,
		[
			fauxAssistantMessage(fauxToolCall("stash_complete", { id, outcome: "The durable handover was verified." }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("completed"),
		],
		"complete the handover",
	);
	const closed = await listStashes(h.storeDir, { state: "closed" });
	assert.equal(closed.length, 1, "stash_complete closes the artifact");
	assert.equal(closed[0]?.meta.outcome, "The durable handover was verified.");
	results = await toolResults(h.root);
	assert.ok(
		results.some(
			(result) => result.name === "stash_complete" && !result.isError && result.text.includes(`Closed stash ${id}`),
		),
		"the model receives the completion result",
	);

	await answerWith(
		h.root,
		h.faux,
		[
			fauxAssistantMessage(fauxToolCall("stash_rotate", { id }), { stopReason: "toolUse" }),
			fauxAssistantMessage("rotated"),
		],
		"rotate the handover",
	);
	assert.equal((await listStashes(h.storeDir, {})).length, 0, "stash_rotate removes the artifact from discovery");
	const archive = await readdir(join(h.storeDir, ".trash"));
	assert.ok(archive.includes(`${id}.md`), "stash_rotate archives the artifact");
	results = await toolResults(h.root);
	assert.ok(
		results.some(
			(result) => result.name === "stash_rotate" && !result.isError && result.text.includes(`Rotated stash ${id}`),
		),
		"the model receives the rotation result",
	);
});

test("returns redaction notices and details through native mutation calls", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	capacityOff(t);
	const token = "sk-abcdefgh" + "ijklmnop1234";
	process.env.PI_STASH_CHECKPOINT_DIR = join(h.workdir, "checkpoints");
	t.after(() => {
		delete process.env.PI_STASH_CHECKPOINT_DIR;
	});
	const invoke = async (name: string, params: Durable.JsonObject) => {
		await answerWith(
			h.root,
			h.faux,
			[fauxAssistantMessage(fauxToolCall(name, params), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
			"Perform the mutation.",
		);
		const view = await h.root.context(context);
		const result = view.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
		assert.ok(result && result.role === "toolResult" && !result.isError);
		assert.match(messageText(result), /Redaction notice: 1/);
		assert.ok(!JSON.stringify(result).includes(token));
		const details = (result as unknown as { details: { redactions: { count: number } } }).details;
		assert.equal(details.redactions.count, 1);
	};
	await invoke("stash_write", { title: "Native safety", summary: `Receipt context. ${token}` });
	const [entry] = await listStashes(h.storeDir, {});
	assert.ok(entry);
	const read = await readStash(h.storeDir, entry.meta.id);
	assert.ok(read.ok);
	await invoke("stash_edit", {
		id: entry.meta.id,
		expectedDigest: read.digest,
		edits: [{ oldText: "Receipt context.", newText: `Receipt context. ${token}` }],
	});
	await invoke("stash_complete", { id: entry.meta.id, outcome: `Verified ${token}.` });
	await invoke("stash_write", {
		title: "Native checkpoint safety",
		summary: `Receipt context. ${token}`,
		checkpoint: true,
	});
});

test("declares an explicit replay class for every tool", async (t) => {
	const h = await startHarness(t);
	const classes = new Map((h.extension.tools ?? []).map((tool) => [tool.name, tool.replay]));
	assert.equal(classes.get("stash_write"), "safe");
	assert.equal(classes.get("stash_list"), "safe");
	assert.equal(classes.get("stash_read"), "safe");
	assert.equal(classes.get("stash_edit"), "unsafe");
	assert.equal(classes.get("stash_complete"), "unsafe");
	assert.equal(classes.get("stash_rotate"), "unsafe");
});

test("carries the native structured list result on details.structuredContent", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	capacityOff(t);
	await answerWith(
		h.root,
		h.faux,
		[
			fauxAssistantMessage(fauxToolCall("stash_write", { title: "Structured record", summary: "Body." }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("stashed"),
		],
		"write",
	);
	await answerWith(
		h.root,
		h.faux,
		[fauxAssistantMessage(fauxToolCall("stash_list", {}), { stopReason: "toolUse" }), fauxAssistantMessage("listed")],
		"list",
	);
	const view = await h.root.context(context);
	const listResult = view.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "stash_list",
	);
	assert.ok(listResult && listResult.role === "toolResult");
	assert.equal(listResult.isError, false);
	const details = (
		listResult as unknown as { details?: { structuredContent?: { kind?: string; records?: unknown[] } } }
	).details;
	assert.equal(details?.structuredContent?.kind, "recent");
	assert.equal(details?.structuredContent?.records?.length, 1);
});

test("issues one capacity notice per threshold crossing and re-arms through the command", {
	timeout: 30000,
}, async (t) => {
	const h = await startHarness(t, 2000);
	process.env.PI_STASH_CHECKPOINT_PERCENT = "1";
	process.env.PI_STASH_DECISION_PERCENT = "2";
	t.after(() => {
		delete process.env.PI_STASH_CHECKPOINT_PERCENT;
		delete process.env.PI_STASH_DECISION_PERCENT;
	});

	const prompt = `${"context ".repeat(140)}question`;
	h.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	const settled = await (await h.root.submit({ type: "input", content: prompt }, context)).wait(context);
	assert.equal(settled.status, "done");
	let text = await modelText(h.root);
	assert.equal(occurrences(text, "[stash-capacity"), 1, "one notice for the crossing");
	assert.match(text, /\[stash-capacity e=1 c=\d+ checkpoint decision\]/u);

	h.faux.setResponses([fauxAssistantMessage("third")]);
	const second = await (await h.root.submit({ type: "input", content: "another prompt" }, context)).wait(context);
	assert.equal(second.status, "done");
	text = await modelText(h.root);
	assert.equal(occurrences(text, "[stash-capacity"), 1, "the notice is not repeated while the episode latch persists");

	const command = h.contribution.commands?.[0];
	assert.ok(command);
	const reset = await command.run({
		args: "capacity reset",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "capacity-reset",
		harness: h.harness,
	});
	assert.match(reset, /episode reset to 2/u);
	const status = await command.run({
		args: "capacity",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "capacity-status",
		harness: h.harness,
	});
	assert.match(status, /Episode 2/u);

	h.faux.setResponses([fauxAssistantMessage("fourth"), fauxAssistantMessage("fifth")]);
	const third = await (await h.root.submit({ type: "input", content: "after reset" }, context)).wait(context);
	assert.equal(third.status, "done");
	text = await modelText(h.root);
	assert.equal(occurrences(text, "[stash-capacity"), 2, "reset re-arms the crossing");
	assert.match(text, /\[stash-capacity e=2 c=\d+ /u);
});

test("estimates context from reported assistant usage and labels the source", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t, 2000);
	process.env.PI_STASH_CHECKPOINT_PERCENT = "1";
	process.env.PI_STASH_DECISION_PERCENT = "2";
	t.after(() => {
		delete process.env.PI_STASH_CHECKPOINT_PERCENT;
		delete process.env.PI_STASH_DECISION_PERCENT;
	});

	// No accepted usage exists on the first request, so the crossing that follows
	// must be decided by request text and labeled as such.
	h.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	const longPrompt = `${"context ".repeat(140)}question`;
	const first = await (await h.root.submit({ type: "input", content: longPrompt }, context)).wait(context);
	assert.equal(first.status, "done");
	let text = await modelText(h.root);
	assert.equal(occurrences(text, "[stash-capacity"), 1);
	assert.match(text, /No accepted assistant usage is available\. Request text estimates context use/u);

	// The next short prompt cannot cross on its own text. The prior assistant's
	// reported usage decides, and the notice says so.
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	await command.run({
		args: "capacity reset",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "capacity-source-reset",
		harness: h.harness,
	});
	h.faux.setResponses([fauxAssistantMessage("third"), fauxAssistantMessage("fourth")]);
	const second = await (await h.root.submit({ type: "input", content: "hi" }, context)).wait(context);
	assert.equal(second.status, "done");
	text = await modelText(h.root);
	assert.equal(occurrences(text, "[stash-capacity"), 2);
	assert.match(
		text,
		/The newest reported assistant usage plus an estimate for later messages gives \d+\.\d% \(\S+ tokens of 2k\)\./u,
	);
	assert.match(text, /\[stash-capacity e=2 c=\d+ checkpoint decision\]/u);
});

function creationInput(h: TestHarness): DistillInput {
	return {
		...captureHint("focus on tests"),
		transcript: "[USER]\nCAPTURED_SOURCE",
		artifacts: ["/source/reference.md"],
		project: "/source/project",
		branch: "source-branch",
		sessionId: "source-session:7",
		storeDir: h.storeDir,
	};
}

async function admitCreation(h: TestHarness, invocationId = "creation-1", data: JsonValue = { ...creationInput(h) }) {
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	const text = await command.run({
		args: "new",
		data,
		conversation: h.root,
		context,
		host: h.host,
		invocationId,
		harness: h.harness,
	});
	const taskId = Number(/task (\d+)/u.exec(text)?.[1]) as Durable.TaskId;
	assert.ok(taskId, text);
	return taskId;
}

async function creationReceipt(conversation: Durable.Conversation) {
	const receipts = (await conversation.entries({}, 100, undefined, context)).items.filter(
		(entry) => entry.kind === "stash.creation",
	);
	assert.equal(receipts.length, 1);
	assert.equal(receipts[0].model, undefined, "a receipt is passive, not a follow-up model input");
	return receipts[0].data as Durable.JsonObject;
}

test("native caller captures and silently launches without a caller task or response", async (t) => {
	const h = await startHarness(t);
	await h.root.commit(
		(tx) =>
			tx.appendEntry(h.root.id, { kind: "pi.user", model: [{ role: "user", content: "CALLER_SOURCE", timestamp: 0 }] }),
		context,
	);
	const before = await modelText(h.root);
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	const result = await command.run({
		args: "new source focus",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "launch-1",
		harness: h.harness,
	});
	assert.equal(result, "");
	assert.equal(await modelText(h.root), before);
	assert.equal(h.launches.length, 1);
	const input = readDistillInput(h.launches[0].command.data);
	assert.match(input.transcript, /CALLER_SOURCE/);
	assert.equal(input.sessionId, h.host.storageId);
	assert.equal(input.project, h.workdir);
	assert.equal(input.storeDir, h.storeDir);
	assert.equal(input.hint, "source focus");
	assert.equal(h.launches[0].invocationId, "launch-1");
	assert.equal(h.faux.state.callCount, 0);
	assert.equal((await h.harness.commit((tx) => tx.scanTasks({ kind: "stash.distill" }, 10), context)).items.length, 0);
});

test("native command retries retain the first snapshot after caller progress and uncertain admission", async (t) => {
	const h = await startHarness(t);
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	const launch = h.host.launchIndependent;
	let attempts = 0;
	t.mock.method(h.host, "launchIndependent", async (input: IndependentCommandInput) => {
		const receipt = await launch(input);
		if (++attempts === 1) throw new Error("admission response lost");
		return receipt;
	});
	const call = {
		args: "new original hint",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "retry-1",
		harness: h.harness,
	};
	await assert.rejects(command.run(call), /admission response lost/);
	await h.root.commit(
		(tx) =>
			tx.appendEntry(h.root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "LATER_CALLER_CONTEXT", timestamp: 1 }],
			}),
		context,
	);
	await h.root.configure({ cwd: "/different-caller-workspace" }, context);
	assert.equal(await command.run(call), "");
	assert.deepEqual(h.launches[1], h.launches[0]);
	assert.doesNotMatch(JSON.stringify(h.launches[1]), /LATER_CALLER_CONTEXT|different-caller-workspace/);
	await assert.rejects(command.run({ ...call, args: "new conflicting hint" }), /different hint/);
	assert.equal(h.launches.length, 2, "conflicts refuse before launch");
	assert.equal(await command.run({ ...call, invocationId: "retry-2" }), "");
	assert.match(JSON.stringify(h.launches[2]), /LATER_CALLER_CONTEXT/);
	assert.equal(h.launches[2].cwd, "/different-caller-workspace");
	assert.equal(h.faux.state.callCount, 0);
});

test("native retries bind the original credential-bearing hint without retaining secret bytes", async (t) => {
	const h = await startHarness(t);
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	const token = "sk-abcdefgh" + "ijklmnop1234";
	await h.root.commit(
		(tx) =>
			tx.appendEntry(h.root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: `Source ${token}`, timestamp: 0 }],
			}),
		context,
	);
	const call = {
		args: `new Focus ${token}`,
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "secret-retry",
		harness: h.harness,
	};
	const launch = h.host.launchIndependent;
	let attempts = 0;
	t.mock.method(h.host, "launchIndependent", async (input: IndependentCommandInput) => {
		const receipt = await launch(input);
		if (++attempts === 1) throw new Error(`admission response lost ${token}`);
		return receipt;
	});
	await assert.rejects(command.run(call), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /response lost/);
		assert.match(error.message, /Redaction notice: 3.*provider token/);
		assert.ok(!error.message.includes(token));
		return true;
	});
	await h.root.commit(
		(tx) =>
			tx.appendEntry(h.root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "Later caller progress.", timestamp: 1 }],
			}),
		context,
	);
	assert.match(await command.run(call), /Redaction notice: 2.*provider token/);
	assert.deepEqual(h.launches[1], h.launches[0]);
	const input = readDistillInput(h.launches[0].command.data);
	assert.equal(input.redactions.count, 2);
	assert.equal(input.hint, "Focus [REDACTED]");
	assert.ok(!JSON.stringify(h.launches).includes(token));
	await assert.rejects(command.run({ ...call, args: `new Focus ${token}other` }), /different hint/);
	assert.equal(h.launches.length, 2);
	assert.equal(h.faux.state.callCount, 0);
});

for (const output of ["clean", "credential", "skip", "failed"] as const) {
	test(`native ${output} receipts retain source reports independently of generated markers`, {
		timeout: 30000,
	}, async (t) => {
		const h = await startHarness(t);
		const token = "sk-abcdefgh" + "ijklmnop1234";
		const source = redactSecretsWithReport(`Captured ${token}`);
		const hint = captureHint(`Focus ${token}`);
		const input = {
			...creationInput(h),
			...hint,
			transcript: source.text,
			redactions: mergeRedactionReports(source.report, hint.redactions),
			branch: `branch/${token}`,
		};
		h.faux.setResponses([
			output === "skip"
				? fauxAssistantMessage("SKIP_STASH")
				: output === "failed"
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid request" })
					: fauxAssistantMessage(
							JSON.stringify({
								title: "Reported artifact",
								summary: output === "clean" ? "Generated clean prose without markers." : `Generated ${token}`,
							}),
						),
		]);
		const taskId = await admitCreation(h, `reported-${output}`, input);
		await h.harness.waitForTask(taskId, context);
		const receipt = await creationReceipt(h.root);
		const count = output === "clean" ? 3 : output === "credential" ? 4 : 2;
		assert.equal((receipt.redactions as Durable.JsonObject).count, count);
		assert.match(String(receipt.message), new RegExp(`Redaction notice: ${count}`));
		assert.ok(!JSON.stringify(receipt).includes(token));
		const entries = await listStashes(h.storeDir, {});
		if (output === "clean" || output === "credential") {
			const read = await readStash(h.storeDir, entries[0].meta.id);
			assert.ok(read.ok);
			assert.match(read.content, new RegExp(`Redaction notice: ${count}`));
			assert.ok(!read.content.includes(token));
		} else assert.equal(entries.length, 0);
	});
}

test("native creation uses tool-free generation and captured publication metadata exactly once", {
	timeout: 30000,
}, async (t) => {
	const h = await startHarness(t);
	await h.root.configure({ instructions: "WORKER_BOOTSTRAP", thinkingLevel: "off" }, context);
	let system = "";
	let text = "";
	let tools: unknown;
	h.faux.setResponses([
		(request) => {
			system = getCurrentSystemPrompt(request.messages);
			tools = getCurrentTools(request.messages);
			text = request.messages.map(messageText).join("\n");
			return fauxAssistantMessage(
				JSON.stringify({ title: "Distilled focus", summary: "Captured state.", files: ["/source/reference.md"] }),
			);
		},
	]);
	const taskId = await admitCreation(h);
	assert.equal(await admitCreation(h), taskId, "repeated admission reuses one task");
	const settled = await h.harness.waitForTask(taskId, context);
	assert.equal(settled.state.outcome.status, "completed", JSON.stringify(settled.state.outcome));
	assert.ok(system.includes(DISTILL_SYSTEM_PROMPT));
	assert.doesNotMatch(system, /WORKER_BOOTSTRAP/);
	assert.deepEqual(tools, []);
	assert.match(text, /CAPTURED_SOURCE/);
	assert.match(text, /focus on tests/);
	assert.doesNotMatch(text, /WORKER_BOOTSTRAP/);
	const entries = await listStashes(h.storeDir, {});
	assert.equal(entries.length, 1);
	assert.equal(entries[0].meta.title, "Distilled focus");
	assert.equal(entries[0].meta.sessionId, "source-session:7");
	assert.equal(entries[0].meta.project, "/source/project");
	assert.equal(entries[0].meta.branch, "source-branch");
	assert.equal(entries[0].meta.state, "open");
	assert.equal((await creationReceipt(h.root)).id, entries[0].meta.id);
	assert.equal(await admitCreation(h), taskId, "completed admission stays idempotent");
	assert.equal(h.faux.state.callCount, 1);
	assert.equal((await h.root.agent(context)).thinkingLevel, "off");
});

test("native creation corrects malformed output once and redacts before publication", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	h.faux.setResponses([
		fauxAssistantMessage("not JSON"),
		(request) => {
			assert.match(request.messages.map(messageText).join("\n"), /CAPTURED_SOURCE[\s\S]*FORMAT CORRECTION/);
			assert.deepEqual(getCurrentTools(request.messages), []);
			return fauxAssistantMessage(
				JSON.stringify({ title: "Corrected", summary: "api_key=sk-test_12345678901234567890" }),
			);
		},
	]);
	const taskId = await admitCreation(h);
	await h.harness.waitForTask(taskId, context);
	const entries = await listStashes(h.storeDir, {});
	assert.equal(entries.length, 1);
	const read = await readStash(h.storeDir, entries[0].meta.id);
	assert.ok(read.ok);
	assert.doesNotMatch(read.content, /sk-test_/);
	assert.equal(h.faux.state.callCount, 2);
	assert.equal((await creationReceipt(h.root)).status, "completed");
});

for (const [name, responses, status] of [
	["skip", [fauxAssistantMessage("SKIP_STASH")], "skipped"],
	["invalid correction", [fauxAssistantMessage("not JSON"), fauxAssistantMessage("still not JSON")], "invalid"],
	["provider failure", [fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" })], "failed"],
] as const) {
	test(`native creation records ${name} without an artifact`, { timeout: 30000 }, async (t) => {
		const h = await startHarness(t);
		h.faux.setResponses([...responses]);
		await h.harness.waitForTask(await admitCreation(h), context);
		assert.equal((await listStashes(h.storeDir, {})).length, 0);
		assert.equal((await creationReceipt(h.root)).status, status);
		assert.equal(h.faux.state.callCount, responses.length);
	});
}

test("native creation records publication failure without another generation", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	const obstacle = join(h.workdir, "not-a-directory");
	await writeFile(obstacle, "occupied");
	const token = "sk-abcdefgh" + "ijklmnop1234";
	h.faux.setResponses([fauxAssistantMessage('{"title":"Failure","summary":"Valid result."}')]);
	await h.harness.waitForTask(
		await admitCreation(h, "failure", { ...creationInput(h), storeDir: obstacle, branch: `branch/${token}` }),
		context,
	);
	const receipt = await creationReceipt(h.root);
	assert.equal(receipt.status, "failed");
	assert.equal((receipt.redactions as Durable.JsonObject).count, 1);
	assert.match(String(receipt.message), /Redaction notice: 1.*provider token/);
	assert.ok(!JSON.stringify(receipt).includes(token));
	assert.equal(h.faux.state.callCount, 1);
	assert.equal((await listStashes(h.storeDir, {})).length, 0);
});

test("native admission failures retain sanitized input and error notices", async (t) => {
	const h = await startHarness(t);
	const token = "sk-abcdefgh" + "ijklmnop1234";
	const hint = captureHint(`Focus ${token}`);
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	const commit = t.mock.method(h.root, "commit", async () => {
		throw new Error(`Admission failed ${token}`);
	});
	try {
		await assert.rejects(
			command.run({
				args: "new",
				data: { ...creationInput(h), ...hint },
				conversation: h.root,
				context,
				host: h.host,
				invocationId: "admission-failure",
				harness: h.harness,
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Admission failed/);
				assert.match(error.message, /Redaction notice: 2.*provider token/);
				assert.ok(!error.message.includes(token));
				return true;
			},
		);
	} finally {
		commit.mock.restore();
	}
	assert.equal(h.faux.state.callCount, 0);
});

test("native creation validates structured input before configuration or admission", async (t) => {
	const h = await startHarness(t);
	const before = await h.root.agent(context);
	for (const data of [
		null,
		[],
		{},
		{ ...creationInput(h), hint: " " },
		{ ...creationInput(h), artifacts: [3] },
		{ ...creationInput(h), project: "relative" },
		{ ...creationInput(h), storeDir: "relative" },
		{ ...creationInput(h), transcript: 3 },
		{ ...creationInput(h), branch: 3 },
		{ ...creationInput(h), redactions: { count: 2, classes: {}, contexts: [] } },
		{ ...creationInput(h), redactions: { count: 1, classes: { hostile: 1 }, contexts: [] } },
		{ ...creationInput(h), hintDigest: "invalid" },
	]) {
		await assert.rejects(admitCreation(h, "invalid-input", data));
	}
	assert.deepEqual(await h.root.agent(context), before);
	assert.equal((await h.harness.commit((tx) => tx.scanTasks({ kind: "stash.distill" }, 10), context)).items.length, 0);
});

test("isolated native workers preserve each snapshot under burst admission and caller abort", {
	timeout: 30000,
}, async (t) => {
	const h = await startHarness(t);
	const count = 16;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.faux.setResponses(
		Array.from({ length: count }, () => async (request) => {
			await gate;
			const text = request.messages.map(messageText).join("\n");
			const subject = /Operator hint: (effort-\d+)/u.exec(text)?.[1];
			assert.ok(subject);
			return fauxAssistantMessage(JSON.stringify({ title: subject, summary: `${subject} captured state.` }));
		}),
	);
	const workers = await Promise.all(
		Array.from({ length: count }, () =>
			h.harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: h.workdir } },
				context,
			),
		),
	);
	const taskIds = await Promise.all(
		workers.map((root, index) =>
			admitCreation({ ...h, root }, `burst-${index}`, {
				...creationInput(h),
				hint: `effort-${index}`,
				sessionId: `source-${index}`,
			}),
		),
	);
	await h.root.abort(context, { background: true });
	release();
	const results = await Promise.all(taskIds.map((id) => h.harness.waitForTask(id, context)));
	assert.ok(results.every((result) => result.state.outcome.status === "completed"));
	const entries = await listStashes(h.storeDir, { limit: 50 });
	assert.equal(entries.length, count);
	for (let i = 0; i < count; i++) {
		const entry = entries.find((item) => item.meta.title === `effort-${i}`);
		assert.equal(entry?.meta.sessionId, `source-${i}`);
		assert.equal((await creationReceipt(workers[i])).id, entry?.meta.id);
	}
	assert.equal(h.faux.state.callCount, count);
	assert.equal(await modelText(h.root), "");
});

test("reports lifecycle failures from the command without changing the store", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	capacityOff(t);
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	await assert.rejects(
		command.run({
			args: "complete missing-id done",
			conversation: h.root,
			context,
			host: h.host,
			invocationId: "missing-1",
			harness: h.harness,
		}),
		/no stash matches/u,
	);
	assert.equal((await listStashes(h.storeDir, {})).length, 0);
	await assert.rejects(
		command.run({
			args: "new",
			conversation: h.root,
			context,
			host: h.host,
			invocationId: "empty-new",
			harness: h.harness,
		}),
		/Usage: \/stash new/u,
	);
});

test("keys pickup submissions by invocation identity", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	capacityOff(t);
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	const written = await writeStash(h.storeDir, { title: "Pickup target", summary: "Body." });
	h.faux.setResponses([fauxAssistantMessage("picked up"), fauxAssistantMessage("picked up again")]);
	const call = (invocationId: string) => ({
		args: `get ${written.record.id}`,
		conversation: h.root,
		context,
		host: h.host,
		invocationId,
		harness: h.harness,
	});
	const first = await command.run(call("pickup-1"));
	const firstId = /submission (\d+)/u.exec(first)?.[1];
	assert.ok(firstId, first);
	const repeat = await command.run(call("pickup-1"));
	assert.equal(/submission (\d+)/u.exec(repeat)?.[1], firstId, "a retried invocation reuses its submission");
	const second = await command.run(call("pickup-2"));
	assert.notEqual(/submission (\d+)/u.exec(second)?.[1], firstId, "a distinct invocation is a distinct request");
	await h.harness.waitForIdle(context);
});

const fixturePath = fileURLToPath(new URL("./durable-fixture.mts", import.meta.url));

function readyFrom(child: ReturnType<typeof spawn>, timeoutMs = 30000): Promise<void> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const detail = (message: string) => `${message}\nstdout=${stdout}\nstderr=${stderr}`;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(detail("fixture did not reach readiness")));
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (settled || !stdout.includes("READY\n")) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(detail(`fixture exited before readiness: ${String(code)}`)));
		});
	});
}

function childDeath(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

/** Reopen one crashed SQLite storage in this process with a fresh faux provider. */
async function recover(
	storagePath: string,
	storeDir: string,
	workdir: string,
	answer: string,
): Promise<{ harness: Durable.Harness; root: Durable.Conversation; faux: ReturnType<typeof fauxProvider> }> {
	process.env.PI_STASH_DIR = storeDir;
	process.env.PI_STASH_CAPACITY = "0";
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host: StashDurableHost = {
		durable: Durable,
		services: { modelRuntime: models } as unknown as AgentSessionServices,
		cwd: workdir,
		agentDir: workdir,
		storageId: "stash-replay",
		launchIndependent: async () => {
			throw new Error("replay fixture does not launch work");
		},
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [], ordinaryOnly: [] },
	};
	const registry = createRegistry();
	registry.install(stashDurableContribution(fileURLToPath(new URL("./index.ts", import.meta.url)), createEventBus(), () => {}).create(host));
	faux.setResponses([fauxAssistantMessage(answer)]);
	const harness = await Harness.open(await openNodeSqliteStorage(storagePath), { models, registry }, context);
	harness.resume();
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workdir },
	});
	return { harness, root, faux };
}

async function replayCase(
	t: { after(fn: () => void | Promise<void>): void },
	mode: "write" | "complete" | "distill",
): Promise<void> {
	const rootDir = await mkdtemp(join(tmpdir(), `stash-replay-${mode}-`));
	t.after(async () => {
		delete process.env.PI_STASH_DIR;
		delete process.env.PI_STASH_CAPACITY;
		await rm(rootDir, { recursive: true, force: true });
	});
	const storagePath = join(rootDir, "run.sqlite");
	const storeDir = join(rootDir, "store");
	const workdir = join(rootDir, "work");
	await mkdir(storeDir, { recursive: true });
	await mkdir(workdir, { recursive: true });
	const artifactId =
		mode === "complete"
			? (await writeStash(storeDir, { title: "Replay target", summary: "Target body." })).record.id
			: undefined;
	const prompt = `replay ${mode}`;
	const requestId = `replay-${mode}`;
	const child = spawn(
		process.execPath,
		[fixturePath, storagePath, mode, storeDir, workdir, artifactId ?? "", prompt, requestId],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	try {
		await readyFrom(child);
		const death = childDeath(child);
		child.kill("SIGKILL");
		await death;
		process.env.PI_STASH_DIR = storeDir;
		const before = await listStashes(storeDir, {});
		assert.equal(before.length, 1, "the killed attempt reached its external effect");

		const original = await readFile(before[0].path);
		const { harness, root, faux } = await recover(storagePath, storeDir, workdir, "after recovery");
		try {
			if (mode === "distill") {
				const tasks = await harness.commit((tx) => tx.scanTasks({ kind: "stash.distill" }, 10), context);
				assert.equal(tasks.items.length, 1);
				const settled = await harness.waitForTask(tasks.items[0].id, context);
				assert.equal(settled.state.outcome.status, "completed");
				assert.equal((await listStashes(storeDir, {})).length, 1);
				assert.deepEqual(await readFile(before[0].path), original);
				assert.equal((await creationReceipt(root)).id, before[0].meta.id);
				assert.equal(faux.state.callCount, 0, "committed generation is not repeated after recovery");
				return;
			}
			const submission = await root.submit({ type: "input", content: prompt, requestId }, context);
			const settled = await submission.wait(context);
			assert.equal(settled.status, "done", settled.status === "unanswered" ? settled.reason : "");
			const after = await listStashes(storeDir, {});
			assert.equal(after.length, 1, "the recovery publishes no second artifact");
			const results = await toolResults(root);
			const target = results.find((result) =>
				mode === "write" ? result.name === "stash_write" : result.name === "stash_complete",
			);
			assert.ok(target, "the tool result is retained");
			if (mode === "write") {
				assert.equal(target.isError, false, "the replay-safe write completes its result");
				assert.match(target.text, /Stashed "Replay handover"/u);
			} else {
				assert.equal(target.isError, true, "the unsafe mutation keeps an interrupted result");
				assert.match(target.text, /interrupted/u);
				assert.doesNotMatch(target.text, /already closed/u);
				assert.equal(after[0]?.meta.state, "closed", "the killed attempt's mutation stands");
				assert.equal(after[0]?.meta.outcome, "Closed before the process died.");
			}
		} finally {
			await harness.close(context);
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const death = childDeath(child);
			child.kill("SIGKILL");
			await death;
		}
	}
}

test("replays native creation after publication without a duplicate artifact or generation", {
	timeout: 60000,
}, async (t) => {
	await replayCase(t, "distill");
});

test("replays a safe stash_write without a duplicate artifact", { timeout: 60000 }, async (t) => {
	await replayCase(t, "write");
});

test("interrupts an unsafe stash_complete without rerunning its mutation", { timeout: 60000 }, async (t) => {
	await replayCase(t, "complete");
});
