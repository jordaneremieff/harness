import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { dashboardTime } from "./dashboard-time.ts";
import { it } from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { EffortAwareness } from "./effort-awareness.ts";
import type { EffortPresencePage } from "./effort-presence.ts";
import { fixture, source, row, turn, deferred, theme } from "./dashboard-test-fixture.mts";
import { rosterLines } from "./dashboard-roster.ts";
import type { CollaborationPage } from "./collaboration.ts";
import { createAgentCommand } from "./command.ts";
import type { AgentDashboard } from "./dashboard.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { keys } from "./dashboard-test-fixture.mts";

function efforts(): EffortPresencePage {
	return {
		efforts: [{
			id: "effort", cwd: "/work", name: "Related effort primary", startedAt: "2026-10-04T00:00:00.000Z",
			liveness: "live", relationship: "repository", repository: "/work/.git", sharedSubstrates: ["repository", "machine-gates"],
			observedPurpose: { source: "session-name", text: "Observed work" },
			intentClaim: { purpose: "Review the overlap", integration: "Wait for shared checks", authority: "Operator brief", scope: { paths: ["extensions/agent"], branches: ["topic"], fullGate: true }, contactThread: "store/thread", updatedAt: "2026-10-04T01:00:00.000Z" },
		}, { id: "uncertain", cwd: "/work", startedAt: "2026-10-04T00:00:00.000Z", liveness: "unknown", relationship: "cwd" }],
		coverage: { visited: 7, unreadable: 1, dead: 1, unrelated: 2, omitted: 1, complete: false, reasons: ["result-limit"] },
		limits: { visits: 256, results: 20, bytes: 16384 },
	};
}
function awareness(presence = efforts()): EffortAwareness {
	return {
		self: { id: "primary", cwd: "/work", observedPurpose: { source: "interactive-input", text: "Current own work" } }, presence,
		threads: { items: [], coverage: { visited: 3, records: 2, unreadable: 0, missingHints: 0, omittedHints: 0, omittedResults: 0, unvisited: false, complete: true, reasons: [] }, limits: { visits: 256, results: 12, bytes: 8192, hintsPerRecord: 8 } },
	};
}
function click(x: number, y: number, width: number, height: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1 };
}
function setup(width = 100, height = 30) {
	let notify = () => {};
	let reads = 0;
	const messages: { id: string; text: string }[] = [];
	const controls: string[] = [];
	const observed = source();
	observed.subscribeRoster = (listener) => { notify = listener; return () => {}; };
	const current = efforts();
	const f = fixture(width, height, observed, {
		efforts: async () => { reads++; return awareness(current); },
		messageEffort: async (id, text) => { messages.push({ id, text }); return { text: "Operator message admitted" }; },
		submit: async () => { controls.push("submit"); return { text: "wrong" }; },
		newAgent: async () => { controls.push("new"); return { text: "wrong" }; },
	});
	return { ...f, messages, controls, current, reads: () => reads, notify: () => notify() };
}
it("effort entry is event-driven and renders claims and finite coverage at narrow width", async () => {
	const f = setup(60, 30);
	try {
		await turn();
		assert.equal(f.reads(), 0);
		f.ui.openNamedAction("efforts");
		await turn();
		assert.equal(f.reads(), 1);
		const lines = f.ui.render(60);
		assert.equal(lines.length, 30);
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
		const text = lines.join("\n");
		assert.match(text, /Purpose/);
		assert.match(text, /Review the overlap/);
		assert.doesNotMatch(text, /Observed work/);
		assert.doesNotMatch(text, /Integration|Operator direction|Scope|Shared substrates|Authority source/);
		assert.match(text, /Contact/);
		assert.match(text, /Identity/);
		assert.match(text, /effort/);
		f.ui.handleInput("d");
		assert.match(f.ui.render(60).join("\n"), /Integration/);
		assert.match(f.ui.render(60).join("\n"), /Wait for shared checks/);
		f.ui.handleInput("d");
		assert.match(text, /2 efforts · scan incomplete/);
		assert.doesNotMatch(text, /7\/256 visits|excluded entries|result-limit/);
		f.ui.handleInput("c");
		const breakdown = f.ui.render(60).join("\n");
		assert.match(breakdown, /Scan details/);
		assert.match(breakdown, /7\/256 visits/);
		assert.match(breakdown, /1 omitted · 1 unreadable · 1 dead · 2 excluded entries/);
		assert.match(breakdown, /result-limit/);
		f.ui.handleInput("c");
		f.ui.render(60);
		assert.equal(f.reads(), 1);
		f.notify();
		await turn();
		assert.equal(f.reads(), 2);
		f.ui.handleInput("\x1b");
		f.notify();
		await turn();
		assert.equal(f.reads(), 2);
	} finally { f.ui.dispose(); }
});
it("the mouse opens Related efforts and message hints without agent-control leakage", async () => {
	const f = setup();
	try {
		await turn();
		const lines = f.ui.render(100);
		const y = lines.findIndex((line) => line.includes("Efforts"));
		assert.ok(y >= 0);
		assert.equal(f.ui.handleMouse(click(lines[y].indexOf("Efforts"), y, 100, 30))?.handled, true);
		await turn(); await turn();
		const pane = f.ui.render(100);
		const messageY = pane.findIndex((line) => line.includes("Message"));
		assert.ok(messageY >= 0);
		f.ui.handleMouse(click(pane[messageY].indexOf("Message"), messageY, 100, 30));
		for (const text of ["/agent abort", "n", "a", "t", "b"]) f.ui.handleInput(text);
		f.ui.handleInput("\r");
		await turn();
		assert.deepEqual(f.messages, [{ id: "effort", text: "/agent abortnatb" }]);
		assert.deepEqual(f.controls, []);
		assert.match(f.ui.render(100).join("\n"), /Operator message admitted/);
	} finally { f.ui.dispose(); }
});
it("unknown and incompatible efforts receive no direct messages", async () => {
	const f = setup();
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		f.ui.handleInput("\x1b[B"); f.ui.handleInput("m"); await turn();
		assert.equal(f.messages.length, 0);
		assert.match(f.ui.render(100).join("\n"), /need a live compatible effort/);
		f.current.efforts[1] = { ...f.current.efforts[1], liveness: "incompatible" };
		f.notify(); await turn(); f.ui.handleInput("m");
		assert.equal(f.messages.length, 0);
	} finally { f.ui.dispose(); }
});
it("message failures retain drafts and changed liveness refuses a pending draft", async () => {
	const f = fixture(100, 30, source(), { efforts: async () => awareness(current), messageEffort: async () => { throw new Error("channel unavailable"); } });
	const current = efforts();
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("m"); f.ui.handleInput("Keep this draft"); f.ui.handleInput("\r"); await turn();
		assert.match(f.ui.render(100).join("\n"), /Draft retained/);
		assert.match(f.ui.render(100).join("\n"), /Keep this draft/);
		current.efforts[0] = { ...current.efforts[0], liveness: "unknown" };
		f.ui.handleInput("\r"); await turn();
		assert.match(f.ui.render(100).join("\n"), /effort is not live/);
	} finally { f.ui.dispose(); }
});
it("closing during an effort read drops late results", async () => {
	const read = deferred<EffortAwareness>();
	const f = fixture(100, 30, source(), { efforts: () => read.promise });
	await turn(); f.ui.openNamedAction("efforts"); f.ui.dispose();
	const count = f.counts().renders;
	read.resolve(awareness()); await turn();
	assert.equal(f.counts().renders, count);
});
it("roster rows carry no creating-session tag, whoever created or owns them", () => {
	const rows = [row("one", { creatingOwnerId: "primary", owner: "unknown" }), row("two", { storageId: "two", creatingOwnerId: "other", owner: "here" }), row("three", { creatingOwnerId: "other" })];
	for (const compact of [false, true]) assert.doesNotMatch(rosterLines(rows, "two", 60, 20, 0, theme, compact, { primaryId: "primary" }).join("\n"), /\[other\]/);
});

