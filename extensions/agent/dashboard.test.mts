import { machineConfig } from "./settings-fixture.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { fixture, formsHost, source, row, page, turn, deferred, conversationFrame, type FormCall } from "./dashboard-test-fixture.mts";
import { agentState, createDashboardState } from "./dashboard-state.ts";
import type { ConversationFrame } from "./live-frames.ts";
import { sessionFigures } from "./footer.ts";
import type { AwaitFact } from "./await-facts.ts";
import type { AgentConversationPage } from "./dashboard-types.ts";
import { createAgentObservationSource } from "./agent-observation.ts";
import type { ActionResult } from "./agent-forms.ts";

type Fixture = ReturnType<typeof fixture>;

/** Visible text: styling and the zero-width cursor markers removed, so columns match the screen. */
const visible = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
const shown = (f: Fixture) => visible(f.ui.render(f.tui.terminal.columns)).join("\n");
const click = (x: number, y: number, width: number, height: number): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1 });

/** Deliver keys one at a time with a paint before each, as a terminal does. */
function press(f: Fixture, ...keys: string[]): void {
	for (const key of keys) {
		f.ui.render(f.tui.terminal.columns);
		f.ui.handleInput(key);
	}
}

/** Type text one character at a time into whatever has focus. */
function type(f: Fixture, text: string): void {
	for (const character of text) f.ui.handleInput(character);
}

/** Click the lowest visible occurrence of a label, as the operator would. */
function clickLabel(f: Fixture, label: string): void {
	const { columns, rows } = f.tui.terminal;
	const lines = visible(f.ui.render(columns));
	for (let y = lines.length - 1; y >= 0; y--) {
		const x = lines[y]?.indexOf(label) ?? -1;
		if (x >= 0) {
			f.ui.handleMouse(click(x + 1, y, columns, rows));
			return;
		}
	}
	assert.fail(`no visible ${label}`);
}

/** Wait for asynchronous owner work until the screen shows `pattern`. */
async function until(f: Fixture, pattern: RegExp): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const screen = shown(f);
		if (pattern.test(screen)) return screen;
		await turn();
	}
	throw new Error(`the screen never showed ${pattern}\n${shown(f)}`);
}

/** Wait for asynchronous owner work until `condition` holds. */
async function settle(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !condition(); attempt++) await turn();
	assert.ok(condition(), "the condition never held");
}

/** The visible screen plus the open More menu, so a control the short row hides is still found. */
function actionText(f: Fixture): string {
	const screen = shown(f);
	if (!/x more/u.test(screen)) return screen;
	press(f, "x");
	const menu = shown(f);
	press(f, "\x1b");
	return `${screen}\n${menu}`;
}

/** The target header's state line: a divider or the row start, the state glyph, then the state label. */
const STATE_LINE = /(^|│) [◌●○✓!■↯·?] (Starting|Working|Idle|Done|Failed|Stopped|Interrupted|New|Unavailable)\b/u;

/** The rows right of the list divider, or every row when the list is a strip above the pane. */
function paneLines(f: Fixture): { lines: string[]; title: number } {
	const lines = visible(f.ui.render(f.tui.terminal.columns));
	const state = lines.findIndex((line, index) => index > 0 && STATE_LINE.test(line));
	assert.ok(state > 0, "the selected agent's header is shown");
	const title = state - 1;
	const divider = lines[title]?.indexOf("│") ?? -1;
	return { lines: lines.map((line) => (divider >= 0 ? line.slice(divider + 1) : line)), title };
}

/** The pane's text joined without its wrap breaks or the reader's scrollbar column. */
const joined = (f: Fixture) =>
	paneLines(f)
		.lines.map((line) => line.replace(/[│┃]\s*$/u, "").trim())
		.join("");

/** The selected agent's two header lines, before one blank row and the conversation. */
function targetHeader(f: Fixture): string[] {
	const { lines, title } = paneLines(f);
	return lines.slice(title, title + 2);
}

/** A forms host whose every owner call answers with `answer`. */
function answering(answer: (call: FormCall) => Promise<ActionResult>, patch: Parameters<typeof formsHost>[4] = {}) {
	const state = createDashboardState();
	const calls: FormCall[] = [];
	return { state, calls, forms: (observed: ReturnType<typeof source>) => (target: Parameters<typeof formsHost>[0]) => formsHost(target, state, observed, calls, patch, answer) };
}

it("Help shows the current machine file, digest, default preset and models without terminal controls", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "dashboard-machine-preferences-"));
	const path = join(directory, "preferences.json");
	const previous = process.env.PI_HARNESS_FILE;
	process.env.PI_HARNESS_FILE = path;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_HARNESS_FILE;
		else process.env.PI_HARNESS_FILE = previous;
		rmSync(directory, { recursive: true, force: true });
	});
	for (const content of [undefined, JSON.stringify(machineConfig({ presets: { standard: { model: "acme/model-x\u001b[2J" }, economy: { model: "other/model-y" } }, preferences: { defaultPreset: "standard" } })), "malformed"]) {
		if (content !== undefined) writeFileSync(path, content);
		const f = fixture(80, 100, source([row("one")]));
		try {
			await turn();
			f.ui.openNamedAction("help");
			const raw = f.ui.render(80).join("\n");
			assert.ok(!raw.includes("\u001b[2J"), "machine text never supplies terminal controls");
			const text = joined(f);
			assert.ok(text.includes(path), "Help names the machine file");
			if (content === undefined) {
				assert.match(text, /Preferences: absent/u);
				assert.match(text, /Digest: none/u);
				assert.match(text, /Presets: none/u);
			} else {
				assert.ok(text.includes(createHash("sha256").update(content).digest("hex")));
				if (content === "malformed") {
					assert.match(text, /Preferences: invalid/u);
					assert.match(text, /Diagnostic document:/u);
					assert.doesNotMatch(text, /acme\/model-x/u);
				} else {
					assert.match(text, /Preferences: loaded; default preset: standard/u);
					assert.match(text, /Preset standard: acme\/model-x/u);
					assert.match(text, /Preset economy: other\/model-y/u);
				}
			}
		} finally {
			f.ui.dispose();
		}
	}
});

