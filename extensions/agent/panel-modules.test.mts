import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createDurableServices } from "./durable-services.ts";
import { readPanelDescriptor, resolvePanelEntry } from "./display-descriptor.ts";
import { loadPanelModules } from "./panel-modules.ts";

const panel = { version: 1, entry: "./panel.ts", export: "operatorPanel", command: "browse" } as const;

function directory(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "panel-modules-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

it("accepts only a bare relative entry, the fixed export and an owner command name", () => {
	assert.deepEqual(readPanelDescriptor(panel), panel);
	for (const entry of ["panel.ts", "../panel.ts", "/abs/panel.ts", "./a//b.ts", "./a/./b.ts", "file:///x/panel.ts", "./a\\b.ts", "./x.ts?y", "./"]) {
		assert.throws(() => readPanelDescriptor({ ...panel, entry }), /relative file path/, entry);
	}
	assert.throws(() => readPanelDescriptor({ ...panel, version: 2 }), /version 1/);
	assert.throws(() => readPanelDescriptor({ ...panel, export: "toolDisplay" }), /export operatorPanel/);
	assert.throws(() => readPanelDescriptor({ ...panel, extra: true }), /unknown fields/);
	for (const command of ["", "Browse", "bad name", "x".repeat(65), 7]) assert.throws(() => readPanelDescriptor({ ...panel, command }), /owner command/, String(command));
	const { command: _command, ...withoutCommand } = panel;
	assert.throws(() => readPanelDescriptor(withoutCommand), /owner command/);
});

it("resolves the panel entry inside the owner directory and refuses an escape", (t) => {
	const root = directory(t);
	mkdirSync(join(root, "owner")); mkdirSync(join(root, "outside"));
	writeFileSync(join(root, "owner", "index.ts"), ""); writeFileSync(join(root, "owner", "panel.ts"), ""); writeFileSync(join(root, "outside", "panel.ts"), "");
	symlinkSync(join(root, "outside", "panel.ts"), join(root, "owner", "escape.ts"));
	assert.ok(resolvePanelEntry(join(root, "owner", "index.ts"), panel).endsWith(join("owner", "panel.ts")));
	assert.throws(() => resolvePanelEntry(join(root, "owner", "index.ts"), { ...panel, entry: "./escape.ts" }), /escapes/);
	assert.throws(() => resolvePanelEntry(join(root, "owner", "index.ts"), { ...panel, entry: "./missing.ts" }), /ENOENT/);
});

const MODULE = `
export function operatorPanel() {
	return { version: 1, title: "Fixture browser", open(host) {
		return { render: (width) => [host.target.id.slice(0, width)], handleInput() {}, dispose() {} };
	} };
}
`;

function inventory(entries: Array<{ name: string; source: string; panel?: unknown }>) {
	return { contributions: entries.map((entry) => ({ commands: [{ name: "browse", description: "browse" }], ...entry })), ordinaryOnly: [] };
}

it("imports advertised panel modules and lists every failure as an unavailable browser", async (t) => {
	const root = directory(t);
	const files: Record<string, string> = {
		"good/index.ts": "", "good/panel.ts": MODULE,
		"wrong/index.ts": "", "wrong/panel.ts": "export function operatorPanel() { return { version: 2, title: 'x', open() {} }; }",
		"untitled/index.ts": "", "untitled/panel.ts": "export function operatorPanel() { return { version: 1, title: '', open() {} }; }",
		"throws/index.ts": "", "throws/panel.ts": "export function operatorPanel() { throw new Error('boom'); }",
		"nofunction/index.ts": "", "nofunction/panel.ts": "export const operatorPanel = 1;",
	};
	for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
	const source = (name: string) => join(root, name, "index.ts");
	const result = await loadPanelModules(inventory([
		{ name: "good", source: source("good"), panel },
		{ name: "wrong", source: source("wrong"), panel },
		{ name: "untitled", source: source("untitled"), panel },
		{ name: "throws", source: source("throws"), panel },
		{ name: "nofunction", source: source("nofunction"), panel },
		{ name: "missing", source: source("missing"), panel },
		{ name: "traversal", source: source("good"), panel: { ...panel, entry: "../good/panel.ts" } },
		{ name: "plain", source: source("good") },
	]));
	assert.deepEqual(result.panels.map((item) => [item.contribution, item.title, item.module !== undefined]), [
		["good", "Fixture browser", true], ["wrong", "wrong", false], ["untitled", "untitled", false], ["throws", "throws", false], ["nofunction", "nofunction", false], ["missing", "missing", false], ["traversal", "traversal", false],
	]);
	assert.equal(result.panels[0].command, "browse");
	for (const item of result.panels.slice(1)) assert.ok(item.unavailable && item.unavailable.length <= 160, item.contribution);
	assert.equal(result.diagnostics.length, 6);
	for (const line of result.diagnostics) assert.ok(/browser unavailable here/.test(line) && line.length <= 200 && !/\n/.test(line));
	const good = result.panels[0].module;
	assert.ok(good);
	const instance = good.open({ target: { id: "conversation-1" } } as never);
	assert.deepEqual(instance.render(8), ["conversa"]);
});

it("a malformed inventory yields no browsers and one diagnostic", async () => {
	const result = await loadPanelModules({ contributions: "nope" });
	assert.deepEqual(result.panels, []);
	assert.equal(result.diagnostics.length, 1);
});

const EMIT = (descriptor: string, commands = `[{ name: "browse", description: "Browse", run: async (call) => call.data === undefined ? "text" : { text: "data", data: call.data } }]`) => `import { fileURLToPath } from "node:url";
export default function (pi) {
	pi.events.emit("durable:contribution", { name: "fixture.panel", source: fileURLToPath(import.meta.url), commands: ${commands}, panel: ${descriptor}, create(host) { return host.durable.defineExtension({ name: "fixture.panel" }); } });
}
`;

async function hostInventory(t: { after(fn: () => void): void }, descriptor: string, files: Record<string, string> = {}, commands?: string) {
	const root = directory(t);
	const cwd = join(root, "work"); const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" } }));
	const owner = join(root, "owner"); mkdirSync(owner);
	writeFileSync(join(owner, "index.ts"), EMIT(descriptor, commands));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(owner, name), text);
	const reports: string[] = [];
	const services = await createDurableServices({ cwd, agentDir, storageId: "panel-host", extensionPaths: [join(owner, "index.ts")], trusted: true, packageDir: getPackageDir(), onReport: (error) => reports.push(String(error)) });
	t.after(() => services.close());
	return { services, reports };
}

