import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
/** Host-injected keybinding hints, as Pi passes them to renderers. */
const cardKeys = { keyText, keyHint };
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import type { Communication } from "./communication.ts";
import {
	createAgentToolCards,
	compactCommunicationRenderer,
	operatorNoticeBody,
	renderCommunicationCard,
	renderPeerNoticeCard,
	type AgentCardContext,
	type AgentCardLookup,
} from "./tool-cards.ts";
import { projectSelectedStatus, projectStorageStatus } from "./status-overview.ts";
import { controlText, readableControlText, projectReportReceipt } from "./control-result.ts";
import { createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";

initTheme("dark", false);
const nativeTui = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
);
const theme = {
	fg: (_color: string, value: string) => value,
	bg: (_color: string, value: string) => value,
	getBgAnsi: () => "",
	bold: (value: string) => value,
} as unknown as Theme;
const screen = (component: { render(width: number): readonly string[] }) =>
	component
		.render(240)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n");
const context = (overrides: Partial<AgentCardContext> = {}): AgentCardContext => ({
	...cardKeys,
	args: {},
	expanded: false,
	argsComplete: true,
	isError: false,
	...overrides,
});
const id = "12345678-1234-1234-1234-123456789abc";
const model = { provider: "provider", modelId: "model", thinkingLevel: "high" };
const row: AgentConversationSummary = {
	id,
	storageId: id,
	name: "Parser review",
	cwd: "/work",
	model,
	modifiedAt: 1,
	owner: "unknown",
	state: "idle",
	cost: 0,
	partial: false,
};
const details = { identity: id, conversationId: 1, submissionId: 405, deduped: false };
const receipt: AgentToolResult<unknown> = { content: [{ type: "text", text: JSON.stringify(details) }], details };
const hintCount = (value: string) => (value.match(/to expand|expand for full/gu) ?? []).length;