for (const [width, height] of [[120, 36], [60, 24]]) {
	it(`selected dependency facts update and retire through native frames at ${width}`, async () => {
		const fact: AwaitFact = { runId: 7, heldInputs: [8], results: [{ result: { sessionId: "exact-peer:2", submissionId: 9, requestId: "exact-request" }, status: "pending" }], queuedInputCount: 1, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 1, results: 2 }, producers: [{ sessionId: "exact-peer:2", source: "producer await-state", observedAt: 123, unavailable: "Producer endpoint closed" }], omittedProducers: 3, likelyCycle: [], coverage: "one hop; remote graph incomplete" };
		const observed = source([row("one", { awaiting: fact })]);
		let notify = () => {};
		observed.subscribe = (listener) => {
			notify = listener;
			return () => {};
		};
		let frame = conversationFrame();
		frame = { ...frame, status: { ...frame.status, awaiting: fact } };
		observed.frame = () => frame;
		observed.availability = () => ({ state: "live", at: frame.observedAt });
		const f = fixture(width, height, observed);
		const read = () => {
			let text = "";
			for (let index = 0; index < 5; index++) {
				const lines = f.ui.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				text += visible(lines).join("\n");
				f.ui.handleInput("\x1b[5~");
			}
			f.ui.handleInput("\x1b[6~");
			return text.replace(/\s+/gu, " ");
		};
		try {
			await turn();
			let text = read();
			assert.match(text, /exact-peer:2/u);
			assert.match(text, /submission 9.*pending/u);
			assert.match(text, /Producer endpoint closed/u);
			assert.match(text, /123/u);
			assert.match(text, /Coverage: one hop/u);
			assert.match(text, /omitted 1 held requests/u);
			assert.match(actionText(f), /release await/u, "an await offers its release");
			const next = { ...fact, results: [{ ...fact.results[0], status: "done" as const }], producers: [{ sessionId: "exact-peer:2", source: "producer await-state" as const, observedAt: 456 }] };
			frame = { ...frame, revision: 2, status: { ...frame.status, awaiting: next } };
			notify();
			text = read();
			assert.match(text, /submission 9.*done/u);
			assert.match(text, /456/u);
			assert.doesNotMatch(text, /Producer endpoint closed/u);
			frame = { ...frame, revision: 3, status: { ...frame.status, awaiting: undefined } };
			notify();
			text = read();
			assert.doesNotMatch(text, /exact-peer:2|Coverage: one hop|producer await-state/u);
			assert.doesNotMatch(actionText(f), /release await/u, "a retired await offers no release");
		} finally {
			f.ui.dispose();
		}
	});
}

