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
import {
	clockTime,
	footerLine,
	headerPair,
	openSubagentPanel,
	positionLabel,
	readerMeasure,
	styleMarkdownBlock,
	styleMarkers,
	threadPaneWidth,
	truncateResidue,
	type FooterStyles,
	type MarkerStyles,
	type SubagentPanelDeps,
} from "./panel.ts";

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
	start: "overview" | "communications" | "evidence" = "evidence",
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
					if (start !== "overview") component.handleInput("m");
					await flush();
					if (start === "evidence") component.handleInput("e");
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

describe("worker overview and separate communications", () => {
	it("defaults to direct-child status without any collaboration query, and preserves all-session scope", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		const records = [
			worker("bg-direct", {
				model: "test/overview-model",
				currentTool: "read",
				lastOutput: "Checking exported functions",
				usage: { cost: 1.25 } as Worker["usage"],
			}),
			worker("bg-nested", { ownerSession: "child-session" }),
			worker("bg-foreign", { ownerSession: "another-manager" }),
		];
		let queries = 0;
		const scopes: Array<string | undefined> = [];
		await panel(
			deps({
				readWorkers: (owner) => {
					scopes.push(owner);
					return records.filter((record) => !owner || record.ownerSession === owner);
				},
				collaboration: async () => {
					queries++;
					return snapshot();
				},
			}),
			async (component) => {
				const output = text(component, 180);
				assert.match(output, /OVERVIEW · DIRECT CHILDREN/);
				assert.match(output, /1 workers · 1 running/);
				assert.match(output, /overview-model.*\$1\.25.*read.*Checking exported functions/);
				assert.doesNotMatch(output, /TIMELINE|HISTORY|bg-nested|bg-foreign/);
				context.mock.timers.tick(1000);
				await flush();
				assert.equal(queries, 0);
				assert.equal(scopes[0], "root");
				component.handleInput("a");
				assert.match(text(component), /ALL SESSIONS/);
				assert.match(text(component), /3 workers/);
				component.handleInput("m");
				await flush();
				assert.equal(queries, 1);
				assert.match(text(component), /COMMUNICATIONS/);
				component.handleInput("m");
				assert.match(text(component), /OVERVIEW · ALL SESSIONS/);
			},
			theme,
			"overview",
		);
	});
	it("keeps an empty overview short and makes other sessions reachable", async () => {
		await panel(
			deps({ readWorkers: (owner) => (owner ? [] : [worker("bg-foreign", { ownerSession: "other" })]) }),
			async (component, terminal) => {
				terminal.rows = 80;
				assert.ok(component.render(140).length <= 8);
				assert.match(text(component), /No direct children.*Press a for all sessions/);
				component.handleInput("a");
				assert.match(text(component), /1 workers/);
				assert.doesNotMatch(text(component), /No direct children/);
			},
			theme,
			"overview",
		);
	});
	it("preserves selected worker controls through live reorder and returns from its console to overview", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		let records = [worker("bg-first"), worker("bg-second")];
		let interrupted = "";
		await panel(
			deps({
				readWorkers: () => records,
				interrupt: async (id) => {
					interrupted = id;
					return "interrupted";
				},
			}),
			async (component) => {
				component.handleInput("\x1b[B");
				records = [records[1], records[0]];
				context.mock.timers.tick(1000);
				await flush();
				component.handleInput("i");
				await flush();
				assert.equal(interrupted, "bg-second");
				component.handleInput("\r");
				assert.match(text(component), /bg-second/);
				component.handleInput("\x1b");
				assert.match(text(component), /OVERVIEW/);
				component.handleInput("d");
				assert.match(text(component), /WORKER bg-second/);
			},
			theme,
			"overview",
		);
	});
	it("uses native overview search and keeps all overview widths bounded", async () => {
		await panel(
			deps({ readWorkers: () => [worker("bg-search", { task: "資料 review" })] }),
			async (component, terminal) => {
				component.handleInput("/");
				assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
				component.handleInput("\x1b[200~資料\x1b[201~");
				assert.match(text(component, 80), /資料/);
				component.handleInput("\r");
				for (const width of [180, 100, 48, 24, 10, 3, 1])
					for (const line of component.render(width)) assert.equal(visibleWidth(line), width);
				terminal.rows = 4;
				assert.ok(component.render(20).length <= 2);
				assert.match(text(component, 20), /esc/);
			},
			theme,
			"overview",
		);
	});
	it("overview rows render a stored label instead of the worker id", async () => {
		await panel(
			deps({ readWorkers: () => [worker("bg-direct", { label: "review-check" })] }),
			async (component) => {
				const output = text(component, 180);
				assert.match(output, /review-check\s+running/);
			},
			theme,
			"overview",
		);
	});
	it("overview rows fall back to the id when a label is null, absent, or equal to the id", async () => {
		await panel(
			deps({
				readWorkers: () => [worker("bg-null", { label: null }), worker("bg-self", { label: "bg-self" }), worker("bg-plain")],
			}),
			async (component) => {
				const output = text(component, 180);
				assert.match(output, /bg-null/);
				assert.match(output, /bg-self/);
				assert.match(output, /bg-plain/);
			},
			theme,
			"overview",
		);
	});
	it("thread labels show a participant label while details keep exact ids", async () => {
		const current = snapshot();
		current.participants = [
			participant("root", null),
			participant("worker-a", "root", { label: "review-check" }),
			participant("worker-b", "worker-a"),
		];
		current.events = [
			event("peer-1", "peer body", {
				actorId: "worker-a",
				recipientId: "worker-b",
				exchange: { kind: "peer", text: "peer body" },
			}),
		];
		await panel(
			deps({ collaboration: async () => current }),
			async (component) => {
				const output = text(component, 180);
				assert.match(output, /review-check/);
				component.handleInput("\r");
				const details = text(component, 140);
				assert.match(details, /Actor: worker-a/);
				assert.match(details, /Recipient: worker-b/);
			},
			theme,
			"communications",
		);
	});
	it("shows peer and manager conversations without management-tool noise, with a separate source view", async () => {
		const current = snapshot();
		current.events = [
			event("question", "raw peer envelope", {
				exchange: { kind: "peer", text: "Does the interface preserve the source?" },
			}),
			event("reply", "raw reply envelope", {
				actorId: "worker-b",
				recipientId: "worker-a",
				replyTo: "message-question",
				exchange: { kind: "peer", text: "Yes. The checked source keeps the identifier." },
			}),
			event("noise", "raw status payload", { kind: "call subagent_status" }),
			event("report", "raw manager envelope", {
				recipientId: "root",
				exchange: { kind: "report", text: "The interface check passed." },
			}),
		];
		await panel(
			deps({ collaboration: async () => current }),
			async (component, terminal) => {
				assert.match(text(component, 180), /CONVERSATIONS · 2/);
				assert.match(text(component, 180), /Does the interface preserve/);
				assert.match(text(component, 180), /checked source keeps/);
				assert.doesNotMatch(text(component, 180), /raw status payload|raw peer envelope|call subagent_status/);
				component.handleInput("\x1b[B");
				assert.match(text(component, 180), /The interface check passed/);
				component.handleInput("\r");
				assert.match(text(component, 180), /raw manager envelope/);
				component.handleInput("\x1b");
				component.handleInput("e");
				assert.match(text(component, 180), /raw status payload/);
				component.handleInput("e");
				terminal.rows = 16;
				component.handleInput("\t");
				assert.match(text(component, 48), /EXCHANGES/);
				assert.match(text(component, 48), /interface check passed/);
			},
			theme,
			"communications",
		);
	});
	it("attributes and bounds readable exchanges with whole cards and conflict flags", async () => {
		const current = snapshot();
		current.events = [
			...Array.from({ length: 4 }, (_, index) =>
				event(`m${index}`, `recorded envelope ${index} keeps readable message ${index} verbatim`, {
					exchange: { kind: "peer", text: `readable message ${index}` },
				}),
			),
			event("m4", "recorded envelope four keeps readable message four verbatim", {
				actorId: "worker-b",
				recipientId: "worker-a",
				kind: "peer conflicting envelope",
				exchange: { kind: "peer", text: "readable message four" },
			}),
			event("solo", "recorded manager envelope keeps the settled report", {
				actorId: "worker-c",
				recipientId: "root",
				kind: "report",
				workerId: "worker-c",
				exchange: { kind: "report", text: "the settled report" },
			}),
		];
		await panel(
			deps({ collaboration: async () => current }),
			async (component, terminal) => {
				terminal.rows = 16;
				const wide = text(component, 180);
				assert.match(wide, /CONVERSATIONS · 2/);
				assert.doesNotMatch(wide, /Manager ↔ peers/);
				assert.match(wide, /worker-a ↔ worker-b/);
				assert.match(wide, /EXCHANGES · unverified/);
				assert.doesNotMatch(wide, /\d+ exchange record/);
				assert.match(wide, /root ↔ worker-c\s+1 10:00:00 report/);
				assert.match(wide, /worker-c/);
				const lines = wide.split("\n");
				const hint = lines.findIndex((line) => /earlier exchange records/.test(line));
				assert.ok(hint >= 0, "hidden cards are counted");
				assert.match(lines[hint], /… [0-9]+ earlier exchange records/);
				assert.match(lines[hint + 1], /\d{2}:\d{2}:\d{2}.*→.*peer/);
				const unverified = wide.match(/unverified/g) ?? [];
				assert.equal(unverified.length, 1);
				const matches = wide.match(/conflicting envelope/g) ?? [];
				assert.equal(matches.length, 1);
				assert.match(wide, /readable message four/);
			},
			theme,
			"communications",
		);
	});
	it("does not flag valid multiline or quoted envelope text and flags only recorded conflicts", async () => {
		const current = snapshot();
		current.events = [
			event("steer-out", 'steer arguments {"message": "step one\\nthen check \\"quoted\\" text"} recorded verbatim', {
				actorId: "root",
				recipientId: "worker-a",
				kind: "steer",
				workerId: null,
				exchange: { kind: "steer", text: 'step one then check "quoted" text' },
			}),
			event("peer-in", 'peer envelope body\\nwith \\"quoted\\" newline\\nrecords intact', {
				exchange: { kind: "peer", text: 'peer envelope body with "quoted" newline records intact' },
			}),
		];
		await panel(
			deps({ collaboration: async () => current }),
			async (component) => {
				const output = text(component, 180);
				assert.match(output, /step one then check "quoted" text/);
				assert.doesNotMatch(output, /conflicting envelope/);
				assert.match(output, /unverified/);
				component.handleInput("\x1b[B");
				const peer = text(component, 180);
				assert.match(peer, /peer envelope body with "quoted" newline/);
				assert.doesNotMatch(peer, /conflicting envelope/);
			},
			theme,
			"communications",
		);
	});
	it("shows Loading while the family snapshot is pending and a true empty state after load", async () => {
		const pending = deferred<CollaborationSnapshot>();
		await panel(
			deps({ collaboration: () => pending.promise }),
			async (component) => {
				const loading = text(component, 140);
				assert.match(loading, /Loading conversations…/);
				assert.doesNotMatch(loading, /No recorded conversations/);
				pending.resolve({ ...snapshot(), events: [] });
				await flush();
				assert.match(text(component, 140), /No recorded conversations in this family\./);
				assert.doesNotMatch(text(component, 140), /Loading conversations/);
			},
			theme,
			"communications",
		);
	});
	it("keeps f filtering inside raw evidence with mode-specific footers", async () => {
		const current = snapshot();
		current.events = [
			event("q", "raw peer envelope keeps the readable question", {
				exchange: { kind: "peer", text: "the readable question" },
			}),
			event("r", "raw reply envelope keeps the readable answer", {
				actorId: "worker-b",
				recipientId: "worker-a",
				exchange: { kind: "peer", text: "the readable answer" },
			}),
			event("unrelated", "raw unrelated exchange", { actorId: "root", recipientId: "worker-c", workerId: null }),
		];
		await panel(
			deps({ collaboration: async () => current }),
			async (component) => {
				const conversations = text(component, 180);
				assert.doesNotMatch(conversations, /f filter/);
				component.handleInput("f");
				assert.match(text(component, 180), /Filtering applies to raw evidence only/);
				assert.match(text(component, 180), /readable question/);
			},
			theme,
			"communications",
		);
		await panel(
			deps({ collaboration: async () => current }),
			async (component) => {
				component.handleInput("e");
				const evidence = text(component, 180);
				assert.match(evidence, /f filter/);
				assert.match(evidence, /e conversations/);
				assert.match(evidence, /raw unrelated exchange/);
				component.handleInput("f");
				assert.doesNotMatch(text(component, 180), /raw unrelated exchange/);
				assert.match(text(component, 180), /filter worker-a/);
				component.handleInput("f");
				assert.match(text(component, 180), /raw unrelated exchange/);
			},
			theme,
			"communications",
		);
	});
	it("shows mode-specific help without leaking history chrome into the overview", async () => {
		await panel(
			deps(),
			async (component) => {
				component.handleInput("?");
				const overviewHelp = text(component, 140);
				assert.match(overviewHelp, /DASHBOARD HELP/);
				assert.match(overviewHelp, /never queries collaboration data or history/);
				assert.match(overviewHelp, /a toggles every known session/);
				assert.doesNotMatch(overviewHelp, /LIVE MEMORY|HISTORY ·|In raw evidence only/);
				component.handleInput("\x1b");
				assert.match(text(component, 140), /OVERVIEW · DIRECT CHILDREN/);
			},
			theme,
			"overview",
		);
		await panel(
			deps({
				collaboration: async () => ({
				...snapshot(),
				events: [
					event("q", "raw peer envelope keeps the readable question", {
						exchange: { kind: "peer", text: "the readable question" },
					}),
				],
			}),
			}),
			async (component) => {
				component.handleInput("?");
				const communicationsHelp = text(component, 140).replace(/\s+/g, " ");
				assert.match(communicationsHelp, /worker-authored and unverified/);
				assert.match(communicationsHelp, /observed with differing envelope evidence/);
				assert.match(communicationsHelp, /In raw evidence only/);
				component.handleInput("\x1b");
				assert.match(text(component, 140), /CONVERSATIONS/);
			},
			theme,
			"communications",
		);
	});
});