it("the host advertises a panel only for an admitted contribution whose entry resolves and whose command is its own", async (t) => {
	const advertised = await hostInventory(t, JSON.stringify(panel), { "panel.ts": MODULE });
	assert.deepEqual(advertised.services.inventory.contributions.map(({ name, panel: value }) => ({ name, panel: value })), [{ name: "fixture.panel", panel }]);
	assert.deepEqual(advertised.reports, []);
});

it("a refused panel descriptor keeps the contribution, its commands and its text route, and drops only the panel", async (t) => {
	for (const [descriptor, files, commands, message] of [
		[JSON.stringify({ ...panel, entry: "../escape.ts" }), { "panel.ts": MODULE }, undefined, /relative file path/],
		[JSON.stringify({ ...panel, version: 2 }), { "panel.ts": MODULE }, undefined, /version 1/],
		[JSON.stringify({ ...panel, command: "other" }), { "panel.ts": MODULE }, undefined, /not a command of this contribution/],
		[JSON.stringify(panel), {}, undefined, /panel entry refused/],
		[JSON.stringify(panel), { "panel.ts": MODULE }, "[]", /not a command of this contribution/],
	] as const) {
		const refused = await hostInventory(t, descriptor, files, commands);
		assert.deepEqual(refused.services.inventory.contributions.map(({ name, panel: value }) => ({ name, panel: value })), [{ name: "fixture.panel", panel: undefined }]);
		assert.ok(refused.reports.some((line) => message.test(line)), `${descriptor} ${commands ?? ""}`);
		if (commands === undefined) assert.ok(refused.services.commands.has("browse"), "the owner command survives a refused panel");
	}
});