for (const [width, height] of [
	[140, 45],
	[80, 24],
]) {
	it(`live state drives the delivery label and Stop at ${width}`, async () => {
		const observed = source([row("one")]);
		let notify = () => {};
		observed.subscribe = (listener) => {
			notify = listener;
			return () => {};
		};
		let frame = conversationFrame();
		observed.frame = () => frame;
		observed.availability = () => ({ state: "live", at: frame.observedAt });
		const f = fixture(width, height, observed);
		try {
			await turn();
			for (const busy of [false, true, false]) {
				frame = { ...frame, revision: frame.revision + 1, status: { ...frame.status, busy } };
				notify();
				const screen = shown(f);
				assert.match(screen, busy ? /╭─ To one ─+ Steer at next step ⇄/u : /╭─ To one ─+┄*╮/u);
				const header = targetHeader(f).join("\n");
				assert.match(header, busy ? /● Working/u : /Idle/u);
				assert.doesNotMatch(header, /Stop/u, "the header holds no commands");
				if (busy) assert.match(shown(f), /s stop/u);
				else assert.doesNotMatch(shown(f), /s stop/u, "Stop shows only while work runs");
			}
		} finally {
			f.ui.dispose();
		}
	});
	for (const outcome of ["success", "newer", "same-text-new-revision", "refusal"]) {
		it(`late admission reconciles the reopened editor (${outcome}, ${width})`, async () => {
			const gate = deferred();
			const started = deferred();
			const observed = source();
			const f = fixture(width, height, observed, {
				submit: async () => {
					started.resolve();
					await gate.promise;
					if (outcome === "refusal") throw new Error("owner refused");
					return { text: "admitted" };
				},
			});
			await turn();
			f.ui.handleInput("\r");
			type(f, "first");
			f.ui.handleInput("\r");
			await started.promise;
			f.ui.dispose();
			const reopened = fixture(width, height, observed, undefined, f.state);
			try {
				await turn();
				reopened.ui.handleInput("\r");
				assert.equal(reopened.ui.focus.region, "composer");
				if (outcome === "newer" || outcome === "same-text-new-revision") {
					reopened.ui.handleInput("\x03");
					type(reopened, outcome === "newer" ? "newer" : "first");
				}
				gate.resolve();
				await turn();
				const text = outcome === "success" ? "" : outcome === "newer" ? "newer" : "first";
				assert.equal(agentState(f.state, "storage:1").draft, text);
				if (outcome === "success") assert.doesNotMatch(shown(reopened), /^│first\s*│$/mu);
				reopened.ui.dispose();
				assert.equal(agentState(f.state, "storage:1").draft, text);
			} finally {
				gate.resolve();
				reopened.ui.dispose();
			}
		});
	}
	it(`Find selects and previews the first match, and Escape clears it without moving the selection at ${width}`, async () => {
		const observed = source([row("one", { name: "Audit" }), row("two", { name: "Build" }), row("three", { name: "Build more" })]);
		const selected: Array<string | undefined> = [];
		observed.select = (id) => selected.push(id);
		observed.snapshot = async (id) => ({
			entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: `Transcript for ${id}`, timestamp: 0 }] }],
			partial: false,
			revision: id,
			nextBefore: null,
		});
		const f = fixture(width, height, observed);
		try {
			await turn();
			assert.equal(f.state.selected, "one");
			press(f, "/");
			type(f, "Build");
			await turn();
			assert.equal(f.state.filter, "Build");
			// Typing moved the selection; read it again rather than through the earlier assertion's narrowing.
			const first = f.state.selected as string | undefined;
			assert.ok(first === "two" || first === "three", "the selection follows Find to a match");
			assert.equal(selected.at(-1), first);
			assert.match(shown(f), new RegExp(`Transcript for ${first}`, "u"));
			assert.doesNotMatch(shown(f), /Audit/u);
			f.ui.handleInput("\x1b[B");
			await turn();
			const second = first === "two" ? "three" : "two";
			assert.equal(selected.at(-1), second);
			assert.match(shown(f), new RegExp(`Transcript for ${second}`, "u"));
			f.ui.handleInput("\x1b");
			await turn();
			assert.equal(f.state.filter, "");
			assert.equal(f.state.selected, second, "clearing Find keeps the chosen agent");
			assert.equal(f.counts().closes, 0);
		} finally {
			f.ui.dispose();
		}
	});
	it(`Find keeps the list, the header and the conversation on screen at ${width}`, async () => {
		for (const count of [1, 3]) {
			const records = Array.from({ length: count }, (_, index) => row(`build-${index}`, { name: `Build ${index}` }));
			const f = fixture(width, height, source(records));
			try {
				await turn();
				press(f, "/");
				type(f, "Build");
				await turn();
				const lines = f.ui.render(width);
				assert.equal(lines.length, height);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				const screen = visible(lines).join("\n");
				assert.match(screen, /▌ ● Build/u);
				assert.match(screen, /Find {2}Build/u);
				assert.match(screen, /Check the task/u);
			} finally {
				f.ui.dispose();
			}
		}
	});
	it(`zero matches start nothing and state the empty search at ${width}`, async () => {
		let starts = 0;
		const f = fixture(width, height, undefined, {
			newAgent: async () => {
				starts++;
				return { text: "created" };
			},
		});
		try {
			await turn();
			press(f, "/");
			type(f, "no-match");
			await turn();
			assert.match(shown(f), /No agent matches “no-match”/u);
			f.ui.handleInput("\r");
			await turn();
			assert.equal(starts, 0);
			assert.equal(f.ui.focus.region, "list");
			f.ui.handleInput("\x1b");
			assert.equal(f.state.filter, "");
			assert.equal(f.counts().closes, 0);
			f.ui.handleInput("\x1b");
			assert.equal(f.counts().closes, 1);
		} finally {
			f.ui.dispose();
		}
	});
	for (const name of ["abort", "attach", "release"]) {
		it(`an owner refusal stays visible in the ${name} form at ${width}`, async () => {
			const observed = source([row("one", { state: name === "abort" ? "working" : "idle", health: name === "attach" ? { lastError: "lost" } : undefined })]);
			const host = answering(async () => {
				throw new Error("Host refusal marker");
			});
			const f = fixture(width, height, observed, { forms: host.forms(observed) }, host.state);
			try {
				await turn();
				f.ui.openNamedAction(name);
				const title = f.ui.focus.inspector;
				assert.ok(title, "the form opens in the inspector");
				press(f, "\r", "\r");
				await until(f, /Host refusal marker/u);
				assert.equal(f.ui.focus.inspector, title, "the refused form stays open");
				assert.deepEqual(host.calls.map((call) => call.target), ["one"]);
			} finally {
				f.ui.dispose();
			}
		});
	}
	for (const action of ["fork", "rewind"]) {
		it(`a ${action} opens the created branch and keeps the source draft at ${width}`, async () => {
			const rows = [row("one")];
			const observed = source(rows);
			const host = answering(async () => {
				rows.push(row("branch", { name: "New branch", state: "idle" }));
				return { text: "Branch created", sessionId: "branch" };
			});
			const f = fixture(width, height, observed, { forms: host.forms(observed) }, host.state);
			try {
				await turn();
				f.ui.handleInput("\r");
				type(f, "source draft");
				f.ui.handleInput("\x1b");
				f.ui.openNamedAction(action);
				await until(f, action === "rewind" ? /Correction/u : /Latest committed entry/u);
				if (action === "rewind") {
					press(f, "\r");
					type(f, "Use the other parser");
					press(f, "\r");
				} else press(f, "\r", "\r");
				await settle(() => f.state.selected === "branch");
				assert.deepEqual(host.calls.map((call) => call.name), [action]);
				const screen = await until(f, /To New branch/u);
				assert.match(screen, /╭─ To New branch ─+┄*╮/u);
				assert.match(targetHeader(f).join("\n"), /Idle/u);
				assert.equal(f.ui.focus.region, "composer");
				assert.equal(agentState(f.state, "one").draft, "source draft");
			} finally {
				f.ui.dispose();
			}
		});
	}
	it(`Details keeps long Unicode values and their exact suffixes at ${width}`, async () => {
		const values = [`/work/${"界".repeat(150)}EXACT_PATH_END`, `provider/${"m".repeat(240)}EXACT_MODEL_END`];
		const observed = source([row("one")]);
		const host = answering(async () => undefined, { status: async () => ({ cwd: values[0], model: values[1] }) });
		const f = fixture(width, 80, observed, { forms: host.forms(observed) }, host.state);
		try {
			await turn();
			f.ui.openNamedAction("status");
			await until(f, /EXACT_MODEL_END/u);
			const lines = f.ui.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const text = joined(f);
			for (const value of values) assert.ok(text.includes(value), `Details keeps ${value.slice(-15)} at ${width}`);
		} finally {
			f.ui.dispose();
		}
	});
}

