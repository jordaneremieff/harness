import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it, mock } from "node:test";
import registerStash from "./index.ts";
import { listStashes, readStash, transitionStash, writeStash } from "./store.ts";

interface Registry {
	tools: Map<string, any>;
	commands: Map<string, any>;
	sent: Array<{ content: string; options?: unknown }>;
	events: Map<string, any>;
	pi: any;
}

function registry(overrides?: { distillSessionFactory?: any; copyText?: (text: string) => Promise<void> }): Registry {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: Array<{ content: string; options?: unknown }> = [];
	const events = new Map<string, any>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		exec: async () => ({ code: 0, stdout: "main\n", stderr: "" }),
		sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
		on: (event: string, handler: any) => events.set(event, handler),
	};
	registerStash(pi, overrides);
	return { tools, commands, sent, events, pi };
}

const theme: any = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
};

let dir: string;
let oldStore: string | undefined;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "stash-index-test-"));
	oldStore = process.env.PI_STASH_DIR;
	process.env.PI_STASH_DIR = dir;
	await writeStash(dir, { title: "Large", summary: "x".repeat(70 * 1024) }, new Date("2026-07-24T10:00:00Z"));
	await writeStash(dir, { title: "Pickup target", summary: "UNIQUE_PICKUP_BODY" }, new Date("2027-07-24T10:00:00Z"));
});

after(async () => {
	if (oldStore === undefined) delete process.env.PI_STASH_DIR;
	else process.env.PI_STASH_DIR = oldStore;
	await rm(dir, { recursive: true, force: true });
});

