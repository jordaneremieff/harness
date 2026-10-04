import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type StashDurableContribution, type StashDurableHost, stashDurableContribution } from "./durable.ts";
import { listStashes, readStash, writeStash } from "./store.ts";

const context = BACKGROUND_CONTEXT;

interface TestHarness {
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
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [], ordinaryOnly: [] },
	};
	const contribution = stashDurableContribution(fileURLToPath(new URL("./index.ts", import.meta.url)));
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
	return { harness, root, faux, host, contribution, extension, storeDir, workdir };
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

test("runs /stash new as a background distilling task with a receipt", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	capacityOff(t);
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	h.faux.setResponses([
		fauxAssistantMessage(
			'```json\n{"title":"Distilled focus","summary":"The command distilled the conversation context."}\n```',
		),
	]);
	const started = await command.run({
		args: "new focus on the tests",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "distill-1",
		harness: h.harness,
	});
	const taskId = /task (\d+)/u.exec(started)?.[1];
	assert.ok(taskId, started);
	const settled = await h.harness.waitForTask(Number(taskId) as Durable.TaskId, context);
	assert.equal(settled.state.status, "terminal");
	assert.equal(settled.state.outcome?.status, "completed", JSON.stringify(settled.state.outcome));
	const entries = await listStashes(h.storeDir, {});
	assert.equal(entries.length, 1, "the task publishes one artifact");
	assert.equal(entries[0]?.meta.title, "Distilled focus");
	assert.equal(entries[0]?.meta.sessionId, String(h.root.id));
});

test("aborts only the recorded distillation task", { timeout: 30000 }, async (t) => {
	const h = await startHarness(t);
	capacityOff(t);
	const command = h.contribution.commands?.[0];
	assert.ok(command);
	h.faux.setResponses([fauxAssistantMessage("conversation still works")]);
	const started = await command.run({
		args: "new abort this one",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "abort-new",
		harness: h.harness,
	});
	const taskId = Number(/task (\d+)/u.exec(started)?.[1]) as Durable.TaskId;
	assert.ok(taskId, started);
	const aborting = await command.run({
		args: "abort",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "abort-1",
		harness: h.harness,
	});
	assert.match(aborting, new RegExp(`task ${String(taskId)} is aborting`, "u"));
	const settled = await h.harness.waitForTask(taskId, context);
	assert.equal(settled.state.outcome?.status, "aborted");
	assert.equal((await listStashes(h.storeDir, {})).length, 0, "the aborted task writes no artifact");
	// The task clears its recorded id, so a later abort reports nothing in flight.
	const again = await command.run({
		args: "abort",
		conversation: h.root,
		context,
		host: h.host,
		invocationId: "abort-2",
		harness: h.harness,
	});
	assert.match(again, /No stash distillation task is running/u);
	// The abort does not touch ordinary conversation work.
	await answerWith(h.root, h.faux, [fauxAssistantMessage("conversation still works")], "are you alive?");
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
): Promise<{ harness: Durable.Harness; root: Durable.Conversation }> {
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
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [], ordinaryOnly: [] },
	};
	const registry = createRegistry();
	registry.install(stashDurableContribution(fileURLToPath(new URL("./index.ts", import.meta.url))).create(host));
	faux.setResponses([fauxAssistantMessage(answer)]);
	const harness = await Harness.open(await openNodeSqliteStorage(storagePath), { models, registry }, context);
	harness.resume();
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workdir },
	});
	return { harness, root };
}

async function replayCase(
	t: { after(fn: () => void | Promise<void>): void },
	mode: "write" | "complete",
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

		const { harness, root } = await recover(storagePath, storeDir, workdir, "after recovery");
		try {
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

test("replays a safe stash_write without a duplicate artifact", { timeout: 60000 }, async (t) => {
	await replayCase(t, "write");
});

test("interrupts an unsafe stash_complete without rerunning its mutation", { timeout: 60000 }, async (t) => {
	await replayCase(t, "complete");
});