for (const [patch, reason, recovery] of [
	[{ owner: "unavailable" as const, state: "unavailable" as const, error: "Claim conflict marker" }, "Unavailable: Claim conflict marker", "Reconnect starts the host when the storage is readable"],
	[{ state: "idle" as const, health: { lastError: "Host error marker" } }, "Host error: Host error marker", "Reconnect starts the host; unfinished work resumes"],
	[{ state: "idle" as const, health: { compactionFailure: { trigger: "manual" as const, at: "now", errorMessage: "Compaction error marker" } } }, "Compaction failed (manual): Compaction error marker", "Reconnect starts the host; unfinished work resumes"],
	[{ state: "idle" as const, health: { autoRetry: { attempt: 3, maxAttempts: 3, delayMs: 0, errorMessage: "Exhausted retry marker" } } }, "Retries exhausted: Exhausted retry marker", "Reconnect starts the host; unfinished work resumes"],
	[{ state: "failed" as const, error: "Work failure marker" }, "Work failure marker", "A new message runs the work again"],
] as const) {
	it(`the selected agent's header states its stored error and the way forward (${JSON.stringify(patch)})`, async () => {
		const f = fixture(240, 45, source([row("one", patch)]));
		try {
			await turn();
			const header = targetHeader(f).join("\n");
			assert.equal(header.split("\n").length, 2);
			assert.ok(header.includes(`${reason} · ${recovery}`), header);
			assert.doesNotMatch(header, /Details has the stored error/u);
		} finally {
			f.ui.dispose();
		}
	});
}

it("a row without a stored error shows its specific read status instead of a generic reason", async () => {
	const observed = source([row("one", { owner: "unavailable", state: "unavailable" })]);
	observed.snapshot = async () => ({ entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: "Check the task", timestamp: 0 }] }], partial: true, revision: "1", nextBefore: null });
	const f = fixture(140, 45, observed);
	try {
		await turn();
		await turn();
		const header = targetHeader(f).join("\n");
		assert.match(header, /Partial history/u);
		assert.doesNotMatch(header, /Storage cannot be read/u);
	} finally {
		f.ui.dispose();
	}
});

it("the error count filters the list and Show all or Escape restores every agent", async () => {
	const rows = [row("ok", { name: "Okay", modifiedAt: 3 }), row("bad", { name: "Broken", state: "failed", error: "quota limit", modifiedAt: 2 }), row("sad", { name: "Host fault", health: { lastError: "Host error" }, modifiedAt: 1 })];
	const f = fixture(120, 30, source(rows));
	/** The whole screen and the list column alone; the pane keeps the selected agent while the list narrows. */
	const read = () => {
		const lines = visible(f.ui.render(120));
		const divider = lines[1]?.indexOf("│") ?? -1;
		return { all: lines.join("\n"), list: lines.map((line) => line.slice(0, divider)).join("\n") };
	};
	try {
		await turn();
		await turn();
		assert.match(read().list, /2 with errors/u);
		assert.match(read().list, /Okay/u);
		clickLabel(f, "2 with errors");
		await turn();
		assert.doesNotMatch(read().list, /Okay/u);
		assert.match(read().list, /Broken/u);
		assert.match(read().list, /errors only/u);
		assert.match(read().list, /errors · 2 of 3 loaded/u);
		press(f, "e");
		await turn();
		assert.match(read().list, /Okay/u);
		assert.match(read().list, /3 loaded/u);
		clickLabel(f, "2 with errors");
		f.ui.handleInput("\x1b");
		await turn();
		assert.match(read().list, /Okay/u);
		assert.doesNotMatch(read().all, /errors only/u);
	} finally {
		f.ui.dispose();
	}
});

it("Home and End select the first and last agent", async () => {
	const f = fixture(120, 30, source([row("first", { modifiedAt: 3 }), row("middle", { modifiedAt: 2 }), row("last", { modifiedAt: 1 })]));
	try {
		await turn();
		await turn();
		assert.equal(f.state.selected, "first");
		f.ui.handleInput("\x1b[F");
		assert.equal(f.state.selected, "last");
		f.ui.handleInput("\x1b[H");
		assert.equal(f.state.selected, "first");
		f.ui.handleInput("\x1b[F");
		await turn();
		assert.match(shown(f), /▌ .*last/u);
	} finally {
		f.ui.dispose();
	}
});

it("late admission adds successful message history to the reopened composer", async () => {
	const gate = deferred();
	const started = deferred();
	const observed = source();
	const f = fixture(80, 24, observed, {
		submit: async () => {
			started.resolve();
			await gate.promise;
			return { text: "admitted" };
		},
	});
	await turn();
	f.ui.handleInput("\r");
	type(f, "first");
	f.ui.handleInput("\r");
	await started.promise;
	f.ui.dispose();
	const reopened = fixture(80, 24, observed, undefined, f.state);
	try {
		await turn();
		reopened.ui.handleInput("\r");
		gate.resolve();
		await turn();
		reopened.ui.handleInput("\x1b[A");
		assert.equal(agentState(f.state, "storage:1").draft, "first");
	} finally {
		gate.resolve();
		reopened.ui.dispose();
	}
});

it("a created branch outside the published roster receives the next message, never its source", async () => {
	const sent: string[] = [];
	const observed = source([row("one")]);
	const host = answering(async () => ({ text: "Forked", sessionId: "branch" }));
	const f = fixture(80, 24, observed, {
		forms: host.forms(observed),
		submit: async (input) => {
			sent.push(input.id);
			return { text: "admitted" };
		},
	}, host.state);
	try {
		await turn();
		f.ui.openNamedAction("fork");
		await until(f, /Latest committed entry/u);
		press(f, "\r", "\r");
		await settle(() => f.state.selected === "branch");
		assert.equal(f.ui.focus.region, "composer");
		const header = targetHeader(f).join("\n");
		assert.doesNotMatch(header, /\$\?/u);
		assert.doesNotMatch(header, /model │/u);
		type(f, "branch instruction");
		f.ui.handleInput("\r");
		await turn();
		assert.deepEqual(sent, ["branch"]);
	} finally {
		f.ui.dispose();
	}
});

