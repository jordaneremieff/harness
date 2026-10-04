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
		action: async () => { controls.push("action"); return { text: "wrong" }; },
		newAgent: async () => { controls.push("new"); return { text: "wrong" }; },
	});
	return { ...f, messages, controls, current, reads: () => reads, notify: () => notify() };
}
it("effort entry is event-driven and renders claims and finite coverage at narrow width", async () => {
	const f = setup(60, 30);
	try {
		await turn();
		assert.equal(f.reads(), 0);
		f.ui.handleInput("b");
		await turn();
		assert.equal(f.reads(), 1);
		const lines = f.ui.render(60);
		assert.equal(lines.length, 30);
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
		const text = lines.join("\n");
		assert.match(text, /Stated by this effort/);
		assert.match(text, /Purpose: Review the overlap/);
		assert.match(text, /Observed purpose \(session-name\): Observed work/);
		assert.match(text, /Integration: Wait for shared checks/);
		assert.match(text, /Operator direction \(quoted\): "Operator brief"/);
		assert.match(text, /Scope:/);
		assert.match(text, /full machine gates:\s+declared/);
		const authorityLine = lines.findIndex((line) => line.includes("Operator direction (quoted)"));
		assert.match(lines[authorityLine + 1], /Scope:/);
		assert.match(text, /Shared substrates: repository, machine-gates/);
		assert.match(text, /unknown/);
		assert.match(text, /Scan incomplete: 1 unreadable record/);
		assert.doesNotMatch(text, /7\/256 visits|excluded entries|result-limit/);
		f.ui.handleInput("c");
		const breakdown = f.ui.render(60).join("\n");
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
		const y = lines.findIndex((line) => line.includes("b efforts"));
		assert.ok(y >= 0);
		assert.equal(f.ui.handleMouse(click(lines[y].indexOf("b efforts"), y, 100, 30))?.handled, true);
		await turn();
		const pane = f.ui.render(100);
		const messageY = pane.findIndex((line) => line.includes("m message"));
		f.ui.handleMouse(click(pane[messageY].indexOf("m message"), messageY, 100, 30));
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
		await turn(); f.ui.handleInput("b"); await turn();
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
		await turn(); f.ui.handleInput("b"); await turn(); f.ui.handleInput("m"); f.ui.handleInput("Keep this draft"); f.ui.handleInput("\r"); await turn();
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
	await turn(); f.ui.handleInput("b"); f.ui.dispose();
	const count = f.counts().renders;
	read.resolve(awareness()); await turn();
	assert.equal(f.counts().renders, count);
});
it("the creating-session marker is independent of writer availability and task requests", () => {
	const rows = [row("one", { creatingOwnerId: "primary", owner: "unknown" }), row("two", { creatingOwnerId: "other", owner: "here" }), row("three")];
	for (const compact of [false, true]) {
		const text = rosterLines(rows, "two", 60, 20, 0, theme, compact, { primaryId: "primary" }).join("\n");
		assert.equal(text.match(/\[other\]/g)?.length, 1);
	}
	assert.doesNotMatch(rosterLines(rows, "two", 60, 20, 0, theme, false).join("\n"), /\[other\]/);
});

function contactPage(): CollaborationPage {
	return { thread: { id: "store/thread", title: "Contact exchange", purpose: "Review the overlap", authority: "Scoped brief", source: "brief", restrictions: "No publication", acceptance: "One agreement", integrator: "primary", creator: "primary", revision: 1, sequence: 0, closed: false, createdAt: 1, updatedAt: 1, members: [] }, events: [], nextBefore: null, pending: 0, coverage: { complete: true, bytes: 100 } };
}
it("keyboard and mouse contact entry read the existing Threads view without list discovery", async () => {
	for (const mouse of [false, true]) {
		const calls: Record<string, unknown>[] = [];
		const f = fixture(100, 30, source(), { efforts: async () => awareness(), collaborate: async (input) => { calls.push(input); return contactPage(); } });
		try {
			await turn(); f.ui.handleInput("b"); await turn();
			if (mouse) {
				const lines = f.ui.render(100);
				const y = lines.findIndex((line) => line.includes("Enter thread"));
				f.ui.handleMouse(click(lines[y].indexOf("Enter thread"), y, 100, 30));
			} else f.ui.handleInput("\r");
			await turn();
			assert.deepEqual(calls, [{ action: "read", threadId: "store/thread" }]);
			assert.match(f.ui.render(100).join("\n"), /Contact exchange/);
		} finally { f.ui.dispose(); }
	}
});
it("the command adapter binds effort reads and operator messages to the unchanged primary context", async () => {
	let dashboard: AgentDashboard | undefined;
	let finish = () => {};
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "primary" }, modelRegistry: { find: () => undefined }, ui: { notify() {}, custom: async (factory: (tui: TUI, paint: typeof theme, appKeys: typeof keys, done: () => void) => AgentDashboard) => new Promise<void>((resolve) => { finish = resolve; dashboard = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} } as unknown as TUI, theme, keys, resolve); }) } } as unknown as ExtensionContext;
	const calls: unknown[] = [];
	const command = createAgentCommand([], source([row("one", { creatingOwnerId: "other" })]), { timers: async () => [], schedule: async () => ({ text: "scheduled" }) }, undefined, undefined, {
		efforts: async (primary) => { calls.push(primary); return awareness(); },
		messageEffort: async (id, text, primary) => { calls.push({ id, text, primary }); return { text: "Operator message admitted" }; },
	});
	const opened = command.openDashboard(ctx);
	try {
		await turn(); assert.ok(dashboard);
		assert.match(dashboard.render(100).join("\n"), /\[other\]/);
		dashboard.handleInput("b"); await turn(); dashboard.handleInput("m"); dashboard.handleInput("Coordinate this"); dashboard.handleInput("\r"); await turn();
		assert.deepEqual(calls, [ctx, { id: "effort", text: "Coordinate this", primary: ctx }]);
		assert.equal(ctx.sessionManager.getSessionId(), "primary");
	} finally { dashboard?.dispose(); finish(); await opened; }
});

