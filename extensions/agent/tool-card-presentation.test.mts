import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
/** Host-injected keybinding hints, as Pi passes them to renderers. */
const cardKeys = { keyText, keyHint };
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defineTool, initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { obj } from "@earendil-works/pi-schema";
import { createAgentToolCards } from "./tool-cards.ts";
import { fixtures, fixtureResult, rows, targetId, forkId } from "./tool-card-fixture.mts";

type NativeContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

initTheme("dark", false);
const nativeTui = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
);
const screen = (component: ToolExecutionComponent, width = 240) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trim())
		.filter(Boolean)
		.join("\n");
const hints = (value: string) => value.split("\n").filter((line) => /to expand|expand for full/u.test(line));
const fullId = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/u;

for (const [name, fixture] of Object.entries(fixtures))
	it(`${name} uses the installed tool row lifecycle for one hint and concise collapsed facts`, (t) => {
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(
			new nativeTui.KeybindingsManager({
				...nativeTui.TUI_KEYBINDINGS,
				"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
			}),
		);
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const cards = createAgentToolCards(() => rows);
		const card = cards[name];
		assert.ok(card);
		const calls: NativeContext[] = [];
		const results: NativeContext[] = [];
		const tool = defineTool({
			name,
			label: name,
			description: "Renderer fixture",
			parameters: obj({}, { open: true }),
			renderCall(args, theme, context) {
				calls.push(context);
				return card.renderCall(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				results.push(context);
				return card.renderResult(result, options, theme, context);
			},
			async execute() {
				throw new Error("Renderer fixtures must not execute.");
			},
		});
		const component = new ToolExecutionComponent(
			name,
			"fixture",
			{},
			undefined,
			tool,
			{ requestRender() {} } as unknown as TUI,
			".",
		);
		component.updateArgs({ ...fixture.args, message: "Review" });
		assert.ok(hints(screen(component)).length <= 1, "streamed arguments have at most one disclosure");
		component.updateArgs(fixture.args);
		component.setArgsComplete();
		assert.ok(hints(screen(component)).length <= 1);
		const beforeStart = calls.length;
		const sharedState = calls.at(-1)?.state;
		component.markExecutionStarted();
		assert.ok(calls.length > beforeStart, "execution start redraws the call");
		assert.equal(calls.at(-1)?.executionStarted, true);
		assert.equal(calls.at(-1)?.state, sharedState);
		assert.ok(hints(screen(component)).length <= 1, "the call owns disclosure before the first result");
		const result = { ...fixtureResult(fixture.details), isError: false };
		const before = structuredClone({ args: fixture.args, result });
		component.updateResult(result, true);
		assert.equal(results.at(-1)?.state, sharedState, "call and result share one native state object");
		assert.equal(results.at(-1)?.isPartial, true);
		assert.ok(hints(screen(component)).length <= 1);
		component.updateResult(result);
		for (const width of [40, 80, 240]) assert.ok(hints(screen(component, width)).length <= 1);
		const collapsed = screen(component);
		if (name === "agent_collaborate") assert.ok(collapsed.includes(String(fixture.args.threadId)));
		else assert.doesNotMatch(collapsed, fullId);
		for (const label of ["Parser review", "Fork review"])
			assert.ok(collapsed.split(label).length - 1 <= 1, `${label} appears once`);
		if (!["agent_fork", "agent_rewind"].includes(name))
			assert.ok(collapsed.split("provider/model").length - 1 <= 1, "model facts appear once");
		assert.doesNotMatch(collapsed, /not proof|not task acceptance|controls escaped|unresolved|Deduplicated against/u);
		component.setExpanded(true);
		const expanded = screen(component);
		assert.equal(hints(expanded).length, 0);
		assert.ok(expanded.includes(targetId) || expanded.includes(forkId), "expanded native source keeps full identities");
		component.setExpanded(false);
		assert.equal(screen(component), collapsed);
		assert.deepEqual({ args: fixture.args, result }, before, "rendering changes neither arguments nor results");
	});

function nativeRow(
	name: string,
	args: Record<string, unknown>,
	details: unknown,
	lookupRows = rows,
	argsComplete = true,
): ToolExecutionComponent {
	const card = createAgentToolCards(() => lookupRows)[name];
	const tool = defineTool({
		name,
		label: name,
		description: "Renderer fixture",
		parameters: obj({}, { open: true }),
		...card,
		async execute() {
			throw new Error("Renderer fixtures must not execute.");
		},
	});
	const component = new ToolExecutionComponent(
		name,
		"fixture",
		args,
		undefined,
		tool,
		{ requestRender() {} } as unknown as TUI,
		".",
	);
	if (argsComplete) component.setArgsComplete();
	if (details !== undefined) {
		component.markExecutionStarted();
		component.updateResult({ ...fixtureResult(details), isError: false });
	}
	return component;
}

it("send hands off its measured call hint without a collapsed Dispatch result body", (t) => {
	const previousKeys = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager(
			{
				...nativeTui.TUI_KEYBINDINGS,
				"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
			},
			{ "app.tools.expand": "ctrl+x" },
		),
	);
	t.after(() => nativeTui.setKeybindings(previousKeys));
	const visibleArgs = nativeRow("agent_send", { sessionId: "@reviewer", message: "Review" }, undefined, []);
	assert.match(screen(visibleArgs), /agent_send @reviewer\nReview/u);
	assert.deepEqual(hints(screen(visibleArgs)), []);
	const visibleStatus = nativeRow("agent_status", { view: "storage-page", storageId: targetId, limit: 7 }, undefined);
	assert.deepEqual(hints(screen(visibleStatus)), []);
	assert.equal(hints(screen(visibleStatus, 35)).length, 1, "expansion restores the clipped storage ID");
	const args = {
		sessionId: targetId,
		message: `${"alpha ".repeat(12).trim()}\nrow 3\nrow 4\nrow 5\n\x1b]52;c;private\x07row 6\nrow 7`,
	};
	const card = nativeRow("agent_send", args, undefined, rows, false);
	const width = 52;
	const pending = screen(card, width);
	assert.match(pending, /^agent_send Parser review\nprovider\/model · high/u);
	assert.match(pending, /row 3\nrow 4\nrow 5\n\.\.\. \(2 more lines, ctrl\+x to expand\)$/u);
	assert.doesNotMatch(pending, /row [67]|private/u);
	card.markExecutionStarted();
	card.updateResult({ content: [], details: undefined, isError: false }, true);
	assert.match(screen(card, width), /Admission pending\n\.\.\. \(2 more lines, ctrl\+x to expand\)$/u);
	card.updateResult({
		content: [{ type: "text", text: "Message admitted" }],
		details: { admitted: true, sessionId: targetId },
		isError: false,
	});
	const rendered = card.render(width).map((line) => stripVTControlCharacters(line).trim());
	assert.match(rendered.join("\n"), /row 5\n\nMessage admitted\n\.\.\. \(2 more lines, ctrl\+x to expand\)/u);
	assert.equal(hints(screen(card, width)).length, 1);
	assert.match(screen(card, 240), /\(1 more line, ctrl\+x to expand\)$/u);
	card.setExpanded(true);
	assert.match(screen(card, 100), new RegExp(`sessionId: ${targetId}\\nmessage: alpha`, "u"));
	assert.match(screen(card, 100), /row 6\nrow 7/u);
	assert.doesNotMatch(screen(card, 100), /private|to expand/u);
});

