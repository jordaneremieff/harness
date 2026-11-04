import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createDurableServices } from "./durable-services.ts";
import { readDisplayDescriptor, resolveDisplayEntry } from "./display-descriptor.ts";
import { loadDisplayModules } from "./display-modules.ts";
import { createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";

const display = { version: 1, entry: "./display.ts", export: "toolDisplay" } as const;

function directory(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "display-modules-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

it("accepts only a bare relative entry with the fixed export", () => {
	assert.deepEqual(readDisplayDescriptor(display), display);
	for (const entry of ["display.ts", "../display.ts", "./../display.ts", "/abs/display.ts", "./a//b.ts", "./a/./b.ts", "file:///x/display.ts", "./a\\b.ts", "./a b.ts", "./x.ts?y", "./x.ts#y", "./"]) {
		assert.throws(() => readDisplayDescriptor({ ...display, entry }), /relative file path/, entry);
	}
	assert.throws(() => readDisplayDescriptor({ ...display, version: 2 }), /version 1/);
	assert.throws(() => readDisplayDescriptor({ ...display, export: "other" }), /export toolDisplay/);
	assert.throws(() => readDisplayDescriptor({ ...display, extra: true }), /unknown fields/);
	assert.throws(() => readDisplayDescriptor("./display.ts"), /object/);
});

it("resolves inside the owner directory and refuses a symbolic-link escape or a missing file", (t) => {
	const root = directory(t);
	mkdirSync(join(root, "owner"));
	mkdirSync(join(root, "outside"));
	writeFileSync(join(root, "owner", "index.ts"), "");
	writeFileSync(join(root, "owner", "display.ts"), "");
	writeFileSync(join(root, "outside", "display.ts"), "");
	symlinkSync(join(root, "outside", "display.ts"), join(root, "owner", "escape.ts"));
	assert.equal(resolveDisplayEntry(join(root, "owner", "index.ts"), display), realpathSync(join(root, "owner", "display.ts")));
	assert.throws(() => resolveDisplayEntry(join(root, "owner", "index.ts"), { ...display, entry: "./escape.ts" }), /escapes/);
	assert.throws(() => resolveDisplayEntry(join(root, "owner", "index.ts"), { ...display, entry: "./missing.ts" }), /ENOENT/);
	assert.throws(() => resolveDisplayEntry("relative/index.ts", display), /absolute/);
});

const MODULE = `
const call = () => ({ render: () => ["owner call"], invalidate() {} });
export function toolDisplay() { return { version: 1, tools: [{ name: "fixture_tool", renderCall: call, renderResult: call, execute() { throw new Error("must never be copied"); } }, { name: "read", renderCall: call }, { name: "bad", renderCall: "not a function" }] }; }
`;

function inventory(entries: Array<{ name: string; source: string; display?: unknown }>) {
	return { contributions: entries.map((entry) => ({ commands: [], ...entry })), ordinaryOnly: [] };
}

it("imports advertised modules, keeps checked presentation records and contains every failure by contribution", async (t) => {
	const root = directory(t);
	const files: Record<string, string> = {
		"good/index.ts": "", "good/display.ts": MODULE,
		"wrong/index.ts": "", "wrong/display.ts": "export function toolDisplay() { return { version: 2, tools: [] }; }",
		"throws/index.ts": "", "throws/display.ts": "export function toolDisplay() { throw new Error('boom'); }",
		"syntax/index.ts": "", "syntax/display.ts": "export function toolDisplay( {",
		"nofunction/index.ts": "", "nofunction/display.ts": "export const toolDisplay = 1;",
		"duplicate/index.ts": "", "duplicate/display.ts": MODULE,
	};
	for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
	const source = (name: string) => join(root, name, "index.ts");
	const result = await loadDisplayModules(inventory([
		{ name: "good", source: source("good"), display },
		{ name: "wrong", source: source("wrong"), display },
		{ name: "throws", source: source("throws"), display },
		{ name: "syntax", source: source("syntax"), display },
		{ name: "nofunction", source: source("nofunction"), display },
		{ name: "missing", source: source("missing"), display },
		{ name: "traversal", source: source("good"), display: { ...display, entry: "../good/display.ts" } },
		{ name: "duplicate", source: source("duplicate"), display },
		{ name: "plain", source: source("good") },
	]));
	assert.equal(typeof result.lookup("fixture_tool")?.renderCall, "function");
	assert.equal(typeof result.lookup("fixture_tool")?.renderResult, "function");
	assert.equal(Object.hasOwn(result.lookup("fixture_tool") ?? {}, "execute"), false);
	assert.equal(result.lookup("bad"), undefined);
	assert.equal(result.lookup("nothing"), undefined);
	const joined = result.diagnostics.join("\n");
	for (const name of ["wrong", "throws", "syntax", "nofunction", "missing", "traversal", "duplicate"]) assert.match(joined, new RegExp(`${name}:`), name);
	assert.equal(result.diagnostics.length, 7);
	for (const line of result.diagnostics) assert.ok(line.length <= 200 && !/\n/.test(line));
});

it("a malformed inventory yields standard cards and one diagnostic", async () => {
	const result = await loadDisplayModules({ contributions: "nope" });
	assert.equal(result.lookup("fixture_tool"), undefined);
	assert.equal(result.diagnostics.length, 1);
});

it("display definitions keep builtin precedence and can never execute", async (t) => {
	const root = directory(t);
	mkdirSync(join(root, "good"));
	writeFileSync(join(root, "good", "index.ts"), "");
	writeFileSync(join(root, "good", "display.ts"), MODULE);
	const { lookup } = await loadDisplayModules(inventory([{ name: "good", source: join(root, "good", "index.ts"), display }]));
	const definitions = createDashboardToolDefinitions(root, lookup);
	const owner = definitions("fixture_tool");
	assert.equal(typeof owner.renderCall, "function");
	await assert.rejects(() => owner.execute("id", {}, undefined, undefined, {} as never), /cannot execute/);
	assert.notEqual(definitions("read").renderCall, lookup("read")?.renderCall, "the builtin read presentation wins over a published read");
});

const EMIT = (descriptor: string) => `import { fileURLToPath } from "node:url";
export default function (pi) {
	pi.events.emit("durable:contribution", { name: "fixture.display", source: fileURLToPath(import.meta.url), display: ${descriptor}, create(host) { return host.durable.defineExtension({ name: "fixture.display" }); } });
}
`;

async function hostInventory(t: { after(fn: () => void): void }, descriptor: string, files: Record<string, string> = {}) {
	const root = directory(t);
	const cwd = join(root, "work"); const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" } }));
	const owner = join(root, "owner"); mkdirSync(owner);
	writeFileSync(join(owner, "index.ts"), EMIT(descriptor));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(owner, name), text);
	const reports: string[] = [];
	const services = await createDurableServices({ cwd, agentDir, storageId: "display-host", extensionPaths: [join(owner, "index.ts")], trusted: true, packageDir: getPackageDir(), onReport: (error) => reports.push(String(error)) });
	t.after(() => services.close());
	return { services, reports, source: join(owner, "index.ts") };
}

it("the host advertises a descriptor only for an admitted contribution whose entry resolves", async (t) => {
	const advertised = await hostInventory(t, JSON.stringify(display), { "display.ts": MODULE });
	assert.deepEqual(advertised.services.inventory.contributions.map(({ name, display: value }) => ({ name, display: value })), [{ name: "fixture.display", display }]);
});

it("a refused or unresolvable descriptor keeps the contribution and drops only the display", async (t) => {
	for (const [descriptor, files, message] of [
		[JSON.stringify({ ...display, entry: "../escape.ts" }), { "display.ts": MODULE }, /relative file path/],
		[JSON.stringify({ ...display, version: 2 }), {}, /version 1/],
		[JSON.stringify(display), {}, /display entry refused/],
	] as const) {
		const refused = await hostInventory(t, descriptor, files);
		assert.deepEqual(refused.services.inventory.contributions.map(({ name, display: value }) => ({ name, display: value })), [{ name: "fixture.display", display: undefined }]);
		assert.ok(refused.reports.some((line) => message.test(line)), descriptor);
	}
});