it("roster reconciliation does not read effort presence", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = setup();
	try {
		await turn(); f.ui.handleInput("b"); await turn();
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
		await turn(); f.ui.handleInput("b"); await turn();
		const text = f.ui.render(60).join("\n");
		assert.match(text, /Observed purpose \(interactive-input\): Compare this change/);
		assert.match(text, /No stated integration plan/);
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
		await turn(); f.ui.handleInput("b"); await turn(); f.ui.handleInput("m"); f.ui.handleInput("Retain this"); f.ui.handleInput("\r");
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
		await turn(); f.ui.handleInput("b"); await turn();
		const text = f.ui.render(80).join("\n");
		assert.match(text, /Stated by this effort/);
		assert.match(text, /Purpose: Review another project/);
		assert.match(text, /Shared substrates: machine-gates/);
		assert.match(text, /Purpose-only view/);
		assert.doesNotMatch(text, /PRIVATE_|Integration:|Operator direction|Scope:/);
		f.ui.handleInput("\r"); await turn();
		assert.deepEqual(calls, [{ action: "read", threadId: "store/thread" }]);
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
		const f = fixture(60, 30, source(), { efforts: async () => current, collaborate: async (input) => { calls.push(input); const page = contactPage(); return { ...page, thread: { ...page.thread, id: String(input.threadId) } }; } });
		try {
			await turn(); f.ui.handleInput("b"); await turn();
			const lines = f.ui.render(60);
			const text = lines.join("\n");
			assert.match(text, /Your observed purpose \(interactive-input\): Current own work/);
			assert.ok(text.indexOf("Newest active") < text.indexOf("Older active"));
			assert.match(text, /Scan incomplete:/);
			assert.doesNotMatch(text, /visits|omitted hints|visit-limit/);
			f.ui.handleInput("c");
			const breakdown = f.ui.render(60).join("\n");
			assert.match(breakdown, /Threads: 3\/256 visits · 2\/12 rows · incomplete/);
			assert.match(breakdown, /2 omitted hints · 3 omitted rows/);
			assert.match(breakdown, /1 missing hints · unvisited records: yes/);
			assert.match(breakdown, /visit-limit/);
			f.ui.handleInput("c"); f.ui.render(60);
			if (mouse) {
				const y = lines.findIndex((line) => line.includes("Newest active"));
				f.ui.handleMouse(click(lines[y].indexOf("Newest active"), y, 60, 30));
			} else { f.ui.handleInput("\x1b[B"); f.ui.handleInput("\x1b[B"); f.ui.handleInput("\r"); }
			await turn();
			assert.deepEqual(calls, [{ action: "read", threadId: "store/newest" }]);
		} finally { f.ui.dispose(); }
	}
});