it("status keeps one keyless disclosure after a result, and preserves the exact storage cursor", (t) => {
	const previousKeys = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager(
			{
				...nativeTui.TUI_KEYBINDINGS,
				"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
			},
			{ "app.tools.expand": [] },
		),
	);
	t.after(() => nativeTui.setKeybindings(previousKeys));
	const args = { view: "storage-page", storageId: targetId, limit: 7 };
	const next = { ...args, cursor: { after: "backend/cursor", position: 19 } };
	const card = nativeRow("agent_status", args, undefined);
	assert.doesNotMatch(screen(card), /expand/u);
	card.markExecutionStarted();
	const details = {
		live: false,
		storageId: targetId,
		conversations: Array.from({ length: 7 }, (_, i) => ({ name: `Reader ${i}`, availability: "retained" })),
		coverage: { complete: false, scanned: 7, returned: 7, next: { tool: "agent_status", ...next } },
	};
	card.updateResult({ ...fixtureResult(details), isError: false });
	const collapsed = screen(card);
	assert.match(collapsed, /7 conversations on a retained storage page; more available/u);
	assert.match(screen(card, 60), /7 conversations on a retained storage page; more available/u);
	assert.match(collapsed, /Reader 4 · live activity not observed\n\.\.\. \(2 more lines, click to expand\)$/u);
	assert.doesNotMatch(collapsed, /Reader [56]|backend\/cursor|\[Truncated/u);
	const rows = card.render(240);
	const y = rows.findIndex((line) => line.includes("click to expand"));
	assert.ok(
		card.handleMouse({
			type: "click",
			button: "left",
			x: 2,
			y,
			screenX: 2,
			screenY: y,
			width: 240,
			height: rows.length,
			shift: false,
			alt: false,
			ctrl: false,
		})?.handled,
	);
	assert.match(screen(card), /Reader 6 · live activity not observed/u);
	assert.ok(screen(card).includes(`Continue with agent_status(${JSON.stringify(next)})`));
	assert.match(screen(card), /7 conversations on a retained storage page; more available/u);
	assert.doesNotMatch(screen(card), /click to expand|\[Storage scan incomplete\]/u);
});

