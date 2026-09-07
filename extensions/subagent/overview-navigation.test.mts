import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type {
	CollaborationEvent,
	CollaborationParticipant,
	CollaborationSnapshot,
} from "./collaboration-types.ts";
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
function exchangeEvent(
	id: string,
	text: string,
	overrides: Partial<CollaborationEvent> = {},
): CollaborationEvent {
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
	return stripTerminalSequences(component.render(width).join("\n"));
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
		await panel(
			deps({ readWorkers: (owner) => (owner ? [own] : [own, foreign]) }),
			async (component) => {
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
			},
		);
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
		await panel(
			deps({ readWorkers: (owner) => (owner ? [] : [foreign]) }),
			async (component) => {
				const empty = text(component);
				assert.match(empty, /No direct children.*Press a for all sessions/);
				assert.match(empty, /a scope · m communications/);
				assert.match(empty, /enter console/);
				assert.match(empty, /i interrupt/);
				assert.match(empty, /k cancel/);
				assert.match(empty, /esc close/);
				component.handleInput("a");
				const populated = text(component);
				assert.match(populated, /Task for bg-foreign/);
				assert.doesNotMatch(populated, /a scope · m communications/);
			},
		);
	});
	it("returns from a worker console to the overview with escape twice", async () => {
		await panel(deps(), async (component, _terminal, closed) => {
			component.handleInput("\r");
			assert.match(text(component), /worker-a · Task for worker-a/);
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
				assert.match(text(component), /bg-done · Task for bg-done/);
				component.handleInput("r");
				for (const char of "resume work") component.handleInput(char);
				component.handleInput("\r");
				await flush();
				assert.match(text(component), /bg-cont · Task for bg-cont/);
				assert.match(text(component), /continuation started/);
				component.handleInput("\x1b");
				assert.match(text(component), /OVERVIEW · DIRECT CHILDREN/);
				assert.match(text(component), /Task for bg-cont/);
				assert.doesNotMatch(text(component), /Task for bg-done/);
			},
		);
	});
	it("shows worker and owner columns with a matched-count search line", async () => {
		const own = worker("bg-own", { lastOutput: "out-own" });
		const foreign = worker("bg-foreign", { ownerSession: "another-manager", lastOutput: "out-foreign" });
		await panel(
			deps({ readWorkers: (owner) => (owner ? [own] : [own, foreign]) }),
			async (component) => {
				const children = text(component, 140);
				assert.match(children, /WORKER +STATE/);
				assert.match(children, /› bg-own +paused|› bg-own +running/);
				assert.doesNotMatch(children, /OWNER/);
				component.handleInput("a");
				const all = text(component, 140);
				assert.match(all, /OWNER/);
				assert.match(all, /bg-foreign/);
				assert.match(all, /…anager/);
				component.handleInput("/");
				for (const char of "foreign") component.handleInput(char);
				assert.match(text(component, 140), /1\/2 workers · \/foreign/);
				assert.match(text(component, 140), /out-foreign/);
				assert.doesNotMatch(text(component, 140), /out-own/);
			},
		);
	});
	it("shrinks overview details to their content and keeps narrow escape hints", async () => {
		await panel(deps({ readWorkers: () => [worker("bg-own")] }), async (component, terminal) => {
			terminal.rows = 40;
			component.handleInput("d");
			const details = component.render(140);
			assert.ok(details.length <= 18, `details height ${details.length} exceeds content`);
			assert.match(details.join("\n"), /WORKER bg-own/);
			component.handleInput("\x1b");
			const narrow = text(component, 30);
			assert.match(narrow, /a scope/);
			assert.match(narrow, /m comms/);
			assert.match(narrow, /esc close/);
			const veryNarrow = text(component, 20);
			assert.match(veryNarrow, /a scope/);
			assert.match(veryNarrow, /esc close/);
		});
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
				assert.match(output, /▌↔ \d{2}:\d{2}:\d{2} worker-b → worker-a peer recorded/);
				assert.doesNotMatch(output, /worker-c → root/);
				component.handleInput("i");
				await flush();
				assert.equal(interrupted, "worker-b");
				component.handleInput("v");
				assert.match(text(component, 180), /worker-b · Task for worker-b/);
				assert.doesNotMatch(text(component, 180), /worker-c · Task for worker-c/);
				component.handleInput("\x1b");
				component.handleInput("\r");
				assert.match(text(component, 180), /EVENT r1/);
			},
			"communications",
		);
	});
	it("walks threads and messages with tab and arrows on a narrow terminal", async () => {
		await panel(deps(), async (component) => {
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
			assert.match(right, /▌← \d{2}:\d{2}:\d{2} worker-c → root report recorded/);
			assert.doesNotMatch(right, /CONVERSATIONS ·/);
			component.handleInput("\t");
			component.handleInput("\x1b[A");
			assert.match(text(component, 60), /› worker-a ↔ worker-b/);
			component.handleInput("\t");
			const thread = text(component, 60);
			assert.match(thread, /▌↔ \d{2}:\d{2}:\d{2} worker-b → worker-a peer recorded/);
			assert.match(thread, /answer one/);
			component.handleInput("\x1b[A");
			const earlier = text(component, 60);
			assert.match(earlier, /↔ \d{2}:\d{2}:\d{2} worker-a → worker-b peer recorded/);
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
		}, "communications");
	});
	it("recovers selection across mode, evidence, focus, and escape transitions", async () => {
		await panel(deps(), async (component, _terminal, closed) => {
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
		}, "communications");
	});
});