describe("compact observation cards", () => {
	const native = {
		identity: id,
		conversationId: 1,
		busy: true,
		name: "Reader",
		live: { run: { taskId: 9 } },
		inbox: { items: [1] },
		submissions: [],
		timers: [],
		agent: { model, thinkingLevel: "high" },
	};
	it("distinguishes forward event pages with an omitted known frame from mutation receipts", () => {
		const threadId = `${id}/thread`,
			next = { tool: "agent_collaborate", action: "read", threadId, after: 9, knownFrameRevision: 2, limit: 3 };
		const details = {
			direction: "forward",
			threadId,
			frameRevision: 2,
			sequence: 12,
			closed: false,
			events: [{ sequence: 9, at: 1, atUtc: new Date(1).toISOString() }],
			next,
			pending: 0,
			coverage: { complete: false, bytes: 200, after: 8, through: 9 },
		};
		const card = createAgentToolCards().agent_collaborate;
		const output = screen(
			card.renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme, context()),
		);
		assert.match(output, /forward events · frame 2 · open/u);
		assert.match(output, /Known frame not repeated/u);
		assert.doesNotMatch(output, /Recorded|Posted|agent_inspect/u);
		assert.ok(
			output.includes(
				`agent_collaborate(${JSON.stringify({ action: "read", threadId, after: 9, knownFrameRevision: 2, limit: 3 })})`,
			),
		);
		const call = screen(
			card.renderCall({ action: "read", threadId, after: 8, knownFrameRevision: 2 }, theme, context()),
		);
		assert.match(call, /after 8 · known frame 2/u);
		const join = screen(
			card.renderCall({ action: "join", threadId, participation: "Check retained events" }, theme, context()),
		);
		assert.match(join, /Check retained events/u);
	});

	it("preserves the exact typed thread recovery call while removing generic evidence advice from the card body", () => {
		const call = `agent_collaborate(${JSON.stringify({ action: "read", threadId: `${id}/thread`, before: 10, limit: 1 })})`;
		const body = operatorNoticeBody(
			`An active excerpt [cut]\n\n${call}\n\nUse agent_inspect for retained source evidence.`,
		);
		assert.ok(body.includes(call));
		assert.match(body, /\[cut\]/u);
		assert.doesNotMatch(body, /agent_inspect/u);
	});

	it("shows compact selected facts and an exact full-detail call without inferring unknown primary activity", () => {
		const cards = createAgentToolCards();
		const details = projectSelectedStatus({ conversation: native, live: false, storageId: id });
		const result = { content: [{ type: "text" as const, text: controlText(details) }], details };
		const output = screen(
			cards.agent_status.renderResult(result, { expanded: false, isPartial: false }, theme, context()),
		);
		assert.match(output, /Live session activity not observed\nDurable agent · retained snapshot/u);
		assert.match(output, /1 queued input/u);
		assert.doesNotMatch(output, /\b(?:Working|Idle)\b|0 timers/u);
		const expanded = screen(
			cards.agent_status.renderResult(result, { expanded: true, isPartial: false }, theme, context({ expanded: true })),
		);
		assert.ok(expanded.includes(`agent_status(${JSON.stringify({ sessionId: id, detail: true })})`));
		const primary = projectSelectedStatus({ kind: "ordinary-primary", sessionId: "primary", presence: {} });
		const unknown = screen(
			cards.agent_status.renderResult(
				{ content: [], details: primary },
				{ expanded: false, isPartial: false },
				theme,
				context(),
			),
		);
		assert.match(unknown, /Live session activity not observed\nOrdinary primary/u);
		assert.doesNotMatch(unknown, /\b(?:Working|Idle)\b/u);
	});

	it("shows retained run failure and parked delivery once each in a compact status card", () => {
		const owner = "00000000-0000-4000-8000-0000000000aa";
		const source = {
			storageId: id,
			pid: 1,
			inventory: { contributions: [], ordinaryOnly: [] },
			deliveryError: `Delivery receipt:25 to ${owner}: parked: primary endpoint is absent; no live owning session for ${owner} and no registered primary accepted delivery`,
			conversation: {
				conversationId: 1,
				identity: id,
				name: "Worker",
				busy: false,
				lastText: "worker answer",
				tasks: [],
				live: { runFailure: { taskId: 26, inputs: [25], reason: "aborted", first: 24 } },
				inbox: { items: [] },
				submissions: [],
				timers: [],
				agent: { model: { provider: "example", modelId: "worker" }, thinkingLevel: "off", extensions: [], tools: [] },
			},
		};
		for (const failure of [
			{ taskId: 26, inputs: [25], reason: "aborted", first: 24 },
			{ taskId: 26, inputs: [25], reason: "model_error", detail: "Request failed\nat a tool", first: 24 },
		]) {
			source.conversation.live.runFailure = failure;
			const details = projectSelectedStatus(source);
			const output = screen(
				createAgentToolCards().agent_status.renderResult(
					{ content: [], details },
					{ expanded: false, isPartial: false },
					theme,
					context(),
				),
			);
			const lines = output.split("\n").map((line) => line.trimStart());
			assert.equal(lines.filter((line) => line.startsWith("Run failed · ")).length, 1);
			assert.equal(lines.filter((line) => line.startsWith("Delivery error · ")).length, 1);
			assert.ok(output.includes(`Run failed · ${failure.reason}`));
			if (failure.detail !== undefined) assert.ok(output.includes("Request failed\\u000aat a tool"));
			assert.match(output, /Delivery error · .*parked/u);
			assert.doesNotMatch(output, /Delivery paused/u);
		}
	});

	it("distinguishes answer pagination from receipt-reference pagination in the card", () => {
		const details = {
			view: "result",
			sessionId: id,
			conversationId: 1,
			submissionId: 7,
			status: "done",
			answer: "Readable answer",
			offset: 0,
			nextOffset: 4096,
			truncated: true,
			answerContinuation: {
				tool: "agent_inspect",
				view: "result",
				sessionId: id,
				submissionId: 7,
				requestId: "input",
				offset: 4096,
			},
			receiptGroup: {
				recipient: "reader",
				results: [],
				complete: false,
				next: {
					tool: "agent_inspect",
					view: "result",
					sessionId: id,
					submissionId: 7,
					requestId: "input",
					receiptCursor: "next",
				},
			},
		};
		const cards = createAgentToolCards();
		const result = { content: [{ type: "text" as const, text: readableControlText(details) }], details };
		const output = screen(
			cards.agent_inspect.renderResult(result, { expanded: false, isPartial: false }, theme, context()),
		);
		assert.match(output, /Answer offset 0 \(UTF-16 units\)/u);
		assert.match(output, /Answer continuation: agent_inspect/u);
		assert.match(output, /Receipt continuation: agent_inspect/u);
		assert.ok(
			screen(
				cards.agent_inspect.renderResult(
					result,
					{ expanded: true, isPartial: false },
					theme,
					context({ expanded: true }),
				),
			).includes("Readable answer"),
		);
		assert.match(
			screen(
				cards.agent_inspect.renderCall({ sessionId: id, view: "result", receiptCursor: "next" }, theme, context()),
			),
			/receipt references page/u,
		);
	});

	it("renders exact communication receipt calls even when this chunk clips no references", () => {
		const receiptContinuation = {
			tool: "agent_inspect",
			view: "result",
			sessionId: id,
			submissionId: 7,
			requestId: "input",
			receiptCursor: "cGFnZTI",
		} as const;
		const receiptCall = `agent_inspect(${JSON.stringify({ view: "result", sessionId: id, submissionId: 7, requestId: "input", receiptCursor: "cGFnZTI" })})`;
		const answerCall = `agent_inspect(${JSON.stringify({ view: "result", sessionId: id, submissionId: 7, requestId: "input", offset: 4096 })})`;
		for (const omittedReferences of [0, 2]) {
			const metadata = {
				status: "done" as const,
				references: [{ submissionId: 7, requestId: "input" }],
				omittedReferences,
				receiptContinuation,
			};
			const value: Communication = {
				format: "agent.communication/1",
				kind: "result",
				sender: { identity: id },
				recordedAt: 1,
				body: { text: `Answer excerpt\n\nAnswer continuation: ${answerCall}`, complete: false, redacted: false },
				metadata,
			};
			const before = structuredClone(value);
			const full = screen(renderCommunicationCard(value, theme, { expanded: true, ...cardKeys }));
			assert.ok(full.includes(`Receipt continuation: ${receiptCall}`));
			assert.ok(full.includes(`Answer continuation: ${answerCall}`));
			assert.match(full, /1 reference shown · more reference pages/u);
			assert.match(full, /further group pages have unknown size/u);
			const renderer = compactCommunicationRenderer();
			const component = renderer(
				{
					role: "custom",
					customType: "agent.communication",
					content: value.body.text,
					details: value,
					timestamp: 1,
					display: true,
				},
				{ expanded: true, outputPad: 0, ...cardKeys },
				theme,
			);
			assert.ok(component);
			const compact = screen(component);
			assert.ok(compact.includes(`Receipt continuation: ${receiptCall}`));
			assert.ok(compact.includes(`Answer continuation: ${answerCall}`));
			assert.match(compact, /1 reference shown · more reference pages/u);
			assert.deepEqual(value, before);
		}
	});

	it("uses ordinary receipt metadata without parsing body prose or requiring a receipt association", () => {
		const receiptContinuation = {
			tool: "agent_inspect",
			view: "result",
			sessionId: id,
			submissionId: 7,
			requestId: "input",
			receiptCursor: "cGFnZTI",
		};
		const receiptCall = `agent_inspect(${JSON.stringify({ view: "result", sessionId: id, submissionId: 7, requestId: "input", receiptCursor: "cGFnZTI" })})`;
		const content = "Answer excerpt with no receipt call in its prose.";
		const details = { kind: "receipt", identity: id, status: "done", receiptContinuation };
		const component = renderPeerNoticeCard({ content, details, timestamp: 1 }, theme, true, cardKeys);
		assert.ok(component);
		const output = screen(component);
		assert.ok(output.includes(`Receipt continuation: ${receiptCall}`));
		assert.ok(output.includes(content));
		assert.match(output, /more receipt references/u);
		const invalid = renderPeerNoticeCard(
			{ content, details: { ...details, receiptContinuation: { ...receiptContinuation, offset: 0 } }, timestamp: 1 },
			theme,
			true,
			cardKeys,
		);
		assert.ok(invalid);
		assert.match(screen(invalid), /Receipt continuation unavailable: invalid source metadata/u);
		assert.doesNotMatch(screen(invalid), /Receipt continuation: agent_inspect/u);
	});

	it("shows retained report acknowledgement without a sender body or a consumption claim", () => {
		const details = projectReportReceipt({
			sourceId: "report:one",
			requestId: "one",
			ownerId: id,
			senderIdentity: "sender",
			createdAt: 1,
			replyTo: null,
			acknowledged: true,
			message: "Secret report body",
		});
		const result = { content: [{ type: "text" as const, text: controlText(details) }], details };
		const card = createAgentToolCards().agent_send;
		for (const expanded of [false, true]) {
			const output = screen(card.renderResult(result, { expanded, isPartial: false }, theme, context({ expanded })));
			assert.match(output, /acknowledged/u);
			assert.doesNotMatch(output, /Secret report body/u);
			if (expanded) assert.match(output, /does not establish model\s+consumption/u);
			else assert.doesNotMatch(output, /consumed|accepted|model consumption/u);
		}
	});

	it("uses the same compact storage presentation in dashboard definitions", () => {
		const details = projectStorageStatus({
			storageId: id,
			conversations: [native],
			coverage: { complete: true, returned: 1, scanned: 1, next: null },
			live: false,
		});
		const definition = createDashboardToolDefinitions("/work")("agent_status");
		assert.ok(definition.renderResult);
		const output = screen(
			definition.renderResult(
				{ content: [], details },
				{ expanded: false, isPartial: false },
				theme,
				context() as never,
			),
		);
		assert.match(output, /1 conversation on a retained storage page/u);
		assert.match(output, /Reader · live activity not observed/u);
		assert.match(output, /Storage scan reached its end/u);
	});
});