it("a late branch completion after Escape leaves the selection and focus where they are", async () => {
	const gate = deferred();
	const entered = deferred();
	const rows = [row("one")];
	const observed = source(rows);
	const host = answering(async () => {
		entered.resolve();
		await gate.promise;
		rows.push(row("branch"));
		return { text: "Forked", sessionId: "branch" };
	});
	const f = fixture(80, 24, observed, { forms: host.forms(observed) }, host.state);
	try {
		await turn();
		f.ui.openNamedAction("fork");
		await until(f, /Latest committed entry/u);
		press(f, "\r", "\r");
		await entered.promise;
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.focus.inspector, undefined);
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.focus.region, "list");
		gate.resolve();
		await settle(() => agentState(f.state, "one").receipt === "Forked");
		await turn();
		assert.equal(f.state.selected, "one");
		assert.equal(f.ui.focus.region, "list");
	} finally {
		gate.resolve();
		f.ui.dispose();
	}
});

it("a late new conversation completion respects a later list selection", async () => {
	const gate = deferred();
	const created = deferred();
	const rows = [row("one")];
	const f = fixture(80, 24, source(rows), {
		newAgent: async ({ prompt, onCreated }) => {
			const starting = row("two", { state: "starting", firstMessage: prompt });
			rows.push(starting);
			onCreated(starting);
			created.resolve();
			await gate.promise;
			return { text: "Started", sessionId: "two" };
		},
	});
	try {
		await turn();
		f.ui.openNamedAction("new");
		type(f, "task");
		press(f, "\r", "\r");
		clickLabel(f, "start");
		await settle(() => f.state.selected === "two");
		f.ui.handleInput("\x1b");
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.focus.region, "list");
		f.ui.handleInput("\x1b[A");
		assert.equal(f.state.selected, "one");
		gate.resolve();
		await turn();
		await turn();
		assert.equal(f.state.selected, "one");
		assert.equal(f.ui.focus.region, "list");
	} finally {
		gate.resolve();
		f.ui.dispose();
	}
});

it("with no related work the list shows every agent, and a chosen Related scope states its whole reason", async () => {
	const f = fixture(120, 30, source([row("unrelated", { storageId: "unrelated", creatingOwnerId: "someone-else", name: "Unrelated worker" })]), undefined, undefined, undefined, "caller-session");
	try {
		await settle(() => /Unrelated worker/u.test(shown(f)));
		const findRow = visible(f.ui.render(120))[1] ?? "";
		const x = findRow.indexOf(" Related ") + 1;
		f.ui.handleMouse({ type: "click", button: "left", x, y: 1, screenX: x, screenY: 1, width: 120, height: 30, shift: false, alt: false, ctrl: false, clickCount: 1 });
		await settle(() => /No related agents yet/u.test(shown(f)));
		const lines = visible(f.ui.render(120));
		const divider = lines[1]?.indexOf("\u2502") ?? 0;
		const list = lines.map((line) => line.slice(0, divider).trim()).join(" ");
		assert.match(list, /No related agents yet\. All shows every loaded agent\./u);
	} finally {
		f.ui.dispose();
	}
});

it("roster publication preserves arrow order during a navigation sequence", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let rows = [row("one", { modifiedAt: 3 }), row("two", { modifiedAt: 2 }), row("three", { modifiedAt: 1 })];
	const observed = source();
	observed.list = async () => page(rows);
	let notify = () => {};
	observed.subscribeRoster = (listener) => {
		notify = listener;
		return () => {};
	};
	const f = fixture(80, 24, observed);
	try {
		await turn();
		f.ui.handleInput("\x1b[B");
		assert.equal(f.state.selected, "two");
		rows = [row("one", { modifiedAt: 3 }), row("two", { modifiedAt: 0 }), row("three", { modifiedAt: 1 })];
		notify();
		t.mock.timers.tick(250);
		await turn();
		f.ui.handleInput("\x1b[B");
		assert.equal(f.state.selected, "three");
	} finally {
		f.ui.dispose();
	}
});

it("the view opens on the list, / focuses Find, and Escape clears Find before it closes", async () => {
	const sent: string[] = [];
	const f = fixture(80, 24, source([row("one"), row("two")]), {
		submit: async (input) => {
			sent.push(input.text);
			return { text: "admitted" };
		},
	});
	await turn();
	assert.equal(f.ui.focus.region, "list");
	assert.match(shown(f), /one/u);
	type(f, "two");
	assert.equal(f.state.filter, "", "letters over the list do not reach Find");
	assert.equal(f.state.selected, "one");
	press(f, "/");
	type(f, "two");
	assert.equal(f.state.filter, "two");
	assert.equal(f.state.selected, "two");
	f.ui.handleInput("\x1b");
	assert.equal(f.state.filter, "");
	assert.equal(f.counts().closes, 0);
	f.ui.handleInput("\x1b");
	assert.equal(f.ui.focus.region, "list", "the second Escape leaves Find");
	press(f, "n");
	assert.equal(f.ui.focus.inspector, "New conversation", "a letter over the list is a key");
	press(f, "\x1b");
	assert.equal(f.ui.focus.inspector, undefined);
	assert.equal(f.counts().closes, 0);
	f.ui.handleInput("\x1b");
	assert.equal(f.ui.focus.region, "list");
	f.ui.handleInput("\x1b");
	assert.equal(f.counts().closes, 1);
	assert.deepEqual(sent, [], "typing over the list never sends a message");
});