it("status leads with observed activity and keeps its source and limits", () => {
	const conversation = {
		identity: targetId,
		conversationId: 1,
		name: "Parser review",
		busy: true,
		availability: "live",
		runId: 42,
		model: { provider: "provider", modelId: "model" },
		thinkingLevel: "high",
		timers: 0,
		queue: { inbox: 0, submissions: 1 },
		unplaced: 0,
		openWorkCount: 0,
		omitted: ["host inventory"],
		detail: { tool: "agent_status", sessionId: targetId, detail: true },
	};
	const args = { sessionId: targetId };
	const card = nativeRow("agent_status", args, { format: "compact", conversation });
	const working = screen(card, 60);
	assert.match(
		working,
		/^agent_status Parser review\nprovider\/model · high · selected status\nWorking · run 42\nDurable agent · live host observation/u,
	);
	assert.doesNotMatch(working, /Activity:|0 timers|unplaced|work open|Compact status omits|host inventory/u);
	assert.equal(hints(working).length, 1);
	card.setExpanded(true);
	assert.match(screen(card), /Working · run 42\nDurable agent · live host observation/u);
	assert.ok(screen(card).includes(`Get full detail with agent_status(${JSON.stringify({ ...args, detail: true })})`));
	assert.match(screen(card), /Omitted host inventory/u);

	const idle = nativeRow("agent_status", args, {
		format: "compact",
		conversation: {
			...conversation,
			busy: false,
			timers: 1,
			unplaced: 2,
			oldest: 10_000,
			openWorkCount: 1,
		},
	});
	assert.match(screen(idle), /\nIdle\nDurable agent · live host observation/u);
	assert.match(screen(idle), /2 unplaced inputs · oldest 10s\n1 open work item/u);
	assert.doesNotMatch(screen(idle), /1 timer|run 42/u);
	idle.setExpanded(true);
	assert.match(screen(idle), /^1 timer$/mu);

	const retained = nativeRow("agent_status", args, { format: "compact", live: false, conversation });
	assert.match(screen(retained), /Live session activity not observed\nDurable agent · retained snapshot/u);
	assert.doesNotMatch(screen(retained), /\n(?:Working|Idle)\b|run 42/u);
	const unknown = nativeRow("agent_status", args, { format: "compact", conversation: { ...conversation, busy: null } });
	assert.match(screen(unknown), /Live session activity not established\nDurable agent · live host observation/u);
	const ordinary = nativeRow(
		"agent_status",
		{ ...args, detail: true },
		{
			kind: "ordinary-primary",
			view: "status",
			sessionId: targetId,
			presence: { name: "Parser review", process: { state: "live" } },
			coverage: { complete: false },
		},
	);
	for (const expanded of [false, true]) {
		ordinary.setExpanded(expanded);
		assert.match(screen(ordinary), /Live session activity not observed\nOrdinary primary/u);
		assert.match(screen(ordinary), /Local process exists/u);
		assert.match(screen(ordinary), /\[Retained ancestry scan incomplete\]/u);
		assert.doesNotMatch(screen(ordinary), /\n(?:Working|Idle)\n/u);
	}
});

