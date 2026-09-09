import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { CollaborationEvent, CollaborationParticipant, CollaborationSnapshot } from "./collaboration-types.ts";
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
	getBgAnsi: (_color: string) => "",
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	inverse: (text: string) => text,
} as unknown as Theme;

function participant(id: string, parentId: string | null, overrides: Partial<CollaborationParticipant> = {}) {
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
	} satisfies CollaborationParticipant;
}
function exchangeEvent(id: string, text: string, overrides: Partial<CollaborationEvent> = {}): CollaborationEvent {
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
		exchange: { kind: "peer", text },
		...overrides,
	};
}
function snapshot(): CollaborationSnapshot {
	return {
		familyId: "root",
		families: [{ id: "root", label: "Current family" }],
		participants: [
			participant("root", null),
			participant("worker-a", "root"),
			participant("worker-b", "root"),
			participant("worker-c", "root"),
		],
		events: [
			exchangeEvent("q1", "raw q1 envelope", { exchange: { kind: "peer", text: "question one" } }),
			exchangeEvent("r1", "raw r1 envelope", {
				actorId: "worker-b",
				recipientId: "worker-a",
				replyTo: "message-q1",
				workerId: "worker-b",
				exchange: { kind: "peer", text: "answer one" },
			}),
			exchangeEvent("z9", "raw z9 envelope", {
				actorId: "worker-c",
				recipientId: "root",
				kind: "report",
				workerId: "worker-c",
				timestamp: 9,
				exchange: { kind: "report", text: "final report" },
			}),
		],
		obligations: [],
		outstandingRequired: [],
		unaccepted: [],
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
		sessionFile: `/sessions/${id}.jsonl`,
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
	start: "overview" | "communications" = "overview",
): Promise<void> {
	let closeCount = 0;
	const terminal = { rows: 32 };
	const ctx = {
		ui: {
			custom: async (factory: (tui: unknown, theme: Theme, keys: unknown, done: () => void) => Component) => {
				const component = factory({ terminal, requestRender: () => undefined }, theme, undefined, () => {
					closeCount++;
				});
				component.focused = true;
				try {
					if (start === "communications") component.handleInput("m");
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
	const lines = component.render(width).map(stripTerminalSequences);
	return (
		lines[0]?.startsWith("┌")
			? lines
					.slice(1, -1)
					.filter((line) => !line.startsWith("├"))
					.map((line) => line.slice(2, -2))
			: lines
	).join("\n");
}

function assertExchangeProvenance(output: string, kind: "peer" | "report"): void {
	const row = output.split("\n").find((line) => line.includes("unverified"));
	assert.ok(row, "the selected exchange retains its unverified attribution");
	assert.match(row, /\brecorded\b/);
	assert.match(row, /\d{2}:\d{2}:\d{2}/);
	assert.match(row, new RegExp(`\\b${kind}\\b`));
}

describe("overview navigation, scope, and action targets", () => {
	it("moves selection with paging keys inside a two-row window", async () => {
		const records = Array.from({ length: 12 }, (_, index) =>
			worker(`bg-${String(index).padStart(2, "0")}`, { lastOutput: `out-${String(index).padStart(2, "0")}` }),
		);
		await panel(deps({ readWorkers: () => records }), async (component, terminal) => {
			terminal.rows = 10;
			assert.match(text(component), /Task for bg-00/);
			assert.match(text(component), /out-00/);
			assert.doesNotMatch(text(component), /out-11/);
			component.handleInput("\x1b[F");
			assert.match(text(component), /Task for bg-11/);
			assert.match(text(component), /out-11/);
			assert.doesNotMatch(text(component), /out-00/);
			component.handleInput("\x1b[H");
			assert.match(text(component), /Task for bg-00/);
			assert.doesNotMatch(text(component), /Task for bg-11/);
			component.handleInput("\x1b[6~");
			assert.match(text(component), /Task for bg-10/);
			component.handleInput("\x1b[5~");
			assert.match(text(component), /Task for bg-00/);
			component.handleInput("\x1b[A");
			assert.match(text(component), /Task for bg-00/);
		});
	});
	it("selects the first filter match, keeps the filter on Enter, and clears it with Escape", async () => {
		const records = [
			worker("bg-first", { lastOutput: "out-first" }),
			worker("bg-second", { lastOutput: "out-second" }),
		];
		await panel(deps({ readWorkers: () => records }), async (component) => {
			component.handleInput("/");
			for (const char of "second") component.handleInput(char);
			assert.match(text(component), /\/ second/);
			assert.match(text(component), /out-second/);
			assert.doesNotMatch(text(component), /out-first/);
			component.handleInput("\r");
			assert.match(text(component), /Task for bg-second/);
			assert.match(text(component), /2 workers/);
			assert.match(text(component), /out-second/);
			assert.doesNotMatch(text(component), /out-first/);
			component.handleInput("/");
			component.handleInput("\x1b");
			assert.match(text(component), /Task for bg-first/);
			assert.match(text(component), /out-first/);
			assert.match(text(component), /bg-second/);
			component.handleInput("\x1b[B");
			assert.match(text(component), /out-second/);
		});
	});
	it("returns selection to a visible worker when the store drops the selected record", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		const records = [worker("bg-first"), worker("bg-second")];
		await panel(deps({ readWorkers: () => records }), async (component) => {
			component.handleInput("\x1b[B");
			assert.match(text(component), /Task for bg-second/);
			records.pop();
			context.mock.timers.tick(1_000);
			await flush();
			assert.match(text(component), /Task for bg-first/);
			assert.doesNotMatch(text(component), /Task for bg-second/);
		});
	});
	it("resets selection and details when a scope change hides the selected worker", async () => {
		const own = worker("bg-own");
		const foreign = worker("bg-foreign", { ownerSession: "another-manager" });
		await panel(deps({ readWorkers: (owner) => (owner ? [own] : [own, foreign]) }), async (component) => {
			assert.match(text(component), /OVERVIEW · DIRECT CHILDREN/);
			assert.match(text(component), /Task for bg-own/);
			component.handleInput("a");
			assert.match(text(component), /ALL SESSIONS/);
			assert.match(text(component), /Task for bg-own/);
			component.handleInput("\x1b[B");
			assert.match(text(component), /Task for bg-foreign/);
			component.handleInput("d");
			assert.match(text(component), /WORKER bg-foreign/);
			component.handleInput("a");
			assert.match(text(component), /DIRECT CHILDREN/);
			assert.match(text(component), /WORKER bg-own/);
			assert.doesNotMatch(text(component), /WORKER bg-foreign/);
		});
	});
	it("routes interrupt and cancel to the selected worker and refuses foreign control", async () => {
		const records = [worker("bg-first"), worker("bg-second")];
		let interrupted = "";
		let cancelled = "";
		await panel(
			deps({
				readWorkers: () => records,
				interrupt: async (id) => {
					interrupted = id;
					return "interrupted";
				},
				kill: async (id) => {
					cancelled = id;
					return "cancelled";
				},
			}),
			async (component) => {
				component.handleInput("\x1b[B");
				assert.match(text(component), /Task for bg-second/);
				component.handleInput("i");
				await flush();
				assert.equal(interrupted, "bg-second");
				component.handleInput("k");
				await flush();
				assert.equal(cancelled, "bg-second");
			},
		);
		let refused = 0;
		await panel(
			deps({
				readWorkers: () => records,
				isLive: () => false,
				kill: async () => {
					refused++;
					return "cancelled";
				},
			}),
			async (component) => {
				component.handleInput("i");
				await flush();
				assert.match(text(component), /does not own live control/);
				assert.equal(refused, 0);
			},
		);
	});
	it("shows reachable actions and scope guidance in the empty overview", async () => {
		const foreign = worker("bg-foreign", { ownerSession: "other" });
		await panel(deps({ readWorkers: (owner) => (owner ? [] : [foreign]) }), async (component) => {
			const empty = text(component);
			assert.match(empty, /No direct children.*Press a for all sessions/);
			assert.match(empty, /a scope · m comms/);
			assert.match(empty, /enter open/);
			assert.doesNotMatch(empty, /i interrupt|k cancel/);
			assert.match(empty, /esc close/);
			component.handleInput("a");
			const populated = text(component);
			assert.match(populated, /Task for bg-foreign/);
			assert.doesNotMatch(populated, /a scope · m communications/);
		});
	});
	it("returns from a worker console to the overview with escape twice", async () => {
		await panel(deps(), async (component, _terminal, closed) => {
			component.handleInput("\r");
			assert.match(text(component), /worker-a · active/);
			component.handleInput("\x1b");
			assert.match(text(component), /OVERVIEW · DIRECT CHILDREN/);
			assert.equal(closed(), 0);
			component.handleInput("\x1b");
			assert.equal(closed(), 1);
		});
	});
	it("follows a continuation into its console and selects it on return", async () => {
		const settled = worker("bg-done", { state: "done", exitedAt: 5 });
		const records = [settled];
		const continuation = worker("bg-cont", { state: "running", startedAt: 10 });
		await panel(
			deps({
				readWorkers: () => records,
				readWorker: (id) => records.find((record) => record.id === id) ?? null,
				isLive: () => false,
				continueWorker: async () => {
					records.push(continuation);
					return { id: "bg-cont", text: "continuation started" };
				},
			}),
			async (component) => {
				component.handleInput("\r");
				assert.match(text(component), /bg-done · done/);
				component.handleInput("r");
				for (const char of "resume work") component.handleInput(char);
				component.handleInput("\r");
				await flush();
				assert.match(text(component), /bg-cont · active/);
				assert.match(text(component), /continuation started/);
				component.handleInput("\x1b");
				assert.match(text(component), /OVERVIEW · DIRECT CHILDREN/);
				assert.match(text(component), /Task for bg-cont/);
				assert.doesNotMatch(text(component), /Task for bg-done/);
			},
		);
	});
	it("shows worker identity and selected owner with a matched-count search line", async () => {
		const own = worker("bg-own", { lastOutput: "out-own" });
		const foreign = worker("bg-foreign", { ownerSession: "another-manager", lastOutput: "out-foreign" });
		await panel(deps({ readWorkers: (owner) => (owner ? [own] : [own, foreign]) }), async (component) => {
			const children = text(component, 140);
			assert.doesNotMatch(children, /Worker +State/);
			assert.match(children, /› bg-own[\s\S]*active/);
			assert.doesNotMatch(children, /OWNER/);
			component.handleInput("a");
			const all = text(component, 140);
			assert.match(all, /Owner: root/);
			assert.match(all, /bg-foreign/);
			component.handleInput("\x1b[B");
			assert.match(text(component, 140), /Owner: another-manager/);
			component.handleInput("/");
			for (const char of "foreign") component.handleInput(char);
			assert.match(text(component, 140), /1\/2 workers · \/foreign/);
			assert.match(text(component, 140), /out-foreign/);
			assert.doesNotMatch(text(component, 140), /out-own/);
		});
	});
	it("shrinks overview details to their content and keeps narrow escape hints", async () => {
		await panel(deps({ readWorkers: () => [worker("bg-own")] }), async (component, terminal) => {
			terminal.rows = 40;
			component.handleInput("d");
			const details = component.render(140);
			assert.ok(details.length <= 21, `details height ${details.length} exceeds content plus frame`);
			assert.match(details.join("\n"), /WORKER bg-own/);
			component.handleInput("\x1b");
			const narrow = text(component, 30);
			assert.match(narrow, /↑↓ select/);
			assert.match(narrow, /esc close/);
			const veryNarrow = text(component, 20);
			assert.match(veryNarrow, /esc close/);
		});
	});
});

function readPosition(component: Component, width: number): { first: number; last: number; total: number } {
	const match = text(component, width).match(/lines (\d+)-(\d+)\/(\d+)/);
	assert.ok(match, "the selected exchange has a visible read position");
	return { first: Number(match[1]), last: Number(match[2]), total: Number(match[3]) };
}
function longExchange(prefix: string, count = 72): string {
	return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}`).join("\n\n");
}
function readingSnapshot(): CollaborationSnapshot {
	const current = snapshot();
	current.events[0].exchange = { kind: "peer", text: longExchange("QUESTION") };
	current.events[1].exchange = { kind: "peer", text: longExchange("ANSWER") };
	return current;
}

describe("selected exchange reader", () => {
	it("reaches every body line through page keys without changing the source or control target", async () => {
		const targets: string[] = [];
		await panel(
			deps({
				collaboration: async () => readingSnapshot(),
				interrupt: async (id) => {
					targets.push(id);
					return "interrupted";
				},
			}),
			async (component) => {
				const width = 180;
				assert.match(text(component, width), /ANSWER-00/);
				assert.doesNotMatch(text(component, width), /ANSWER-71/);
				const start = readPosition(component, width);
				component.handleInput(" ");
				const space = readPosition(component, width);
				assert.ok(space.first > start.first);
				component.handleInput("b");
				assert.deepEqual(readPosition(component, width), start);
				component.handleInput("\x1b[6~");
				assert.deepEqual(readPosition(component, width), space);
				component.handleInput("\x1b[5~");
				assert.deepEqual(readPosition(component, width), start);
				const observed = new Set<string>();
				for (let page = 0; page < 100; page++) {
					for (const marker of text(component, width).match(/ANSWER-\d{2}/g) ?? []) observed.add(marker);
					const position = readPosition(component, width);
					if (position.last === position.total) break;
					component.handleInput(page % 2 ? " " : "\x1b[6~");
				}
				assert.deepEqual(
					[...observed].sort(),
					Array.from({ length: 72 }, (_, index) => `ANSWER-${String(index).padStart(2, "0")}`),
				);
				assert.match(text(component, width), /ANSWER-71/);
				const end = readPosition(component, width);
				component.handleInput(" ");
				assert.deepEqual(readPosition(component, width), end, "paging clamps at the end");
				component.handleInput("\x1b[H");
				assert.deepEqual(readPosition(component, width), start);
				component.handleInput("\x1b[F");
				assert.deepEqual(readPosition(component, width), end);
				component.handleInput("i");
				await flush();
				assert.deepEqual(targets, ["worker-b"]);
				component.handleInput("\r");
				assert.match(text(component, width), /EVENT r1/);
				assert.match(text(component, width), /raw r1 envelope/);
				component.handleInput("\x1b");
				assert.deepEqual(readPosition(component, width), end);
				component.handleInput("v");
				assert.match(text(component, width), /worker-b · active/);
			},
			"communications",
		);
	});
	it("uses arrows for event selection, ignores unknown keys, and resets each changed selection", async () => {
		await panel(
			deps({ collaboration: async () => readingSnapshot() }),
			async (component) => {
				const width = 180;
				text(component, width);
				component.handleInput("\x1b[F");
				assert.match(text(component, width), /ANSWER-71/);
				const end = readPosition(component, width);
				for (const key of ["z", "\x1b[C", "\x1b[D", "\x1b[122;5u"]) {
					component.handleInput(key);
					assert.deepEqual(readPosition(component, width), end);
					assert.match(text(component, width), /ANSWER-71/);
				}
				component.handleInput("\x1b[A");
				assert.match(text(component, width), /QUESTION-00/);
				assert.doesNotMatch(text(component, width), /ANSWER-71|QUESTION-71/);
				assert.equal(readPosition(component, width).first, 1);
				component.handleInput("\x1b[F");
				assert.match(text(component, width), /QUESTION-71/);
				component.handleInput("\x1b[B");
				assert.match(text(component, width), /ANSWER-00/);
				assert.equal(readPosition(component, width).first, 1);
				component.handleInput("\x1b[F");
				component.handleInput("\t");
				component.handleInput("\x1b[B");
				assert.match(text(component, width), /final report/);
				assert.equal(readPosition(component, width).first, 1);
				component.handleInput("\x1b[A");
				assert.match(text(component, width), /ANSWER-00/);
				assert.equal(readPosition(component, width).first, 1);
			},
			"communications",
		);
	});
	it("resolves selection and body dimensions before a page key without an intervening paint", async () => {
		await panel(
			deps({ collaboration: async () => readingSnapshot() }),
			async (component) => {
				text(component, 180);
				component.handleInput("\t");
				component.handleInput("\x1b[A");
				component.handleInput("\x1b[F");
				assert.match(text(component, 180), /QUESTION-71/);
				component.handleInput("\x1b[B");
				component.handleInput(" ");
				assert.ok(readPosition(component, 180).first > 1);
				assert.doesNotMatch(text(component, 180), /QUESTION-71/);
				component.handleInput("\r");
				assert.match(text(component, 180), /EVENT r1/);
			},
			"communications",
		);
	});
	it("preserves the selected event and read offset through live growth, new records, and reflow", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		const current = readingSnapshot();
		await panel(
			deps({ collaboration: async () => structuredClone(current) }),
			async (component, terminal) => {
				text(component, 180);
				component.handleInput(" ");
				const before = readPosition(component, 180);
				const markers = text(component, 180).match(/ANSWER-\d{2}/g);
				current.events[1].exchange = { kind: "peer", text: longExchange("ANSWER", 90) };
				current.events.push(
					exchangeEvent("new-10", "new source", { exchange: { kind: "peer", text: "NEWEST MESSAGE" } }),
				);
				context.mock.timers.tick(1000);
				await flush();
				const grown = readPosition(component, 180);
				assert.equal(grown.first, before.first);
				assert.ok(grown.total > before.total);
				assert.deepEqual(text(component, 180).match(/ANSWER-\d{2}/g), markers);
				assert.doesNotMatch(text(component, 180), /NEWEST MESSAGE/);
				for (const width of [60, 120, 180]) {
					assert.equal(readPosition(component, width).first, before.first);
					component.invalidate();
					assert.equal(readPosition(component, width).first, before.first);
					assert.doesNotMatch(text(component, width), /NEWEST MESSAGE/);
				}
				terminal.rows = 18;
				assert.equal(readPosition(component, 180).first, before.first);
				component.handleInput("\x1b[F");
				assert.match(text(component, 180), /ANSWER-89/);
				component.handleInput("\r");
				assert.match(text(component, 180), /EVENT r1/);
			},
			"communications",
		);
	});
	it("retains body access below long identity and conflict metadata on narrow and short terminals", async () => {
		const current = readingSnapshot();
		current.participants[1].label = "A participant with a long descriptive identity for source attribution";
		current.participants[2].label =
			"Another participant with a different long descriptive identity for source attribution";
		current.events[1].kind = "peer conflicting envelope";
		for (const [width, rows] of [
			[180, 16],
			[60, 16],
			[48, 12],
			[140, 12],
			[140, 10],
		]) {
			await panel(
				deps({ collaboration: async () => current }),
				async (component, terminal) => {
					terminal.rows = rows;
					text(component, width);
					component.handleInput("\x1b[H");
					const first = text(component, width);
					assert.match(first, /ANSWER-00/, `body start remains visible at ${width}x${rows}`);
					assert.match(first, /unverified/, `provenance remains visible at ${width}x${rows}`);
					assert.match(first, /esc/);
					component.handleInput("\x1b[F");
					assert.match(text(component, width), /ANSWER-71/, `body end remains reachable at ${width}x${rows}`);
					const end = readPosition(component, width);
					component.handleInput("b");
					assert.ok(readPosition(component, width).last < end.last);
					assert.ok(component.render(width).length <= rows - 2);
				},
				"communications",
			);
		}
	});
});

describe("communications navigation and visible targets", () => {
	it("targets the visibly selected exchange for worker actions on first entry", async () => {
		let interrupted = "";
		await panel(
			deps({
				interrupt: async (id) => {
					interrupted = id;
					return "interrupted";
				},
			}),
			async (component) => {
				const output = text(component, 180);
				assert.match(output, /CONVERSATIONS · 2/);
				assert.match(output, /› worker-a ↔ worker-b/);
				assert.doesNotMatch(output, /› root ↔ worker-c/);
				assert.match(output, /↔ worker-b → worker-a/);
				assertExchangeProvenance(output, "peer");
				assert.doesNotMatch(output, /worker-c → root/);
				component.handleInput("i");
				await flush();
				assert.equal(interrupted, "worker-b");
				component.handleInput("v");
				assert.match(text(component, 180), /worker-b · active/);
				assert.doesNotMatch(text(component, 180), /worker-c · active/);
				component.handleInput("\x1b");
				component.handleInput("\r");
				assert.match(text(component, 180), /EVENT r1/);
			},
			"communications",
		);
	});
	it("walks threads and messages with tab and arrows on a narrow terminal", async () => {
		await panel(
			deps(),
			async (component) => {
				const left = text(component, 60);
				assert.match(left, /CONVERSATIONS · 2/);
				assert.doesNotMatch(left, /EXCHANGES/);
				component.handleInput("\x1b[B");
				const switched = text(component, 60);
				assert.match(switched, /› root ↔ worker-c/);
				assert.doesNotMatch(switched, /› worker-a ↔ worker-b/);
				component.handleInput("\t");
				const right = text(component, 60);
				assert.match(right, /EXCHANGES · selected/);
				assert.match(right, /← worker-c → root/);
				assertExchangeProvenance(right, "report");
				assert.doesNotMatch(right, /CONVERSATIONS ·/);
				component.handleInput("\t");
				component.handleInput("\x1b[A");
				assert.match(text(component, 60), /› worker-a ↔ worker-b/);
				component.handleInput("\t");
				const thread = text(component, 60);
				assert.match(thread, /↔ worker-b → worker-a/);
				assertExchangeProvenance(thread, "peer");
				assert.match(thread, /answer one/);
				component.handleInput("\x1b[A");
				const earlier = text(component, 60);
				assert.match(earlier, /↔ worker-a → worker-b/);
				assertExchangeProvenance(earlier, "peer");
				assert.match(earlier, /question one/);
				assert.doesNotMatch(earlier, /answer one/);
				component.handleInput("\x1b[B");
				component.handleInput("\r");
				const detail = text(component, 60);
				assert.match(detail, /EVENT r1/);
				assert.match(detail, /raw r1 envelope/);
				component.handleInput("\x1b");
				assert.match(text(component, 60), /EXCHANGES · selected/);
				component.handleInput("\t");
				assert.match(text(component, 60), /CONVERSATIONS · 2/);
			},
			"communications",
		);
	});
	it("recovers selection across mode, evidence, focus, and escape transitions", async () => {
		await panel(
			deps(),
			async (component, _terminal, closed) => {
				assert.match(text(component, 180), /CONVERSATIONS · 2/);
				component.handleInput("\t");
				assert.match(text(component, 180), /EXCHANGES · selected/);
				component.handleInput("\t");
				assert.match(text(component, 180), /CONVERSATIONS · 2/);
				assert.doesNotMatch(text(component, 180), /EXCHANGES · selected/);
				component.handleInput("e");
				const evidence = text(component, 180);
				assert.match(evidence, /TIMELINE · 3 events/);
				assert.match(evidence, /WORKERS · 3/);
				assert.doesNotMatch(evidence, /CONVERSATIONS ·/);
				component.handleInput("\t");
				assert.match(text(component, 180), /WORKERS · 3 · tab focus/);
				component.handleInput("\t");
				const detail = text(component, 180);
				assert.match(detail, /PARTICIPANT worker-a/);
				assert.match(detail, /Owner: root/);
				component.handleInput("\x1b");
				assert.match(text(component, 180), /TIMELINE · 3 events/);
				component.handleInput("e");
				assert.match(text(component, 180), /CONVERSATIONS · 2/);
				component.handleInput("m");
				assert.match(text(component, 180), /OVERVIEW · DIRECT CHILDREN/);
				assert.equal(closed(), 0);
				component.handleInput("\x1b");
				assert.equal(closed(), 1);
			},
			"communications",
		);
	});
});