function contactPage(): CollaborationPage {
	return { thread: { id: "store/thread", title: "Contact exchange", purpose: "Review the overlap", authority: "Scoped brief", source: "brief", restrictions: "No publication", acceptance: "One agreement", integrator: "primary", creator: "primary", revision: 1, sequence: 0, closed: false, createdAt: 1, updatedAt: 1, members: [] }, events: [], nextBefore: null, pending: 0, coverage: { complete: true, bytes: 100 } };
}
it("keyboard and mouse contact entry read the existing Threads view without list discovery", async () => {
	for (const mouse of [false, true]) {
		const calls: Record<string, unknown>[] = [];
		const f = fixture(100, 30, source(), { efforts: async () => awareness(), collaborate: async (input) => { calls.push(input); return contactPage(); } });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn();
			if (mouse) {
				const lines = f.ui.render(100);
				const y = lines.findIndex((line) => line.includes("Open thread"));
				f.ui.handleMouse(click(lines[y].indexOf("Open thread"), y, 100, 30));
			} else f.ui.handleInput("\r");
			await turn();
			assert.deepEqual(calls.filter((call) => call.action === "read"), [{ action: "read", threadId: "store/thread", limit: 1 }, { action: "read", threadId: "store/thread" }]);
			assert.match(f.ui.render(100).join("\n"), /Contact exchange/);
		} finally { f.ui.dispose(); }
	}
});
it("Back from a contact thread returns to Related efforts with its selection and draft", async () => {
	const f = fixture(100, 30, source(), { efforts: async () => awareness(), collaborate: async () => contactPage(), messageEffort: async () => ({ text: "admitted" }) });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		assert.equal(f.ui.focus.surface, "efforts");
		f.ui.handleInput("m"); f.ui.handleInput("Draft for later"); f.ui.handleInput("\x1b");
		f.ui.handleInput("\r"); await turn();
		assert.equal(f.ui.focus.surface, "threads");
		assert.match(f.ui.render(100).join("\n"), /Contact exchange/);
		f.ui.handleInput("\x1b"); await turn();
		assert.equal(f.ui.focus.surface, "efforts", "the thread was opened from Related efforts, not the list");
		assert.match(f.ui.render(100).join("\n"), / Efforts|efforts ·/);
		f.ui.handleInput("m");
		assert.match(f.ui.render(100).join("\n"), /Draft for later/);
		f.ui.handleInput("\x1b");
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.focus.surface, "work");
	} finally { f.ui.dispose(); }
});
it("the command adapter binds effort reads and operator messages to the unchanged primary context", async () => {
	let dashboard: AgentDashboard | undefined;
	let finish = () => {};
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "primary" }, modelRegistry: { find: () => undefined }, ui: { notify() {}, custom: async (factory: (tui: TUI, paint: typeof theme, appKeys: typeof keys, done: () => void) => AgentDashboard) => new Promise<void>((resolve) => { finish = resolve; dashboard = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} } as unknown as TUI, theme, keys, resolve); }) } } as unknown as ExtensionContext;
	const calls: unknown[] = [];
	const wiring = { timers: async () => [], schedule: async () => ({ text: "scheduled" }), control: async () => ({}), newAgent: async () => ({ text: "created" }), newDefaults: () => ({ cwd: "/work", presets: [], ownership: "" }) };
	const command = createAgentCommand([], source([row("one", { storageId: "one", creatingOwnerId: "other" })]), wiring, undefined, undefined, {
		efforts: async (primary) => { calls.push(primary); return awareness(); },
		messageEffort: async (id, text, primary) => { calls.push({ id, text, primary }); return { text: "Operator message admitted" }; },
		observeEffort: async (id, primary) => { calls.push({ observe: id, primary }); return "Recorded activity from source"; },
	});
	const opened = command.openDashboard(ctx);
	try {
		await turn(); assert.ok(dashboard);
		assert.doesNotMatch(dashboard.render(100).join("\n"), /\[other\]/);
		const findRow = stripVTControlCharacters((dashboard.render(100)[1] ?? "").replace(/\x1b_[^\x07]*\x07/g, ""));
		assert.match(findRow, / Related {2}All /, "Related and All are visible choices on the list's Find row");
		assert.equal(dashboard.handleMouse(click(findRow.indexOf(" All ") + 1, 1, 100, 30))?.handled, true); await turn();
		assert.match(dashboard.render(100).join("\n"), /one/);
		assert.doesNotMatch(dashboard.render(100).join("\n"), /\[other\]/);
		dashboard.openNamedAction("efforts"); await turn(); dashboard.handleInput("o"); await turn();
		assert.match(dashboard.render(100).join("\n"), /Recorded activity from source/);
		dashboard.handleInput("m"); dashboard.handleInput("Coordinate this"); dashboard.handleInput("\r"); await turn();
		assert.deepEqual(calls, [ctx, { observe: "effort", primary: ctx }, { id: "effort", text: "Coordinate this", primary: ctx }]);
		assert.equal(ctx.sessionManager.getSessionId(), "primary");
	} finally { dashboard?.dispose(); finish(); await opened; }
});

