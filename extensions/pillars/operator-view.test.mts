import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { NavigationFrame, type OperatorView, type ViewHost } from "../../operator-ui/index.ts";
import { access, type AccessError, type AccessPage, type AccessRequest } from "./access.ts";
import { loadCatalog, type Catalog } from "./catalog.ts";
import { browserEntries, type BrowserEntry } from "./inventory.ts";
import { pillarsView } from "./operator-view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const digest = "a".repeat(64);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const page = (over: Partial<AccessPage> = {}): AccessPage => ({ schema: "pillars-source", resource: "governance", referenceBodyDigest: digest, bodyBytes: 96, offset: 0, endOffset: 48, text: "body", ...over });
const entries: BrowserEntry[] = [
	{ resource: "inventory", title: "Pillars", type: "inventory", index: "Portable design doctrine for agent-assisted work." },
	{ resource: "governance", title: "Pillars Governance", type: "governance", index: "Operating rules for the pillar corpus." },
	{ resource: "pattern-frame-inspection", title: "Frame Inspection", type: "pattern", index: "At an option set, name the frame, test whether it binds, step out if not." },
];

function open(read: (request: AccessRequest) => Promise<AccessPage | AccessError>) {
	const calls: AccessRequest[] = [];
	const host: ViewHost = {
		theme,
		target: { id: "session", label: "This session · work" },
		signal: new AbortController().signal,
		requestRender: () => {},
		notify: () => {},
		push: () => {},
		back: () => {},
		close: () => {},
	};
	const view: OperatorView = pillarsView(host, {
		inventory: async () => entries,
		read: async (request) => {
			calls.push(request);
			return read(request);
		},
	});
	const screen = (width = 120) => (view.render(width, 30) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
	const action = (label: string) => {
		const found = view.actions?.().find((candidate) => candidate.label === label);
		assert.ok(found, `no ${label}`);
		return found;
	};
	return { view, calls, screen, action };
}

test("the inventory lists every source read-only; selecting reads its first page and shows the complete digest", async () => {
	const v = open(async (request) => page({ resource: request.resource ?? "inventory", text: `${request.resource} text` }));
	await turn();
	const first = v.screen();
	assert.match(first, /3 sources · read-only/);
	assert.ok(first.includes("Frame Inspection"));
	assert.deepEqual(v.calls, [{ resource: "inventory" }], "the first listed source reads on selection");
	v.view.handleInput("\u001b[B");
	await turn();
	assert.deepEqual(v.calls.at(-1), { resource: "governance" });
	// A wide window keeps the whole digest on one detail row.
	const detail = v.screen(200);
	assert.ok(detail.includes(`SHA-256: ${digest}`), "the digest is complete");
	assert.ok(detail.includes("governance text"));
	assert.deepEqual(v.view.actions?.().map((action) => action.label), ["Read more", "Read again"], "no judgment action starts from here");
});

test("Read more carries the exact offset and digest of the pages shown; Read again starts from the first page", async () => {
	const pages = [page({ text: "first ", nextOffset: 48 }), page({ text: "second", offset: 48, endOffset: 96 }), page({ text: "again" })];
	const v = open(async (request) => (request.resource === "inventory" ? page({ resource: "inventory" }) : (pages.shift() ?? page())));
	await turn();
	v.view.handleInput("\u001b[B");
	await turn();
	assert.ok(v.screen().includes("Read more continues at byte 48 of 96"));
	v.action("Read more").run();
	await turn();
	assert.deepEqual(v.calls.at(-1), { resource: "governance", offset: 48, referenceBodyDigest: digest });
	assert.ok(v.screen().includes("first second"));
	assert.equal(typeof v.action("Read more").disabled, "string", "the whole source is shown");
	v.action("Read again").run();
	await turn();
	assert.deepEqual(v.calls.at(-1), { resource: "governance" });
	assert.ok(v.screen().includes("again"));
	assert.ok(!v.screen().includes("first second"), "a fresh read never mixes revisions");
});

test("a source error shows its code and stops further pages; the filter narrows the inventory", async () => {
	const error: AccessError = { schema: "pillars-source-error", code: "source_changed", message: "The source changed; omit both continuation fields for a fresh read." };
	const v = open(async (request) => (request.offset === undefined ? page({ resource: "inventory", nextOffset: 48 }) : error));
	await turn();
	v.action("Read more").run();
	await turn();
	assert.ok(v.screen().includes("source_changed"));
	assert.equal(typeof v.action("Read more").disabled, "string");
	v.view.handleInput("/");
	for (const key of "frame") v.view.handleInput(key);
	const filtered = v.screen();
	assert.match(filtered, /1 of 3 sources match/);
	assert.ok(!filtered.includes("Pillars Governance ·"));
});

test("the footer shows m read more and r read again, and a footer click reads as its key does", async () => {
	const calls: AccessRequest[] = [];
	const frame = new NavigationFrame({
		theme,
		target: { id: "session", label: "This session · work" },
		destinations: () => [
			{
				key: "pillars",
				label: "Pillars",
				open: (host: ViewHost) =>
					pillarsView(host, {
						inventory: async () => entries,
						read: async (request) => {
							calls.push(request);
							return request.offset === undefined
								? page({ resource: request.resource ?? "inventory", text: "first ", nextOffset: 48 })
								: page({ resource: request.resource ?? "inventory", text: "second", offset: 48, endOffset: 96 });
						},
					}),
			},
		],
		rows: () => 24,
		requestRender: () => {},
		close: () => {},
	});
	await turn();
	const drawn = frame.render(160);
	const row = stripVTControlCharacters(drawn.at(-1) ?? "");
	for (const control of ["m read more", "r read again", "esc close"]) assert.ok(row.includes(control), `${control} in: ${row}`);
	frame.handleInput("m");
	await turn();
	assert.deepEqual(calls.at(-1), { resource: "inventory", offset: 48, referenceBodyDigest: digest });
	const at = row.indexOf("r read again");
	const event: TuiMouseEvent = { type: "click", button: "left", x: at, y: drawn.length - 1, screenX: at, screenY: drawn.length - 1, width: 160, height: drawn.length, shift: false, alt: false, ctrl: false };
	assert.ok(frame.handleMouse(event)?.handled, "the read again control is clickable");
	await turn();
	assert.deepEqual(calls.at(-1), { resource: "inventory" }, "the click reads again from the first page");
	frame.close();
});

/** A real corpus in a private temporary directory, read through the real catalog and accessor. */
async function tempCorpus(): Promise<{ catalog: Catalog; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "pillars-view-"));
	const long = `${"filler line for a multi-page source\n".repeat(900)}PAGE-TWO-TAIL`;
	await writeFile(join(root, "README.md"), "# Pillars\n\n| [Frame Inspection](pattern-frame-inspection.md) | At an option set, name the frame. |\n\n| [Made Up Heuristic](heuristic-made-up.md) | Quoted index statement. |\n");
	await writeFile(join(root, "GOVERNANCE.md"), "Governance rules for the corpus.\n");
	await writeFile(join(root, "pattern-frame-inspection.md"), `PAGE-ONE-HEAD\n${long}`);
	await writeFile(join(root, "heuristic-made-up.md"), "A short heuristic body.\n");
	const catalog = await loadCatalog(undefined, { agentDir: root, env: { PI_PILLARS_CORPUS: root } });
	return { catalog, root };
}

