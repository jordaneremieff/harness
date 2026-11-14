import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, LiveDoc, MemoryStorage, type ConversationId, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { conversationFrame, deferred, fixture, formsHost, row, source, turn } from "./dashboard-test-fixture.mts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { readConversationStatus, readInspection } from "./durable-observation.ts";
import { inputEntry } from "./input-entry.ts";
import { declareOpenWork, executeAgentWork, finalReportLabel } from "./open-work.ts";
import { recordRequestContext, type RequestContext } from "./request-context.ts";
import { testModel } from "./test-runtime.mts";
import type { AgentObservationSource } from "./agent-observation.ts";
import type { OpenWorkView } from "./open-work-schema.ts";
import { readWork, workRows } from "./agent-work-view.ts";

type Fixture = ReturnType<typeof fixture>;

const STORAGE = "storage-a";
const DOWN = "\x1b[B";

const visible = (f: Fixture) => f.ui.render(f.tui.terminal.columns).map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
const shown = (f: Fixture) => visible(f).join("\n");

function press(f: Fixture, ...keys: string[]): void {
	for (const key of keys) {
		f.ui.render(f.tui.terminal.columns);
		f.ui.handleInput(key);
	}
}

function click(f: Fixture, label: string, clickCount = 1, last = true): void {
	const lines = visible(f);
	const rows = last ? lines.map((_, index) => lines.length - 1 - index) : lines.map((_, index) => index);
	for (const y of rows) {
		const x = lines[y]?.indexOf(label) ?? -1;
		if (x < 0) continue;
		const event: TuiMouseEvent = { type: "click", button: "left", x: x + 1, y, screenX: x + 1, screenY: y, width: f.tui.terminal.columns, height: f.tui.terminal.rows, shift: false, alt: false, ctrl: false, clickCount };
		f.ui.handleMouse(event);
		return;
	}
	assert.fail(`no visible ${label}`);
}

async function settle(steps = 12): Promise<void> {
	for (let step = 0; step < steps; step++) await turn();
}

/** A native storage: the lead conversation declares work on two producers, one answered and one still working. */
async function nativeScenario(t: TestContext) {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const agent = { model: { provider: testModel.provider, modelId: testModel.id } };
	const lead = await harness.root(context, { agent });
	const survey = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
	const audit = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
	const place = (tx: Tx, conversationId: ConversationId, request: RequestContext) => placed(tx, conversationId, request);
	const leadInput = await harness.commit((tx) => place(tx, lead.id, { requestId: "task-a", requester: "requester-b", replyTo: "recipient-c", origin: "model" }), context);
	const surveyInput = await harness.commit((tx) => place(tx, survey.id, { requestId: "child-survey", requester: STORAGE, replyTo: STORAGE, origin: "model" }), context);
	const auditInput = await harness.commit((tx) => place(tx, audit.id, { requestId: "child-audit", requester: STORAGE, replyTo: STORAGE, origin: "model" }), context);
	const results = [
		{ sessionId: `${STORAGE}:${survey.id}`, submissionId: surveyInput, requestId: "child-survey" },
		{ sessionId: `${STORAGE}:${audit.id}`, submissionId: auditInput, requestId: "child-audit" },
	];
	const declared = await harness.commit((tx) => declareOpenWork(tx, STORAGE, lead.id, { results, note: "Combine the survey and the audit" }, Date.now()), context);
	assert.ok(!("error" in declared));
	await harness.commit((tx) => answeredWith(tx, lead.id, leadInput, "State note: the survey and the audit continue."), context);
	await harness.commit((tx) => answeredWith(tx, survey.id, surveyInput, "Survey result: three parsers need the new grammar."), context);
	const conversations = new Map([[STORAGE, lead.id], [`${STORAGE}:${survey.id}`, survey.id], [`${STORAGE}:${audit.id}`, audit.id]]);
	const inspections: Array<Record<string, unknown>> = [];
	const forms = {
		status: async () => ({ conversation: await readConversationStatus(harness, STORAGE, lead.id, {}, context) }),
		inspect: async (params: Record<string, unknown>) => {
			inspections.push(params);
			const conversation = await harness.conversation(conversations.get(String(params.sessionId)) as ConversationId, context);
			if (!conversation) throw new Error(`No conversation ${String(params.sessionId)}`);
			return readInspection(harness, STORAGE, conversation, params, context);
		},
	};
	const complete = async (message: string) => {
		const done = await executeAgentWork({ action: "complete", request: "task-a", status: "done", message }, { harness, storageId: STORAGE, conversationId: lead.id, now: Date.now() }, context);
		assert.equal(done.isError, undefined);
	};
	const submissions = async () => (await harness.inspect(context)).submissions.length;
	return { harness, lead, leadInput, surveyInput, auditInput, surveyId: `${STORAGE}:${survey.id}`, auditId: `${STORAGE}:${audit.id}`, forms, inspections, complete, submissions };
}