describe("collaboration dashboard", () => {
	it("starts with the family timeline, nested ownership, and a separate continuation edge", async () => {
		await panel(deps(), async (component) => {
			const output = text(component, 180);
			assert.match(output, /FOLLOW TAIL · timeline · Current family/);
			assert.match(output, /WORKERS/);
			assert.match(output, /TIMELINE/);
			assert.match(output, /worker-a · same-model/);
			assert.match(output, /Task for worker-a/);
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
				assert.match(text(component), /HISTORY · 3 events · \+1\/-0/);
				component.handleInput("n");
				assert.match(text(component), /Last history snapshot:/);
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
			assert.match(after, /BROWSE · 1 new/);
			assert.match(after, /payload-1/);
			assert.doesNotMatch(after, /newest payload/);
			assert.match(before, /payload-1/);
			component.handleInput("\r");
			assert.match(text(component), /EVENT event-1/);
			component.handleInput("\x1b");
			component.handleInput("l");
			assert.match(text(component, 180), /FOLLOW TAIL/);
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
			assert.match(output, /Exact first message\s*\n\s*Second line/);
			assert.match(output, /Source: memory/);
			assert.match(output, /Session: session-a/);
			assert.match(output, /Entry: entry-event-1/);
			assert.match(output, /TASK \/ CONTEXT[\s\S]*Task for worker-a/);
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
				component.handleInput("n");
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
				assert.match(text(component, 180), /HISTORY/);
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
			component.handleInput("n");
			assert.match(text(component, 240), /View cache omitted 50 older events/);
			component.handleInput("\x1b");
			component.handleInput("\x1b[H");
			component.handleInput("\r");
			assert.match(text(component), /EVENT event-50/);
			component.handleInput("\x1b");
			context.mock.timers.tick(1_000);
			await flush();
			assert.match(text(component), /BROWSE · 0 new/);
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
			assert.match(text(component, 60), /WORKERS/);
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

describe("history feedback and dense layouts", () => {
	it("counts history additions against the retained view rather than omitted source events", async () => {
		const many = Array.from({ length: 1001 }, (_, index) => event(`event-${index}`, `body-${index}`));
		await panel(
			deps({ collaboration: async (query) => ({ ...snapshot(), events: query.history ? [many[0]] : many }) }),
			async (component) => {
				component.handleInput("h");
				await flush();
				assert.match(text(component), /HISTORY · 1 events · \+1\/-1000/);
			},
		);
	});
	it("ignores late history failures after another family becomes selected", async () => {
		const pending = deferred<CollaborationSnapshot>();
		await panel(
			deps({
				collaboration: async (query) =>
					query.familyId === "other"
						? { ...snapshot(), familyId: "other", notices: ["Other family source"] }
						: query.history
							? pending.promise
							: snapshot(),
			}),
			async (component) => {
				component.handleInput("h");
				component.handleInput("F");
				component.handleInput("\x1b[B");
				component.handleInput("\r");
				await flush();
				pending.reject(new Error("Old family failed"));
				await flush();
				component.handleInput("n");
				assert.match(text(component), /Family: other/);
				assert.match(text(component), /Other family source/);
				assert.doesNotMatch(text(component), /Old family failed|HISTORY FAILED/);
			},
		);
	});
	it("shows a pending history read immediately, coalesces repeats, and reports no change", async () => {
		const pending = deferred<CollaborationSnapshot>();
		let reads = 0;
		await panel(
			deps({
				collaboration: async (query) => {
					if (!query.history) return snapshot();
					reads++;
					return pending.promise;
				},
			}),
			async (component) => {
				component.handleInput("h");
				assert.match(text(component, 80).split("\n")[1], /HISTORY · Loading/);
				component.handleInput("h");
				assert.equal(reads, 1);
				pending.resolve(snapshot());
				await flush();
				assert.match(text(component, 80).split("\n")[1], /HISTORY · 2 events · \+0\/-0/);
				component.handleInput("n");
				assert.match(text(component), /No event identities changed/);
			},
		);
	});
	it("preserves historical omissions across live ticks, then replaces them on history refresh", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		let limited = true;
		await panel(
			deps({
				collaboration: async (query) => ({
					...snapshot(),
					notices:
						query.history && limited
							? [
									"The event count or byte limit was reached; additional evidence was omitted.",
									"Worker file exceeds the snapshot byte limit.",
								]
							: [],
				}),
			}),
			async (component) => {
				component.handleInput("h");
				await flush();
				context.mock.timers.tick(1000);
				await flush();
				assert.match(text(component, 80).split("\n")[1], /2 notices/);
				component.handleInput("n");
				assert.match(text(component), /Worker file exceeds/);
				assert.match(text(component), /event count or byte limit/);
				limited = false;
				component.handleInput("h");
				await flush();
				assert.doesNotMatch(text(component), /Worker file exceeds/);
				assert.match(text(component), /SOURCE NOTICES \(0\)/);
			},
		);
	});
	it("keeps history failures visible after later memory refresh and permits retry", async (context) => {
		context.mock.timers.enable({ apis: ["setInterval"] });
		let fail = true;
		await panel(
			deps({
				collaboration: async (query) => {
					if (query.history && fail) throw new Error("selected source unavailable");
					return snapshot();
				},
			}),
			async (component) => {
				component.handleInput("h");
				await flush();
				context.mock.timers.tick(1000);
				await flush();
				assert.match(text(component, 80).split("\n")[1], /HISTORY FAILED/);
				assert.match(text(component), /Exact reply/);
				component.handleInput("n");
				assert.match(text(component), /History read failed: selected source unavailable/);
				fail = false;
				component.handleInput("h");
				await flush();
				assert.match(text(component), /History read finished/);
				assert.doesNotMatch(text(component), /HISTORY FAILED/);
			},
		);
	});
	it("reports removals and does not leak history reports between families", async () => {
		await panel(
			deps({
				collaboration: async (query) =>
					query.familyId === "other"
						? {
								...snapshot(),
								familyId: "other",
								events: [],
								notices: [],
							}
						: query.history
							? { ...snapshot(), events: [], notices: ["Current family omission"] }
							: snapshot(),
			}),
			async (component) => {
				component.handleInput("h");
				await flush();
				assert.match(text(component), /HISTORY · 0 events · \+0\/-2/);
				component.handleInput("F");
				component.handleInput("\x1b[B");
				component.handleInput("\r");
				await flush();
				component.handleInput("n");
				assert.doesNotMatch(text(component), /Current family omission/);
				assert.match(text(component), /Family: other/);
			},
		);
	});
	it("wraps every notice, supports help and report paging on narrow terminals, and restores selection", async () => {
		const notices = Array.from(
			{ length: 30 },
			(_, index) => `Notice ${index}: source information with a long explanation for the selected family.`,
		);
		await panel(deps({ collaboration: async () => ({ ...snapshot(), notices }) }), async (component, terminal) => {
			terminal.rows = 16;
			component.handleInput("\x1b[H");
			component.handleInput("n");
			text(component, 48);
			component.handleInput("\x1b[F");
			assert.match(text(component, 48), /Notice 29:/);
			component.handleInput("b");
			assert.doesNotMatch(text(component, 48), /Notice 29:/);
			component.handleInput(" ");
			assert.match(text(component, 48), /Notice 29:/);
			component.handleInput("\x1b");
			component.handleInput("\r");
			assert.match(text(component, 48), /EVENT event-1/);
			component.handleInput("?");
			assert.match(text(component, 48), /DASHBOARD HELP/);
			component.handleInput("\x1b[F");
			assert.match(text(component, 48), /continuation remains\s+active/);
			for (const width of [180, 100, 48, 24, 10, 3, 1]) {
				for (const line of component.render(width)) assert.equal(visibleWidth(line), width);
				assert.ok(component.render(width).length <= terminal.rows - 2);
			}
			component.handleInput("\x1b");
			assert.match(text(component, 48), /EVENT event-1/);
		});
	});
	it("abbreviates colliding worker IDs distinctly while preserving state, model, text, and exact controls", async () => {
		const first = "bg-longfirsta123456",
			second = "bg-longsecondb123456";
		const current = {
			...snapshot(),
			participants: [
				participant("root", null),
				participant(first, "root", { state: "done" }),
				participant(second, "root", { state: "paused" }),
			],
			events: [event("one", "Full readable event", { actorId: first, recipientId: second, workerId: first })],
		};
		let target = "";
		await panel(
			deps({
				collaboration: async () => current,
				interrupt: async (id) => {
					target = id;
					return "interrupted";
				},
			}),
			async (component, terminal) => {
				const lines = component.render(120).map(stripTerminalSequences);
				assert.ok(lines.some((line) => /…a123456.*same-model.*done/.test(line)));
				assert.ok(lines.some((line) => /…b123456.*same-model.*paused/.test(line)));
				assert.match(lines.join("\n"), /…a123456 → …b123456/);
				component.handleInput("i");
				await flush();
				assert.equal(target, first);
				component.handleInput("\r");
				terminal.rows = 60;
				assert.match(text(component), new RegExp(`Actor: ${first}`));
			},
		);
	});
	it("uses normal text contrast for unrelated events and puts event content before source metadata", async () => {
		const colors: { color: string; value: string }[] = [];
		const trackedTheme = {
			...theme,
			fg: (color: string, value: string) => {
				colors.push({ color, value });
				return value;
			},
		} as Theme;
		await panel(
			deps({
				collaboration: async () => ({
					...snapshot(),
					events: [event("plain", "unrelated readable content", { actorId: "root", recipientId: "worker-c" })],
				}),
			}),
			async (component) => {
				text(component);
				assert.ok(colors.some((entry) => entry.color === "text" && entry.value.includes("unrelated readable content")));
				assert.ok(!colors.some((entry) => entry.color === "dim" && entry.value.includes("unrelated readable content")));
				component.handleInput("\r");
				const output = text(component);
				assert.ok(output.indexOf("unrelated readable content") < output.indexOf("SOURCE / REPLY EVIDENCE"));
			},
			trackedTheme,
		);
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

describe("dashboard ergonomics", () => {
	const markers: MarkerStyles = {
		bold: (text) => `[b]${text}[/b]`,
		italic: (text) => `[i]${text}[/i]`,
		code: (text) => `[c]${text}[/c]`,
		heading: (text) => `[h]${text}[/h]`,
		rule: (text) => `[r]${text}[/r]`,
		bullet: (text) => `[•]${text}[/•]`,
	};
	const footerStyles: FooterStyles = {
		key: (text) => `<${text}>`,
		label: (text) => text,
		rule: (text) => text,
	};
	it("maps bounded markers and wraps markdown with hanging indents", () => {
		assert.equal(styleMarkers("`code` and **bold** and *em*", markers), "[c]code[/c] and [b]bold[/b] and [i]em[/i]");
		assert.doesNotMatch(styleMarkers("**keep**", markers), /\*\*/);
		const lines = styleMarkdownBlock("intro\n# Title\n- item one that wraps at a tight measure\n---", 12, markers);
		assert.ok(lines.some((line) => line === ""));
		assert.ok(lines.some((line) => line.includes("[h]Title[/h]") || line.includes("[h]")));
		const bullet = lines.find((line) => line.includes("[•]"));
		assert.ok(bullet);
		const bulletAt = lines.indexOf(bullet!);
		assert.ok(bulletAt >= 0 && bulletAt + 1 < lines.length);
		assert.match(lines[bulletAt + 1], /^ {2}/);
		assert.ok(lines.some((line) => /\[r\]─{12}\[\/r\]/.test(line)));
	});
	it("caps reader measure, scales the thread pane, and counts truncation residue", () => {
		assert.equal(readerMeasure(240), 96);
		assert.equal(readerMeasure(50), 44);
		assert.equal(readerMeasure(5), 1);
		assert.equal(threadPaneWidth(80), 80);
		assert.equal(threadPaneWidth(100), 28);
		assert.equal(threadPaneWidth(160), 40);
		assert.ok(threadPaneWidth(140) >= 28 && threadPaneWidth(140) <= 40);
		assert.match(truncateResidue("abcdefghijklmnopqrstuvwxyz", 10), /\+\d+/);
		assert.doesNotMatch(truncateResidue("abcdefghijklmnopqrstuvwxyz", 10), /…/);
		assert.equal(visibleWidth(headerPair(20, "left identity", "esc back")), 20);
		assert.equal(positionLabel(0, 10, 40), "lines 1-10/40");
		assert.equal(clockTime(Number.NaN), "--:--:--");
	});
	it("drops footer groups from the end and keeps escape", () => {
		const dismiss = { key: "esc", label: "close" };
		const groups = [
			[{ key: "↑↓", label: "select" }],
			[{ key: "enter", label: "open" }],
			[{ key: "k", label: "cancel" }],
		];
		const wide = footerLine(80, groups, dismiss, footerStyles);
		assert.match(wide, /↑↓.*select/);
		assert.match(wide, /enter.*open/);
		assert.match(wide, /k.*cancel/);
		assert.match(wide, /esc.*close/);
		const mid = footerLine(28, groups, dismiss, footerStyles);
		assert.match(mid, /↑↓.*select/);
		assert.doesNotMatch(mid, /cancel/);
		assert.match(mid, /esc.*close/);
		const tight = footerLine(10, groups, dismiss, footerStyles);
		assert.match(tight, /esc/);
		assert.doesNotMatch(tight, /cancel/);
	});
	it("lays out thread columns, card time and direction, and a single unverified mark", async () => {
		const current = snapshot();
		current.events = [
			event("out", "**bold** outbound", {
				actorId: "root",
				recipientId: "worker-a",
				workerId: null,
				exchange: { kind: "steer", text: "**bold** outbound" },
			}),
			event("in", "reply inbound", {
				actorId: "worker-a",
				recipientId: "root",
				exchange: { kind: "peer", text: "reply inbound" },
			}),
		];
		await panel(
			deps({ collaboration: async () => current }),
			async (component) => {
				const output = text(component, 180);
				assert.match(output, /CONVERSATIONS · 1 · root ↔ peers/);
				assert.match(output, /worker-a/);
				assert.doesNotMatch(output, /exchange record/);
				assert.match(output, /\d{2}:\d{2}:\d{2}.*root → worker-a.*steer/);
				assert.match(output, /→ /);
				assert.match(output, /← /);
				assert.doesNotMatch(output, /\*\*bold\*\*/);
				assert.match(output, /bold outbound/);
				assert.equal((output.match(/unverified/g) ?? []).length, 1);
				assert.doesNotMatch(output, /e evidence|h history|n report|v transcript|\/ search|F families/);
				component.handleInput("?");
				const help = text(component, 140).replace(/\s+/g, " ");
				assert.match(help, /e, h, n, v, \/, and F stay listed here/);
			},
			theme,
			"communications",
		);
	});
	it("pins a sticky reader identity with position readout and drops timeline tokens", async () => {
		const current = snapshot();
		current.events = [
			event("event-1", "Exact first message\nSecond line", {
				exchange: { kind: "peer", text: "Exact first message\nSecond line" },
			}),
			event("event-2", "Exact reply", {
				actorId: "worker-b",
				recipientId: "worker-a",
				replyTo: "message-event-1",
				exchange: { kind: "peer", text: "Exact reply" },
			}),
		];
		await panel(
			deps({ collaboration: async () => current }),
			async (component) => {
				component.handleInput("\r");
				const output = text(component, 140);
				assert.match(output, /SOURCE DETAILS/);
				assert.match(output, /worker-b → worker-a · peer · recorded · \d{2}:\d{2}:\d{2}/);
				assert.match(output, /lines \d+-\d+\/\d+/);
				assert.match(output, /esc back/);
				assert.doesNotMatch(output, /BROWSE|FOLLOW TAIL|l follow/);
				assert.match(output, /Actor: worker-b/);
				assert.match(output, /Recipient: worker-a/);
			},
			theme,
			"communications",
		);
	});
	it("collapses chrome in a short window and fills leftover thread rows", async () => {
		await panel(
			deps({
				collaboration: async () => ({
					...snapshot(),
					events: [
						event("q", "raw", { exchange: { kind: "peer", text: "hello from the thread" } }),
					],
				}),
			}),
			async (component, terminal) => {
				terminal.rows = 10;
				const conversations = text(component, 140);
				assert.match(conversations, /SELECTED THREAD/);
				assert.match(conversations, /running · test\/same-model/);
				component.handleInput("\r");
				const lines = component.render(80);
				assert.ok(lines.length <= 8);
				const reader = text(component, 80);
				assert.match(reader, /worker-a → worker-b · peer · recorded · \d{2}:\d{2}:\d{2}/);
				assert.match(reader, /lines /);
				assert.match(reader, /esc/);
				assert.doesNotMatch(reader, /BROWSE|FOLLOW TAIL/);
				assert.equal(lines.filter((line) => /esc/.test(stripTerminalSequences(line))).length >= 1, true);
			},
			theme,
			"communications",
		);
	});
});