it("activity shows live evidence and the newest retained reply ahead of scan details", () => {
	const args = { sessionId: targetId, view: "activity", limit: 2 };
	const details = {
		view: "activity",
		sessionId: targetId,
		metadata: {
			live: true,
			operation: 42,
			runningTools: [
				{ name: "bash", toolCallId: "tool-1" },
				{ name: "read", toolCallId: "tool-2", parentToolCallId: "tool-1" },
			],
			pending: 1,
		},
		turns: [
			{
				entries: [
					{ id: 71, role: "user", text: "Check the parser." },
					{ id: 72, role: "assistant", text: "The boundary cases pass.\nHere is the output." },
				],
			},
			{ entries: [{ id: 42, role: "assistant", text: "I reproduced the failure." }] },
		],
		coverage: { scannedEntries: 19, complete: false },
		nextCursor: { after: 42 },
	};
	const card = nativeRow("agent_inspect", args, details);
	const collapsed = screen(card, 80);
	assert.match(collapsed, /Live observation · run 42 · 1 pending input\nCurrent tools · bash, read/u);
	assert.match(collapsed, /Retained reply · The boundary cases pass\./u);
	assert.doesNotMatch(collapsed, /19 entries scanned|Check the parser|tool-1|reproduced/u);
	assert.equal(hints(collapsed).length, 1);
	card.setExpanded(true);
	assert.match(screen(card), /Here is the output\.|I reproduced the failure\./u);
	assert.match(screen(card), /19 entries scanned/u);
	assert.match(screen(card), /"parentToolCallId": "tool-1"/u);
	assert.ok(
		screen(card).includes(
			`Next page: agent_inspect(${JSON.stringify({ view: "activity", sessionId: targetId, cursor: details.nextCursor, limit: 2 })})`,
		),
	);
	assert.equal(hints(screen(card)).length, 0);

	const retrying = nativeRow("agent_inspect", args, {
		...details,
		metadata: { ...details.metadata, lastError: "Old failure", autoRetry: { errorMessage: "Provider timed out" } },
	});
	assert.match(screen(retrying), /Retrying · Provider timed out/u);
	assert.doesNotMatch(screen(retrying), /Old failure/u);

	const older = nativeRow("agent_inspect", { ...args, cursor: { after: 99 } }, details);
	assert.match(screen(older), /Older retained activity\nReply on this page/u);
	assert.doesNotMatch(screen(older), /Live observation|Current tools|run 42/u);
	const retained = nativeRow("agent_inspect", args, { ...details, metadata: { ...details.metadata, live: false } });
	assert.match(screen(retained), /Retained activity only/u);
	assert.doesNotMatch(screen(retained), /Live observation|Current tools|run 42/u);
});

it("fleet status leads with counts and keeps one separate coverage warning at narrow widths", () => {
	const card = nativeRow(
		"agent_status",
		{ view: "fleet" },
		{
			view: "fleet",
			models: [{}, {}],
			failures: Array.from({ length: 4 }, () => ({})),
			warnings: [],
			usageCoverage: { status: "partial", sampledResponses: 1273 },
			coverage: { catalog: { complete: false, records: 320 }, output: { omittedWarnings: 27 } },
		},
	);
	for (const expanded of [false, true]) {
		card.setExpanded(expanded);
		const output = screen(card, 60);
		assert.match(output, /^agent_status fleet\n/u);
		assert.match(output, /2 models, 4 failures in local evidence\nPublished evidence, not provider health/u);
		assert.equal(output.match(/\[Partial fleet coverage\]/gu)?.length, 1);
		assert.doesNotMatch(output, /0 warnings|Returned:/u);
		if (expanded) assert.match(output, /Catalogue scan incomplete\n320 storage records read/u);
	}
});

it("status presents the actual flagged diagnostic and adds no hint to an empty call with a complete answer", () => {
	const card = nativeRow("agent_status", {}, undefined);
	card.updateResult({
		content: [{ type: "text", text: "Local storage is unavailable" }],
		details: undefined,
		isError: true,
	});
	assert.equal(screen(card), "agent_status\noverview\nLocal storage is unavailable");
});

it("shows the diagnostic cause on the error card without repeating its heading in expansion", () => {
	const card = nativeRow("agent_status", { view: null }, undefined);
	const heading = 'Validation failed for tool "agent_status":';
	const cause = '  - view: expected "fleet"';
	card.updateResult({ content: [{ type: "text", text: `${heading}\n${cause}` }], details: undefined, isError: true });
	for (const expanded of [false, true]) {
		card.setExpanded(expanded);
		const output = screen(card, 60);
		assert.equal(output.split(heading).length - 1, 1);
		assert.ok(output.includes(cause.trim()));
	}
});