describe("stash entrypoint", () => {
	it("registers lifecycle-aware tools and the /stash command", () => {
		const { tools, commands } = registry();
		assert.deepEqual([...tools.keys()], ["stash_write", "stash_list", "stash_read", "stash_complete", "stash_rotate"]);
		assert.ok(commands.has("stash"));
	});

	it("archives a superseded open stash through stash_rotate", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Rotate tool target", summary: "SUPERSEDED_BODY" },
			new Date("2025-07-20T10:00:00Z"),
		);
		const { tools } = registry();
		const rotated = await tools.get("stash_rotate").execute("call", { id: record.id }, new AbortController().signal);
		assert.equal(rotated.details.id, record.id);
		assert.equal(rotated.details.state, "open");
		assert.match(rotated.content[0].text, /Rotated stash/);
		const listed = await tools.get("stash_list").execute("call", { limit: 50 }, new AbortController().signal);
		assert.equal(listed.details.ids.includes(record.id), false, "rotated artifacts must disappear from listings");
		await assert.rejects(
			tools.get("stash_read").execute("call", { id: record.id }, new AbortController().signal),
			/no stash matches/,
		);
		assert.match(await readFile(rotated.details.archivePath, "utf8"), /SUPERSEDED_BODY/);
	});

	it("refuses to rotate an active stash through stash_rotate", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Active rotate refusal", summary: "live session owns this" },
			new Date("2025-07-19T10:00:00Z"),
		);
		await transitionStash(dir, record.id, { action: "activate" });
		const { tools } = registry();
		await assert.rejects(
			tools.get("stash_rotate").execute("call", { id: record.id }, new AbortController().signal),
			/is active; complete it before rotation/,
		);
		assert.ok((await listStashes(dir, { state: "active" })).some((entry) => entry.meta.id === record.id));
	});

	it("supports the /stash rotate verb and rejects a bare verb", async () => {
		const { record } = await writeStash(dir, { title: "Verb rotation", summary: "stale verb" }, new Date("2025-07-18T10:00:00Z"));
		const { commands } = registry();
		const notifications: string[] = [];
		const ctx: any = {
			mode: "rpc",
			hasUI: true,
			cwd: "/workspace",
			isIdle: () => true,
			ui: { notify: (message: string) => notifications.push(message) },
		};
		await commands.get("stash").handler(`rotate ${record.id}`, ctx);
		assert.match(notifications.join("\n"), /Rotated stash/);
		assert.ok(!(await listStashes(dir, { limit: 50 })).some((entry) => entry.meta.id === record.id));
		notifications.length = 0;
		await commands.get("stash").handler("rotate", ctx);
		assert.match(notifications.join("\n"), /Usage: \/stash rotate/);
	});

	it("rotates from the browser manage dialog only after confirmation", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Panel rotation", summary: "panel stale" },
			new Date("2027-07-25T10:00:00Z"),
		);
		const { commands } = registry();
		const notifications: string[] = [];
		let confirmShown = 0;
		let rounds = 0;
		const ctx: any = {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: (message: string) => notifications.push(message),
				custom: async (factory: any) => {
					rounds++;
					if (rounds > 1) return {};
					return new Promise((resolve) => {
						const tui = { terminal: { rows: 10 }, requestRender: () => {} };
						void Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) =>
							component.handleInput("\t"),
						);
					});
				},
				select: async () => "Rotate (archive)",
				confirm: async () => {
					confirmShown++;
					return true;
				},
			},
		};
		await commands.get("stash").handler("", ctx);
		assert.equal(confirmShown, 1, "rotation must require explicit confirmation");
		assert.match(notifications.join("\n"), /Rotated stash/);
		assert.ok(!(await listStashes(dir, { limit: 50 })).some((entry) => entry.meta.id === record.id));
	});

	it("signals a missing stash as a failed tool execution", async () => {
		const { tools } = registry();
		await assert.rejects(
			tools.get("stash_read").execute("call", { id: "does-not-exist" }, new AbortController().signal),
			/no stash matches/,
		);
	});

	it("bounds large stash_read output and reports the full artifact path", async () => {
		const { tools } = registry();
		const result = await tools
			.get("stash_read")
			.execute("call", { id: "20260724T100000Z-large" }, new AbortController().signal);
		assert.equal(result.details.truncated, true);
		assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 50 * 1024);
		assert.match(result.content[0].text, /Full artifact:/);
	});

	it("uses an explicit id as a direct, deterministic pickup shortcut", async () => {
		const { commands, sent, tools } = registry();
		const ctx: any = {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: () => {},
				custom: async () => {
					throw new Error("the browser should not open for an exact id");
				},
			},
		};
		await commands.get("stash").handler("20270724T100000Z-pickup-target", ctx);
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /UNIQUE_PICKUP_BODY/);
		assert.match(sent[0].content, /stash_complete.*20270724T100000Z-pickup-target/);
		assert.equal((await listStashes(dir, { state: "active" })).some((entry) => entry.meta.id === "20270724T100000Z-pickup-target"), true);
		const listed = await tools.get("stash_list").execute("call", { state: "active" }, new AbortController().signal);
		assert.match(listed.content[0].text, /active · Pickup target/);
		assert.ok(listed.details.states.every((state: string) => state === "active"));
	});

	it("keeps activation committed and reports it when pickup delivery fails", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Delivery failure target", summary: "resume me" },
			new Date("2025-07-23T10:00:00Z"),
		);
		const registered = registry();
		registered.pi.sendUserMessage = () => {
			throw new Error("session delivery unavailable");
		};
		const notifications: string[] = [];
		await registered.commands.get("stash").handler(record.id, {
			mode: "rpc",
			hasUI: true,
			cwd: "/workspace",
			isIdle: () => true,
			ui: { notify: (message: string) => notifications.push(message) },
		});
		assert.match(notifications.join("\n"), /is active, but pickup delivery failed.*session delivery unavailable/i);
		assert.ok((await listStashes(dir, { state: "active" })).some((entry) => entry.meta.id === record.id));
	});

	it("closes an active stash with an outcome and reopens it only through an explicit action", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Completion target", summary: "finish this" },
			new Date("2025-07-24T10:00:00Z"),
		);
		await transitionStash(dir, record.id, { action: "activate" });
		const { tools, commands } = registry();
		const completed = await tools
			.get("stash_complete")
			.execute(
				"call",
				{ id: record.id, outcome: "The requested change landed and its focused checks pass." },
				new AbortController().signal,
			);
		assert.equal(completed.details.state, "closed");
		assert.match(completed.content[0].text, /focused checks pass/);
		const closed = await listStashes(dir, { state: "closed" });
		assert.ok(closed.some((entry) => entry.meta.id === record.id));

		const notifications: string[] = [];
		await commands.get("stash").handler(`reopen ${record.id}`, {
			mode: "rpc",
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
		});
		assert.match(notifications.join("\n"), /Reopened stash/);
		const reopened = await readStash(dir, record.id);
		assert.equal(reopened.ok, true);
		assert.ok((await listStashes(dir, { state: "open" })).some((entry) => entry.meta.id === record.id));
	});

	it("supports direct lifecycle verbs and refuses to pick up a closed effort", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Verb target", summary: "VERB_PICKUP_BODY" },
			new Date("2025-07-21T10:00:00Z"),
		);
		const { commands, sent } = registry();
		const notifications: string[] = [];
		const ctx: any = {
			mode: "rpc",
			hasUI: true,
			cwd: "/workspace",
			isIdle: () => true,
			ui: { notify: (message: string) => notifications.push(message) },
		};

		await commands.get("stash").handler(`pickup ${record.id}`, ctx);
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /VERB_PICKUP_BODY/);
		assert.ok((await listStashes(dir, { state: "active" })).some((entry) => entry.meta.id === record.id));

		await commands.get("stash").handler(`complete ${record.id} Landed the verb path end-to-end.`, ctx);
		assert.match(notifications.join("\n"), /Closed stash/);
		assert.ok((await listStashes(dir, { state: "closed" })).some((entry) => entry.meta.id === record.id));

		notifications.length = 0;
		await commands.get("stash").handler(record.id, ctx);
		assert.match(notifications.join("\n"), /closed; reopen it before pickup/i);
		assert.equal(sent.length, 1, "a closed effort must not inject a pickup message");
	});

	it("serializes competing completions so one outcome cannot overwrite the other", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Concurrent completion target", summary: "close once" },
			new Date("2025-07-22T10:00:00Z"),
		);
		await transitionStash(dir, record.id, { action: "activate" });
		const { tools } = registry();
		const complete = tools.get("stash_complete");
		const results = await Promise.allSettled([
			complete.execute("call-a", { id: record.id, outcome: "Outcome A" }, new AbortController().signal),
			complete.execute("call-b", { id: record.id, outcome: "Outcome B" }, new AbortController().signal),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(results.filter((result) => result.status === "rejected").length, 1);
		const target = (await listStashes(dir, { limit: 50 })).find((entry) => entry.meta.id === record.id);
		assert.ok(target);
		assert.equal(target.meta.state, "closed");
		assert.ok(target.meta.outcome === "Outcome A" || target.meta.outcome === "Outcome B");
	});

	it("does not construct a custom panel outside TUI mode", async () => {
		const { commands } = registry();
		const notifications: string[] = [];
		await commands.get("stash").handler("", {
			mode: "rpc",
			hasUI: true,
			ui: {
				notify: (message: string) => notifications.push(message),
				custom: () => {
					throw new Error("custom UI must not be constructed in RPC mode");
				},
			},
		});
		assert.match(notifications.join("\n"), /requires TUI mode.*stash_list/i);
		await assert.rejects(
			commands.get("stash").handler("", { mode: "json", hasUI: false, ui: {} }),
			/requires TUI mode.*stash_list/i,
		);
	});

	it("picks up the selected artifact in one injected message and retains the footer height authority", async () => {
		const { commands, sent } = registry();
		let overlayOptions: any;
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx: any = {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				custom: async (factory: any, options: any) => {
					overlayOptions = options.overlayOptions;
					return new Promise((resolve) => {
						const tui = { terminal: { rows: 10 }, requestRender: () => {} };
						void Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => {
							const lines = component.render(38);
							assert.ok(lines.length <= 8);
							assert.match(lines.join("\n"), /esc|close/i);
							component.handleInput("\r");
						});
					});
				},
			},
		};

		await commands.get("stash").handler("", ctx);
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /UNIQUE_PICKUP_BODY/);
		assert.doesNotMatch(sent[0].content, /stash_read|fetch the stash/i);
		assert.equal(sent[0].options, undefined);
		assert.equal(overlayOptions.minWidth, 104);
		assert.equal(overlayOptions.maxHeight, "92%");
		assert.equal(notifications.length, 0);
	});

	it("copies the selected resume command without leaving the browser", async () => {
		const copied: string[] = [];
		const { commands } = registry({ copyText: async (text) => copied.push(text) });
		let panels = 0;
		await commands.get("stash").handler("", {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: () => {},
				custom: async (factory: any) =>
					new Promise((resolve) => {
						const tui = { terminal: { rows: 20 }, requestRender: () => {} };
						const component = factory(tui, theme, {}, resolve);
						if (panels++ === 0) {
							component.handleInput("c");
							setImmediate(() => component.handleInput("\x1b"));
						}
					}),
			},
		});
		assert.equal(copied.length, 1);
		assert.match(copied[0], /^pi "\/stash \d{8}T\d{6}Z-/);
	});

	it("closes an active stash from the direct outcome key", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Direct browser completion", summary: "close from the browser" },
			new Date("2026-07-26T10:00:00Z"),
		);
		await transitionStash(dir, record.id, { action: "activate" });
		const { commands } = registry();
		let panels = 0;
		await commands.get("stash").handler("Direct browser completion", {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: () => {},
				input: async () => "The direct browser action closed this effort.",
				custom: async (factory: any) =>
					new Promise((resolve) => {
						const tui = { terminal: { rows: 20 }, requestRender: () => {} };
						const component = factory(tui, theme, {}, resolve);
						if (panels++ === 0) component.handleInput("o");
						else {
							component.handleInput("/");
							assert.match(component.render(104).join("\n"), /filter Direct browser completion▌/);
							component.handleInput("\x1b");
							component.handleInput("\x1b");
						}
					}),
			},
		});
		assert.ok((await listStashes(dir, { state: "closed" })).some((entry) => entry.meta.id === record.id));
	});

	it("offers lifecycle actions through a separate browser dialog without stealing filter text", async () => {
		const { record } = await writeStash(
			dir,
			{ title: "Separate dialog target", summary: "close from the dashboard" },
			new Date("2026-07-25T10:00:00Z"),
		);
		await transitionStash(dir, record.id, { action: "activate" });
		const { commands } = registry();
		let overlays = 0;
		const notifications: string[] = [];
		await commands.get("stash").handler("Separate dialog target", {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: (message: string) => notifications.push(message),
				select: async () => "Close with outcome",
				input: async () => "The browser-driven effort reached its intended result.",
				confirm: async () => true,
				custom: async (factory: any) =>
					new Promise((resolve) => {
						const tui = { terminal: { rows: 20 }, requestRender: () => {} };
						const component = factory(tui, theme, {}, resolve);
						if (overlays++ === 0) component.handleInput("\t");
						else {
							component.handleInput("\x1b");
							component.handleInput("\x1b");
						}
					}),
			},
		});
		assert.match(notifications.join("\n"), /Closed stash/);
		assert.ok((await listStashes(dir, { state: "closed" })).some((entry) => entry.meta.id === record.id));
	});
});