async function placed(tx: Tx, conversationId: ConversationId, request: RequestContext): Promise<SubmissionId> {
	await recordRequestContext(tx, conversationId, request);
	const entry = await tx.appendEntry(conversationId, { kind: "pi.user", ...inputEntry(request.origin, request.requester), model: [{ role: "user", content: "Task", timestamp: 1 }] });
	const id = (await tx.createSubmission({ conversationId, requestId: request.requestId, type: "input", status: "placed", entry: entry.id })).id;
	(await tx.doc(LiveDoc, conversationId)).run = { taskId: 123 as TaskId, inputs: [id], turns: 0 };
	return id;
}

async function answeredWith(tx: Tx, conversationId: ConversationId, id: SubmissionId, text: string): Promise<void> {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const answer = await tx.appendEntry(conversationId, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "test", model: "test", timestamp: 2, stopReason: "stop", usage }] });
	tx.settleSubmission(id, { status: "done", answer: answer.id });
	delete (await tx.doc(LiveDoc, conversationId)).run;
}

const lead = (patch: Parameters<typeof row>[1] = {}) => row(STORAGE, { storageId: STORAGE, name: "Lead", state: "idle", openWorkCount: 1, openWorkOldest: 60_000, ageObservedAt: Date.now(), ...patch });

it("opens Work with w, reads an arrived dependency, then reads the exact final report after the work closes", async (t) => {
	const scenario = await nativeScenario(t);
	const before = await scenario.submissions();
	const observed = source([lead()]);
	const f: Fixture = fixture(140, 40, observed, { forms: (target) => formsHost(target, f.state, observed, f.calls, scenario.forms) });
	try {
		await settle();
		assert.match(shown(f), /w work/u, "the footer offers Work while the agent owes a final report");
		press(f, "w");
		await settle();
		assert.equal(f.ui.focus.inspector, "Work");
		let screen = shown(f);
		assert.match(screen, /○ open · 1 of 2 arrived · Combine the/u);
		assert.match(screen, new RegExp(`↳ result arrived · ${scenario.surveyId} #${scenario.surveyInput}`, "u"));
		assert.match(screen, new RegExp(`↳ pending · ${scenario.auditId} #${scenario.auditInput}`, "u"));
		assert.match(screen, /│Combine the survey and the audit/u, "the detail holds the whole state note");
		assert.match(screen, /1 open · 0 closed · read/u);
		assert.match(screen, /Request task-a/u, "the detail names the exact request");
		assert.match(screen, /Reply recipient: recipient-c/u);
		assert.match(screen, /What remains/u, "the declared note is not called a state note");

		press(f, DOWN);
		screen = shown(f);
		assert.match(screen, /enter read result/u, "the footer names what Enter does on a dependency");
		assert.match(screen, /An arrived result is not task/u);
		press(f, "\r");
		await settle();
		screen = shown(f);
		assert.match(screen, /Survey result: three parsers need the new grammar\./u);
		assert.match(screen, /Input: answered/u);
		assert.deepEqual(scenario.inspections.at(-1), { sessionId: scenario.surveyId, view: "result", submissionId: scenario.surveyInput });
		press(f, "\x1b");
		assert.equal(f.ui.focus.inspector, "Work");

		press(f, DOWN, "\r");
		await settle();
		assert.match(shown(f), /Input: placed: the producer works on it and has not answered/u, "a pending dependency reads as pending, not as a result");
		press(f, "\x1b");

		const report = `Combined: ${"x".repeat(5000)} END`;
		await scenario.complete(report);
		press(f, "r");
		await settle();
		screen = shown(f);
		assert.match(screen, /✓ done · Combine the survey and the audit/u);
		assert.match(screen, /↳ final report · delivering/u);
		assert.doesNotMatch(screen, /read again · .*read again/u);
		assert.match(screen, /0 open · 1 closed/u);
		press(f, DOWN, DOWN, DOWN);
		screen = shown(f);
		assert.match(screen, /Report request: work-final:1:task-a/u);
		assert.match(screen, /Delivery to recipient-c is in progress\./u);
		assert.match(screen, /enter read report/u);
		const inspected = scenario.inspections.length;
		press(f, "\r");
		await settle(30);
		const exact = `${finalReportLabel("done", "task-a")}\n\n${report}`;
		screen = shown(f);
		assert.match(screen, new RegExp(`Complete: ${exact.length} characters`, "u"));
		assert.deepEqual(scenario.inspections.slice(inspected), [
			{ sessionId: STORAGE, view: "result", submissionId: scenario.leadInput, finalReport: true, offset: 0 },
			{ sessionId: STORAGE, view: "result", submissionId: scenario.leadInput, finalReport: true, offset: 4096 },
		], "the second page uses the exact continuation the first page returned");
		press(f, "\x1b[F");
		assert.match(shown(f), /END/u, "the report text joins to its end");
		assert.deepEqual(f.calls, [], "reading sends no action");
		assert.equal(await scenario.submissions(), before, "reading admits no input");
	} finally {
		f.ui.dispose();
	}
});