it("roster reconciliation does not read effort presence", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = setup();
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		const reads = f.reads();
		t.mock.timers.tick(6000); await turn();
		assert.equal(f.reads(), reads);
	} finally { f.ui.dispose(); t.mock.timers.reset(); }
});
it("observed purpose stays visible without an intent claim", async () => {
	const current = efforts();
	current.efforts[0] = { ...current.efforts[0], intentClaim: undefined, observedPurpose: { source: "interactive-input", text: "Compare this change" } };
	const f = fixture(60, 20, source(), { efforts: async () => awareness(current) });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		const text = f.ui.render(60).join("\n");
		assert.match(text, /Purpose/);
		assert.match(text, /Compare this change/);
		assert.match(text, /Identity/);
	} finally { f.ui.dispose(); }
});
it("a late message receipt preserves edits and does not retarget an omitted effort", async () => {
	const admitted = deferred<{ text: string }>();
	const current = efforts();
	let notify = () => {};
	const observed = source();
	observed.subscribeRoster = (listener) => { notify = listener; return () => {}; };
	const f = fixture(60, 20, observed, { efforts: async () => awareness(current), messageEffort: async () => admitted.promise });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("m"); f.ui.handleInput("Retain this"); f.ui.handleInput("\r");
		f.ui.handleInput("\x03"); f.ui.handleInput("Retain this");
		current.efforts.shift(); notify(); await turn();
		const lines = f.ui.render(60);
		assert.equal(lines.length, 20);
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
		assert.match(lines.join("\n"), /Operator message to effort/);
		admitted.resolve({ text: "Operator message admitted" }); await turn();
		assert.match(f.ui.render(60).join("\n"), /Retain this/);
	} finally { f.ui.dispose(); }
});

it("all-local machine efforts show purpose and contact without full intent leakage", async () => {
	const current = efforts();
	const claim = current.efforts[0].intentClaim;
	assert.ok(claim);
	current.efforts[0] = { ...current.efforts[0], cwd: "/unrelated", repository: "/unrelated/.git", relationship: "machine", sharedSubstrates: ["machine-gates"], purposeClaim: "Review another project", contactThreadClaim: "store/thread", intentUpdatedAt: "2026-10-04T01:00:00.000Z", intentClaim: { ...claim, integration: "PRIVATE_INTEGRATION", authority: "PRIVATE_AUTHORITY", scope: { paths: ["PRIVATE_SCOPE"], branches: [] } } };
	const calls: Record<string, unknown>[] = [];
	const f = fixture(80, 30, source(), { efforts: async () => awareness(current), collaborate: async (input) => { calls.push(input); return contactPage(); } });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		const text = f.ui.render(80).join("\n");
		assert.match(text, /Purpose/);
		assert.match(text, /Review another project/);
		assert.doesNotMatch(text, /PRIVATE_|Operator direction|Scope|Shared substrates|Directory|Integration/);
		f.ui.handleInput("d");
		const details = f.ui.render(80).join("\n");
		assert.match(details, /Shared substrates/);
		assert.match(details, /machine-gates/);
		assert.doesNotMatch(details, /PRIVATE_/);
		f.ui.handleInput("\r"); await turn();
		assert.deepEqual(calls.filter((call) => call.action === "read"), [{ action: "read", threadId: "store/thread", limit: 1 }, { action: "read", threadId: "store/thread" }]);
	} finally { f.ui.dispose(); }
});
it("inline active threads show covered recency and open through keyboard or mouse", async () => {
	for (const mouse of [false, true]) {
		const current = awareness();
		current.threads.items = [
			{ id: "store/older", title: "Older active", purpose: "Review old overlap", updatedAt: 1, closed: false, members: 2 },
			{ id: "store/newest", title: "Newest active", purpose: "Review current overlap", updatedAt: 2, closed: false, members: 2 },
		];
		current.threads.coverage = { ...current.threads.coverage, missingHints: 1, omittedHints: 2, omittedResults: 3, unvisited: true, complete: false, reasons: ["visit-limit"] };
		const calls: Record<string, unknown>[] = [];
		const f = fixture(100, 30, source(), { efforts: async () => current, collaborate: async (input) => { calls.push(input); const page = contactPage(); return { ...page, thread: { ...page.thread, id: String(input.threadId) } }; } });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn();
			const lines = f.ui.render(100);
			const text = lines.join("\n");
			assert.ok(text.indexOf("Newest active") < text.indexOf("Older active"));
			assert.match(text, /scan incomplete/);
			assert.doesNotMatch(text, /visits|omitted hints|visit-limit/);
			f.ui.handleInput("c");
			const breakdown = f.ui.render(100).join("\n");
			assert.match(breakdown, /Threads: 3\/256 visits · 2\/12 rows · incomplete/);
			assert.match(breakdown, /2 omitted hints · 3 omitted rows/);
			assert.match(breakdown, /1 missing hints · unvisited records: yes/);
			assert.match(breakdown, /visit-limit/);
			f.ui.handleInput("c"); f.ui.render(100);
			if (mouse) {
				const y = lines.findIndex((line) => line.includes("Newest active"));
				f.ui.handleMouse(click(lines[y].indexOf("Newest active"), y, 100, 30));
			} else { f.ui.handleInput("\x1b[B"); f.ui.handleInput("\x1b[B"); f.ui.handleInput("\r"); }
			await turn();
			assert.deepEqual(calls.filter((call) => call.action === "read"), [{ action: "read", threadId: "store/thread", limit: 1 }, { action: "read", threadId: "store/newest" }]);
		} finally { f.ui.dispose(); }
	}
});