it("a late send receipt keeps a newer draft and never changes focus", async () => {
	const gate = deferred();
	const sent: string[] = [];
	const f = fixture(80, 24, source([row("one"), row("two")]), {
		submit: async (input) => {
			sent.push(input.id);
			await gate.promise;
			return { text: "admitted" };
		},
	});
	try {
		await turn();
		f.ui.handleInput("\r");
		type(f, "first");
		f.ui.handleInput("\r");
		f.ui.handleInput("\x1b");
		f.ui.handleInput("\x1b[B");
		assert.equal(f.state.selected, "two");
		agentState(f.state, "one").draft = "newer";
		gate.resolve();
		await turn();
		assert.deepEqual(sent, ["one"]);
		assert.equal(f.state.selected, "two");
		assert.equal(f.ui.focus.region, "list");
		assert.equal(agentState(f.state, "one").draft, "newer");
	} finally {
		gate.resolve();
		f.ui.dispose();
	}
});

it("a new conversation selects its purpose and starting state before host readiness", async () => {
	const rows = [row("one")];
	const observed = source(rows);
	observed.snapshot = async () => ({ entries: [], partial: false, revision: "empty", nextBefore: null });
	const created = deferred();
	const release = deferred();
	const f = fixture(140, 45, observed, {
		newAgent: async ({ prompt, onCreated }) => {
			const starting = row("two", { name: undefined, firstMessage: prompt, state: "starting" });
			rows.push(starting);
			onCreated(starting);
			created.resolve();
			await release.promise;
			return { text: "Started", sessionId: "two" };
		},
	});
	try {
		await turn();
		f.ui.openNamedAction("new");
		type(f, "Write the startup note");
		press(f, "\r", "\r");
		clickLabel(f, "start");
		await settle(() => f.state.selected === "two");
		for (const [width, height] of [
			[140, 45],
			[80, 24],
		]) {
			f.resize(width, height);
			const screen = shown(f);
			assert.match(screen, /◌ Starting/u);
			assert.match(screen, /Write the startup note/u);
			assert.match(screen, /model │/u);
			assert.doesNotMatch(screen, /Conversation unavailable|Unavailable|Attention|need attention|model \?|reasoning \?/u);
		}
		f.resize(140, 45);
		assert.match(shown(f), /╭─ To Write the startup note ─+┄*╮/u);
		await turn();
		assert.match(shown(f), /Starting/u);
		assert.doesNotMatch(shown(f), /Conversation unavailable/u);
	} finally {
		release.resolve();
		await turn();
		f.ui.dispose();
	}
});

it("a busy live frame updates the header, the list and the message field together", async () => {
	const observed = source([row("one", { state: "done" })]);
	let changed = () => {};
	observed.subscribe = (listener) => {
		changed = listener;
		return () => {};
	};
	let frame: ConversationFrame | undefined;
	observed.frame = () => frame;
	observed.availability = () => (frame ? { state: "live", at: frame.observedAt } : undefined);
	const f = fixture(140, 45, observed);
	try {
		await turn();
		frame = conversationFrame();
		changed();
		const screen = shown(f);
		assert.match(screen, /Steer at next step ⇄/u);
		assert.match(targetHeader(f).join("\n"), /● Working/u);
		assert.match(shown(f), /model │/u);
		assert.doesNotMatch(screen, /Done|0 working/u);
	} finally {
		f.ui.dispose();
	}
});

it("a late cold snapshot error never replaces a live conversation", async () => {
	const observed = source([row("one")]);
	let fail!: (error: Error) => void;
	observed.snapshot = () =>
		new Promise((_resolve, reject) => {
			fail = reject;
		});
	let changed = () => {};
	observed.subscribe = (listener) => {
		changed = listener;
		return () => {};
	};
	let frame: ConversationFrame | undefined;
	observed.frame = () => frame;
	observed.availability = () => (frame ? { state: "live", at: frame.observedAt } : undefined);
	const f = fixture(140, 45, observed);
	try {
		await turn();
		frame = conversationFrame({
			entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: "Live task", timestamp: 0 }] }],
		});
		changed();
		fail(new Error("ENOENT: source was absent before the host started"));
		await turn();
		const screen = shown(f);
		assert.match(screen, /model │/u);
		assert.match(screen, /Live task/u);
		assert.doesNotMatch(screen, /Conversation unavailable|ENOENT/u);
	} finally {
		f.ui.dispose();
	}
});

it("a new conversation without a creation callback selects the created identity", async () => {
	const rows = [row("one")];
	const f = fixture(80, 24, source(rows), {
		newAgent: async () => {
			rows.push(row("two"));
			return { text: "Started", sessionId: "two" };
		},
	});
	try {
		await turn();
		f.ui.openNamedAction("new");
		type(f, "task");
		press(f, "\r", "\r");
		clickLabel(f, "start");
		await settle(() => f.state.selected === "two");
		await settle(() => f.ui.focus.inspector === undefined);
		assert.equal(f.state.newTask, "");
		assert.equal(f.ui.focus.inspector, undefined);
		assert.equal(f.ui.focus.region, "composer");
	} finally {
		f.ui.dispose();
	}
});

it("a retained conversation reattaches and rereads when a stopped host restarts", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
	let current = row("new", { state: "stopped", modifiedAt: 1 });
	const observed = source([current]);
	let rosterChange = () => {};
	const refreshed: string[] = [];
	let reads = 0;
	observed.subscribeRoster = (listener) => {
		rosterChange = listener;
		return () => {};
	};
	observed.list = async () => page([current]);
	observed.refresh = (id) => refreshed.push(id);
	observed.availability = () => ({ state: "unavailable", at: new Date(0).toISOString() });
	observed.snapshot = async () => {
		reads++;
		return {
			entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: reads === 1 ? "Stored task" : "Restarted task", timestamp: 0 }] }],
			partial: false,
			revision: "2",
			nextBefore: null,
		};
	};
	const f = fixture(80, 24, observed);
	try {
		await turn();
		await turn();
		assert.match(shown(f), /model │/u);
		assert.match(shown(f), /Stored task/u);
		rosterChange();
		t.mock.timers.tick(250);
		await turn();
		assert.deepEqual(refreshed, []);
		current = row("new", { state: "working", modifiedAt: 2, cost: 0.43 });
		rosterChange();
		t.mock.timers.tick(250);
		await turn();
		await turn();
		assert.deepEqual(refreshed, ["new"]);
		assert.equal(reads, 2);
		const screen = shown(f);
		assert.match(screen, /Not connected; stored messages shown/u);
		assert.equal(screen.split("Not connected").length - 1, 1);
		assert.match(screen, /Restarted task/u);
	} finally {
		f.ui.dispose();
	}
});

