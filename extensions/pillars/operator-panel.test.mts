/** The attached-terminal reader: a pure module over the shared browser, every page read through the host. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { pillarsDurableContribution, type DurableCommandCall, type DurableContributionHost } from "./durable.ts";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { JsonValue, PanelHost } from "../../operator-ui/index.ts";
import { operatorPanel } from "./operator-panel.ts";
import { readPanelAnswer, readPanelRequest } from "./panel-protocol.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

function panelHost(request: PanelHost["request"]): PanelHost {
	return { theme, target: { id: "c", label: "Reviewer · work" }, signal: new AbortController().signal, requestRender: () => {}, notify: () => {}, push: () => {}, back: () => {}, focusActions: () => {}, close: () => {}, request };
}
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

test("the reader module lists the inventory and reads a selected source through the host", async (t) => {
	const { root } = await corpus(t);
	const run = command(join(root, "agent"));
	const requests: JsonValue[] = [];
	const module = operatorPanel();
	assert.equal(module.title, "Pillars");
	const view = module.open(panelHost(async (data) => {
		requests.push(data);
		return (await run(data)) as { text: string; data?: JsonValue };
	}));
	const screen = () => view.render(120, 20).map(stripVTControlCharacters).join("\n");
	assert.match(screen(), /Reading the inventory/);
	await flush();
	assert.ok(screen().includes("Principle one"), screen());
	assert.deepEqual(requests[0], { op: "inventory" });
	view.handleInput("\x1b[B");
	view.handleInput("\x1b[B");
	await flush();
	assert.ok(screen().includes("Checked evidence"), screen());
	assert.ok(requests.some((request) => (request as { op?: string }).op === "read" && (request as { resource?: string }).resource === "principle-one"));
	assert.deepEqual(view.actions?.().map((action) => action.label), ["Read more", "Read again"]);
});

test("an unreadable inventory is reported in the view", async () => {
	const view = operatorPanel().open(panelHost(async () => {
		throw new Error("corpus missing");
	}));
	await flush();
	assert.match(view.render(80, 10).map(stripVTControlCharacters).join("\n"), /corpus missing/);
});