it("multiline effort drafts keep the send receipt and escape hint inside the narrow viewport", async () => {
	const current = awareness();
	current.threads.coverage = { ...current.threads.coverage, complete: false, reasons: ["visit-limit"], unvisited: true };
	const f = fixture(60, 20, source(), { efforts: async () => current, messageEffort: async () => ({ text: "admitted" }) });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		f.ui.handleInput("m");
		for (let index = 0; index < 20; index++) { f.ui.handleInput("Draft line"); f.ui.handleInput("\x1b[106;5u"); }
		const lines = f.ui.render(60);
		assert.equal(lines.length, 20);
		assert.match(lines.join("\n"), /Operator message to effort/);
		assert.match(lines.join("\n"), /Draft line/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	} finally { f.ui.dispose(); }
});

it("malformed recorded dates render unknown without a viewport failure", async () => {
	for (const machine of [false, true]) {
		const current = awareness();
		const claim = current.presence.efforts[0].intentClaim;
		assert.ok(claim);
		current.presence.efforts[0] = { ...current.presence.efforts[0], startedAt: "invalid-start", lastActivityAt: "invalid-activity", intentClaim: { ...claim, updatedAt: "invalid-claim" }, ...(machine ? { relationship: "machine", purposeClaim: "Other local work", intentUpdatedAt: "invalid-intent" } : {}) };
		current.threads.items = [{ id: "store/thread", title: "Invalid dated hint", purpose: "Read a current frame", updatedAt: Number.MAX_VALUE, closed: false, members: 1 }];
		const f = fixture(80, 40, source(), { efforts: async () => current });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn();
			const lines = f.ui.render(80);
			assert.equal(lines.length, 40);
			const text = lines.join("\n");
			assert.match(text, /updated unknown \(invalid time\)/);
			assert.doesNotMatch(text, /updated:/i);
			assert.match(text, /Invalid dated hint\s+unknown \(invalid time\)/);
			f.ui.handleInput("d");
			for (let i = 0; i < 4; i++) f.ui.handleInput("\x1b[6~");
			const details = f.ui.render(80).join("\n");
			assert.match(details, /Started/);
			assert.match(details, /Last recorded activity/);
			assert.match(details, /unknown \(invalid time\)/);
			f.ui.handleInput("d");
			f.ui.handleInput("\x1b[B"); f.ui.handleInput("\x1b[B");
			const threadText = f.ui.render(80).join("\n");
			assert.match(threadText, /unknown \(invalid time\)/);
			assert.doesNotMatch(threadText, /[Uu]pdate/);
		} finally { f.ui.dispose(); }
	}
});

