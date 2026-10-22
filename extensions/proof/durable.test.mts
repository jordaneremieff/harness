import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { type ProofDurableHost, proofDurableContribution } from "./durable.ts";

const context = BACKGROUND_CONTEXT;
const FIXTURE = fileURLToPath(new URL("./meter-fixture.mts", import.meta.url));
const saved = ["PI_HARNESS_FILE", "PI_PROOF_METER_PATH", "PI_PROOF_TIMEOUT_MS", "PI_PROOF_TEST_LOG"].map(
	(key) => [key, process.env[key]] as const,
);
let dir = "";
let log = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "proof-durable-"));
	log = join(dir, "runs.log");
	await writeFile(log, "");
	delete process.env.PI_HARNESS_FILE;
	process.env.PI_PROOF_METER_PATH = FIXTURE;
	process.env.PI_PROOF_TIMEOUT_MS = "1500";
	process.env.PI_PROOF_TEST_LOG = log;
});
afterEach(async () => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(dir, { recursive: true, force: true });
});

async function start(t: { after(fn: () => Promise<void>): void }) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let opened: Durable.Harness | undefined;
	const host: ProofDurableHost = {
		durable: Durable,
		agentDir: dir,
		get harness() {
			if (!opened) throw new Error("harness not open");
			return opened;
		},
		onClose: () => {},
	};
	const contribution = proofDurableContribution(fileURLToPath(new URL("./index.ts", import.meta.url)), createEventBus(), () => {});
	const registry = createRegistry();
	registry.install(contribution.create(host));
	opened = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await opened.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: dir } });
	const open = opened;
	t.after(() => open.close(context));
	const run = async (...replies: string[]) => {
		faux.setResponses(replies.map((reply) => fauxAssistantMessage(reply)));
		const settled = await (await root.submit({ type: "input", content: "question" }, context)).wait(context);
		assert.equal(settled.status, "done", settled.status === "unanswered" ? settled.reason : "");
	};
	const transcript = async () => {
		const view = await root.context(context);
		return view.messages.map((message: Message) => (typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))).join("\n---\n");
	};
	return { run, transcript, faux };
}
const runs = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).length;
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("contribution names the proof extension and its entrypoint", () => {
	const source = fileURLToPath(new URL("./index.ts", import.meta.url));
	const contribution = proofDurableContribution(source, createEventBus(), () => {});
	assert.equal(contribution.name, "proof");
	assert.equal(contribution.source, source);
});

test("hard findings continue the answer once with the findings text", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run("first HARD reply", "second HARD reply");
	const text = await h.transcript();
	assert.equal(count(text, "The prose meter found problems"), 1);
	assert.match(text, /punctuation\.em-dash line 2 "x": Em dash found/u);
	assert.match(text, /second HARD reply/u);
	assert.equal(await runs(), 1, "the repaired answer is not measured again");
});

test("the guard resets for the next run", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run("one HARD", "one repaired");
	await h.run("two HARD", "two repaired");
	assert.equal(count(await h.transcript(), "The prose meter found problems"), 2);
	assert.equal(await runs(), 2);
});

test("a clean answer adds nothing", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run("plain reply");
	assert.equal(count(await h.transcript(), "prose meter"), 0);
});

test("an unavailable meter adds one notice, does not continue, and stays silent until it works again", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run("first EXIT4");
	let text = await h.transcript();
	assert.equal(count(text, "The prose meter check did not run"), 1);
	assert.match(text, /meter failed/u);
	await h.run("second EXIT4");
	assert.equal(count(await h.transcript(), "The prose meter check did not run"), 1);
	await h.run("fine now");
	await h.run("third EXIT4");
	text = await h.transcript();
	assert.equal(count(text, "The prose meter check did not run"), 2);
});

test("a hanging meter is killed and noticed", { timeout: 30000 }, async (t) => {
	process.env.PI_PROOF_TIMEOUT_MS = "300";
	const h = await start(t);
	await h.run("HANG");
	assert.match(await h.transcript(), /meter timed out/u);
});