it("opens Work from a click on the header's work count and reads a result from the footer control", async (t) => {
	const scenario = await nativeScenario(t);
	const observed = source([lead()]);
	const f: Fixture = fixture(140, 40, observed, { forms: (target) => formsHost(target, f.state, observed, f.calls, scenario.forms) });
	try {
		await settle();
		const header = visible(f).findIndex((line) => line.includes("work open: 1, oldest: 1m") && !line.includes("test"));
		assert.ok(header >= 0, "the header shows the work count");
		click(f, "work open: 1", 1, false);
		await settle();
		assert.equal(f.ui.focus.inspector, "Work", "a click on the count opens Work, as w does");
		click(f, "↳ result arrived");
		await settle();
		assert.match(shown(f), /Dependency of request task-a/u, "a click selects the dependency");
		click(f, "read result");
		await settle();
		assert.match(shown(f), /Survey result: three parsers/u, "the footer control runs Read result");
		click(f, "back");
		assert.equal(f.ui.focus.inspector, "Work");
	} finally {
		f.ui.dispose();
	}
});

it("aborts the Work reads when another conversation is selected and shows nothing late", async () => {
	const status = deferred<unknown>();
	const signals: AbortSignal[] = [];
	const observed = source([lead(), row("two", { name: "Bravo", state: "idle" })]);
	const f: Fixture = fixture(140, 40, observed, {
		forms: (target) => formsHost(target, f.state, observed, f.calls, {
			status: (signal?: AbortSignal) => {
				if (signal) signals.push(signal);
				return status.promise;
			},
		}),
	});
	try {
		await settle();
		press(f, "w");
		await settle();
		assert.match(shown(f), /Reading the declared work…/u);
		assert.equal(signals.length, 1);
		click(f, "Bravo");
		await settle();
		assert.equal(f.state.selected, "two");
		assert.equal(f.ui.focus.inspector, undefined, "the Work view closed with the selection change");
		assert.equal(signals[0]?.aborted, true, "the pending status read was aborted");
		status.resolve({ conversation: { openWork: [openItem()] } });
		await settle();
		assert.doesNotMatch(shown(f), /Declared work|Combine/u, "the late answer opens nothing");
	} finally {
		f.ui.dispose();
	}
});

it("aborts a result read when another conversation is selected", async () => {
	const signals: AbortSignal[] = [];
	const observed = source([lead(), row("two", { name: "Bravo", state: "idle" })]);
	const f: Fixture = fixture(140, 40, observed, {
		forms: (target) => formsHost(target, f.state, observed, f.calls, {
			status: async () => ({ conversation: { openWork: [openItem()] } }),
			inspect: (_params: Record<string, unknown>, signal?: AbortSignal) => {
				if (signal) signals.push(signal);
				return new Promise(() => {});
			},
		}),
	});
	try {
		await settle();
		press(f, "w");
		await settle();
		press(f, DOWN, "\r");
		await settle();
		assert.equal(signals.length, 1);
		click(f, "Bravo");
		await settle();
		assert.equal(signals[0]?.aborted, true);
	} finally {
		f.ui.dispose();
	}
});

