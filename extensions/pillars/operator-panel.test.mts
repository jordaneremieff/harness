/** The attached-terminal reader: a pure module over the shared browser, every page read through the host. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { pillarsDurableContribution, type DurableCommandCall, type DurableContributionHost } from "./durable.ts";
import { operatorPanel, type OperatorPanelHost } from "./operator-panel.ts";
import { readPanelAnswer, readPanelRequest } from "./panel-protocol.ts";

type JsonValue = Parameters<OperatorPanelHost["request"]>[0];
const flush = async () => { for (let round = 0; round < 40; round++) await new Promise((resolve) => setTimeout(resolve, 5)); };

async function corpus(t: { after(fn: () => void | Promise<void>): void }) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pillars-operator-panel-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "corpus");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "README.md"), "# Inventory\n\n| Entry | Index |\n|---|---|\n| [Principle one](principle-one.md) | Check evidence before claims. |\n");
	await writeFile(join(dir, "GOVERNANCE.md"), "# Governance\n\nRead the matching body.\n");
	await writeFile(join(dir, "principle-one.md"), "# Principle one\n\nChecked evidence.\n");
	const previous = process.env.PI_PILLARS_CORPUS;
	process.env.PI_PILLARS_CORPUS = dir;
	t.after(() => { if (previous === undefined) delete process.env.PI_PILLARS_CORPUS; else process.env.PI_PILLARS_CORPUS = previous; });
	return { root, dir };
}

function command(agentDir: string) {
	const contribution = pillarsDurableContribution("/owner/index.ts", { bus: { emit() {}, on: () => () => {} } as never, stopFactory() {} });
	assert.deepEqual(contribution.panel, { version: 1, entry: "./operator-panel.ts", export: "operatorPanel", command: "pillars" });
	const run = contribution.commands?.[0].run;
	assert.ok(run);
	const host = { agentDir } as DurableContributionHost;
	return (data?: JsonValue) => run({ args: "", ...(data === undefined ? {} : { data }), host, context: {}, invocationId: "inv", conversation: { submit() { throw new Error("no judgment action may start from the reader"); } } } as unknown as DurableCommandCall);
}

test("the reader route answers inventory and exact source pages without starting a judgment action", async (t) => {
	const { root } = await corpus(t);
	const run = command(join(root, "agent"));
	const inventory = await run({ op: "inventory" }) as { text: string; data: unknown };
	const answer = readPanelAnswer({ op: "inventory" }, inventory.data);
	assert.ok(answer.op === "inventory");
	assert.deepEqual(answer.entries.map((entry) => entry.resource), ["inventory", "governance", "principle-one"]);
	assert.equal(answer.entries[2].index, "Check evidence before claims.");
	const page = await run({ op: "read", resource: "principle-one" }) as { text: string; data: unknown };
	const read = readPanelAnswer({ op: "read", resource: "principle-one" }, page.data);
	assert.ok(read.op === "read" && read.page.schema === "pillars-source" && /Checked evidence/.test(read.page.text));
	assert.match(page.text, /principle-one bytes 0-/);
	const stale = await run({ op: "read", resource: "principle-one", offset: 5, referenceBodyDigest: "a".repeat(64) }) as { data: unknown };
	const refused = readPanelAnswer({ op: "read", resource: "principle-one" }, stale.data);
	assert.ok(refused.op === "read" && refused.page.schema === "pillars-source-error");
	await assert.rejects(run({ op: "check" }), /not supported/);
	assert.throws(() => readPanelRequest({ op: "read", resource: "../x" }), /resource identifier/);
	assert.throws(() => readPanelRequest({ op: "read", resource: "inventory", referenceBodyDigest: "nope" }), /digest/);
	const text = await run();
	assert.match(String(text), /check, derive, or review/);
});

test("the reader module lists the inventory, opens a source through the host, and closes on Esc", async (t) => {
	const { root } = await corpus(t);
	const run = command(join(root, "agent"));
	const requests: JsonValue[] = [];
	let closed = 0;
	const module = operatorPanel();
	assert.equal(module.title, "Pillars");
	const instance = module.open({
		target: { id: "c" }, tui: { requestRender() {} }, rows: () => 20,
		request: async (data) => { requests.push(data); return await run(data) as { text: string; data?: JsonValue }; },
		close: () => { closed++; },
	});
	assert.match(instance.render(60).join("\n"), /Read Pillars inventory/);
	await flush();
	let lines = instance.render(60).map(stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("Principle one")), lines.join("\n"));
	assert.deepEqual(requests[0], { op: "inventory" });
	instance.handleInput("\x1b[B"); instance.handleInput("\x1b[B");
	instance.handleInput("\r");
	await flush();
	lines = instance.render(60).map(stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("Checked evidence")), lines.join("\n"));
	assert.ok(requests.some((request) => (request as { op?: string }).op === "read"));
	instance.handleInput("\x1b");
	instance.handleInput("\x1b");
	assert.equal(closed, 1);
	instance.dispose();
});

test("an unreadable inventory is reported and Esc still returns", async () => {
	let closed = 0;
	const instance = operatorPanel().open({ target: { id: "c" }, tui: { requestRender() {} }, rows: () => 20, request: async () => { throw new Error("corpus missing"); }, close: () => { closed++; } });
	await flush();
	assert.match(instance.render(60).join("\n"), /corpus missing/);
	instance.handleInput("\x1b");
	assert.equal(closed, 1);
	instance.dispose();
});
