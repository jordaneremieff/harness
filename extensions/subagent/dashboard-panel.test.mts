import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type {
	CollaborationEvent,
	CollaborationParticipant,
	CollaborationQuery,
	CollaborationSnapshot,
} from "./collaboration-types.ts";
import { renderConversation, stripTerminalSequences } from "./console.ts";
import { openSubagentPanel, type SubagentPanelDeps } from "./panel.ts";

type Worker = NonNullable<ReturnType<SubagentPanelDeps["readWorker"]>>;
type Component = {
	focused: boolean;
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
};
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	inverse: (text: string) => text,
} as unknown as Theme;
function participant(
	id: string,
	parentId: string | null,
	overrides: Partial<CollaborationParticipant> = {},
): CollaborationParticipant {
	return {
		id,
		parentId,
		label: id,
		task: `Task for ${id}`,
		model: "test/same-model",
		state: "running",
		workerId: id === "root" ? null : id,
		continuedFrom: null,
		...overrides,
	};
}
function event(id: string, text: string, overrides: Partial<CollaborationEvent> = {}): CollaborationEvent {
	return {
		id,
		actorId: "worker-a",
		recipientId: "worker-b",
		kind: "peer",
		text,
		timestamp: Number(id.replace(/\D/g, "")) || 1,
		source: "memory",
		sourceSessionId: "session-a",
		entryId: `entry-${id}`,
		messageId: `message-${id}`,
		replyTo: null,
		workerId: "worker-a",
		receipt: "sent_unconfirmed",
		...overrides,
	};
}
function snapshot(): CollaborationSnapshot {
	return {
		familyId: "root",
		families: [
			{ id: "root", label: "Current family" },
			{ id: "other", label: "Other family" },
		],
		participants: [
			participant("root", null),
			participant("worker-a", "root"),
			participant("worker-b", "worker-a"),
			participant("worker-c", "root", { continuedFrom: "worker-a" }),
		],
		events: [
			event("event-1", "Exact first message\nSecond line"),
			event("event-2", "Exact reply", { actorId: "worker-b", recipientId: "worker-a", replyTo: "message-event-1" }),
		],
		notices: [],
	};
}
function worker(id = "worker-a", overrides: Partial<Worker> = {}): Worker {
	return {
		id,
		ownerSession: "root",
		task: `Task for ${id}`,
		model: "test/model",
		state: "running",
		startedAt: 1,
		interruptedAt: null,
		sessionFile: "/sessions/worker.jsonl",
		...overrides,
	} as Worker;
}
function deps(overrides: Partial<SubagentPanelDeps> = {}): SubagentPanelDeps {
	return {
		readWorkers: () => [worker()],
		readWorker: (id) => worker(id),
		collaboration: async () => snapshot(),
		kill: async () => "cancelled",
		continueWorker: async () => ({ id: null, text: "declined" }),
		report: () => null,
		conversation: () => [],
		isLive: () => true,
		subscribeLive: () => null,
		isActive: () => true,
		interrupt: async () => "interrupted",
		sendLive: async () => ({ ok: true, text: "sent" }),
		currentSessionId: () => "root",
		...overrides,
	};
}
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
async function panel(
	dependencies: SubagentPanelDeps,
	run: (component: Component, terminal: { rows: number }, closed: () => number) => Promise<void>,
	panelTheme = theme,
): Promise<void> {
	let closeCount = 0;
	const terminal = { rows: 32 };
	const ctx = {
		ui: {
			custom: async (factory: (tui: unknown, theme: Theme, keys: unknown, done: () => void) => Component) => {
				const component = factory({ terminal, requestRender: () => undefined }, panelTheme, undefined, () => {
					closeCount++;
				});
				component.focused = true;
				try {
					await flush();
					await run(component, terminal, () => closeCount);
				} finally {
					component.dispose();
				}
			},
		},
	} as unknown as ExtensionCommandContext;
	await openSubagentPanel(ctx, dependencies);
}
function text(component: Component, width = 140): string {
	return stripTerminalSequences(component.render(width).join("\n"));
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
	let resolve!: (value: T) => void, reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("collaboration dashboard", () => {
	it("starts with the family timeline, nested ownership, and a separate continuation edge", async () => {
		await panel(deps(), async (component) => {
			const output = text(component, 180);
			assert.match(output, /LIVE · timeline · root/);
			assert.match(output, /OWNERSHIP/);
			assert.match(output, /TIMELINE/);
			assert.match(output, /worker-a: Task/);
			assert.match(output, / {4}└ worker-b/);
			assert.match(output, /Exact reply/);
			component.handleInput("\t");
			component.handleInput("\x1b[F");
			component.handleInput("\r");
			assert.match(text(component), /Continuation: worker-a/);
			assert.match(text(component), /Owner: root/);
		});
	});
	it("refreshes the final report once after a worker settles without another live callback", async () => {
		const record = worker();
		let reads = 0;
		await panel(
			deps({
				readWorker: () => record,
				isLive: () => record.state === "running",
				conversation: () => {
					reads++;
					return [];
				},
				report: () => (record.state === "done" ? { label: "submitted report", text: "Final retained result" } : null),
			}),
			async (component) => {
				component.handleInput("v");
				assert.doesNotMatch(text(component), /Final retained result/);
				assert.equal(reads, 1);
				record.state = "done";
				record.exitedAt = 2;
				record.resultBytes = 21;
				assert.match(text(component), /Final retained result/);
				assert.equal(reads, 2);
				text(component, 80);
				component.invalidate();
				text(component, 100);
				assert.equal(reads, 2, "settled data is cached across paints and resizes");
			},
		);
	});
	it("loads no history during render, polls only memory, and retains explicit history", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		const queries: CollaborationQuery[] = [];
		await panel(
			deps({
				collaboration: async (query) => {
					queries.push(query);
					const result = snapshot();
					if (query.history) result.events.unshift(event("event-0", "historical evidence"));
					return result;
				},
			}),
			async (component) => {
				component.render(140);
				component.render(80);
				component.invalidate();
				component.render(80);
				assert.deepEqual(queries, [{}]);
				context.mock.timers.tick(1_000);
				await flush();
				assert.deepEqual(queries.at(-1), { familyId: "root" });
				component.handleInput("h");
				await flush();
				assert.deepEqual(queries.at(-1), { familyId: "root", history: true });
				context.mock.timers.tick(1_000);
				await flush();
				assert.match(text(component, 180), /historical evidence/);
				assert.match(text(component), /retained snapshot.*history/);
			},
		);
	});
	it("preserves the selected event and scroll while new events arrive, then returns live", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		const current = snapshot();
		current.events = Array.from({ length: 40 }, (_, i) => event(`event-${i + 1}`, `payload-${i + 1}`));
		await panel(deps({ collaboration: async () => structuredClone(current) }), async (component) => {
			component.handleInput("\x1b[H");
			const before = text(component, 180);
			current.events.push(event("event-41", "newest payload"));
			context.mock.timers.tick(1_000);
			await flush();
			const after = text(component, 180);
			assert.match(after, /PAUSED · 1 new/);
			assert.equal(before.split("\n").slice(2, -2).join("\n"), after.split("\n").slice(2, -2).join("\n"));
			component.handleInput("\r");
			assert.match(text(component), /EVENT event-1/);
			component.handleInput("\x1b");
			component.handleInput("l");
			assert.match(text(component, 180), /LIVE/);
			assert.match(text(component, 180), /newest payload/);
		});
	});
	it("highlights a participant without filtering, then explicitly restricts events", async () => {
		const current = snapshot();
		current.events.push(
			event("event-3", "unrelated exchange", { actorId: "root", recipientId: "worker-c", workerId: null }),
		);
		await panel(deps({ collaboration: async () => current }), async (component) => {
			component.handleInput("\t");
			assert.match(text(component, 180), /unrelated exchange/);
			component.handleInput("f");
			assert.doesNotMatch(text(component, 180), /unrelated exchange/);
			assert.match(text(component), /filter worker-a/);
			component.handleInput("f");
			assert.match(text(component, 180), /unrelated exchange/);
		});
	});
	it("shows exact event text, source and reply links, with recorded task context", async () => {
		await panel(deps(), async (component, terminal) => {
			terminal.rows = 60;
			component.handleInput("\r");
			assert.match(text(component), /EVENT event-2/);
			assert.match(text(component), /Reply to: message-event-1/);
			component.handleInput("[");
			const output = text(component);
			assert.match(output, /EVENT event-1/);
			assert.match(output, /Exact first message\s*\nSecond line/);
			assert.match(output, /Source: memory/);
			assert.match(output, /Session: session-a/);
			assert.match(output, /Entry: entry-event-1/);
			assert.match(output, /TASK \/ CONTEXT.*\nTask for worker-a/);
			component.handleInput("]");
			assert.match(text(component), /EVENT event-2/);
		});
	});
	it("switches explicit families without leaking retained events from another family", async () => {
		await panel(
			deps({
				collaboration: async (query) =>
					query.familyId === "other"
						? {
								familyId: "other",
								families: snapshot().families,
								participants: [participant("foreign", null)],
								events: [event("foreign-event", "only other family", { actorId: "foreign" })],
								notices: [],
							}
						: snapshot(),
			}),
			async (component) => {
				component.handleInput("F");
				component.handleInput("\x1b[B");
				component.handleInput("\r");
				await flush();
				const output = text(component, 180);
				assert.match(output, /only other family/);
				assert.doesNotMatch(output, /Exact reply|worker-a: Task/);
			},
		);
	});
	it("ignores stale snapshot completions after a newer explicit history request", async () => {
		const pending = deferred<CollaborationSnapshot>();
		let calls = 0;
		await panel(
			deps({
				collaboration: async () => (++calls === 1 ? pending.promise : { ...snapshot(), notices: ["fresh snapshot"] }),
			}),
			async (component) => {
				component.handleInput("h");
				await flush();
				assert.match(text(component, 220), /fresh snapshot/);
				pending.resolve({ ...snapshot(), notices: ["stale snapshot"] });
				await flush();
				assert.doesNotMatch(text(component, 220), /stale snapshot/);
			},
		);
	});
	it("preserves source ancestry order despite inverted timestamps and replaces explicit history", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		const current = {
			...snapshot(),
			events: [
				event("event-1", "first source entry", { timestamp: 900 }),
				event("event-2", "second source entry", { timestamp: 100 }),
			],
		};
		await panel(deps({ collaboration: async () => structuredClone(current) }), async (component) => {
			component.handleInput("\x1b[H");
			component.handleInput("\r");
			assert.match(text(component), /EVENT event-1/);
			component.handleInput("\x1b");
			current.events = [current.events[1], event("event-3", "third source entry", { timestamp: 50 })];
			context.mock.timers.tick(1_000);
			await flush();
			component.handleInput("\x1b[B");
			component.handleInput("\r");
			assert.match(text(component), /EVENT event-2/);
			component.handleInput("\x1b");
			component.handleInput("h");
			await flush();
			assert.doesNotMatch(text(component), /first source entry/);
		});
	});
	it("retains terminal history between record anchors through record-only live ticks", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		const dispatch = event("dispatch", "dispatch summary", { source: "record", sourceSessionId: "terminal-session" });
		const result = event("result", "result summary", { source: "record", sourceSessionId: "terminal-session" });
		const retained = event("retained", "retained custom message", {
			source: "session-entry",
			sourceSessionId: "terminal-session",
		});
		let deleted = false;
		await panel(
			deps({
				collaboration: async (query) => ({
					...snapshot(),
					events: query.history && !deleted ? [dispatch, retained, result] : [dispatch, result],
				}),
			}),
			async (component) => {
				component.handleInput("h");
				await flush();
				assert.match(text(component, 180), /retained custom message/);
				context.mock.timers.tick(1_000);
				await flush();
				assert.match(text(component, 180), /retained custom message/);
				assert.match(text(component, 180), /TIMELINE · 3 events/);
				assert.match(text(component, 180), /history/);
				deleted = true;
				component.handleInput("h");
				await flush();
				assert.doesNotMatch(text(component, 180), /retained custom message/);
			},
		);
	});
	it("bounds retained events and exposes cache omissions", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		const current = {
			...snapshot(),
			events: Array.from({ length: 1_050 }, (_, index) => event(`event-${index}`, `body-${index}`)),
		};
		await panel(deps({ collaboration: async () => current }), async (component) => {
			assert.match(text(component, 240), /View cache omitted 50 older events/);
			component.handleInput("\x1b[H");
			component.handleInput("\r");
			assert.match(text(component), /EVENT event-50/);
			context.mock.timers.tick(1_000);
			await flush();
			assert.match(text(component), /PAUSED · 0 new/);
		});
	});
	it("uses native Unicode and bracketed paste inputs with focus propagation and narrow pages", async () => {
		await panel(deps(), async (component, terminal) => {
			component.handleInput("/");
			assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
			component.handleInput("\x1b[200~中文é\x1b[201~");
			component.handleInput("\x7f");
			assert.match(text(component, 80), /中文/);
			assert.doesNotMatch(text(component, 80), /é/);
			component.focused = false;
			assert.ok(!component.render(80).join("\n").includes(CURSOR_MARKER));
			component.focused = true;
			component.handleInput("\x1b");
			component.handleInput("\t");
			assert.match(text(component, 60), /OWNERSHIP/);
			assert.doesNotMatch(text(component, 60), /TIMELINE/);
			component.handleInput("v");
			component.handleInput("\x1b[200~👩‍💻界\x1b[201~");
			component.handleInput("\x7f");
			assert.match(text(component, 80), /👩‍💻/);
			assert.doesNotMatch(text(component, 80), /界/);
			for (const width of [180, 100, 60, 24, 10, 3, 1])
				for (const line of component.render(width)) assert.equal(visibleWidth(line), width);
			terminal.rows = 4;
			assert.equal(component.render(20).length, 2);
			assert.match(text(component, 20), /esc/);
		});
	});
});