it("follows the live frame without a status read and shows unestablished evidence explicitly", async () => {
	const observed: AgentObservationSource = source([lead({ state: "working" })]);
	let frame = conversationFrame({ storageId: STORAGE, revision: 3, status: { ...conversationFrame().status, openWork: [openItem({ unavailable: true }), { requestId: "broken" }] as unknown as OpenWorkView[] } });
	observed.frame = () => frame;
	observed.availability = () => ({ state: "live" }) as ReturnType<AgentObservationSource["availability"]>;
	let reads = 0;
	const f: Fixture = fixture(140, 40, observed, {
		forms: (target) => formsHost(target, f.state, observed, f.calls, {
			status: async () => {
				reads++;
				return {};
			},
		}),
	});
	try {
		await settle();
		press(f, "w");
		await settle();
		let screen = shown(f);
		assert.equal(reads, 0, "a live frame supplies the items");
		assert.match(screen, /1 open · 0 closed · live · 1 item could not be read/u);
		assert.match(screen, /↳ not established · other-storage:4 #9/u);
		assert.doesNotMatch(screen, /read again/u, "a live view offers no read again");
		press(f, DOWN);
		assert.match(shown(f), /No committed fact establishes its state: the producer is/u);
		assert.match(shown(f), /enter read result/u, "a dependency that is not established still reads its result");
		frame = { ...frame, revision: 4, status: { ...frame.status, openWork: [closedItem("retained")] } };
		screen = shown(f);
		assert.match(screen, /✓ done · Combine the survey and the audit/u, "a newer frame replaces the items");
		assert.match(screen, /↳ final report · kept for reading/u);
		assert.equal(reads, 0);
	} finally {
		f.ui.dispose();
	}
});

it("names a status read failure and a final report that is not retained", async () => {
	let fail = true;
	const observed = source([lead()]);
	const f: Fixture = fixture(140, 40, observed, {
		forms: (target) => formsHost(target, f.state, observed, f.calls, {
			status: async () => {
				if (fail) throw new Error("storage busy");
				return { conversation: { openWork: [closedItem("absent")] } };
			},
			inspect: async () => ({ view: "result", sessionId: STORAGE, conversationId: 1, submissionId: 7, status: "done", reason: "Final report work-final:1:task-a is not retained for recipient-c", usage: { models: {}, tools: {} } }),
		}),
	});
	try {
		await settle();
		press(f, "w");
		await settle();
		assert.match(shown(f), /The declared work could not be read: storage busy · r reads again/u);
		fail = false;
		press(f, "r");
		await settle();
		press(f, DOWN, "\r");
		await settle();
		const screen = shown(f);
		assert.match(screen, /Final report work-final:1:task-a is not retained for recipient-c/u);
		assert.match(screen, /The closed work item keeps this message, which is not the retained report:/u);
		assert.match(screen, /all parts landed/u);
	} finally {
		f.ui.dispose();
	}
});

it("orders open work before closed work and keeps every identity in its row key", () => {
	const rows = workRows([closedItem("delivered"), openItem()]);
	assert.deepEqual(rows.map((entry) => entry.key), ["request:task-b", "dependency:task-b:other-storage:4:9", "request:task-a", "report:task-a"]);
	assert.deepEqual(readWork({}), { items: [], unreadable: 0 });
	assert.deepEqual(readWork({ openWork: "x" }), { items: [], unreadable: 1 });
	assert.throws(() => readWork(null), /names no conversation/u);
});

function openItem(options: { unavailable?: boolean } = {}): OpenWorkView {
	return {
		requestId: "task-b", submissionId: 8, requester: "requester-b", replyTo: "recipient-c", origin: "operator", note: "Wait for the other storage", state: "open", declaredAt: 1, updatedAt: 1,
		dependencies: [{ sessionId: "other-storage:4", submissionId: 9, state: "open", ...(options.unavailable === false ? {} : { unavailable: "the producer is in another storage and no result of this dependency was admitted into this conversation; read it with the inspect call" }), inspect: { tool: "agent_inspect", view: "result", sessionId: "other-storage:4", submissionId: 9 } }],
	};
}

function closedItem(delivery: NonNullable<OpenWorkView["close"]>["delivery"]): OpenWorkView {
	return {
		requestId: "task-a", submissionId: 7, requester: "requester-b", replyTo: "recipient-c", origin: "model", note: "Combine the survey and the audit", state: "closed", declaredAt: 1, updatedAt: 2,
		close: { status: "done", message: "all parts landed", at: 2, reportRequestId: "work-final:1:task-a", ...(delivery === undefined ? {} : { delivery }), read: { tool: "agent_inspect", view: "result", sessionId: STORAGE, submissionId: 7, finalReport: true, offset: 0 } },
		dependencies: [],
	};
}