it("wide effort panes separate discovery from claim-first details and quiet coverage", async () => {
	const colored = Object.create(theme) as typeof theme;
	colored.fg = (color, text) => `\x1b[${color === "muted" ? 90 : 37}m${text}\x1b[39m`;
	colored.bold = (text) => `\x1b[1m${text}\x1b[22m`;
	for (const [width, height] of [[164, 44], [100, 32]]) {
		const f = fixture(width, height, source(), { efforts: async () => awareness() }, undefined, colored);
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn();
			const lines = f.ui.render(width);
			const text = lines.map(stripVTControlCharacters).join("\n");
			assert.equal(lines.length, height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(text, /Efforts/);
			assert.match(text, /Session uncertain/);
			assert.ok(lines.some((line) => /\x1b\[90m\s+Purpose/.test(line)));
			assert.match(text, /Review the overlap/);
			assert.match(text, /wait for shared checks/i);
			assert.match(text, /2 efforts/);
			const pane = lines.map((line) => stripVTControlCharacters(line.split("│")[1] ?? ""));
			const purposeKey = pane.findIndex((line) => line.trim() === "Purpose");
			assert.ok(purposeKey >= 0, "the default detail has a Purpose key");
			assert.equal(pane[purposeKey + 2]?.trim(), "", "one blank row after a group");
			assert.ok(visibleWidth(pane[purposeKey + 1]?.trim() ?? "") <= 100, "values use the shared reading width");
			const selected = stripVTControlCharacters(lines.find((line) => line.includes("▌ ")) ?? "");
			const divider = selected.indexOf("│");
			assert.ok(divider >= 30 && divider <= 40, "the divider sits at the 30 to 40 column list width, as in the Agents tab");
			f.ui.handleInput("d");
			const full = f.ui.render(width).join("\n");
			assert.match(full, /Operator direction/);
			assert.match(full, /Scope/);
		} finally { f.ui.dispose(); }
	}
});
it("wide discovery clicks select efforts and open inline threads through existing routes", async () => {
	for (const width of [100, 164]) {
		const current = awareness();
		current.threads.items = [{ id: "store/thread", title: "Inline contact", purpose: "Read its current frame", updatedAt: Date.now(), closed: false, members: 2 }];
		const calls: Record<string, unknown>[] = [];
		const f = fixture(width, 44, source(), { efforts: async () => current, collaborate: async (input) => { calls.push(input); return contactPage(); } });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn();
			let lines = f.ui.render(width);
			const uncertainY = lines.findIndex((line) => line.includes("Session uncertain"));
			assert.ok(uncertainY >= 0);
			assert.equal(f.ui.handleMouse(click(2, uncertainY, width, 44))?.handled, true);
			f.ui.handleInput("m");
			assert.match(f.ui.render(width).join("\n"), /need a live compatible effort/);
			lines = f.ui.render(width);
			const threadY = lines.findIndex((line) => line.includes("Inline contact"));
			assert.equal(f.ui.handleMouse(click(2, threadY, width, 44))?.handled, true);
			await turn();
			assert.deepEqual(calls.filter((call) => call.action === "read"), [{ action: "read", threadId: "store/thread", limit: 1 }, { action: "read", threadId: "store/thread" }]);
		} finally { f.ui.dispose(); }
	}
});
it("effort ages stay fixed between observations and keyboard or mouse reveals only local dates", async (t) => {
	let now = Date.parse("2026-10-04T12:00:00.000Z");
	t.mock.method(Date, "now", () => now);
	const current = awareness();
	const at = new Date(now - 15 * 60000).toISOString();
	const claim = current.presence.efforts[0].intentClaim;
	assert.ok(claim);
	current.presence.efforts[0] = { ...current.presence.efforts[0], startedAt: at, lastActivityAt: at, intentClaim: { ...claim, updatedAt: at } };
	let reads = 0;
	const f = fixture(100, 44, source(), { efforts: async () => { reads++; return current; } });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		const before = f.ui.render(100);
		assert.match(before.join("\n"), /updated 15m ago/);
		assert.ok(before.some((line) => line.split("│")[1]?.trim() === "live · same repository · updated 15m ago"));
		assert.doesNotMatch(before.join("\n"), /updated:/i);
		now += 60 * 60000;
		assert.deepEqual(f.ui.render(100), before);
		f.ui.handleInput("i");
		const exact = f.ui.render(100);
		assert.ok(exact.some((line) => line.includes(`updated ${dashboardTime(Date.parse(at), true)}`)));
		assert.doesNotMatch(exact.join("\n"), /2026-10-04T/);
		const y = exact.findIndex((line) => line.includes(`updated ${dashboardTime(Date.parse(at), true)}`));
		assert.ok(y >= 0);
		assert.equal(f.ui.handleMouse(click(34, y, 100, 44))?.handled, true);
		assert.match(f.ui.render(100).join("\n"), /updated 15m ago/);
		assert.equal(reads, 1);
	} finally { f.ui.dispose(); }
});
it("thread detail timestamps use the same label-free mouse toggle as claims", async (t) => {
	const now = Date.parse("2026-10-04T12:00:00.000Z");
	t.mock.method(Date, "now", () => now);
	const at = now - 15 * 60000;
	const current = awareness();
	current.threads.items = [{ id: "store/thread", title: "Shared work", purpose: "Agree the order", updatedAt: at, closed: false, members: 2 }];
	const f = fixture(100, 44, source(), { efforts: async () => current });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		f.ui.handleInput("\x1b[B"); f.ui.handleInput("\x1b[B");
		const before = f.ui.render(100);
		assert.match(before.join("\n"), /Active thread: Shared work/);
		assert.doesNotMatch(before.join("\n"), /[Uu]pdate/);
		const y = before.findIndex((line) => line.split("│")[1]?.trim() === "15m ago");
		assert.ok(y >= 0);
		assert.equal(f.ui.handleMouse(click(34, y, 100, 44))?.handled, true);
		assert.ok(f.ui.render(100).some((line) => line.split("│")[1]?.trim() === dashboardTime(at, true)));
	} finally { f.ui.dispose(); }
});

for (const [width, height] of [[60, 30], [100, 32], [164, 44]]) for (const complete of [false, true]) it(`scan coverage is on demand at ${width} columns with ${complete ? "complete" : "partial"} sources`, async () => {
		const initial = awareness();
		const current = { ...initial,
			presence: { ...initial.presence,
				efforts: [{ ...initial.presence.efforts[0], id: "peer-primary" }, initial.presence.efforts[1]],
				coverage: { ...initial.presence.coverage, complete, unreadable: complete ? 0 : 1, omitted: complete ? 0 : 1, reasons: complete ? [] : ["result-limit"] },
			},
			threads: { ...initial.threads, coverage: { ...initial.threads.coverage, complete, unvisited: !complete, missingHints: complete ? 0 : 1, reasons: complete ? [] : ["visit-limit"] } },
		};
		const f = fixture(width, height, source(), { efforts: async () => current });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn();
			const lines = f.ui.render(width);
			const text = lines.join("\n");
			assert.equal(text.match(/scan incomplete/g)?.length ?? 0, complete ? 0 : 1);
			assert.doesNotMatch(text, /visits|excluded entries|omitted hints|reasons:|Stated by this effort/);
			assert.doesNotMatch(text, /Purpose claim:|Integration intent claim:|Scope claim:|Contact thread claim:|authority claim:/);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (complete) f.ui.handleInput("c");
			else {
				const y = lines.findIndex((line) => line.includes("scan incomplete"));
				assert.equal(f.ui.handleMouse(click(lines[y].indexOf("scan incomplete"), y, width, height))?.handled, true);
			}
			const expanded = f.ui.render(width).join("\n");
			assert.match(expanded, /Scan details/);
			assert.match(expanded, /7\/256 visits/);
			assert.match(expanded, /unvisited records: (yes|no)/);
			f.ui.handleInput("\x1b");
			assert.equal(f.ui.render(width).join("\n"), text);
			f.ui.handleInput("c"); f.ui.render(width); f.ui.handleInput("c");
			assert.equal(f.ui.render(width).join("\n"), text);
		} finally { f.ui.dispose(); }
});

it("wide effort discovery keeps the selected loaded row visible on bounded pages", async () => {
	const initial = awareness();
	const current = { ...initial, presence: { ...initial.presence, efforts: Array.from({ length: 20 }, (_, index) => ({ ...initial.presence.efforts[0], id: `effort-${index}`, name: `Loaded effort ${index}` })) } };
	const f = fixture(100, 32, source(), { efforts: async () => current });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		for (let index = 0; index < 19; index++) f.ui.handleInput("\x1b[B");
		const lines = f.ui.render(100);
		assert.match(lines.join("\n"), /20 efforts/);
		assert.match(lines.join("\n"), /Identity/);
		assert.match(lines.join("\n"), /effort-19/);
		assert.equal(lines.length, 32);
	} finally { f.ui.dispose(); }
});