describe("worker console robustness", () => {
	it("retains failed typed sends and prevents duplicate sends", async () => {
		const outcome = deferred<{ ok: boolean; text: string }>();
		let calls = 0;
		await panel(
			deps({
				sendLive: async () => {
					calls++;
					return outcome.promise;
				},
			}),
			async (component) => {
				component.handleInput("v");
				component.handleInput("Keep this draft");
				component.handleInput("\r");
				component.handleInput("\r");
				assert.equal(calls, 1);
				outcome.resolve({ ok: false, text: "Recipient refused delivery" });
				await flush();
				assert.match(text(component), /Keep this draft/);
				assert.match(text(component), /Recipient refused/);
			},
		);
	});
	it("keeps rejected promise drafts and clears successful sends only after success", async () => {
		let fail = true;
		await panel(
			deps({
				sendLive: async () => {
					if (fail) throw new Error("synthetic failure");
					return { ok: true, text: "sent" };
				},
			}),
			async (component) => {
				component.handleInput("v");
				component.handleInput("retained draft");
				component.handleInput("\r");
				await flush();
				assert.match(text(component), /retained draft/);
				fail = false;
				component.handleInput("\r");
				await flush();
				assert.doesNotMatch(text(component), /retained draft/);
			},
		);
	});
	it("never turns Ctrl+C into cancellation when a worker becomes idle", async () => {
		let active = true,
			interrupts = 0,
			cancellations = 0;
		await panel(
			deps({
				isActive: () => active,
				interrupt: async () => {
					interrupts++;
					return "interrupted";
				},
				kill: async () => {
					cancellations++;
					return "cancelled";
				},
			}),
			async (component) => {
				component.handleInput("v");
				component.handleInput("\x03");
				await flush();
				active = false;
				component.handleInput("\x03");
				await flush();
				assert.equal(interrupts, 2);
				assert.equal(cancellations, 0);
				component.handleInput("\x0b");
				await flush();
				assert.equal(cancellations, 1);
			},
		);
	});
	it("refuses foreign controls and ignores completions after navigation or disposal", async () => {
		const outcome = deferred<{ ok: boolean; text: string }>();
		let live = false,
			kills = 0;
		await panel(
			deps({
				isLive: () => live,
				kill: async () => {
					kills++;
					return "cancelled";
				},
				sendLive: async () => outcome.promise,
			}),
			async (component) => {
				component.handleInput("k");
				assert.equal(kills, 0);
				live = true;
				component.handleInput("v");
				component.handleInput("old draft");
				component.handleInput("\r");
				component.handleInput("\x1b");
				component.handleInput("v");
				component.handleInput("\r");
				assert.match(text(component), /Send request pending/);
				outcome.resolve({ ok: true, text: "stale send success" });
				await flush();
				component.handleInput("new draft");
				assert.match(text(component), /new draft/);
				assert.doesNotMatch(text(component), /stale send success/);
				component.dispose();
			},
		);
	});
	it("labels pending continuation Escape truthfully and rejects late navigation", async () => {
		const continuation = deferred<{ id: string | null; text: string }>();
		let calls = 0;
		await panel(
			deps({
				isLive: () => false,
				readWorker: (id) => worker(id, { state: "done" }),
				continueWorker: async () => {
					calls++;
					return continuation.promise;
				},
			}),
			async (component) => {
				component.handleInput("v");
				component.handleInput("r");
				component.handleInput("continue draft");
				component.handleInput("\r");
				component.handleInput("\r");
				assert.equal(calls, 1);
				assert.doesNotMatch(text(component), /esc cancel/);
				component.handleInput("\x1b");
				assert.match(text(component), /Continuation remains active/);
				continuation.resolve({ id: "new-worker", text: "late continuation" });
				await flush();
				assert.match(text(component), /TIMELINE/);
				assert.doesNotMatch(text(component), /late continuation/);
			},
		);
	});
	it("rebuilds theme output without repeated terminal transcript reads", async () => {
		let calls = 0,
			color = "old";
		const changingTheme = { ...theme, fg: (_token: string, value: string) => `${color}:${value}` } as Theme;
		await panel(
			deps({
				isLive: () => false,
				readWorker: (id) => worker(id, { state: "done" }),
				conversation: () => {
					calls++;
					return [
						{
							id: "custom",
							role: "custom",
							customType: "peer-note",
							content: [{ type: "text", text: "custom body" }],
							timestamp: 1,
						},
					];
				},
			}),
			async (component) => {
				component.handleInput("v");
				assert.match(text(component), /old:custom body/);
				component.render(80);
				component.render(140);
				color = "new";
				component.invalidate();
				assert.match(text(component), /new:custom body/);
				assert.equal(calls, 1);
			},
			changingTheme,
		);
	});
	it("sanitizes tool headers, custom labels and assistant errors before paint", () => {
		const poison = "\x1b]0;title\x07bad\x1b[2J\x00\r\nnext\x1b_Payload\x1b\\";
		const lines = renderConversation(
			[
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: poison } }],
				},
				{ role: "assistant", content: [], stopReason: "error", errorMessage: poison },
				{ role: "custom", customType: poison, content: [{ type: "text", text: poison }] },
			],
			{ width: 30, theme },
		);
		for (const line of lines) {
			assert.equal(visibleWidth(line), 30);
			assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
		}
		assert.doesNotMatch(lines.join("\n"), /title|Payload/);
	});
});