/** Wait for every settled promise the view started, within a bounded number of event-loop turns. */
const settle = async (rounds = 50) => {
	for (let round = 0; round < rounds; round++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * One held read: the caller decides when the accessor runs. `skip` lets earlier matching reads
 * pass through, so the held read is the one the selection started, not the inventory listing. A
 * read released after its abortion answers as the real accessor does, with an error value;
 * `rejectWith` models a route that rejects instead.
 */
interface Gate {
	matches: (request: AccessRequest) => boolean;
	used: boolean;
	release: () => void;
	rejectWith?: Error;
	promise: Promise<void>;
}

function gate(resource: string, options: { skip?: number; offset?: boolean; rejectWith?: Error } = {}): Gate {
	let seen = 0;
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		matches: (request) =>
				request.resource === resource && (!options.offset || request.offset !== undefined) && ++seen > (options.skip ?? 0),
		used: false,
		release,
		promise,
		...(options.rejectWith ? { rejectWith: options.rejectWith } : {}),
	};
}

/** The real accessor behind the view's operations, with chosen reads held until the test releases them. */
function gatedAccess(catalog: Catalog, gates: Gate[]) {
	const calls: AccessRequest[] = [];
	const read = async (request: AccessRequest, signal?: AbortSignal): Promise<AccessPage | AccessError> => {
		calls.push(request);
		const held = gates.find((candidate) => !candidate.used && candidate.matches(request));
		if (held) {
			held.used = true;
			await held.promise;
			if (held.rejectWith) throw held.rejectWith;
		}
		return access(catalog, request, signal);
	};
	return { calls, read };
}

function viewHost(): ViewHost {
	return {
		theme,
		target: { id: "session", label: "This session · work" },
		signal: new AbortController().signal,
		requestRender: () => {},
		notify: () => {},
		push: () => {},
		back: () => {},
		close: () => {},
	};
}

test("a late read that fulfils with an error value after cancellation leaves no pending state", async () => {
	const { catalog } = await tempCorpus();
	// The listing reads the inventory source once; the held read is the one the selection started.
	const held = gate("inventory", { skip: 1 });
	const { calls, read } = gatedAccess(catalog, [held]);
	const view = pillarsView(viewHost(), { inventory: (signal) => browserEntries(catalog, read, signal), read });
	await settle();
	assert.ok(calls.some((request) => request.resource === "inventory"), "selection reads the inventory source");
	view.handleInput("\u001b[B");
	await settle();
	assert.ok(calls.some((request) => request.resource === "governance"), "the next row reads its own source");
	held.release();
	await settle();
	const again = calls.filter((request) => request.resource === "inventory").length;
	view.handleInput("\u001b[A");
	await settle();
	assert.ok(
		calls.filter((request) => request.resource === "inventory").length > again,
		"reselecting the withdrawn source starts a new read",
	);
	const screen = (view.render(120, 30) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
	assert.ok(screen.includes("# Pillars"), "the reread inventory page is shown");
	assert.ok(!screen.includes("Reading the source…"), "no read stays pending forever");
	const actions = view.actions?.() ?? [];
	const readAgain = actions.find((action) => action.label === "Read again");
	assert.ok(readAgain);
	assert.equal(readAgain.disabled, undefined, "Read again works after the late cancelled read");
});

test("a late read that rejects after cancellation also leaves no pending state", async () => {
	const { catalog } = await tempCorpus();
	const held = gate("inventory", { skip: 1, rejectWith: new Error("route rejected the read") });
	const { read } = gatedAccess(catalog, [held]);
	const view = pillarsView(viewHost(), { inventory: (signal) => browserEntries(catalog, read, signal), read });
	await settle();
	view.handleInput("\u001b[B");
	await settle();
	held.release();
	await settle();
	view.handleInput("\u001b[A");
	await settle();
	const screen = (view.render(120, 30) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
	assert.ok(screen.includes("# Pillars"), "the reread inventory page is shown");
	assert.ok(!screen.includes("Reading the source…"), "no read stays pending forever");
});

test("a cancelled continuation keeps the pages already read and stays retryable", async () => {
	const { catalog } = await tempCorpus();
	const held = gate("pattern-frame-inspection", { offset: true });
	const { calls, read } = gatedAccess(catalog, [held]);
	const view = pillarsView(viewHost(), { inventory: (signal) => browserEntries(catalog, read, signal), read });
	await settle();
	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	await settle();
	const screen = (view.render(120, 30) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
	assert.ok(screen.includes("PAGE-ONE-HEAD"), "the first page is shown");
	const more = view.actions?.().find((action) => action.label === "Read more");
	assert.ok(more);
	assert.equal(more.disabled, undefined, "the first page has a continuation to read");
	more.run();
	await settle();
	view.handleInput("\u001b[A");
	await settle();
	held.release();
	await settle();
	view.handleInput("\u001b[B");
	await settle();
	const kept = (view.render(120, 30) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
	assert.ok(kept.includes("PAGE-ONE-HEAD"), "the cancelled continuation keeps its first page");
	assert.ok(!kept.includes("Reading the next page…"), "no continuation stays pending forever");
	const actions = view.actions?.() ?? [];
	for (const label of ["Read more", "Read again"]) {
		const action = actions.find((candidate) => candidate.label === label);
		assert.ok(action);
		assert.notEqual(action.disabled, "A read is running", `${label} stays available`);
	}
	const before = calls.length;
	const readAgain = actions.find((candidate) => candidate.label === "Read again");
	readAgain?.run();
	await settle();
	assert.ok(calls.length > before, "Read again starts a fresh read after the cancelled continuation");
});