it("place receipts omit labels and models already shown in the card", () => {
	const place = nativeRow(
		"agent_place",
		{ area: "/work", topic: "Parser review", prompt: "Review the parser" },
		fixtures.agent_spawn.details,
	);
	const rendered = screen(place);
	assert.match(rendered, /Admitted · submission 405/u);
	assert.equal(rendered.split("Parser review").length - 1, 1);
	assert.equal(rendered.split("provider/model").length - 1, 1);
});

it("labels an observed configuration without claiming the request changed it", () => {
	const status = {
		identity: targetId,
		conversationId: 1,
		agent: { model: { provider: "provider", modelId: "model" }, thinkingLevel: "high" },
	};
	const row = nativeRow(
		"agent_configure",
		{ sessionId: targetId, thinkingLevel: "low" },
		{ identity: targetId, conversationId: 1, status },
		[],
	);
	const collapsed = screen(row);
	assert.match(collapsed, /provider\/model · high · requested low/u);
	assert.match(collapsed, /^Configuration observed$/mu);
	assert.doesNotMatch(collapsed, /Configuration applied|^\{$/mu);
	row.setExpanded(true);
	assert.match(screen(row), /"thinkingLevel": "high"/u);
});

it("a retained continue receipt shows the state note rather than the model instruction", () => {
	const args = { action: "continue", note: "The source check is still running." };
	const row = nativeRow("agent_work", args, undefined);
	const source = "The state note is shown to the operator. The turn ends here: write no chat text.";
	row.updateResult({ content: [{ type: "text", text: source }], details: args, isError: false });
	const collapsed = screen(row);
	assert.match(collapsed, /^State note recorded$/mu);
	assert.equal(collapsed.split(args.note).length - 1, 1);
	assert.doesNotMatch(collapsed, /write no chat text|Work declared/u);
	row.setExpanded(true);
	assert.ok(screen(row).includes(source));
});

it("new fork facts survive an incomplete roster and applied settings preserve host adjustments", () => {
	const fork = nativeRow("agent_fork", fixtures.agent_fork.args, fixtures.agent_fork.details, rows.slice(0, 1));
	const forkText = screen(fork);
	assert.match(forkText, /Fork created · Fork review/u);
	assert.match(forkText, /provider\/model · high/u);
	assert.equal((forkText.match(/Fork review/gu) ?? []).length, 1);
	const snapshot = {
		identity: targetId,
		conversationId: 1,
		name: "Parser review",
		busy: false,
		state: "idle",
		agent: { model: { provider: "provider", modelId: "new-model" }, thinkingLevel: "low" },
	};
	const configured = nativeRow(
		"agent_configure",
		{ sessionId: targetId, model: "provider/new-model", thinkingLevel: "high" },
		{
			sessionId: targetId,
			outcome: "applied",
			before: { name: "Parser review", model: "provider/model", thinkingLevel: "high" },
			after: { name: "Parser review", model: "provider/new-model", thinkingLevel: "low" },
			reasoning: { requested: "high", effective: "low", clamped: true },
			status: snapshot,
		},
	);
	assert.match(screen(configured), /provider\/new-model · low/u);
	assert.equal(screen(configured).split("provider/new-model").length - 1, 1);
	assert.match(screen(configured), /Configuration applied\nReasoning adjusted to low/u);
});

it("scheduled messages and timer cancellation name their actual outcomes without duplicate targets", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 23, 12) });
	for (const [day, shownTime] of [
		[23, "2:32 PM"],
		[24, "24 Nov 2:32 PM"],
	] as const) {
		const deadline = new Date(2026, 10, day, 14, 32, 45, 123);
		const deliverAt = deadline.toISOString();
		const args = { sessionId: targetId, message: "Later", deliverAt };
		assert.ok(screen(nativeRow("agent_send", args, undefined)).includes(`deliver at ${shownTime}`));
		const scheduled = nativeRow("agent_send", args, {
			identity: targetId,
			conversationId: 1,
			timerId: 7,
			deadline: deadline.getTime(),
		});
		assert.ok(screen(scheduled).split("\n").includes(`Scheduled · timer 7 · ${shownTime}`));
		assert.doesNotMatch(screen(scheduled), /Admitted/u);
		scheduled.setExpanded(true);
		assert.ok(screen(scheduled).includes(`deliverAt: ${deliverAt}`), "the expanded call keeps the exact time");
	}
	const canceled = nativeRow(
		"agent_abort",
		{ sessionId: targetId, timerId: 7 },
		{ timerId: 7, status: "cancelled", outcome: "marked" },
	);
	assert.match(screen(canceled), /timer 7/u);
	assert.match(screen(canceled), /Timer cancelled/u);
	const fired = nativeRow(
		"agent_abort",
		{ sessionId: targetId, timerId: 7 },
		{ timerId: 7, status: "fired", outcome: "unchanged" },
	);
	assert.match(screen(fired), /Timer fired · unchanged/u);
});

