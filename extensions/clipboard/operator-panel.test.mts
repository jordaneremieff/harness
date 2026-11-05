/** The attached-terminal browser: a pure module over the shared panel, with every read and effect routed through the host. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { clipboardContribution, type DurableCommandCall } from "./durable.ts";
import type { JsonValue, PanelHost } from "../../operator-ui/index.ts";
import { operatorPanel } from "./operator-panel.ts";
import { readPanelAnswer, readPanelRequest } from "./panel-protocol.ts";
import { appendEntry, makeEntry, readEntries } from "./store.ts";

const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text } as unknown as PanelHost["theme"];
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

	it("restore rewrites the full exact record and adds no archive record", async () => {
		const run = command();
		const before = (await readEntries(join(root, "archive"), { limit: 10 })).map((entry) => entry.id);
		const restored = await run({ op: "restore", id: "entry-one" }) as { text: string; data: unknown };
		const answer = readPanelAnswer({ op: "restore", id: "entry-one" }, restored.data);
		assert.ok(answer.op === "restore" && answer.ok === true);
		assert.equal(await readFile(clipboardFile, "utf8"), "first body\nsecond line", "the clipboard holds the exact full content");
		assert.match(restored.text, /restored entry-one/);
		const after = (await readEntries(join(root, "archive"), { limit: 10 })).map((entry) => entry.id);
		assert.deepEqual(after, before, "the archive holds the same records as before the restore");
		const missing = await run({ op: "restore", id: "absent" }) as { text: string; data: unknown };
		const failed = readPanelAnswer({ op: "restore", id: "absent" }, missing.data);
		assert.ok(failed.op === "restore" && failed.ok === false && /no longer available/.test(failed.error));
	});
});

/** A panel host over a request route, recording notices and the frame close request. */
function panelHost(request: PanelHost["request"]) {
	const notices: string[] = [];
	let closed = 0;
	const host: PanelHost = {
		theme,
		target: { id: "conversation-1", label: "owner · work" },
		signal: new AbortController().signal,
		requestRender: () => {},
		notify: (text) => notices.push(text),
		push: () => {},
		back: () => {},
		close: () => {
			closed++;
		},
		request,
	};
	return { host, notices, closed: () => closed };
}

describe("clipboard operator panel module", () => {
	it("opens the shared view over host requests and restores only through the labelled control", async () => {
		const module = operatorPanel();
		assert.equal(module.version, 2);
		assert.equal(module.title, "Clipboard");
		const requests: JsonValue[] = [];
		const pending: Promise<unknown>[] = [];
		const settle = async () => {
			for (let round = 0; round < 6; round++) {
				await Promise.allSettled(pending);
				await flush();
			}
		};
		const run = command();
		const f = panelHost(async (data) => {
			requests.push(data);
			const answer = run(data) as Promise<{ text: string; data?: JsonValue }>;
			pending.push(answer);
			return await answer;
		});
		const view = module.open(f.host);
		await settle();
		const lines = view.render(100, 20).map(stripVTControlCharacters);
		assert.ok(lines.some((line) => line.includes("other")), lines.join("\n"));
		assert.deepEqual(requests[0], { op: "recent" });
		assert.ok(requests.some((request) => (request as { op?: string }).op === "preview"), "selection reads the exact record through the host");
		assert.ok(!requests.some((request) => (request as { op?: string }).op === "restore"), "selection never restores");
		const restore = view.actions?.().find((action) => action.label === "Restore");
		assert.ok(restore && restore.disabled === undefined, "Restore is labelled and available once the record is read");
		restore.run();
		await settle();
		assert.ok(f.notices.some((text) => /^Restored /.test(text)), f.notices.join("\n"));
		const previewed = requests.find((request) => (request as { op?: string }).op === "preview") as { id?: string } | undefined;
		const restored = requests.find((request) => (request as { op?: string }).op === "restore") as { id?: string } | undefined;
		assert.ok(previewed?.id && restored?.id === previewed.id, "Restore writes the record the operator read");
		assert.ok(["first body\nsecond line", "other body"].includes(await readFile(clipboardFile, "utf8")));
	});

	it("shows a pending and then failed initial read in the view itself, never an empty history, and Refresh retries", async () => {
		let fail = true;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = command();
		const f = panelHost(async (data) => {
			await gate;
			if (fail) throw new Error("archive unreadable");
			return await (run(data) as Promise<{ text: string; data?: JsonValue }>);
		});
		const view = operatorPanel().open(f.host);
		const draw = () => view.render(100, 20).map(stripVTControlCharacters).join("\n");
		assert.match(draw(), /Reading recent entries/);
		assert.doesNotMatch(draw(), /Clipboard history is empty/, "a pending read is not an empty archive");
		release();
		await flush();
		await flush();
		assert.match(draw(), /Recent entries could not be read; Refresh retries: archive unreadable/);
		assert.doesNotMatch(draw(), /Clipboard history is empty/);
		fail = false;
		const refresh = view.actions?.().find((action) => action.label === "Refresh");
		assert.ok(refresh, "Refresh stays reachable after the failure");
		refresh.run();
		assert.match(draw(), /Reading recent entries/, "a retry shows the read again");
		for (let round = 0; round < 200 && !draw().includes("other"); round++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(draw().includes("other"), draw());
	});
});
