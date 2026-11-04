/** The attached-terminal browser: a pure module over the shared panel, with every read and effect routed through the host. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { clipboardContribution, type DurableCommandCall } from "./durable.ts";
import { operatorPanel, type OperatorPanelHost } from "./operator-panel.ts";
import { readPanelAnswer, readPanelRequest } from "./panel-protocol.ts";
import { appendEntry, makeEntry } from "./store.ts";

type JsonValue = Parameters<OperatorPanelHost["request"]>[0];

const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text } as unknown as OperatorPanelHost["theme"];
const flush = () => new Promise((resolve) => setImmediate(resolve));

let root: string;
let agentDir: string;
let clipboardFile: string;
const saved: Record<string, string | undefined> = {};

before(async () => {
	root = await mkdtemp(join(tmpdir(), "clipboard-operator-panel-"));
	agentDir = join(root, "agent");
	clipboardFile = join(root, "clipboard.txt");
	const bin = join(root, "bin");
	await mkdir(bin); await mkdir(agentDir);
	await writeFile(join(bin, "pbcopy"), '#!/bin/sh\ncat > "$FAKE_CLIPBOARD_FILE"\n');
	await chmod(join(bin, "pbcopy"), 0o755);
	for (const key of ["PATH", "PI_CLIPBOARD_DIR", "FAKE_CLIPBOARD_FILE", "PI_HARNESS_FILE"]) saved[key] = process.env[key];
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
	process.env.PI_CLIPBOARD_DIR = join(root, "archive");
	process.env.FAKE_CLIPBOARD_FILE = clipboardFile;
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	await appendEntry(join(root, "archive"), makeEntry("first body\nsecond line", "first", new Date("2026-03-04T05:06:07Z"), "entry-one"));
	await appendEntry(join(root, "archive"), makeEntry("other body", "other", new Date("2026-03-04T06:06:07Z"), "entry-two"));
});

after(async () => {
	for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await rm(root, { recursive: true, force: true });
});

function command() {
	const contribution = clipboardContribution("/owner/index.ts", { emit() {}, on: () => () => {} } as never, () => {});
	assert.deepEqual(contribution.panel, { version: 1, entry: "./operator-panel.ts", export: "operatorPanel", command: "clipboard" });
	const run = contribution.commands[0].run;
	return (data?: JsonValue, origin: "operator" | "model" = "operator") => run({ args: "", ...(data === undefined ? {} : { data }), origin, host: { agentDir } as never, context: {}, invocationId: "inv" } as DurableCommandCall);
}

describe("clipboard native browser route", () => {
	it("answers text callers with a bounded recent listing and structured callers with the browser's data", async () => {
		const run = command();
		const text = await run();
		assert.equal(typeof text, "string");
		assert.match(String(text), /2 recent entries/);
		assert.match(String(text), /entry-two/);
		const recent = await run({ op: "recent" });
		assert.equal(typeof recent, "object");
		const answer = readPanelAnswer({ op: "recent" }, (recent as { data: unknown }).data);
		assert.equal(answer.op, "recent");
		if (answer.op === "recent") assert.deepEqual(answer.entries.map((entry) => entry.id), ["entry-two", "entry-one"]);
		const preview = await run({ op: "preview", id: "entry-one" }) as { text: string; data: unknown };
		const previewAnswer = readPanelAnswer({ op: "preview", id: "entry-one" }, preview.data);
		assert.ok(previewAnswer.op === "preview" && previewAnswer.entry.content === "first body\nsecond line");
		const search = await run({ op: "search", query: "other" }) as { data: unknown };
		const searchAnswer = readPanelAnswer({ op: "search", query: "other" }, search.data);
		assert.ok(searchAnswer.op === "search" && searchAnswer.page.matches.map((match) => match.id).includes("entry-two"));
		await assert.rejects(run({ op: "steal" }), /not supported/);
		await assert.rejects(run({ op: "restore", id: "" }), /entry id/);
		assert.throws(() => readPanelRequest({ op: "search", query: "x".repeat(300) }), /bounded query/);
	});

	it("restore rewrites the full exact record and keeps success distinct from an archive warning", async () => {
		const run = command();
		const restored = await run({ op: "restore", id: "entry-one" }) as { text: string; data: unknown };
		const answer = readPanelAnswer({ op: "restore", id: "entry-one" }, restored.data);
		assert.ok(answer.op === "restore" && answer.ok === true);
		assert.equal(await readFile(clipboardFile, "utf8"), "first body\nsecond line");
		assert.match(restored.text, /restored entry-one/);
		const missing = await run({ op: "restore", id: "absent" }) as { text: string; data: unknown };
		const failed = readPanelAnswer({ op: "restore", id: "absent" }, missing.data);
		assert.ok(failed.op === "restore" && failed.ok === false && /no longer available/.test(failed.error));
	});
});

describe("clipboard operator panel module", () => {
	it("opens the shared panel over host requests and restores only through the labelled control", async () => {
		const module = operatorPanel();
		assert.equal(module.version, 1);
		assert.equal(module.title, "Clipboard");
		const requests: JsonValue[] = [];
		const pending: Promise<unknown>[] = [];
		const settle = async () => { for (let round = 0; round < 6; round++) { await Promise.allSettled(pending); await flush(); } };
		const notices: string[] = [];
		let closed = 0;
		const run = command();
		const host: OperatorPanelHost = {
			target: { id: "conversation-1", name: "owner" }, theme, tui: { requestRender() {} }, rows: () => 24,
			request: async (data) => { requests.push(data); const answer = run(data) as Promise<{ text: string; data?: JsonValue }>; pending.push(answer); return await answer; },
			dialogs: { notify: (text) => { notices.push(text); } },
			close: () => { closed++; },
		};
		const instance = module.open(host);
		await settle();
		let lines = instance.render(80).map(stripVTControlCharacters);
		assert.ok(lines.some((line) => /Recent [1-9]/.test(line)) && lines.some((line) => line.includes("other")), lines.join("\n"));
		assert.deepEqual(requests[0], { op: "recent" });
		assert.ok(requests.some((request) => (request as { op?: string }).op === "preview"), "selection reads the exact record through the host");
		const restoreRow = lines.findIndex((line) => line.includes("[Restore]"));
		const x = lines[restoreRow].indexOf("[Restore]") + 1;
		instance.handleMouse({ type: "click", button: "left", x, y: restoreRow, width: 80, height: lines.length, screenX: x, screenY: restoreRow, clickCount: 1 } as never);
		await settle();
		assert.equal(closed, 1, "a successful restore returns to the conversation");
		assert.ok(notices.some((text) => /^Restored /.test(text)), notices.join("\n"));
		assert.ok(requests.some((request) => (request as { op?: string }).op === "restore"));
		instance.dispose();
		lines = instance.render(80);
		assert.ok(Array.isArray(lines));
	});

	it("shows a pending and then failed initial read in the panel itself, never an empty history, and Refresh retries", async () => {
		const notices: string[] = [];
		let fail = true;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const run = command();
		const instance = operatorPanel().open({
			target: { id: "c" }, theme, tui: { requestRender() {} }, rows: () => 20,
			request: async (data) => {
				await gate;
				if (fail) throw new Error("archive unreadable");
				return await (run(data) as Promise<{ text: string; data?: JsonValue }>);
			},
			dialogs: { notify: (text) => { notices.push(text); } },
			close() {},
		});
		const draw = () => instance.render(60).map(stripVTControlCharacters);
		let lines = draw();
		assert.ok(lines.some((line) => line.includes("Recent \u00b7 reading")), lines.join("\n"));
		assert.ok(lines.some((line) => line.includes("Reading clipboard history")));
		assert.ok(!lines.some((line) => /Recent 0|No clipboard history matches/.test(line)), "a pending read is not an empty archive");
		release();
		await flush(); await flush();
		lines = draw();
		assert.ok(lines.some((line) => line.includes("Recent \u00b7 read failed")), lines.join("\n"));
		assert.ok(lines.some((line) => /Could not read clipboard history: archive unreadable/.test(line)), "the failure shows in the mounted panel");
		assert.ok(!lines.some((line) => /Recent 0|No clipboard history matches/.test(line)));
		assert.ok(notices.some((text) => /archive unreadable/.test(text)));
		fail = false;
		const refreshRow = lines.findIndex((line) => line.includes("[Refresh]"));
		assert.ok(refreshRow >= 0, "Refresh stays reachable after the failure");
		const x = lines[refreshRow].indexOf("[Refresh]") + 1;
		instance.handleMouse({ type: "click", button: "left", x, y: refreshRow, width: 60, height: lines.length, screenX: x, screenY: refreshRow, clickCount: 1 } as never);
		assert.ok(draw().some((line) => line.includes("Recent \u00b7 reading")), "a retry after a failure shows the read again");
		for (let round = 0; round < 200 && !draw().some((line) => /Recent [1-9]/.test(line)); round++) await new Promise((resolve) => setTimeout(resolve, 5));
		lines = draw();
		assert.ok(lines.some((line) => /Recent [1-9]/.test(line)) && lines.some((line) => line.includes("other")), lines.join("\n"));
		assert.ok(lines.some((line) => line.includes("[Close]")), "Close stays reachable");
		instance.dispose();
	});
});