it("distinguishes pending stops, cold release and guarded continuation on a native abort card", () => {
	const card = (args: Record<string, unknown>, details: unknown) =>
		screen(nativeRow("agent_abort", { sessionId: targetId, ...args }, details));
	const unsettled = { identity: targetId, background: true, settled: false, pendingTasks: [24, 32] };
	const stop = card({ background: true }, unsettled);
	assert.match(stop, /same-storage children/u);
	assert.match(stop, /Stop not settled; do not repeat · pending tasks 24, 32/u);
	const release = card(
		{ release: true },
		{ aborted: { ...unsettled, background: false, cold: true }, retiring: true, blockers: [], writesPlaced: 0 },
	);
	assert.match(release, /Cold stop recorded; no serving host started/u);
	assert.match(release, /pending tasks 24, 32/u);
	assert.doesNotMatch(release, /retirement requested/u);
	const args = { interrupt: { taskId: 24, queuedInputs: [32], intentId: "selection" } };
	const admitted = card(args, { state: "continued", submissionId: 49 });
	assert.match(admitted, /interrupt generation 24/u);
	assert.match(admitted, /Continuation admitted · submission 49/u);
	assert.match(card(args, { state: "protected" }), /no continuation admitted/u);
	assert.match(card(args, { state: "pending" }), /same intent/u);
});

it("collaboration pages, reset refusals, and raw error previews keep detail behind expansion", () => {
	const collaboration = nativeRow(
		"agent_collaborate",
		{ action: "read", threadId: `${targetId}/0123456789abcdef0123456789abcdef` },
		{
			thread: { title: "Parser plan", closed: false, members: [{ identity: targetId }] },
			events: [],
			pending: 1,
			coverage: { complete: false },
		},
	);
	assert.match(screen(collaboration), /Parser plan · open\n1 pending notice\n1 member/u);
	assert.match(screen(collaboration), /0 events on this page; coverage incomplete/u);
	assert.ok(screen(collaboration).includes(`${targetId}/0123456789abcdef0123456789abcdef`));
	const reset = nativeRow(
		"agent_reset",
		{ sessionId: targetId },
		{ status: "unanswered", identity: targetId, reason: "unavailable" },
	);
	assert.match(screen(reset), /Reset not placed: unavailable/u);
	const error = nativeRow("agent_status", { sessionId: targetId }, `Storage ${targetId} is unavailable`);
	assert.ok(screen(error).includes(targetId));
	error.setExpanded(true);
	assert.match(screen(error), new RegExp(targetId));
});

it("reset uses the returned placement and preserves separate model text and receipt IDs", () => {
	const reset = nativeRow("agent_reset", { sessionId: targetId }, undefined);
	reset.markExecutionStarted();
	const modelText = "The next input starts from new context only after the reset places.";
	reset.updateResult({
		content: [{ type: "text", text: modelText }],
		details: { status: "queued", identity: targetId, submissionId: 541, text: modelText },
		isError: false,
	});
	assert.match(screen(reset, 42), /Reset queued/u);
	assert.doesNotMatch(screen(reset, 42), /new context|submissionId|Reset placed/u);
	assert.equal(hints(screen(reset, 42)).length, 1);
	reset.setExpanded(true);
	assert.ok(screen(reset).includes(modelText));
	assert.match(screen(reset), /"submissionId": 541/u);
	assert.equal(hints(screen(reset)).length, 0);
});