/** A canned distillation reply that resolves immediately. */
function fakeDistillFactory(reply: string, opts?: { session?: any }) {
	const session = {
		prompt: async () => {},
		getLastAssistantText: () => reply,
		abort: async () => {
			if (opts?.session) opts.session.aborted = true;
		},
		dispose: () => {},
	};
	if (opts?.session) opts.session.instance = session;
	return async () => session;
}

const DISTILL_PAYLOAD = JSON.stringify({
	title: "Distilled handover",
	summary: "Background distillation state.",
	decisions: ["Use the SDK session for distillation"],
	nextActions: ["Run the suite"],
	tags: ["distill"],
});

function creationCtx(ui: any, extra: any = {}) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/workspace",
		model: { id: "test-model", provider: "test" },
		sessionManager: {
			getSessionId: () => "sess-1",
			buildContextEntries: () => [],
		},
		ui,
		...extra,
	};
}

function waitForSettle(): Promise<void> {
	// The job settles on microtasks plus a few fs ticks after the store write.
	return new Promise((resolve) => setTimeout(resolve, 30));
}

/** Under mock timers, an unmocked macrotask turn lets the job's microtask chain complete. */
async function flushUnderMockTimers(tickMs: number): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	if (tickMs > 0) await mock.timers.tick(tickMs);
	await new Promise((resolve) => setImmediate(resolve));
}