it("explicit effort observation fires no message or agent control and keeps selection responsive", async () => {
	const read = deferred<string>();
	const reads: string[] = [];
	const messages: string[] = [];
	const controls: string[] = [];
	const f = fixture(100, 32, source(), {
		efforts: async () => awareness(),
		observeEffort: async (id) => { reads.push(id); return read.promise; },
		messageEffort: async () => { messages.push("message"); return { text: "wrong" }; },
		submit: async () => { controls.push("submit"); return { text: "wrong" }; },
		newAgent: async () => { controls.push("new"); return { text: "wrong" }; },
	});
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		assert.deepEqual(reads, []);
		const lines = f.ui.render(100);
		const y = lines.findIndex((line) => line.includes("Observe"));
		assert.ok(y >= 0);
		f.ui.handleMouse(click(lines[y].indexOf("Observe"), y, 100, 32));
		f.ui.handleInput("o");
		assert.deepEqual(reads, ["effort"]);
		assert.match(f.ui.render(100).join("\n"), /Read-only observation/);
		f.ui.handleInput("\x1b[B");
		assert.match(f.ui.render(100).join("\n"), /unknown ·/);
		read.resolve("LATE_FIRST_EFFORT"); await turn();
		assert.doesNotMatch(f.ui.render(100).join("\n"), /LATE_FIRST_EFFORT/);
		assert.deepEqual(messages, []); assert.deepEqual(controls, []);
	} finally { read.resolve("done"); f.ui.dispose(); }
});
it("late observations are rejected after away-and-back selection, pane exit and disposal", async t => {
	// Unrelated dashboard repaint timers must not count as an observation response.
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	for (const exit of ["selection", "pane", "dispose"]) {
		const read = deferred<string>();
		const f = fixture(100, 32, source(), { efforts: async () => awareness(), observeEffort: () => read.promise });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("o");
			if (exit === "selection") { f.ui.handleInput("\x1b[B"); f.ui.handleInput("\x1b[A"); }
			else if (exit === "pane") f.ui.handleInput("\x1b");
			else f.ui.dispose();
			t.mock.timers.tick(0);
			const count = f.counts().renders;
			read.resolve("REJECTED_OLD_OBSERVATION"); await turn();
			assert.equal(f.counts().renders, count, exit);
			if (exit !== "dispose") assert.doesNotMatch(f.ui.render(100).join("\n"), /REJECTED_OLD_OBSERVATION/);
		} finally { read.resolve("done"); f.ui.dispose(); }
	}
});
it("observation text has a Unicode-safe display bound, explicit omissions and no terminal controls", async () => {
	for (const width of [60, 100]) {
		const f = fixture(width, 32, source(), { efforts: async () => awareness(), observeEffort: async () => `Safe\x1b[2J\n${"x".repeat(15990)}😀TAIL_NOT_SHOWN` });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("o"); await turn();
			const lines = f.ui.render(width);
			assert.equal(lines.length, 32); assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(lines.join("\n"), /Safe/); assert.doesNotMatch(lines.join("\n"), /\x1b\[2J/);
			for (let i = 0; i < 80; i++) f.ui.handleInput("\x1b[6~");
			assert.match(f.ui.render(width).join("\n"), /Observation omitted by display bound/);
			assert.doesNotMatch(f.ui.render(width).join("\n"), /TAIL_NOT_SHOWN/);
		} finally { f.ui.dispose(); }
	}
});
it("observation absence, empty output and failure stay explicit without delivery", async () => {
	for (const observeEffort of [undefined, async () => "", async () => { throw Error("reader offline"); }]) {
		const f = fixture(100, 32, source(), { efforts: async () => awareness(), observeEffort });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("o"); await turn();
			assert.match(f.ui.render(100).join("\n"), /no reader|coverage unknown|reader offline/);
		} finally { f.ui.dispose(); }
	}
});
it("contact declarations retain separate release and hold, source frame and ordinary event navigation", async () => {
	let current = contactPage();
	current.thread.members = [
		{ identity: "release-peer", contribution: "Policy gate released. Source: event 2", joinedAt: 1 },
		{ identity: "hold-peer", contribution: "Hold my gate for dependency release. Source: event 3", joinedAt: 1 },
	];
	const calls: Record<string, unknown>[] = [];
	let notify = () => {};
	const observed = source(); observed.subscribeRoster = (fn) => { notify = fn; return () => {}; };
	const f = fixture(100, 60, observed, { efforts: async () => awareness(), collaborate: async (input) => { calls.push(input); return structuredClone(current); } });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("d");
		const text = f.ui.render(100).join("\n").replace(/\s+/g, " ");
		assert.match(text, /Authority source/);
		assert.match(text, /Member declarations/);
		assert.match(text, /Policy gate released/); assert.match(text, /Hold my gate/);
		assert.match(text, /Enter opens frame, sources and events/);
		assert.doesNotMatch(text, /machine free|joinedAt|declaration updated|revision time/i);
		assert.deepEqual(calls, [{ action: "read", threadId: "store/thread", limit: 1 }]);
		current = { ...current, thread: { ...current.thread, members: [{ ...current.thread.members[0], contribution: "Release replaced with a renewed hold" }, current.thread.members[1]] } };
		notify(); await turn();
		const pane = f.ui.render(100).map((line) => line.split("│")[1] ?? "").join(" ").replace(/\s+/g, " ");
		assert.match(pane, /renewed hold/);
		assert.doesNotMatch(f.ui.render(100).join("\n"), /Policy gate released/);
		f.ui.handleInput("\r"); await turn();
		assert.equal(calls.at(-1)?.limit, undefined);
		assert.match(f.ui.render(100).join("\n"), /Contact exchange/);
	} finally { f.ui.dispose(); }
});
it("late contact pages cannot attach declarations to another selected effort", async () => {
	const read = deferred<CollaborationPage>();
	const f = fixture(100, 60, source(), { efforts: async () => awareness(), collaborate: () => read.promise });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("\x1b[B");
		const page = contactPage(); page.thread.members = [{ identity: "one", contribution: "OLD_CONTACT_DECLARATION", joinedAt: 1 }];
		read.resolve(page); await turn();
		assert.doesNotMatch(f.ui.render(100).join("\n"), /OLD_CONTACT_DECLARATION/);
		assert.doesNotMatch(f.ui.render(100).join("\n"), /Contact exchange/);
	} finally { read.resolve(contactPage()); f.ui.dispose(); }
});
it("contact failures and display omissions do not imply agreement or an empty machine", async () => {
	for (const invalid of [true, false]) {
		const page = contactPage();
		page.thread.members = Array.from({ length: 17 }, (_, i) => ({ identity: `peer-${i}`, contribution: `Hold gate ${i}`, joinedAt: 1 }));
		const f = fixture(100, 70, source(), { efforts: async () => awareness(), collaborate: async () => invalid ? { bad: true } : page });
		try {
			await turn(); f.ui.openNamedAction("efforts"); await turn();
			await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("d");
			const text = f.ui.render(100).join("\n");
			const detail = f.ui.render(100).map((line) => line.split("│")[1]?.trim() ?? "").join(" ");
			assert.match(detail, invalid ? /invalid contact thread\s+page/ : /1 member declarations omitted/);
			assert.doesNotMatch(text, /machine free|no holds|agreement reached/i);
		} finally { f.ui.dispose(); }
	}
});