it("multiline effort drafts keep the send receipt and escape hint inside the narrow viewport", async () => {
	const current = awareness();
	current.threads.coverage = { ...current.threads.coverage, complete: false, reasons: ["visit-limit"], unvisited: true };
	const f = fixture(60, 20, source(), { efforts: async () => current, messageEffort: async () => ({ text: "admitted" }) });
	try {
		await turn(); f.ui.handleInput("b"); await turn();
		f.ui.handleInput("m");
		for (let index = 0; index < 20; index++) { f.ui.handleInput("Draft line"); f.ui.handleInput("\x1b[106;5u"); }
		const lines = f.ui.render(60);
		assert.equal(lines.length, 20);
		assert.match(lines[19], /Esc back/);
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
			await turn(); f.ui.handleInput("b"); await turn();
			const lines = f.ui.render(80);
			assert.equal(lines.length, 40);
			const text = lines.join("\n");
			assert.match(text, /Started: unknown \(invalid time\)/);
			assert.match(text, /Last recorded activity: unknown \(invalid time\)/);
			assert.match(text, /^unknown \(invalid time\)/m);
			assert.doesNotMatch(text, /updated:/i);
			assert.match(text, /Invalid dated hint · unknown \(invalid time\)/);
			f.ui.handleInput("\x1b[B"); f.ui.handleInput("\x1b[B");
			const threadText = f.ui.render(80).join("\n");
			assert.match(threadText, /^unknown \(invalid time\)/m);
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
			await turn(); f.ui.handleInput("b"); await turn();
			const lines = f.ui.render(width);
			const text = lines.map(stripVTControlCharacters).join("\n");
			assert.equal(lines.length, height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(text.includes("Efforts · 2/2 loaded"));
			assert.match(text, /uncertain/);
			assert.ok(lines.some((line) => line.includes("\x1b[1mPurpose: Review the overlap")));
			assert.ok(lines.some((line) => line.includes("\x1b[90mScan incomplete: 1 unreadable record")));
			assert.ok(text.indexOf("Purpose:") < text.indexOf("Shared substrates:"));
			const selected = stripVTControlCharacters(lines.find((line) => line.includes("› Related effort")) ?? "");
			assert.equal(selected.indexOf("│"), width === 164 ? 37 : 31);
			const authority = lines.findIndex((line) => line.includes("Operator direction (quoted)"));
			assert.match(lines[authority + 1], /Scope:/);
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
			await turn(); f.ui.handleInput("b"); await turn();
			let lines = f.ui.render(width);
			const uncertainY = lines.findIndex((line) => line.startsWith("  uncertain"));
			assert.ok(uncertainY >= 0);
			assert.equal(f.ui.handleMouse(click(2, uncertainY, width, 44))?.handled, true);
			f.ui.handleInput("m");
			assert.match(f.ui.render(width).join("\n"), /need a live compatible effort/);
			lines = f.ui.render(width);
			const threadY = lines.findIndex((line) => line.includes("Inline contact"));
			assert.equal(f.ui.handleMouse(click(2, threadY, width, 44))?.handled, true);
			await turn();
			assert.deepEqual(calls, [{ action: "read", threadId: "store/thread" }]);
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
		await turn(); f.ui.handleInput("b"); await turn();
		const before = f.ui.render(100);
		assert.match(before.join("\n"), /Started: 15m ago/);
		assert.ok(before.some((line) => line.split("│")[1]?.trim() === "15m ago"));
		assert.doesNotMatch(before.join("\n"), /updated:/i);
		now += 60 * 60000;
		assert.deepEqual(f.ui.render(100), before);
		f.ui.handleInput("i");
		const exact = f.ui.render(100);
		assert.ok(exact.some((line) => line.includes(`Started: ${dashboardTime(Date.parse(at), true)}`)));
		assert.doesNotMatch(exact.join("\n"), /2026-10-04T|updated:/i);
		const y = exact.findIndex((line) => line.split("│")[1]?.trim() === dashboardTime(Date.parse(at), true));
		assert.ok(y >= 0);
		assert.equal(f.ui.handleMouse(click(34, y, 100, 44))?.handled, true);
		assert.match(f.ui.render(100).join("\n"), /Started: 15m ago/);
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
		await turn(); f.ui.handleInput("b"); await turn();
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
			await turn(); f.ui.handleInput("b"); await turn();
			const lines = f.ui.render(width);
			const text = lines.join("\n");
			assert.equal(lines.filter((line) => line.includes("Scan incomplete:")).length, complete ? 0 : 1);
			assert.doesNotMatch(text, /visits|excluded entries|omitted hints|reasons:|peer-primary/);
			assert.equal(text.match(/Stated by this effort/g)?.length, 1);
			assert.doesNotMatch(text, /Purpose claim:|Integration intent claim:|Scope claim:|Contact thread claim:|authority claim:/);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (complete) f.ui.handleInput("c");
			else {
				const y = lines.findIndex((line) => line.includes("Scan incomplete:"));
				assert.equal(f.ui.handleMouse(click(lines[y].indexOf("Scan incomplete:"), y, width, height))?.handled, true);
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
		await turn(); f.ui.handleInput("b"); await turn();
		for (let index = 0; index < 19; index++) f.ui.handleInput("\x1b[B");
		const lines = f.ui.render(100);
		assert.match(lines.join("\n"), /› Loaded effort 19/);
		assert.ok(lines.some((line) => line.includes("Efforts · 4/20 loaded")));
		assert.equal(lines.length, 32);
	} finally { f.ui.dispose(); }
});