describe("stash creation", () => {
	afterEach(() => {
		mock.timers.reset();
	});

	it("dispatches a background distillation without touching the live session", async () => {
		const { commands, sent } = registry({ distillSessionFactory: fakeDistillFactory(DISTILL_PAYLOAD) });
		const statuses: string[] = [];
		const notifications: string[] = [];
		await commands.get("stash").handler("new focus the harness on distillation", creationCtx({
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<clear>"),
		}));

		assert.equal(sent.length, 0, "the live session must receive no turn");
		assert.ok(statuses[0]?.startsWith("stash: running"), "a running status must appear on dispatch");
		assert.match(notifications.join("\n"), /Stash distillation started.*focus the harness on distillation/);

		await waitForSettle();
		assert.ok(
			statuses.some((text) => /^stash: done \d{8}T\d{6}Z-/.test(text)),
			"a done status must name the written artifact",
		);
		assert.match(notifications.join("\n"), /Stashed "Distilled handover"/);
		assert.ok((await listStashes(dir, { limit: 50 })).some((entry) => entry.meta.title === "Distilled handover"));
	});

	it("rejects a second dispatch while a creation is in flight", async () => {
		const pending: Array<() => void> = [];
		const never = () =>
			new Promise<void>((resolve) => {
				pending.push(resolve);
			});
		const factory = async () => ({
			prompt: never,
			getLastAssistantText: () => "",
			abort: async () => {},
			dispose: () => {},
		});
		const { commands } = registry({ distillSessionFactory: factory });
		const notifications: string[] = [];
		const ctx = creationCtx({ notify: (message: string) => notifications.push(message) });
		await commands.get("stash").handler("new", ctx);
		await commands.get("stash").handler("new second try", ctx);
		assert.match(notifications.join("\n"), /already in flight.*abort/i);
		// Release the stuck job so later tests share a clean slot.
		await commands.get("stash").handler("abort", ctx);
	});

	it("aborts an in-flight creation, clears the status, and frees the slot", async () => {
		const session: any = {};
		const never = () => new Promise<void>(() => {});
		const factory = async () => ({
			prompt: never,
			getLastAssistantText: () => "",
			abort: async () => {
				session.aborted = true;
			},
			dispose: () => {},
		});
		const { commands } = registry({ distillSessionFactory: factory });
		const statuses: string[] = [];
		const notifications: string[] = [];
		const ctx = creationCtx({
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<clear>"),
		});
		await commands.get("stash").handler("new", ctx);
		assert.ok(statuses.some((text) => text.startsWith("stash: running")));
		await commands.get("stash").handler("abort", ctx);
		assert.equal(session.aborted, true, "the job must receive the abort");
		assert.equal(statuses.at(-1), "<clear>", "abort must clear the status");
		assert.match(notifications.join("\n"), /Stash creation cancelled/);

		notifications.length = 0;
		await commands.get("stash").handler("abort", ctx);
		assert.match(notifications.join("\n"), /No stash creation is in flight/);
	});

	it("clears a stale done status before a new dispatch runs", async () => {
		mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		// Job 1 settles on microtasks only (SKIP path), so synchronous ticks drive
		// its lifecycle; job 2 stays stuck, so its own clear timer never competes.
		const never = () => new Promise<void>(() => {});
		const stuckSession = () =>
			Promise.resolve({
				prompt: never,
				getLastAssistantText: () => "",
				abort: async () => {},
				dispose: () => {},
			});
		let calls = 0;
		const factory = async () => {
			calls++;
			return calls === 1 ? await fakeDistillFactory("SKIP_STASH")() : await stuckSession();
		};
		const { commands } = registry({ distillSessionFactory: factory });
		const statuses: string[] = [];
		const ctx = creationCtx({
			setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<clear>"),
		});
		await commands.get("stash").handler("new first", ctx);
		await flushUnderMockTimers(50);
		// First job settled; its held status is pending a three-second clear.
		assert.ok(statuses.some((text) => text === "stash: skipped"));
		await commands.get("stash").handler("new second", ctx);
		const before = statuses.length;
		// Past the first job's hold deadline, its stale clear timer must not wipe
		// the new running status: startCreation clears it before dispatch.
		await mock.timers.tick(3100);
		await flushUnderMockTimers(0);
		assert.ok(statuses.slice(before).every((text) => text !== "<clear>"));
		assert.ok(statuses.slice(before).some((text) => text.startsWith("stash: running")));
		await commands.get("stash").handler("abort", ctx);
	});

	it("clears the status after the held state expires", async () => {
		mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		const { commands } = registry({ distillSessionFactory: fakeDistillFactory("SKIP_STASH") });
		const statuses: string[] = [];
		const ctx = creationCtx({
			setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<clear>"),
		});
		await commands.get("stash").handler("new", ctx);
		await flushUnderMockTimers(50);
		assert.ok(statuses.some((text) => text === "stash: skipped"));
		await mock.timers.tick(3100);
		await flushUnderMockTimers(0);
		assert.equal(statuses.at(-1), "<clear>", "the held status must clear itself");
	});

	it("writes the artifact in RPC mode without a spinner and without a live turn", async () => {
		const { commands, sent } = registry({ distillSessionFactory: fakeDistillFactory(DISTILL_PAYLOAD) });
		const notifications: string[] = [];
		const statuses: string[] = [];
		const ctx = creationCtx(
			{
				notify: (message: string) => notifications.push(message),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<clear>"),
			},
			{ mode: "rpc" },
		);
		await commands.get("stash").handler("new", ctx);
		await waitForSettle();
		assert.equal(sent.length, 0);
		assert.ok((await listStashes(dir, { limit: 50 })).some((entry) => entry.meta.title === "Distilled handover"));
	});

	it("reports distillation failures and writes nothing", async () => {
		const { commands } = registry({
			distillSessionFactory: fakeDistillFactory("not json at all"),
		});
		const before = (await listStashes(dir, { limit: 200 })).length;
		const notifications: string[] = [];
		const statuses: string[] = [];
		const ctx = creationCtx({
			notify: (message: string, level: string) => notifications.push(`${level}: ${message}`),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<clear>"),
		});
		await commands.get("stash").handler("new", ctx);
		await waitForSettle();
		assert.match(notifications.join("\n"), /error: Stash distillation failed.*did not return valid JSON/);
		assert.ok(statuses.some((text) => text === "stash: failed"));
		assert.equal((await listStashes(dir, { limit: 200 })).length, before, "a failed distillation must not write");
	});

	it("skips writing when the distiller finds nothing worth preserving", async () => {
		const { commands } = registry({ distillSessionFactory: fakeDistillFactory("SKIP_STASH") });
		const before = (await listStashes(dir, { limit: 200 })).length;
		const notifications: string[] = [];
		const statuses: string[] = [];
		const ctx = creationCtx({
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<clear>"),
		});
		await commands.get("stash").handler("new", ctx);
		await waitForSettle();
		assert.match(notifications.join("\n"), /Nothing worth stashing/);
		assert.ok(statuses.some((text) => text === "stash: skipped"));
		assert.equal((await listStashes(dir, { limit: 200 })).length, before);
	});

	it("aborts the in-flight job on session shutdown", async () => {
		const session: any = {};
		const never = () => new Promise<void>(() => {});
		const factory = async () => ({
			prompt: never,
			getLastAssistantText: () => "",
			abort: async () => {
				session.aborted = true;
			},
			dispose: () => {},
		});
		const { commands, events } = registry({ distillSessionFactory: factory });
		const statuses: string[] = [];
		const ctx = creationCtx({
			setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<clear>"),
		});
		await commands.get("stash").handler("new", ctx);
		const shutdownHandler = events.get("session_shutdown");
		assert.equal(typeof shutdownHandler, "function", "a session_shutdown handler must be registered");
		await shutdownHandler({}, ctx);
		assert.equal(session.aborted, true, "session shutdown must abort the in-flight job");
		assert.equal(statuses.at(-1), "<clear>", "session shutdown must clear the status");
	});
});