it("contact reads stop at pane disposal and narrow contact text stays in the viewport", async () => {
	const pending = deferred<CollaborationPage>();
	const closed = fixture(60, 30, source(), { efforts: async () => awareness(), collaborate: () => pending.promise });
	await turn(); closed.ui.openNamedAction("efforts"); await turn(); closed.ui.dispose();
	const count = closed.counts().renders;
	pending.resolve(contactPage()); await turn();
	assert.equal(closed.counts().renders, count);
	const page = contactPage();
	page.thread.members = [{ identity: "peer", contribution: "Hold dependency checks. Source: #3", joinedAt: 1 }];
	const f = fixture(60, 24, source(), { efforts: async () => awareness(), collaborate: async () => page });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn(); f.ui.handleInput("d");
		let shown = "";
		for (let i = 0; i < 12; i++) {
			const lines = f.ui.render(60);
			assert.equal(lines.length, 24); assert.ok(lines.every((line) => visibleWidth(line) <= 60));
			shown += lines.join("\n"); f.ui.handleInput("\x1b[6~");
		}
		assert.match(shown, /Member declarations/);
		assert.match(shown, /Hold dependency checks/);
		assert.match(shown, /Authority source/);
	} finally { f.ui.dispose(); }
});

it("roster notices coalesce contact reads into one active read and one latest refresh", async () => {
	const pending = deferred<CollaborationPage>();
	let reads = 0;
	let notify = () => {};
	const observed = source(); observed.subscribeRoster = (fn) => { notify = fn; return () => {}; };
	const latest = contactPage(); latest.thread.members = [{ identity: "peer", contribution: "LATEST_DECLARATION", joinedAt: 1 }];
	const f = fixture(100, 60, observed, { efforts: async () => awareness(), collaborate: () => { reads++; return reads === 1 ? pending.promise : Promise.resolve(latest); } });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		for (let i = 0; i < 3; i++) { notify(); await turn(); }
		assert.equal(reads, 1);
		pending.resolve(contactPage()); await turn();
		assert.equal(reads, 2);
		f.ui.handleInput("d");
		assert.match(f.ui.render(100).join("\n"), /LATEST_DECLARATION/);
		await turn(); assert.equal(reads, 2);
	} finally { pending.resolve(contactPage()); f.ui.dispose(); }
});

function crowd(count: number): EffortPresencePage {
	return { ...efforts(), efforts: Array.from({ length: count }, (_, index) => ({
		id: `effort-${index}`, cwd: "/work", name: `Effort ${index}`, startedAt: "2026-10-04T00:00:00.000Z",
		liveness: index === 0 ? "live" as const : "unknown" as const, relationship: "repository" as const,
		...(index === 0 ? { intentClaim: { purpose: "First", integration: "None", authority: "Brief", scope: { paths: [], branches: [], fullGate: false }, updatedAt: "2026-10-04T01:00:00.000Z" } } : {}),
	})) };
}
function wheel(x: number, y: number, width: number, height: number, wheelDelta: number): TuiMouseEvent {
	return { ...click(x, y, width, height), type: "wheel", wheelDelta };
}

for (const width of [60, 100]) {
	it(`wheel over the effort list scrolls only that list and never changes the selection or recipient at ${width}`, async () => {
		const messages: string[] = [];
		const f = fixture(width, 30, source(), {
			efforts: async () => awareness(crowd(12)),
			messageEffort: async (id) => { messages.push(id); return { text: "Operator message admitted" }; },
		});
		try {
			await turn();
			f.ui.openNamedAction("efforts");
			await turn();
			const draw = () => stripVTControlCharacters(f.ui.render(width).join("\n"));
			assert.match(draw(), /First/);
			f.ui.handleInput("m");
			f.ui.handleInput("hello");
			const lines = f.ui.render(width).map(stripVTControlCharacters);
			const y = lines.findIndex((line) => line.includes("▌"));
			assert.ok(y >= 0);
			f.ui.handleMouse(wheel(2, y, width, 30, 12));
			const scrolled = draw();
			assert.doesNotMatch(scrolled, /▌ .*First/);
			assert.match(scrolled, /Message target|Operator message to effort-0/);
			f.ui.handleInput("\r");
			await turn();
			assert.deepEqual(messages, ["effort-0"], "the recipient captured when the message started is unchanged by scrolling");
		} finally { f.ui.dispose(); }
	});
}