it("command results keep the last five output rows and reveal the complete native command report on expansion", () => {
	const command = nativeRow("agent_command", { sessionId: targetId, name: "report" }, undefined);
	const report = Array.from({ length: 8 }, (_, i) => `Report row ${i + 1}`).join("\n");
	const details = { name: "report", identity: targetId, text: report };
	command.markExecutionStarted();
	command.updateResult({
		content: [{ type: "text", text: JSON.stringify({ ...details, data: { reportId: 71 } }) }],
		details,
		isError: false,
	});
	assert.match(
		screen(command, 52),
		/Command completed\nReport row 4\nReport row 5\nReport row 6\nReport row 7\nReport row 8\n\.\.\. \(3 more lines,/u,
	);
	assert.doesNotMatch(screen(command, 52), /Report row [123]|reportId|Result received/u);
	command.setExpanded(true);
	assert.ok(screen(command).includes(report));
	assert.match(screen(command), /"reportId":71/u);
	assert.equal(hints(screen(command)).length, 0);
	const reload = nativeRow(
		"agent_command",
		{ sessionId: targetId, name: "reload" },
		{ reloaded: true, sessionId: targetId, contributionCount: 4 },
	);
	assert.match(screen(reload), /Host registrations reloaded\n4 native contributions installed/u);
	const tree = nativeRow(
		"agent_command",
		{ sessionId: targetId, name: "tree" },
		{ forkedIdentity: forkId, deduped: true },
	);
	assert.match(screen(tree), /Existing tree fork · Fork review/u);
});

it("remote compact reports task settlement without claiming a summary placed", () => {
	const compact = nativeRow("agent_compact", { sessionId: targetId }, undefined);
	const details = {
		status: "completed",
		taskId: 58,
		submissionId: 91,
		summaryPlacement: "unanswered",
		summaryReason: "Reset superseded the write",
		compaction: { identity: targetId, before: { contextWindow: 48000 } },
	};
	compact.markExecutionStarted();
	compact.updateResult({ ...fixtureResult(details), isError: false });
	const collapsed = screen(compact, 76);
	assert.match(collapsed, /Compaction completed · task 58 · submission 91/u);
	assert.match(collapsed, /Summary not placed: Reset superseded the write/u);
	assert.match(collapsed, /48000 window/u);
	assert.doesNotMatch(collapsed, /Summary placed|summary entry|Result received/u);
	compact.setExpanded(true);
	assert.match(screen(compact), /"summaryPlacement": "unanswered"/u);
});

it("an actual structured configuration diagnostic replaces generic errors", () => {
	const configure = nativeRow("agent_configure", { sessionId: targetId, model: "provider/unavailable" }, undefined);
	configure.markExecutionStarted();
	configure.updateResult({
		...fixtureResult({
			outcome: "failed",
			error: "The model is unavailable",
			persistence: { nativeWrites: "not-attempted" },
		}),
		isError: true,
	});
	assert.match(screen(configure, 65), /The model is unavailable/u);
	assert.doesNotMatch(screen(configure, 65), /Tool error|Configuration applied|nativeWrites/u);
	configure.setExpanded(true);
	assert.match(screen(configure), /"nativeWrites": "not-attempted"/u);
});

it("a primary continuity receipt and expanded messages use plain labels", () => {
	const compact = nativeRow(
		"agent_compact",
		{ sessionId: targetId, summary: "Keep facts" },
		{
			text: "Continuity summary queued for this completed tool batch.",
			status: "queued",
			compaction: { identity: targetId, self: true },
		},
	);
	assert.match(screen(compact), /Summary queued/u);
	assert.doesNotMatch(screen(compact), /at this tool batch|does not establish/u);
	const send = nativeRow("agent_send", fixtures.agent_send.args, fixtures.agent_send.details);
	send.setExpanded(true);
	assert.match(screen(send), /message: Review the parser\./u);
	assert.doesNotMatch(screen(send), /Submitted message|controls escaped/u);
});

it("same-target message receipts omit repeated facts but newly resolved and different targets retain their labels", () => {
	const cards = createAgentToolCards(() => rows);
	const context = { ...cardKeys, expanded: false, argsComplete: true, executionStarted: true, state: {} };
	const render = (args: Record<string, unknown>, identity: string) =>
		cards.agent_send
			.renderResult(
				fixtureResult({ identity, conversationId: 1, submissionId: 405 }),
				{ ...cardKeys, expanded: false, isPartial: false },
				{ fg: (_color: string, text: string) => text } as never,
				{ ...context, args },
			)
			.render(240)
			.join("\n");
	assert.match(render({ sessionId: targetId }, targetId), /^\nMessage admitted · submission 405/u);
	assert.match(render({ sessionId: "@unobserved" }, targetId), /Message admitted for Parser review · submission 405/u);
	assert.match(render({ sessionId: targetId }, forkId), /Message admitted for Fork review · submission 405/u);
});