it("Load more is selected before it reads, and loaded coverage survives reconciliation", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
	const observed = source();
	let rosterChange = () => {};
	const calls: Array<string | undefined> = [];
	const inventory = { candidates: 4, inspected: 4, unreadable: 1, unknownClaims: 0, returned: 1, remaining: 0, priorityRemaining: 0,
		remainingRows: 0, priorityRemainingRows: 0, recordByteLimit: 32768, claimByteLimit: 16384, outputLimit: 2 };
	observed.subscribeRoster = (listener) => {
		rosterChange = listener;
		return () => {};
	};
	observed.list = async (input): Promise<AgentConversationPage> => {
		calls.push(input?.cursor);
		return input?.cursor
			? {
					...page([row("c")]),
					coverage: { complete: false, storagesVisited: 4, skipped: 2, omitted: 0, nextCursor: null, inventory,
						projections: { c: { skipped: 1, omitted: 0 } } },
				}
			: {
					...page([row("a"), row("b")]),
					coverage: { complete: false, storagesVisited: 4, skipped: 1, omitted: 0, nextCursor: "more",
						inventory: { ...inventory, returned: 2, remaining: 1, remainingRows: 1 },
						projections: { a: { skipped: 0, omitted: 0 }, b: { skipped: 0, omitted: 0 } } },
				};
	};
	const f = fixture(100, 24, observed, { sessionFigures: async (roster) => sessionFigures(roster.rows, "primary", () => "primary") });
	try {
		await turn();
		f.ui.handleInput("\x1b[B");
		f.ui.handleInput("\x1b[B");
		assert.deepEqual(calls, [undefined], "moving to Load more reads nothing");
		assert.match(shown(f), /› Load more/u);
		assert.equal(f.state.selected, "b", "Load more leaves the last agent selected");
		f.ui.handleInput("\r");
		await turn();
		assert.deepEqual(calls, [undefined, "more"]);
		assert.match(visible(f.ui.render(100))[0] ?? "", /agents: 3\/3 active · ~\$1\.26/u);
		rosterChange();
		t.mock.timers.tick(250);
		await turn();
		assert.deepEqual(calls, [undefined, "more", undefined, "more"]);
		assert.match(visible(f.ui.render(100))[0] ?? "", /agents: 3\/3 active · ~\$1\.26/u);
		assert.doesNotMatch(shown(f), /unreadable/u, "storage coverage stays in Details, out of the list");
	} finally {
		f.ui.dispose();
	}
});

it("Tasks Refresh retries a declined attachment without reopening the view", async () => {
	const storageId = "00000000-0000-4000-8000-000000000001";
	const base = source([row(storageId)]);
	let attaches = 0;
	let releases = 0;
	const observed = createAgentObservationSource({
		list: base.list,
		snapshot: async () => ({ ...(await base.snapshot(storageId)), nextBefore: null, coverage: { complete: true, entries: 0, bytes: 0, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: false } }),
		subscribeRoster: base.subscribeRoster,
		observeLive: async (id, scope, listener) => {
			if (scope !== "tasks") return () => {};
			attaches++;
			if (attaches === 1) return undefined;
			await Promise.resolve();
			listener({ scope: "tasks", storageId: id, revision: 1, observedAt: new Date(0).toISOString(), tasks: [], labels: [], coverage: { complete: true, live: true } }, true, "live");
			return () => {
				releases++;
			};
		},
	});
	const f = fixture(80, 24, observed);
	try {
		await turn();
		f.ui.openNamedAction("tasks");
		await turn();
		assert.equal(f.ui.focus.inspector, "Tasks");
		assert.equal(attaches, 1);
		assert.equal((await observed.tasks(storageId)).coverage.live, false);
		clickLabel(f, "refresh");
		await turn();
		assert.equal(f.ui.focus.inspector, "Tasks");
		assert.equal(attaches, 2);
		assert.equal((await observed.tasks(storageId)).coverage.live, true);
		assert.match(await until(f, /No live tasks/u), /No live tasks/u);
		clickLabel(f, "refresh");
		await turn();
		assert.equal(attaches, 2, "a live attachment is not attached again");
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.focus.inspector, undefined);
		assert.equal(releases, 1);
	} finally {
		f.ui.dispose();
	}
});

it("Tasks opens a resolved unloaded conversation and releases its graph", async () => {
	const observed = source([row("storage")]);
	let active = false;
	let releases = 0;
	const selected: Array<string | undefined> = [];
	observed.select = (id) => selected.push(id);
	observed.releaseTasks = () => {
		if (active) releases++;
		active = false;
	};
	observed.tasks = async () => {
		active = true;
		return {
			scope: "tasks",
			storageId: "storage",
			revision: 1,
			observedAt: new Date(0).toISOString(),
			coverage: { complete: true, live: true },
			labels: [{ conversationId: 2, identity: "storage:2", name: "Child" }],
			tasks: [{ id: 1, kind: "turn", conversationId: 2, background: false, abortRequested: false, status: "running", phase: "model", waitsOn: [], conversations: [2] }],
		};
	};
	const f = fixture(80, 24, observed);
	try {
		await turn();
		f.ui.openNamedAction("tasks");
		await until(f, /Child/u);
		f.ui.handleInput("\r");
		await turn();
		assert.equal(f.ui.focus.inspector, undefined);
		assert.equal(f.ui.focus.region, "composer");
		assert.equal(f.state.selected, "storage:2");
		assert.ok(selected.includes("storage:2"));
		assert.equal(active, false);
		assert.equal(releases, 1);
		const header = targetHeader(f).join("\n");
		assert.match(header, /Child/u);
		assert.doesNotMatch(header, /\$\?/u);
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.focus.region, "list");
	} finally {
		f.ui.dispose();
	}
});