it("an effort row click after the list scrolled selects the row under the pointer", async () => {
	const f = fixture(100, 30, source(), { efforts: async () => awareness(crowd(12)) });
	try {
		await turn();
		f.ui.openNamedAction("efforts");
		await turn();
		const before = f.ui.render(100).map(stripVTControlCharacters);
		const y = before.findIndex((line) => line.includes("Session effort-0"));
		f.ui.handleMouse(wheel(2, y, 100, 30, 4));
		const after = f.ui.render(100).map(stripVTControlCharacters);
		const row = after.findIndex((line) => /Session effort-[1-9]/.test(line));
		assert.ok(row >= 0);
		const label = /Session effort-\d+/.exec(after[row] ?? "")?.[0];
		f.ui.handleMouse(click(2, row, 100, 30));
		assert.match(f.ui.render(100).map(stripVTControlCharacters).join("\n"), new RegExp(`▌ .*${label}`));
	} finally { f.ui.dispose(); }
});

it("effort rows keep two lines and a gap and omit placeholder purposes", async () => {
	const current = awareness();
	current.threads.items = [{ id: "store/thread", title: "Shared work", purpose: "Agree the order", updatedAt: Date.parse("2026-10-04T01:00:00.000Z"), closed: false, members: 2 }];
	const f = fixture(100, 30, source(), { efforts: async () => current });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		const lines = f.ui.render(100).map((line) => stripVTControlCharacters(line));
		const left = lines.map((line) => line.split("│")[0] ?? line);
		const at = left.findIndex((line) => line.includes("Review the overlap"));
		assert.equal((left[at] ?? "").indexOf("Review the overlap"), 4, "title text starts after the rail and glyph");
		assert.equal((left[at + 1] ?? "").indexOf("live · "), 4, "the facts line aligns with the title");
		assert.match(left[at + 1] ?? "", /live · /, "two content lines");
		assert.equal((left[at + 2] ?? "").trim(), "", "one blank row between items");
		const thread = left.findIndex((line) => line.includes("Shared work"));
		assert.ok(thread >= 0, "the active threads strip is rendered");
		assert.equal((left[thread] ?? "").indexOf("Shared work"), 4, "thread title text starts after the rail and glyph");
		assert.equal((left[thread + 1] ?? "").indexOf("Agree the order"), 4, "the thread purpose line aligns with its title");
		assert.equal((left[thread + 2] ?? "").trim(), "", "one blank row between thread items");
		f.ui.handleInput("\x1b[B");
		const screen = stripVTControlCharacters(f.ui.render(100).join("\n"));
		assert.match(screen, /Session uncertain|Session 01a1a92e/, "a title without a purpose uses a short identity");
		assert.doesNotMatch(screen, /No purpose claim/, "no placeholder purpose");
		assert.doesNotMatch(screen, /Your effort:/, "no self-purpose row");
		assert.doesNotMatch(screen, /More \(x\)|Back \(Esc\)/, "no persistent action bar");
	} finally { f.ui.dispose(); }
});

it("long effort titles clip in the row and use the header room", async () => {
	const current = awareness();
	const claim = current.presence.efforts[0].intentClaim;
	assert.ok(claim);
	const long = "Make the Agents tab, conversation body, Threads and Efforts calm and scannable after the operator feedback. Second sentence stays out.";
	current.presence.efforts[0] = { ...current.presence.efforts[0], intentClaim: { ...claim, purpose: long } };
	const f = fixture(200, 56, source(), { efforts: async () => current });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		const lines = f.ui.render(200).map((line) => stripVTControlCharacters(line));
		const left = lines.map((line) => line.split("│")[0] ?? line);
		const row = left.find((line) => line.includes("Make the Agents tab")) ?? "";
		assert.match(row, /…/);
		assert.doesNotMatch(row, /\.\.\./);
		const header = lines.find((line) => line.includes("Open thread")) ?? "";
		const titlePart = header.split("Open thread")[0] ?? "";
		assert.ok(titlePart.trim().length > 40, "the header uses the room beside the actions");
		assert.match(titlePart, /…/);
		assert.doesNotMatch(titlePart, /\.\.\./);
		assert.doesNotMatch(header, /Second sentence/);
	} finally { f.ui.dispose(); }
});

it("the exact-time toggle repaints effort and thread rows", async (t) => {
	const now = Date.parse("2026-10-04T12:00:00.000Z");
	t.mock.method(Date, "now", () => now);
	const current = awareness();
	const at = new Date(now - 15 * 60000).toISOString();
	const claim = current.presence.efforts[0].intentClaim;
	assert.ok(claim);
	current.presence.efforts[0] = { ...current.presence.efforts[0], intentClaim: { ...claim, updatedAt: at } };
	current.threads.items = [{ id: "store/thread", title: "Shared work", purpose: "Agree the order", updatedAt: Date.parse(at), closed: false, members: 2 }];
	const f = fixture(100, 44, source(), { efforts: async () => current });
	try {
		await turn(); f.ui.openNamedAction("efforts"); await turn();
		assert.match(f.ui.render(100).join("\n"), /15m ago/);
		f.ui.handleInput("i");
		const exact = f.ui.render(100).join("\n");
		assert.ok(exact.split(dashboardTime(Date.parse(at), true)).length - 1 >= 2, "effort and thread rows both switch to exact time");
		assert.doesNotMatch(exact, /15m ago/);
		f.ui.handleInput("i");
		assert.match(f.ui.render(100).join("\n"), /15m ago/);
	} finally { f.ui.dispose(); }
});

it("the menu lists every Related efforts action and a disabled message names its reason", async () => {
	const f = setup(60, 20);
	try {
		await turn();
		f.ui.openNamedAction("efforts");
		await turn();
		assert.match(f.ui.render(60).join("\n"), /More…/);
		f.ui.handleInput("x");
		const menu = f.ui.render(60).map(stripVTControlCharacters).join("\n");
		for (const label of ["Open thread", "Message", "Observe", "Details", "Threads", "Scan details", "Exact times"]) assert.match(menu, new RegExp(label), label);
		f.ui.handleInput("\x1b");
		f.ui.handleInput("\x1b[B");
		f.ui.handleInput("m");
		assert.match(f.ui.render(60).join("\n"), /Direct messages need a live compatible effort/);
	} finally { f.ui.dispose(); }
});
