import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Inspector } from "./inspector.ts";
import { createAgentCommand, type AgentViewWiring } from "./command.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import { deferred, theme } from "./dashboard-test-fixture.mts";
import { preparePlaybookComparison } from "./playbook-comparison.ts";
import { readPlaybookCatalog } from "./playbook-catalog.ts";
import { PlaybookViews, parsePlaybookCommand, playbookSelectionText } from "./playbook-ui.ts";

const id = "c9b0d619-eab1-4d0f-8f96-d67273e491ba";

function fixture(t: { after(callback: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "playbook-ui-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { dir, file: join(dir, "playbooks", "maker.md") };
}

it("distinguishes names, exact identities, and the reserved clear and import syntax", () => {
	assert.deepEqual(parsePlaybookCommand(["maker"]), { kind: "set", name: "maker" });
	assert.deepEqual(parsePlaybookCommand(["@maker", "off"]), { kind: "set", target: "@maker", name: "off" });
	assert.deepEqual(parsePlaybookCommand([`${id}:300`]), { kind: "show", target: `${id}:300` });
	assert.deepEqual(parsePlaybookCommand(["--import", "maker"]), { kind: "import", name: "maker" });
	for (const words of [["maker", "off"], ["@Maker"], [`${id}:00`], ["--import", "off"], ["@maker", "off", "again"]]) {
		assert.throws(() => parsePlaybookCommand(words));
	}
	assert.match(playbookSelectionText(undefined), /unknown/);
	assert.match(playbookSelectionText({ name: null, origin: "operator" }), /off/);
});

it("routes ordinary selection and exact target clear separately; help and completions do not seed or select", async (t) => {
	const { dir, file } = fixture(t);
	const calls: Array<[string, unknown]> = [];
	const notices: string[] = [];
	const ctx = { mode: "rpc", hasUI: false, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
	const source = { list: async () => ({ rows: [{ id, name: "Maker", profile: { handle: "@maker" } }] }) } as unknown as AgentObservationSource;
	const wiring: Partial<AgentViewWiring> = {
		playbookAgentDir: dir,
		playbooks: (_ctx, initialize) => readPlaybookCatalog(dir, { initialize }),
		setPlaybook: (name) => { calls.push(["local", name]); return `saved ${name}`; },
		currentPlaybook: () => "Playbook: not selected",
		control: async (method, input) => {
			calls.push([method, input]);
			return method === "configure" ? { outcome: "applied", playbook: { name: null, origin: "operator" } } : null;
		},
	};
	const command = createAgentCommand([], source, wiring as AgentViewWiring);
	const items = await command.getArgumentCompletions?.("playbook maker");
	assert.match(items?.find((item) => item.value === "playbook maker")?.description ?? "", /Bundled, not installed/);
	assert.match(items?.find((item) => item.value === "playbook @maker ")?.description ?? "", /Agent target/);
	const after = await command.getArgumentCompletions?.("playbook @maker ");
	assert.ok(after?.some((item) => item.value === "playbook @maker off"));
	assert.ok(after?.every((item) => !item.label.startsWith("@") && item.label !== "--import"));
	for (const action of ["help", "help playbook"]) {
		await command.handler(action, ctx);
		assert.match(notices.at(-1) ?? "", /Bundled starters \(not installed\)/);
	}
	assert.deepEqual(calls, []);
	assert.equal(existsSync(join(dir, "playbooks")), false);
	await command.handler("playbook maker", ctx);
	await command.handler("playbook off", ctx);
	await command.handler("playbook @maker off", ctx);
	await command.handler(`playbook ${id}`, ctx);
	assert.match(notices.at(-1) ?? "", /unknown/);
	assert.deepEqual(calls, [["local", "maker"], ["local", "off"], ["configure", { sessionId: "@maker", playbook: "off", origin: "operator" }], ["playbook-read", { sessionId: id }]]);
	await command.handler("playbook", ctx);
	assert.match(notices.at(-1) ?? "", /Playbooks: ready/);
	assert.ok(existsSync(file));
	await command.handler("playbook --import maker", ctx);
	assert.match(notices.at(-1) ?? "", /Read-only preview.*interactive comparison/s);
});

it("opens one editor-slot reader, uses the configured Expand key and closes it on shutdown", async () => {
	const views = new PlaybookViews();
	const ready = deferred<Inspector>();
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => id }, ui: {
		custom: (factory: (...args: unknown[]) => Inspector, options?: unknown) => {
			assert.equal(options, undefined, "the transcript stays above the editor slot");
			return new Promise<void>((done) => ready.resolve(factory({ terminal: { rows: 40 }, requestRender() {} }, theme, { getKeys: () => ["ctrl+e"] }, done)));
		},
	} } as unknown as ExtensionCommandContext;
	const first = views.show(ctx, () => ({ title: "Playbooks", text: "Selected: maker" }));
	await views.show(ctx, () => assert.fail("a second open must not read another target"));
	const frame = await ready.promise;
	try {
		assert.equal(frame.capturesViewportInput, true);
		const rows = frame.render(120);
		assert.match(rows[0], /Playbooks.*This session/);
		assert.match(rows.at(-1) ?? "", /ctrl\+e expand/);
		frame.handleInput("\x05");
		assert.ok(frame.render(120).length > rows.length);
	} finally { views.close(); await first; }
	assert.equal(views.showing, false);
});

it("reads both files at wide and narrow widths; Escape cancels and replacement binds the reviewed bytes", (t) => {
	const { dir, file } = fixture(t);
	mkdirSync(join(dir, "playbooks"));
	const original = `# maker\n\nLocal summary\n\n${Array.from({ length: 48 }, (_, i) => `Local line ${i}`).join("\n")}\n`;
	writeFileSync(file, original);
	function compare() {
		const { preview, open } = preparePlaybookComparison(dir, "maker");
		let closed = false;
		const ui = new Inspector({ theme, target: { id: "maker", label: "Playbooks" }, title: "Review maker.md", open, rows: () => 12, requestRender() {}, close() { closed = true; } });
		return { ui, preview, closed: () => closed };
	}
	const first = compare();
	const wide = first.ui.render(136);
	assert.ok(wide.every((line) => visibleWidth(line) <= 136));
	assert.match(wide.join("\n"), /Current file.*Bundled starter/);
	assert.match(wide.join("\n"), /Local line 0/);
	const narrow = first.ui.render(53);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 53));
	assert.match(narrow.join("\n"), /Current file/);
	first.ui.handleInput("\x1b[F");
	assert.match(first.ui.render(53).join("\n"), /Local line 47/);
	first.ui.handleInput("s");
	assert.match(first.ui.render(53).join("\n"), /Bundled starter/);
	first.ui.handleInput("\r");
	assert.equal(readFileSync(file, "utf8"), original, "only the named effect applies");
	first.ui.handleInput("\x1b");
	assert.ok(first.closed());
	assert.equal(readFileSync(file, "utf8"), original);
	const stale = compare();
	stale.ui.render(136);
	const edited = original.replace("Local summary", "New local summary");
	writeFileSync(file, edited);
	stale.ui.handleInput("a");
	assert.match(stale.ui.render(136).join("\n"), /Reopen the comparison/);
	assert.equal(readFileSync(file, "utf8"), edited);
	const fresh = compare();
	fresh.ui.render(136);
	fresh.ui.handleInput("a");
	assert.equal(readFileSync(file, "utf8"), fresh.preview.starterText);
});