describe("human-readable agent targets", () => {
	it("uses observed names, model and provider on every targeted call, with full IDs expanded", () => {
		const cards = createAgentToolCards(() => [row]);
		for (const [name, card] of Object.entries(cards).filter(
			([name]) => name !== "agent_list" && name !== "agent_place" && name !== "agent_intent" && name !== "agent_work",
		)) {
			const args = {
				results: [{ sessionId: id, submissionId: 1 }],
				sessionId: id,
				name: "reload",
				message: "Task",
				action: "read",
			};
			const collapsed = screen(card.renderCall(args, theme, context({ executionStarted: true })));
			assert.match(collapsed, /Parser review\nprovider\/model · high/u, name);
			assert.doesNotMatch(collapsed, new RegExp(id), name);
			assert.ok(screen(card.renderCall(args, theme, context({ ...cardKeys, expanded: true }))).includes(id), name);
		}
	});

	it("keeps declared work local and does not identify its dependency as the caller", () => {
		const card = createAgentToolCards(() => [row]).agent_work;
		const args = {
			action: "continue",
			request: "request-1",
			results: [{ sessionId: id, submissionId: 1 }],
			note: "Read the result",
		};
		const collapsed = screen(card.renderCall(args, theme, context({ executionStarted: true })));
		assert.match(collapsed, /agent_work · continue/u);
		assert.match(collapsed, /request request-1 · 1 result reference/u);
		assert.doesNotMatch(collapsed, /Parser review|provider\/model|high/u);
		const expanded = screen(card.renderCall(args, theme, context({ ...cardKeys, expanded: true })));
		assert.ok(expanded.includes(id));
		assert.match(expanded, /Read the result/u);
	});

	it("resolves handle targets and handle reuse on spawn", () => {
		const profile = {
			identity: id,
			handle: "@parser",
			role: "Review source",
			revision: "abc",
			hasExpertise: false,
			updatedAt: null,
		};
		const cards = createAgentToolCards(() => [{ ...row, profile }]);
		for (const name of ["agent_send", "agent_steer", "agent_status"]) {
			assert.match(
				screen(cards[name].renderCall({ sessionId: "@parser", message: "Task" }, theme, context())),
				/@parser\nprovider\/model · high/u,
			);
		}
		assert.match(
			screen(cards.agent_spawn.renderCall({ handle: "parser" }, theme, context())),
			/@parser\nprovider\/model · high/u,
		);
		assert.ok(
			screen(
				cards.agent_spawn.renderCall({ handle: "parser" }, theme, context({ ...cardKeys, expanded: true })),
			).includes(id),
		);
		assert.ok(
			screen(
				cards.agent_send.renderCall(
					{ sessionId: "@parser", message: "Task" },
					theme,
					context({ ...cardKeys, expanded: true }),
				),
			).includes(id),
		);
		assert.match(
			screen(
				cards.agent_send.renderResult(receipt, { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
			),
			/Message admitted for @parser · submission 405/u,
		);
	});

	it("falls back to the full identity and retains unknown handles", () => {
		const cards = createAgentToolCards();
		assert.ok(
			screen(cards.agent_send.renderCall({ sessionId: id, message: "Task" }, theme, context())).includes(
				`agent_send ${id}`,
			),
		);
		assert.ok(screen(cards.agent_abort.renderCall({ sessionId: `${id}:7` }, theme, context())).includes(`${id}:7`));
		assert.match(
			screen(cards.agent_send.renderCall({ sessionId: "@unknown", message: "Task" }, theme, context())),
			/agent_send @unknown/u,
		);
		assert.ok(
			screen(
				cards.agent_send.renderCall(
					{ sessionId: id, message: "Task" },
					theme,
					context({ ...cardKeys, expanded: true }),
				),
			).includes(id),
		);
	});

	it("disambiguates repeated names only without distinct handles", () => {
		const other = { ...row, id: "87654321-1234-1234-1234-123456789abc" };
		const cards = createAgentToolCards(() => [row, other]);
		assert.ok(
			screen(cards.agent_status.renderCall({ sessionId: id }, theme, context())).includes(`Parser review [${id}]`),
		);
		assert.doesNotMatch(
			screen(createAgentToolCards(() => [row]).agent_status.renderCall({ sessionId: id }, theme, context())),
			/\[/u,
		);
		const differentModel = { ...other, model: { ...model, modelId: "other-model" } };
		assert.doesNotMatch(
			screen(
				createAgentToolCards(() => [row, differentModel]).agent_status.renderCall({ sessionId: id }, theme, context()),
			),
			/\[/u,
		);
	});

	it("uses one hint across call and result during partial, final, expanded and repeated renders", (t) => {
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(
			new nativeTui.KeybindingsManager({
				...nativeTui.TUI_KEYBINDINGS,
				"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
			}),
		);
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const cards = createAgentToolCards(() => [row]);
		for (const name of Object.keys(cards)) {
			const card = cards[name];
			const args = {
				sessionId: id,
				message: "Task\n".repeat(80),
				instructions: "Keep facts",
				background: true,
				view: "history",
				query: "q".repeat(400),
				action: "read",
			};
			const state = {};
			assert.equal(hintCount(screen(card.renderCall(args, theme, context({ state, argsComplete: false })))), 0);
			assert.ok(hintCount(screen(card.renderCall(args, theme, context({ state })))) <= 1);
			const phases = [
				{ ...cardKeys, expanded: false, isPartial: true },
				{ ...cardKeys, expanded: false, isPartial: false },
				{ ...cardKeys, expanded: true, isPartial: true },
				{ ...cardKeys, expanded: true, isPartial: false },
				{ ...cardKeys, expanded: false, isPartial: true },
				{ ...cardKeys, expanded: false, isPartial: false },
			];
			for (const { expanded, isPartial } of phases) {
				const ctx = context({ args, state, expanded, executionStarted: true, isPartial });
				const call = card.renderCall(args, theme, ctx);
				const result = card.renderResult(receipt, { expanded, isPartial }, theme, ctx);
				const combined = `${screen(call)}\n${screen(result)}`;
				assert.ok(hintCount(combined) <= (expanded ? 0 : 1), name);
			}
		}
	});

	it("shares hint ownership without execution flags and respects missing model facts", () => {
		const cards = createAgentToolCards(() => [{ ...row, model: undefined }]);
		const args = { sessionId: id, message: "Task\n".repeat(80) };
		const state = {};
		const ctx = context({ args, state });
		const callComponent = cards.agent_send.renderCall(args, theme, ctx);
		const resultComponent = cards.agent_send.renderResult(
			receipt,
			{ ...cardKeys, expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const call = screen(callComponent);
		const output = screen(resultComponent);
		assert.match(call, /Parser review/u);
		assert.doesNotMatch(call, /unknown|unavailable/u);
		assert.equal(hintCount(call) + hintCount(output), 1);
		const off = createAgentToolCards(() => [{ ...row, model: { ...model, thinkingLevel: "off" } }]);
		assert.match(screen(off.agent_send.renderCall(args, theme, context())), /\nprovider\/model · off\n/u);
	});

	it("keeps admission concise, labels the target, and preserves the full result", () => {
		const cards = createAgentToolCards(() => [row]);
		const before = structuredClone(receipt);
		const collapsed = screen(
			cards.agent_send.renderResult(
				receipt,
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context({ args: { sessionId: id }, executionStarted: true }),
			),
		);
		assert.deepEqual(collapsed.split("\n").slice(0, 2), ["", "Message admitted · submission 405"]);
		assert.doesNotMatch(collapsed, /not proof|submitted|12345678/u);
		assert.ok(
			screen(
				cards.agent_send.renderResult(
					receipt,
					{ ...cardKeys, expanded: true, isPartial: false },
					theme,
					context({ ...cardKeys, expanded: true }),
				),
			).includes(id),
		);
		assert.deepEqual(receipt, before);
	});
});

describe("thread notice cards", () => {
	const sender = "7f7f7f7f-1111-4222-8333-444444444444";
	const notice = (
		metadata: Partial<Extract<Communication, { kind: "notice" }>["metadata"]>,
		text: string,
	): Communication => ({
		format: "agent.communication/1",
		kind: "notice",
		sender: { identity: sender },
		recordedAt: 1,
		body: { text, complete: false, redacted: false },
		metadata: {
			threadId: "storage/thread-a",
			title: "Parser contract",
			event: 27,
			frameRevision: 2,
			eventKind: "close",
			passive: true,
			...metadata,
		},
	});
	const reviewer = {
		id: sender,
		name: "Reviewer",
		model: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
	} as unknown as AgentConversationSummary;
	const lookup = Object.assign((): AgentConversationSummary[] => [reviewer], {
		nameFor: (identity: string) => (identity === sender ? "Reviewer" : undefined),
	});
	const compact = (value: Communication, expanded: boolean, rows: AgentCardLookup = lookup, width = 240) => {
		const component = new CustomMessageComponent(
			{
				role: "custom",
				customType: "agent.communication",
				content: "Model notice, not operator display copy",
				details: value,
				timestamp: 1,
				display: true,
			},
			compactCommunicationRenderer(rows),
		);
		component.setExpanded(expanded);
		return stripVTControlCharacters(component.render(width).join("\n"))
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			.trim();
	};

	it("puts the thread event above the sender and observed model facts", () => {
		const passive = compact(notice({}, "The repairs are in the branch."), false);
		assert.match(
			passive,
			/^\[agent\] Thread closed · Parser contract\n from Reviewer · openai-codex\/gpt-6\.1-sol · high · #27 · passive · /u,
		);
		assert.match(passive, /\n\n The repairs are in the branch\./u);
		assert.doesNotMatch(passive, /Model notice|Source details/u);
		const posted = compact(
			notice({ eventKind: "contribution", passive: false }, "Please check the frame bound."),
			false,
		);
		assert.match(
			posted,
			/^\[agent\] Thread post · Parser contract\n from Reviewer · openai-codex\/gpt-6\.1-sol · high · #27 · attention requested · /u,
		);
		assert.doesNotMatch(posted, /Passive copy|was notified/u);
		const session = Object.assign((): AgentConversationSummary[] => [], {
			modelFor: (identity: string) =>
				identity === sender ? { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "max" } : undefined,
		});
		assert.ok(
			compact(notice({}, ""), false, session).includes(`from ${sender} · anthropic/claude-opus-5-5 · max · #27 · `),
			"the sender configuration comes from the view, and an untyped sender keeps its full identity",
		);
	});

	it("separates the passive copy bound, exact source read and optional delivery facts", () => {
		const limit = "[Passive copy: up to 280 UTF-16 code units retained]";
		const fullRead = 'agent_collaborate({"action":"read","threadId":"storage/thread-a","before":28,"limit":1})';
		const collapsed = compact(notice({}, ""), false);
		assert.doesNotMatch(collapsed, /no text|agent_collaborate/u);
		assert.ok(collapsed.includes(limit));
		assert.match(collapsed, /\.\.\. \([^\n]+ to expand\)$/u);
		const expanded = compact(notice({}, "An authored ellipsis…"), true);
		for (const line of [
			"An authored ellipsis…",
			"Thread: Parser contract",
			"Thread ID: storage/thread-a",
			"Event: #27 · close · frame revision 2",
			"Delivery: passive, no wake requested",
			`Sender identity: ${sender}`,
			limit,
			fullRead,
		])
			assert.ok(expanded.includes(line), line);
		assert.doesNotMatch(expanded, /to expand|frameRevision:|eventKind:|passive: true|threadId:|truncated/u);
		const unknown = notice({ eventKind: undefined, passive: undefined }, "An authored ellipsis…");
		assert.match(compact(unknown, false), /^\[agent\] Thread notice · Parser contract\n/u);
		assert.doesNotMatch(compact(unknown, false), /passive|attention requested|notified/iu);
		assert.doesNotMatch(compact(unknown, true), /Passive copy|Delivery:|notified|truncated/u);
		assert.match(compact(notice({ passive: false }, ""), true), /Delivery: attention requested/u);
	});

	it("keeps a configured disclosure key on one row at narrow widths", (t) => {
		const previous = nativeTui.getKeybindings();
		nativeTui.setKeybindings(
			new nativeTui.KeybindingsManager({
				...nativeTui.TUI_KEYBINDINGS,
				"app.tools.expand": { defaultKeys: "ctrl+shift+y", description: "Expand tool output" },
			}),
		);
		t.after(() => nativeTui.setKeybindings(previous));
		const value = notice({ passive: false }, "first\nsecond\nthird\nfourth\nfifth");
		const wide = compact(value, false);
		assert.match(wide, /\.\.\. \(2 more lines, ctrl\+shift\+y to expand\)$/u);
		const narrow = compact(value, false, lookup, 31)
			.split("\n")
			.map((line) => line.trim());
		assert.deepEqual(narrow.slice(3, 6), ["first", "second", "third"]);
		assert.equal(narrow.filter((line) => line.includes("to expand")).length, 1);
		assert.equal(narrow.at(-1), "... (ctrl+shift+y to expand)");
		assert.ok(!narrow.some((line) => line.match(/fourth|fifth|Source details/u)));
	});

	it("gives an ordinary peer notice the same two tiers, with the sender's model", () => {
		const details = {
			kind: "report",
			senderIdentity: sender,
			label: "Reviewer",
			provider: "openai-codex",
			modelId: "gpt-6.1-sol",
			thinkingLevel: "high",
			threadId: "storage/thread-a",
			threadTitle: "Parser contract",
			threadEvent: 12,
			threadEventKind: "contribution",
			passive: false,
			operatorMessage: "Please check the frame bound.",
		};
		const card = renderPeerNoticeCard(
			{ content: "Thread notice from the model text", details, timestamp: 1 },
			theme,
			false,
			cardKeys,
		);
		assert.ok(card);
		const output = screen(card);
		assert.match(
			output,
			/\[agent\] thread post · Parser contract\nfrom Reviewer · openai-codex\/gpt-6\.1-sol · high · #12 · notified this session\n/u,
		);
		assert.match(output, /Please check the frame bound\./u);
		assert.doesNotMatch(output, /model text/u);
		const passive = {
			kind: "report",
			senderIdentity: sender,
			label: "Reviewer",
			threadId: "storage/thread-a",
			threadTitle: "Parser contract",
			passive: true,
			operatorMessage: "",
			communicationPassive: { value: { metadata: { event: 13, eventKind: "join" } } },
		};
		const joined = renderPeerNoticeCard(
			{ content: "Thread notice from the model text", details: passive, timestamp: 1 },
			theme,
			false,
			cardKeys,
		);
		assert.ok(joined);
		const joinedOutput = screen(joined);
		assert.match(joinedOutput, /\[agent\] member joined · Parser contract\nfrom Reviewer · #13\n/u);
		assert.doesNotMatch(joinedOutput, /no text|notified this session/u);
	});
});