for (const width of [80, 164]) {
	it(`the fact line resolves the current model once per render at ${width}`, async () => {
		const observed = source([row("one"), row("two", { model: { provider: "other", modelId: "second", thinkingLevel: "high" } })]);
		observed.snapshot = async () => ({ entries: [{ id: "1", kind: "pi.assistant", model: [{ role: "assistant", api: "openai-responses", provider: "test", model: "model", content: [], timestamp: 0, stopReason: "stop", usage: { input: 160, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] }], partial: false, revision: "1" });
		const lookups: Array<[string, string]> = [];
		let capacity: number | undefined = 1000;
		const f = fixture(width, 30, observed, {
			modelInfo: (provider, modelId) => {
				lookups.push([provider, modelId]);
				return capacity === undefined ? undefined : { name: modelId, reasoning: true, contextWindow: capacity };
			},
		});
		try {
			await turn();
			let screen = shown(f);
			assert.deepEqual(lookups, [["test", "model"]]);
			assert.match(screen, /160\/1.0k/u);
			assert.match(screen, /16%/u);
			capacity = 2000;
			f.ui.handleInput("\x1b[B");
			await turn();
			screen = shown(f);
			assert.deepEqual(lookups, [["test", "model"], ["other", "second"]]);
			assert.match(screen, /160\/2.0k/u);
			assert.match(screen, /8%/u);
			capacity = undefined;
			screen = shown(f);
			assert.equal(lookups.length, 3);
			assert.match(screen, /│ 160 │/u);
			assert.doesNotMatch(screen, /8%|2.0k/u);
		} finally {
			f.ui.dispose();
		}
	});
}

for (const width of [80, 164]) {
	it(`the header omits fact lines with nothing known at ${width}`, async () => {
		const f = fixture(width, 30, source([row("one", { state: "idle", model: undefined, cost: Number.NaN })]));
		try {
			await turn();
			const header = targetHeader(f);
			assert.match(header[0] ?? "", /one {2}work/u);
			assert.match(header[1] ?? "", /○ Idle/u);
			assert.equal(header.length, 2);
			assert.doesNotMatch(header.join("\n"), /Model|Tokens|Context|Cost|\$\?/u);
			const { lines } = paneLines(f);
			const composerBottom = lines.findIndex((line) => line.startsWith("╰─"));
			assert.match(lines[composerBottom + 1] ?? "", /^ \/work/u, "the directory follows the composer without an empty metrics line");
		} finally {
			f.ui.dispose();
		}
	});
}

it("c configure opens the same form by its key and by a click on its footer control", async () => {
	for (const mode of ["key", "click"] as const) {
		const f = fixture(140, 45, source([row("one", { state: "idle" })]));
		try {
			await turn();
			if (mode === "key") f.ui.handleInput("c");
			else {
				const rows = visible(f.ui.render(140));
				const footer = rows.at(-1) ?? "";
				f.ui.handleMouse(click(footer.indexOf("c configure") + 1, rows.length - 1, 140, 45));
			}
			assert.equal(f.ui.focus.inspector, "Configure", mode);
		} finally {
			f.ui.dispose();
		}
	}
});

it("x and a click on the footer's More control show the same actions", async () => {
	const menus: string[] = [];
	for (const mode of ["key", "click"] as const) {
		const f = fixture(120, 30, source([row("one", { state: "idle" })]));
		try {
			await turn();
			f.ui.render(120);
			if (mode === "key") f.ui.handleInput("x");
			else {
				const rows = visible(f.ui.render(120));
				const footer = rows.at(-1) ?? "";
				f.ui.handleMouse(click(footer.indexOf("x more") + 1, rows.length - 1, 120, 30));
			}
			const rows = visible(f.ui.render(120));
			const heading = rows.findIndex((line) => line.trimEnd().startsWith("More"));
			assert.ok(heading >= 0, `${mode} opens More`);
			menus.push(rows.slice(heading, heading + 3).map((line) => line.trim()).join("|"));
		} finally {
			f.ui.dispose();
		}
	}
	assert.equal(menus[0], menus[1], "the key and the click show the same entries");
});

it("the footer follows the focused region", async () => {
	const f = fixture(164, 45, source([row("one")]));
	try {
		await turn();
		const footer = () => (visible(f.ui.render(164)).at(-1) ?? "").trimEnd();
		assert.match(footer(), /↑↓ select.*esc (close|list)$/u);
		press(f, "/");
		assert.match(footer(), /↑↓ select · enter done · esc list$/u);
		press(f, "\x1b");
		press(f, "\r");
		assert.match(footer(), /enter (send|steer).*esc list$/u);
		press(f, "\x1b");
		press(f, "\t");
		assert.match(footer(), /↑↓ scroll.*esc list$/u);
	} finally {
		f.ui.dispose();
	}
});

it("footer targets follow a resize", async () => {
	const f = fixture(140, 40, source([row("one", { state: "idle" })]));
	try {
		await turn();
		const wide = visible(f.ui.render(140));
		const oldX = (wide.at(-1) ?? "").indexOf("? help");
		assert.ok(oldX > 0, "the wide row shows Help");
		f.resize(80, 24);
		const narrow = visible(f.ui.render(80));
		const narrowFooter = (narrow.at(-1) ?? "").trimEnd();
		assert.ok(!narrowFooter.includes("? help"), "the narrow row hides Help in More");
		f.ui.handleMouse(click(oldX, narrow.length - 1, 80, 24));
		assert.equal(f.ui.focus.inspector, undefined, "the old position opens nothing");
		f.ui.handleMouse(click(narrowFooter.indexOf("x more") + 1, narrow.length - 1, 80, 24));
		const menu = visible(f.ui.render(80));
		assert.ok(menu.some((line) => line.includes("help")), "the drawn More control lists the hidden action");
	} finally {
		f.ui.dispose();
	}
});
