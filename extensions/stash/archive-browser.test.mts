import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import registerStash from "./index.ts";
import type { PanelTheme } from "./panel.ts";
import { listStashes, writeStash } from "./store.ts";

const theme: PanelTheme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	underline: (t: string) => t,
	strikethrough: (t: string) => t,
};

type Component = { render(width: number): string[]; handleInput?(data: string): void };
type Handler = (args: string, ctx: unknown) => Promise<void>;

let dir = "";
let ancientId = "";
let saved: string | undefined;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "stash-archive-browser-"));
	saved = process.env.PI_STASH_DIR;
	process.env.PI_STASH_DIR = dir;
	await seed();
});
after(async () => {
	if (saved === undefined) delete process.env.PI_STASH_DIR;
	else process.env.PI_STASH_DIR = saved;
	await rm(dir, { recursive: true, force: true });
});

function command() {
	let handler: Handler | undefined;
	const sent: string[] = [];
	registerStash({
		events: { on: () => () => {}, emit: () => {} },
		registerTool: () => {},
		registerCommand: (name: string, definition: { handler: Handler }) => {
			if (name === "stash") handler = definition.handler;
		},
		registerShortcut: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, truncated: false }),
		sendUserMessage: (content: string) => {
			sent.push(content);
		},
		sendMessage: () => {},
		appendEntry: () => {},
		on: () => {},
	} as unknown as Parameters<typeof registerStash>[0]);
	assert.ok(handler);
	return { handler, sent };
}

function drive(script: (panels: number, component: Component, text: string) => void, extra: Record<string, unknown> = {}) {
	let panels = 0;
	return {
		ctx: {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			cwd: "/workspace",
			ui: {
				notify: () => {},
				custom: (factory: (...args: unknown[]) => Component) =>
					new Promise((resolve) => {
						const tui = { terminal: { rows: 30 }, requestRender: () => {} };
						const component = factory(tui, theme, {}, resolve);
						const index = panels++;
						setImmediate(() => script(index, component, component.render(100).join("\n")));
					}),
				...extra,
			},
		},
		panels: () => panels,
	};
}

async function seed(): Promise<void> {
	const old = await writeStash(dir, { title: "Ancient effort", summary: `${"filler ".repeat(6000)} deep-archive-needle` }, new Date("2020-01-01T00:00:00Z"));
	ancientId = old.record.id;
	for (let index = 0; index < 300; index++) {
		await writeFile(join(dir, `20260101T${String(index).padStart(6, "0")}Z-recent-${index}.md`), `---\ntitle: "Recent ${index}"\nstate: "open"\ncreated: "20260101T000000Z"\ntags: []\n---\nbody\n`, "utf8");
	}
}

describe("stash archive browsing", () => {
	it("follows an empty bounded page with Continue to a match beyond the preload and preview bound, then picks the exact record", async () => {
		const { handler, sent } = command();
		const harness = drive(
			(index, component, text) => {
				if (index === 0) {
					assert.match(text, /Recent/);
					assert.match(text, /\+/);
					component.handleInput?.("s");
				} else if (index === 1) {
					assert.match(text, /Search archive: deep-archive-needle/);
					assert.match(text, /no matches on this page/);
					assert.match(text, /coverage partial/);
					assert.match(text, /\[Continue\]/);
					component.handleInput?.("n");
				} else {
					assert.match(text, /Ancient effort/);
					assert.match(text, /2020-01-01/);
					assert.match(text, /coverage complete/);
					component.handleInput?.("\r");
				}
			},
			{ input: async () => "deep-archive-needle" },
		);
		await handler("", harness.ctx);
		assert.equal(sent.length, 1);
		assert.ok(sent[0].includes(ancientId));
		assert.match(sent[0], /deep-archive-needle/);
	});

	it("marks a store change under a held cursor as stale and offers refresh", async () => {
		const { handler } = command();
		const harness = drive(
			(index, component, text) => {
				if (index === 0) component.handleInput?.("s");
				else if (index === 1) {
					assert.match(text, /\[Continue\]/);
					void writeStash(dir, { title: "Arrives mid-query", summary: "new" }, new Date("2026-06-01T00:00:00Z")).then(() => component.handleInput?.("n"));
				} else if (index === 2) {
					assert.match(text, /results may be stale/);
					assert.match(text, /\[Refresh\]/);
					assert.doesNotMatch(text, /\[Pickup\]|\[Continue\]|\[Actions\]/);
					component.handleInput?.("\x1b");
				} else component.handleInput?.("\x1b");
			},
			{ input: async () => "deep-archive-needle" },
		);
		const before = (await listStashes(dir, { limit: 400 })).map((e) => e.meta.id).sort();
		await handler("", harness.ctx);
		assert.ok((await listStashes(dir, { limit: 400 })).length > before.length);
	});

	it("cancelling the archive query keeps the recent view without a store change", async () => {
		const { handler, sent } = command();
		const harness = drive(
			(index, component, text) => {
				if (index === 0) component.handleInput?.("s");
				else {
					assert.match(text, /Recent/);
					component.handleInput?.("\x1b");
				}
			},
			{ input: async () => undefined },
		);
		await handler("", harness.ctx);
		assert.equal(sent.length, 0);
	});
});
