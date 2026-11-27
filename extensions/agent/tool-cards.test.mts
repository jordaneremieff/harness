import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
/** Host-injected keybinding hints, as Pi passes them to renderers. */
const cardKeys = { keyText, keyHint };
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OpenWorkDependencyView, OpenWorkDetails, OpenWorkView } from "./open-work.ts";
import { projectReportReceipt } from "./control-result.ts";
import { briefPreview, briefPreviewText, renderBrief } from "./brief.ts";
import { fixtures, rows, targetId } from "./tool-card-fixture.mts";
import { buildStatusOverview, projectStorageStatus } from "./status-overview.ts";
import { AgentCatalog, type CatalogRecord } from "./catalog.ts";
import { readFleetStatus } from "./fleet-status.ts";
import type { OrdinaryPrimaryObservation } from "./primary-observation.ts";
import { coverage as rosterCoverage } from "./dashboard-test-fixture.mts";
import type { AgentConversationSummary, AgentPrioritySummary } from "./dashboard-types.ts";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import {
	createAgentToolCards,
	displayPreview,
	displayText,
	renderAbortCall,
	renderAgentCall,
	renderCommandCall,
	renderCompactCall,
	renderCompactResult,
	renderInspectCall,
	renderInspectResult,
	renderListCall,
	renderListResult,
	renderSendCall,
	renderSendResult,
	renderSteerCall,
	renderSteerResult,
	renderAgentPeerMessage,
	type AgentCardContext,
} from "./tool-cards.ts";

function renderPeerNoticeCard(
	input: { content: string; details?: unknown; timestamp?: number },
	theme: Theme,
	expanded: boolean,
	keys: typeof cardKeys,
) {
	return renderAgentPeerMessage(
		{ role: "custom", customType: "agent.peer", display: true, timestamp: 0, ...input },
		{ expanded, outputPad: 0, ...keys },
		theme,
	);
}

initTheme("dark", false);
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
// Native key hints read the TUI instance resolved by the coding-agent package.
const nativeTui = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
);
const previousNativeKeys = nativeTui.getKeybindings();
nativeTui.setKeybindings(
	new nativeTui.KeybindingsManager({
		...nativeTui.TUI_KEYBINDINGS,
		"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
	}),
);
after(() => nativeTui.setKeybindings(previousNativeKeys));
const theme = {
	fg: (_color: string, value: string) => value,
	bg: (_color: string, value: string) => value,
	getBgAnsi: () => "",
	bold: (value: string) => value,
} as unknown as Theme;
const screen = (component: { render(width: number): readonly string[] }, width = 100) =>
	component
		.render(width)
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
const result = (details: unknown, text = JSON.stringify(details)): AgentToolResult<unknown> => ({
	content: [{ type: "text", text }],
	details,
});
it("shows the brief objective, section summary, and exact expanded source", () => {
	const card = createAgentToolCards(() => rows).agent_brief;
	const args = {
		...fixtures.agent_brief.args,
		kind: "review",
		handle: "parser",
		preset: "review",
		model: "test/other",
		thinkingLevel: "high",
		preview: true,
		purpose: "Find gaps before release.",
		operator: [{ quote: "Use the source.", source: "Original request" }],
		sources: ["README.md", "docs/guide.md"],
		checks: ["Check the example."],
	};
	const collapsed = screen(card.renderCall(args, theme, context()), 200);
	assert.match(collapsed, /^agent_brief @parser\n.*test\/other · high.*preset review.*review · preview/u);
	assert.match(collapsed, /Review the parser\./u);
	assert.match(collapsed, /1 operator decision · 2 sources/u);
	assert.doesNotMatch(collapsed, /Find gaps before release|Original request/u);
	const expanded = screen(card.renderCall(args, theme, context({ expanded: true })), 320);
	for (const line of [
		"handle: parser",
		"thinkingLevel: high",
		"objective: Review the parser.",
		"endCondition: Stop after review.",
		'"quote": "Use the source."',
		'"source": "Original request"',
		'"docs/guide.md"',
	])
		assert.ok(expanded.includes(line), line);
	const steer = screen(
		card.renderCall(
			{ ...fixtures.agent_brief.args, sessionId: targetId, mode: "steer" },
			theme,
			context({ lookup: () => rows }),
		),
	);
	assert.match(steer, /agent_brief Parser review[\s\S]*mode steer/u);
	const long = screen(card.renderCall({ objective: "x".repeat(380) }, theme, context()), 60);
	assert.match(long, /^agent_brief\n(?:x+\n){5}\.\.\. \(2 more lines, ctrl\+o to expand\)$/u);
	assert.doesNotMatch(long, /new agent|objective pending/u);
});

it("renders a brief creation or admission like its dispatch path and a preview like no dispatch", () => {
	const cards = createAgentToolCards();
	const { args, details } = fixtures.agent_brief;
	const options = { isPartial: false, expanded: false };
	const render = (name: keyof typeof cards, value: AgentToolResult<unknown>, args: Record<string, unknown>) =>
		screen(cards[name].renderResult(value, options, theme, context({ args, lookup: () => rows })));
	const created = result(details);
	assert.equal(render("agent_brief", created, args), render("agent_spawn", created, args));
	for (const [mode, outcome] of [
		["followUp", "Message admitted"],
		["steer", "Steer admitted"],
	] as const) {
		const reach = { ...args, sessionId: targetId, mode };
		const admission = result({ ...(fixtures.agent_send.details as object), brief: renderBrief(reach).brief });
		assert.match(render("agent_brief", admission, reach), new RegExp(`${outcome} · submission 405`, "u"));
	}
	const problem = "Source path does not exist: missing.md (resolved /work/missing.md)";
	const preview = briefPreview(renderBrief(args), [problem]);
	const output = render("agent_brief", result(preview, briefPreviewText(preview)), { ...args, preview: true });
	assert.match(output, new RegExp(`Preview · ${preview.brief.characters} characters`));
	assert.match(output, /nothing was sent/u);
	assert.ok(output.includes(problem));
	assert.doesNotMatch(output, /Spawned|Admitted/u);
});

const conversationStatus = (overrides: Record<string, unknown> = {}) => ({
	conversationId: 1,
	identity: "storage-a",
	name: "Parser review",
	busy: true,
	cwd: "/work",
	lastText: "Check the source\u001b",
	live: {
		run: { taskId: 7 },
		tools: [
			{ callId: "call-7", name: "read", status: "running" },
			{ callId: "call-8", name: "bash", status: "pending" },
		],
	},
	inbox: { items: [{ id: 1, mode: "steer", content: "queued" }] },
	usage: {},
	agent: {
		model: { provider: "provider", modelId: "model" },
		thinkingLevel: "high",
		extensions: ["a"],
		tools: ["read", "bash"],
		cwd: "/work",
	},
	tasks: [{ id: 7, kind: "pi.generation", status: "running", background: false, abortRequested: false }],
	submissions: [{ id: 3, type: "input", status: "done", entryId: 1, answerEntryId: 2 }],
	...overrides,
});
const snapshotResult = (status: Record<string, unknown>, outer: Record<string, unknown> = {}) =>
	result({
		sessionId: "storage-a",
		cwd: "/work",
		status: { conversation: status, inventory: { contributions: [], ordinaryOnly: ["/ext/ordinary.ts"] }, ...outer },
		admission: { submissionId: 9, conversationId: 1, deduped: false, identity: "storage-a" },
		lifetime: "independent host process",
	});

let fleetCatalogs = 0;
/** An in-memory catalog for a fleet read: the named records, plus identities whose record cannot be read. */
function fleetCatalog(records: CatalogRecord[], unreadable: string[] = []): AgentCatalog {
	const catalog = new AgentCatalog(`/work/catalog-${++fleetCatalogs}`);
	catalog.identities = async () => [...records.map((record) => record.storageId), ...unreadable].sort();
	catalog.recordStamp = () => "unchanged";
	catalog.derive = (identity, project) => {
		const record = records.find((item) => item.storageId === identity);
		if (!record) throw new Error("unreadable fixture record");
		return { fileStamp: "unchanged", value: project(record) };
	};
	return catalog;
}

describe("status cards", () => {
	const card = createAgentToolCards().agent_status;
	const options = { ...cardKeys, expanded: false, isPartial: false };
	const render = (details: unknown, args: unknown = {}, expanded = false) =>
		screen(
			card.renderResult(result(details), { ...options, expanded }, theme, context({ args, expanded })),
			expanded ? 1000 : 180,
		);

	it("shows the exact storage and distinguishes an initial scan from a cursor continuation", () => {
		const storageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const args = { view: "storage-page", storageId };
		const nextArgs = { ...args, cursor: { after: "opaque-token" }, limit: 50 };
		const next = { tool: "agent_status", ...nextArgs };
		const value = projectStorageStatus({
			storageId,
			live: false,
			conversations: [],
			coverage: { complete: false, scanned: 50, returned: 0, next },
		});
		const firstCall = screen(card.renderCall(args, theme, context()));
		assert.ok(firstCall.includes(storageId));
		assert.match(firstCall, /storage page/u);
		assert.doesNotMatch(firstCall, /overview|continuation/u);
		assert.match(screen(card.renderCall(nextArgs, theme, context())), /storage page · continuation/u);
		const text = render(value, args);
		assert.match(text, /0 conversations on a retained storage page; more available/u);
		assert.doesNotMatch(text, /50 conversations scanned|agent_list|opaque-token|0 working/u);
		const expanded = render(value, args, true);
		assert.match(expanded, /50 conversations scanned/u);
		assert.ok(expanded.includes(`Continue with agent_status(${JSON.stringify(nextArgs)})`));
		assert.ok(render(value).includes(storageId), "implicit native storage is named by the result");
	});

	it("puts observed working rows first without treating a retained run as live", () => {
		const details = {
			conversations: [
				{ identity: "quiet", name: "Quiet review", availability: "live", busy: false },
				{ identity: "active", name: "Active review", availability: "live", busy: true, runId: 9 },
			],
		};
		assert.match(render(details), /Active review · working · run 9/u);
		assert.doesNotMatch(render(details), /Quiet review/u);
		assert.match(render(details, {}, true), /Quiet review · idle/u);
		assert.match(render({ ...details, live: false }), /Active review · live activity not observed/u);
		assert.doesNotMatch(render({ ...details, live: false }), /working|run 9/u);
	});

	it("distinguishes matched fleet samples from machine-wide coverage and from a no-match filter", async () => {
		const now = Date.UTC(2026, 9, 1);
		const observedAt = new Date(now).toISOString();
		const model = "sample/runner";
		const catalog = fleetCatalog(
			[
				{
					storageId: "storage-a",
					storagePath: "/work/agent.sqlite",
					cwd: "/work",
					agentDir: "/work",
					packageDir: "/work",
					model: { provider: "sample", modelId: "runner" },
					thinkingLevel: "high",
					createdAt: observedAt,
					view: {
						updatedAt: observedAt,
						rows: [],
						coverage: { complete: false, omitted: 1 },
						modelEvidence: {
							models: [{ model, reportedCost: 0.2 }],
							failures: [
								{
									provider: "sample",
									modelId: "runner",
									at: now,
									conversationId: "storage-a",
									entryId: 2,
									message: "Request refused",
								},
							],
							warnings: [],
							toolReportedCost: 0,
							sampling: {
								observedAt,
								entriesVisited: 2,
								entriesOmitted: 0,
								messagesOmitted: 0,
								invalidSamples: 0,
								omittedSamples: 0,
								samples: [
									{ model, at: now, tokens: 100, reportedCost: 0.2 },
									{ model: "other/runner", at: now, tokens: 24, reportedCost: 0.1 },
								],
							},
							coverage: {
								conversationsVisited: 1,
								conversationsComplete: false,
								unavailableUsage: 0,
								incompleteHistory: 1,
								omittedModels: 0,
								omittedFailures: 0,
								omittedWarnings: 0,
							},
						},
					},
				},
			],
			["storage-b"],
		);
		const args = { view: "fleet", model, provider: "sample" };
		const call = screen(card.renderCall(args, theme, context()));
		assert.match(call, /agent_status sample\/runner\nfleet · provider filter sample/u);
		assert.doesNotMatch(call, /overview/u);
		const providerOnly = screen(card.renderCall({ view: "fleet", provider: "sample" }, theme, context()));
		assert.match(providerOnly, /agent_status sample\nfleet/u);
		const match = render(await readFleetStatus(catalog, { now, model, provider: "sample" }), args);
		assert.match(match, /1 model, 1 failure in local evidence\nPublished evidence, not provider health/u);
		assert.doesNotMatch(match, /0 warnings/u);
		assert.match(match, /Sampled failure · sample\/runner · Request refused/u);
		assert.match(match, /1 sampled response for the filter in the last 7 days.*\$0\.2 reported/u);
		assert.match(match, /2 machine-wide usage samples/u);
		assert.match(match, /\[Partial fleet coverage\]/u);
		assert.doesNotMatch(match, /Result received|"usageCoverage"/u);
		const none = render(await readFleetStatus(catalog, { now, model: "missing/model" }), {
			view: "fleet",
			model: "missing/model",
		});
		assert.match(none, /No evidence matched the filter/u);
		assert.match(none, /2 machine-wide usage samples/u);
		assert.doesNotMatch(none, /Last 7 days|\$0|healthy/u);

		const empty = fleetCatalog([]);
		assert.match(screen(card.renderCall({ view: "fleet" }, theme, context())), /^agent_status fleet/u);
		const unfiltered = render(await readFleetStatus(empty, { now }), { view: "fleet" });
		assert.match(unfiltered, /No machine-wide usage samples; use is not established/u);
		assert.doesNotMatch(unfiltered, /\$0|healthy|Result received/u);
	});

	it("identifies ordinary primary presence and Durable timer facts in full selected results", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 24, 12) });
		const timestamp = new Date(2026, 9, 1, 14, 32).toISOString();
		const primary: OrdinaryPrimaryObservation = {
			kind: "ordinary-primary",
			view: "status",
			sessionId: "primary",
			observedAt: timestamp,
			presence: {
				basis: "endpoint-record",
				cwd: "/work",
				name: "Primary review",
				process: {
					pid: 1,
					hostname: "local",
					state: "live",
					basis: "local-pid-probe",
					attribution: "process-existence-not-session-progress",
				},
			},
			unknown: {
				idle: "unknown",
				selectedLeaf: "unknown",
				timers: "unknown",
				tasks: "unknown",
				unretainedActivity: "unknown",
			},
			source: {
				ancestry: "latest-retained-ancestry",
				head: { id: "b5e12936", parentId: null, timestamp, byteOffset: 8 },
				latestKnown: true,
			},
			entries: [],
			coverage: {
				complete: false,
				reasons: ["line-budget"],
				bytesRead: 240,
				linesVisited: 3,
				parentVisits: 1,
				textScanBytes: 0,
				omissions: { credentials: 0, fields: 0, text: 0 },
			},
		};
		const ordinary = render(primary, { sessionId: "primary", detail: true });
		assert.match(ordinary, /Live session activity not observed\nOrdinary primary/u);
		assert.match(ordinary, /Primary review/u);
		assert.match(ordinary, /Local process exists/u);
		assert.match(ordinary, /Latest retained entry b5e12936/u);
		assert.match(ordinary, /Retained ancestry scan incomplete/u);
		assert.doesNotMatch(ordinary, /idle|working|Result received/u);
		const durable = render(
			{
				storageId: "storage-a",
				pid: 1,
				inventory: { contributions: [], ordinaryOnly: [] },
				conversation: conversationStatus({
					timers: [
						{
							id: 12,
							target: "storage-a",
							deadline: Date.parse(timestamp),
							mode: "followUp",
							status: "unsettled",
							overdue: true,
						},
					],
				}),
			},
			{ sessionId: "storage-a", detail: true },
			true,
		);
		assert.match(durable, /Durable agent · live host observation/u);
		assert.match(durable, /Earliest timer 12 · 1 Oct 2:32 PM · unsettled · overdue/u);
	});
});

describe("agent call cards", () => {
	it("shows explicit requests without unresolved default chatter", () => {
		const spawn = screen(
			renderAgentCall(
				"agent_spawn",
				{ name: "Parser review", model: "provider/model", thinkingLevel: "high" },
				theme,
				context(),
			),
			160,
		);
		assert.match(spawn, /agent_spawn Parser review/);
		assert.match(spawn, /^provider\/model · high$/m);
		assert.doesNotMatch(spawn, /Model: |snapshot/);
		assert.doesNotMatch(screen(renderAgentCall("agent_spawn", {}, theme, context())), /Requested:|unresolved/);
		assert.doesNotMatch(
			screen(renderAgentCall("agent_place", { area: "project" }, theme, context())),
			/Requested:|unresolved/,
		);
		assert.doesNotMatch(
			screen(renderAgentCall("agent_configure", { sessionId: "target", name: "" }, theme, context())),
			/Requested:|unresolved/,
		);
		assert.match(
			screen(renderAgentCall("agent_configure", { sessionId: "target", model: "provider/model" }, theme, context())),
			/^provider\/model$/m,
		);
		assert.doesNotMatch(screen(renderAgentCall("agent_status", {}, theme, context())), /Requested:/);
	});

	it("renders a bare heading for missing arguments and the submitted arguments on redraw", () => {
		const initial = renderAgentCall("agent_spawn", null, theme, context());
		assert.match(screen(initial), /^agent_spawn/);
		const final = renderAgentCall(
			"agent_spawn",
			{ prompt: "/project/location" },
			theme,
			context({ ...cardKeys, expanded: true, lastComponent: initial }),
		);
		assert.equal(screen(initial), "agent_spawn");
		assert.match(screen(final), /project\/location/);
	});

	it("shows an argument hint only when a collapsed call hides or clips content", () => {
		assert.equal(
			screen(renderAgentCall("agent_status", { sessionId: "s" }, theme, context())),
			"agent_status s\nselected status",
		);
		assert.match(
			screen(renderAgentCall("agent_status", { sessionId: "s", detail: true }, theme, context())),
			/full detail/u,
		);
		assert.doesNotMatch(screen(renderAgentCall("agent_attach", { sessionId: "s" }, theme, context())), /to expand/u);
		assert.match(
			screen(renderAgentCall("agent_attach", { sessionId: "s", model: "p/m" }, theme, context())),
			/^p\/m$/m,
		);
		assert.match(
			screen(renderAgentCall("agent_spawn", { prompt: "p".repeat(640) }, theme, context())),
			/more lines, ctrl\+o to expand\)/,
		);
		assert.match(screen(renderListCall({ query: "q".repeat(400) }, theme, context())), /\(ctrl\+o to expand\)/);
	});

	it("removes controls and fits narrow widths", () => {
		const hostile = "日本語 😀\x1b]52;c;data\x07\u202e";
		const view = renderAgentCall(
			"agent_spawn",
			{ model: `provider/${"long-".repeat(80)}`, prompt: hostile, cwd: "/project" },
			theme,
			context(),
		);
		for (const width of [12, 24, 80, 160]) {
			assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(screen(view, width), /[\x1b\x07\u202e]/u);
		}
		const expanded = renderAgentCall(
			"agent_spawn",
			{ prompt: hostile },
			theme,
			context({ ...cardKeys, expanded: true }),
		);
		assert.ok(screen(expanded).includes(displayText(hostile)));
	});

	it("shows a send or steer target, reply reference, preview, and full submitted text", () => {
		for (const [renderer, name] of [
			[renderSendCall, "agent_send"],
			[renderSteerCall, "agent_steer"],
		] as const) {
			const args = {
				sessionId: "target-session",
				message: "First line\n\n**literal Markdown** and `code`\nLast line",
				replyTo: "message-reference",
			};
			const before = structuredClone(args);
			const collapsed = renderer(args, theme, context());
			assert.match(screen(collapsed), new RegExp(`^${name} target-session\nreply to message-reference`, "u"));
			assert.match(screen(collapsed), /First line\n\n\*\*literal Markdown\*\*/u);
			assert.doesNotMatch(screen(collapsed), /to expand/u, "all supplied values already fit");
			const expanded = renderer(args, theme, context({ ...cardKeys, expanded: true, lastComponent: collapsed }));
			assert.match(screen(expanded), /message: First line[\s\S]*\*\*literal Markdown\*\*[\s\S]*Last line/u);
			assert.deepEqual(args, before);
		}
	});

	it("omits pending and empty message placeholders and names display bounds", () => {
		assert.doesNotMatch(
			screen(renderSendCall({ sessionId: "t", message: " \n " }, theme, context())),
			/empty or whitespace-only message/,
		);
		assert.equal(
			screen(renderSendCall({ sessionId: "t", message: " " }, theme, context({ argsComplete: false }))),
			"agent_send t",
		);
		assert.doesNotMatch(screen(renderSendCall({}, theme, context())), /target pending|unknown|unavailable/);
		const message = `${"long line\n".repeat(5000)}EXACT_END`;
		const expanded = screen(
			renderSendCall({ sessionId: "t", message }, theme, context({ ...cardKeys, expanded: true })),
		);
		assert.match(expanded, /\[Truncated: showing 32000 of \d+ characters\]/u);
		assert.doesNotMatch(expanded, /EXACT_END/u);
		assert.equal(displayPreview("a😀b", 2), "a…");
	});

	it("shows a compaction request without an abort or idle prediction", () => {
		const summary = "Preserve the objective and next action.";
		assert.equal(
			screen(renderCompactCall({ sessionId: "target", summary }, theme, context())),
			`agent_compact target\nsupplied summary\n${summary}`,
		);
		assert.equal(
			screen(renderCompactCall({ sessionId: "worker-session" }, theme, context())),
			"agent_compact worker-session",
		);
		assert.equal(
			screen(renderCompactCall({ sessionId: "w", instructions: "Keep the API section" }, theme, context())),
			"agent_compact w\nKeep the API section",
		);
	});

	it("summarizes list, inspect, abort, and command calls", () => {
		const list = screen(
			renderListCall({ query: "renderer", cwd: "/srv/work", limit: 5, cursor: "Y3Vyc29y" }, theme, context()),
		);
		assert.match(list, /^agent_list renderer/m);
		assert.match(list, /in \/srv\/work · limit 5 · continuation page/);
		const inspect = screen(
			renderInspectCall(
				{
					sessionId: "s",
					view: "search",
					query: "needle",
					source: "assistant",
					cursor: { cursor: null, skip: 0, scannedBytes: 0 },
				},
				theme,
				context(),
			),
		);
		assert.match(inspect, /^agent_inspect needle\ns · search · source assistant · continuation page/u);
		const activity = screen(renderInspectCall({ sessionId: "s", view: "activity" }, theme, context()));
		assert.match(activity, /^activity$/mu);
		assert.doesNotMatch(activity, /limit/u, "ordinary primary and Durable activity have different default limits");
		const call = (args: Record<string, unknown>) =>
			screen(renderInspectCall({ sessionId: "s", ...args }, theme, context()), 240);
		assert.match(call({ view: "exact", entryId: 83, offset: 0 }), /^agent_inspect entry 83\ns · exact · offset 0/u);
		assert.match(call({ view: "history", fromId: 64, limit: 2 }), /from 64 · limit 2/u);
		assert.match(
			call({ view: "result", submissionId: 23, requestId: "ask", finalReport: true, offset: 64 }),
			/^agent_inspect submission 23\ns · result · request ask · offset 64 · final report/u,
		);
		assert.match(
			call({ view: "result", operationId: "op", receiptCursor: "opaque" }),
			/^agent_inspect operation op\ns · result · receipt references page/u,
		);
		assert.doesNotMatch(call({}), /view history/u, "the target determines the default view");
		assert.match(screen(renderAbortCall({ sessionId: "s" }, theme, context())), /agent_abort s/);
		assert.match(
			screen(renderCommandCall({ sessionId: "s", name: "reload", args: "--force" }, theme, context())),
			/^agent_command reload\non s · args --force/u,
		);
		assert.match(
			screen(renderCommandCall({ sessionId: "s", name: "reload", args: "--force" }, theme, context())),
			/args --force/,
		);
		assert.equal(screen(renderInspectCall({}, theme, context())), "agent_inspect this session");
	});
});

describe("agent result cards", () => {
	it("shows the snapshot model, activity, running tools, pending input, and capability limits", () => {
		const resultValue = snapshotResult(conversationStatus());
		const before = structuredClone(resultValue);
		const card = createAgentToolCards().agent_status.renderResult(
			resultValue,
			{ ...cardKeys, expanded: false, isPartial: false },
			theme,
			context(),
		);
		const text = screen(card, 180);
		assert.match(text, /Parser review/);
		assert.match(text, /provider\/model · high/);
		assert.match(text, /^\nWorking · run 7\nDurable agent · live host observation\n/u);
		assert.match(
			text,
			/Running read · call call-7\nPending bash · call call-8\n\.\.\. \(4 more lines, ctrl\+o to expand\)$/u,
		);
		assert.doesNotMatch(text, /Latest message|Saved result|configured extension/u);
		assert.deepEqual(resultValue, before);
		for (const width of [12, 40, 100]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
		const expanded = screen(
			createAgentToolCards().agent_status.renderResult(
				resultValue,
				{ ...cardKeys, expanded: true, isPartial: false },
				theme,
				context(),
			),
			240,
		);
		assert.match(expanded, /^\nWorking · run 7\nDurable agent · live host observation\n/u);
		assert.match(expanded, /Pending bash · call call-8\n1 pending input\nLatest message · Check the source$/mu);
		assert.doesNotMatch(expanded, /\x1b|\\u\{|to expand/u, "expanded text has no control characters or hint");
		assert.match(expanded, /Saved result · done · submission 3\n1 configured extension without a native form/u);
		assert.match(expanded, /"callId":\s*"call-7"/);
	});

	it("lists parked tool calls without calling them running", () => {
		const live = {
			tools: [
				{ callId: "signal", name: "read", status: "sleeping" },
				{ callId: "child", name: "codemode", status: "waiting" },
			],
		};
		const status = createAgentToolCards().agent_status;
		const value = snapshotResult(conversationStatus({ live }));
		const render = (expanded: boolean) =>
			screen(status.renderResult(value, { ...cardKeys, expanded, isPartial: false }, theme, context()), 180);
		const collapsed = render(false);
		assert.match(
			collapsed,
			/Sleeping read · call signal\nWaiting codemode · call child\n\.\.\. \(4 more lines, ctrl\+o to expand\)$/u,
		);
		assert.doesNotMatch(collapsed, /Running (?:read|codemode)/u);
		const expanded = render(true);
		assert.match(expanded, /Sleeping read · call signal\nWaiting codemode · call child/u);
		assert.doesNotMatch(expanded, /Running (?:read|codemode)|to expand/u);
	});

	it("marks a cold snapshot read-only instead of reporting it idle", () => {
		const readOnly = snapshotResult(conversationStatus({ busy: false, live: {} }), { live: false });
		const text = screen(
			createAgentToolCards().agent_status.renderResult(
				readOnly,
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			),
			180,
		);
		assert.match(text, /^\nLive session activity not observed\nDurable agent · retained snapshot\n/u);
		assert.doesNotMatch(text, /\n(?:Idle|Working)\n|live host observation/u);
	});

	it("labels the newest retained text by author without inferring current work from it", () => {
		const render = (status: Record<string, unknown>) =>
			screen(
				createAgentToolCards().agent_status.renderResult(
					snapshotResult(status),
					{ ...cardKeys, expanded: true, isPartial: false },
					theme,
					context(),
				),
				180,
			);
		for (const busy of [true, false]) {
			const live = busy ? { run: { taskId: 7 } } : {};
			const cases = [
				[undefined, "Ran crash-1.", "Latest message"],
				["assistant", "Done reviewing.", "Latest reply"],
				["user", "Check the parser", "Latest input"],
			] as const;
			for (const [lastTextRole, lastText, label] of cases) {
				const lines = render(conversationStatus({ busy, live, lastTextRole, lastText })).split("\n");
				assert.equal(lines[1], busy ? "Working · run 7" : "Idle");
				assert.ok(lines.includes(`${label} · ${lastText}`));
				assert.doesNotMatch(lines.join("\n"), /Replying|Working on (?:the task|input)/u);
			}
		}
	});

	it("renders a compact mutation status with state and capability limits", () => {
		const compact = result({
			sessionId: "storage-a",
			cwd: "/work",
			admission: { submissionId: 9, conversationId: 1, deduped: false },
			status: {
				identity: "storage-a",
				conversationId: 1,
				name: "Parser review",
				cwd: "/work",
				busy: false,
				state: "idle",
				agent: { model: { provider: "provider", modelId: "model" }, thinkingLevel: "high" },
				limits: { ordinaryOnly: ["/ext/ordinary.ts"] },
			},
		});
		const card = createAgentToolCards().agent_spawn;
		const collapsed = screen(
			card.renderResult(compact, { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
			180,
		);
		assert.match(collapsed, /Admitted · Parser review · submission 9 · provider\/model · high/u);
		assert.doesNotMatch(collapsed, /State:|Capability limits/u);
		const text = screen(
			card.renderResult(compact, { ...cardKeys, expanded: true, isPartial: false }, theme, context()),
			180,
		);
		assert.match(text, /^idle$/mu);
		assert.match(text, /1 configured extension without a native form/);
		assert.doesNotMatch(text, /Activity: idle · pending unknown/u);
	});

	it("shows a stalled delivery from the host status", () => {
		const status = result({
			conversation: conversationStatus({ busy: false, live: {} }),
			inventory: { contributions: [], ordinaryOnly: [] },
			pid: 1,
			storageId: "storage-a",
			deliveryError:
				"primary owner 18f6603b runs an agent extension with endpoint version 1; this host requires version 2. Restart that Pi process to load the current extension.",
		});
		const text = screen(
			createAgentToolCards().agent_status.renderResult(
				status,
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			),
			240,
		);
		assert.match(text, /^\nIdle\nDelivery paused · primary owner [^\n]+Restart that Pi process/u);
		assert.match(text, /\nDurable agent · live host observation\n/u);
	});

	it("shows an enriched mutation snapshot beside its receipt", () => {
		const fork = result({
			conversationId: 2,
			identity: "storage-a:2",
			deduped: false,
			status: { conversation: conversationStatus({ name: "Forked review" }) },
		});
		const text = screen(
			createAgentToolCards().agent_fork.renderResult(
				fork,
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			),
			180,
		);
		assert.match(text, /provider\/model · high/);
		assert.match(text, /Fork created · storage-a:2/);
	});

	it("keeps a successful mutation receipt when the post-mutation snapshot failed", () => {
		const fork = result({
			conversationId: 2,
			identity: "storage-a:2",
			deduped: false,
			snapshotError: "claim refused after mutation",
		});
		const card = createAgentToolCards().agent_fork.renderResult(
			fork,
			{ ...cardKeys, expanded: false, isPartial: false },
			theme,
			context(),
		);
		const text = screen(card, 180);
		assert.match(text, /Snapshot unavailable: claim refused after mutation/);
		assert.match(text, /Fork created · storage-a:2/);
		assert.doesNotMatch(text, /Model: |Activity:/);
		for (const width of [12, 40, 100]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
	});

	it("accepts a bare conversation status and a conversations wrapper without inventing cost", () => {
		const bare = screen(
			createAgentToolCards().agent_status.renderResult(
				result({ conversation: conversationStatus({ busy: false, live: {} }) }),
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			),
			180,
		);
		assert.match(bare, /^\nIdle\nDurable agent · live host observation\n/u);
		const wrapped = screen(
			createAgentToolCards().agent_status.renderResult(
				result({
					conversations: [conversationStatus(), conversationStatus({ identity: "storage-a:2", busy: false, live: {} })],
				}),
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			),
			180,
		);
		assert.match(wrapped, /2 conversations on a storage page/);
		assert.match(wrapped, /Parser review · live activity not observed/u);
		assert.doesNotMatch(wrapped, / · (?:working|idle)\b|\$0\.00/u);
	});

	it("summarizes a status overview with unavailable storage counters", () => {
		const details = {
			sessions: [
				{ id: "a", name: "Parser review", state: "working", currentTool: { name: "read" }, cost: 0.25, partial: false },
				{ id: "b", name: "Reviewer", state: "idle", cost: 0.5, partial: true },
				{ id: "c", state: "done", cost: 0, partial: false },
				{ id: "d", state: "failed", cost: 0, partial: false },
				{ id: "e", state: "new", cost: 0, partial: false },
			],
			failures: [{ storageId: "broken", error: "unreadable" }],
			summary: {
				sessions: {
					observed: 5,
					working: 1,
					attention: 1,
					unavailable: 0,
					quiet: 3,
					summarizedUnavailable: 0,
					summarizedQuiet: 0,
				},
			},
		};
		const text = screen(
			createAgentToolCards().agent_status.renderResult(
				result(details),
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			),
			180,
		);
		assert.match(text, /1 working · 1 needs attention\nParser review · working · read/);
		assert.match(text, /ctrl\+o to expand/u);
		assert.doesNotMatch(text, /rows returned|3 quiet|≥|\+\?/);
		assert.doesNotMatch(text, /\$/, "sampled costs are not fleet totals");
		assert.match(text, /1 storage unavailable; absence not established/);
		assert.doesNotMatch(text, /· new/);
	});

	it("shows disjoint supplied-page totals rather than sampled overview counts at narrow widths", () => {
		const row = (index: number, state: AgentConversationSummary["state"]): AgentPrioritySummary => ({
			id: `agent-${index}`,
			storageId: `agent-${index}`,
			cwd: "/work",
			modifiedAt: index,
			owner: "unknown",
			state,
			cost: 0,
			partial: false,
			rosterOrder: { priority: false, modifiedAt: index },
		});
		const rows = [
			...Array.from({ length: 100 }, (_, index) => row(index, "unavailable")),
			...Array.from({ length: 20 }, (_, index) => row(index + 100, "idle")),
			row(200, "working"),
			{ ...row(201, "failed"), error: "turn failed" },
		];
		const value = buildStatusOverview({ rows, coverage: rosterCoverage(rows), observedAt: "now" }, [], []);
		for (const width of [48, 80, 180]) {
			const card = createAgentToolCards().agent_status.renderResult(
				result(value),
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			);
			const text = screen(card, width);
			assert.match(text, /1 working · 1 needs attention/);
			assert.match(text, /agent-201 · failed · turn failed\nagent-200 · working/u);
			assert.match(text, /100 conversations unavailable/u);
			assert.doesNotMatch(text, /rows returned|20 quiet|summarised/u);
			assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
		}
		const expanded = screen(
			createAgentToolCards().agent_status.renderResult(
				result(value),
				{ ...cardKeys, expanded: true, isPartial: false },
				theme,
				context(),
			),
			180,
		);
		assert.match(expanded, /122 conversations observed; 12 rows returned\n20 quiet/u);
		assert.match(expanded, /95 unavailable summarised · 15 quiet summarised/u);
	});

	it("summarizes a discovery page with coverage and the next page", () => {
		const details = {
			rows: [
				{ identity: "reader", handle: "@reader", name: "Reader", role: "Read the source" },
				{ identity: "reviewer", name: "Reviewer", role: "", firstMessage: "Check the parser", busy: true },
			],
			nextCursor: "Y3Vyc29y",
			coverage: {
				complete: false,
				storagesVisited: 3,
				unavailable: [{ storageId: "s", reason: "x" }],
				catalog: { storages: 40, pass: "remainder", pending: 12, settled: 5 },
				next: { tool: "agent_list", query: "review", cwd: "/work area", limit: 2, cursor: "Y3Vyc29y" },
			},
			observedAt: "t",
			authority: "Observation grants no control or task authority",
		};
		const text = screen(
			renderListResult(result(details), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
			180,
		);
		assert.match(text, /2 conversations on this page; next page available/u);
		assert.match(text, /@reader · Reader\nRead the source\nReviewer · Check the parser/u);
		assert.match(text, /\[Discovery evidence incomplete\]/u);
		assert.doesNotMatch(text, /Y3Vyc29y|scan step|storages visited|working|No role set/u);
		const expanded = screen(
			renderListResult(
				result(details),
				{ ...cardKeys, expanded: true, isPartial: false },
				theme,
				context({ expanded: true }),
			),
			180,
		);
		assert.ok(expanded.includes('agent_list({"query":"review","cwd":"/work area","limit":2,"cursor":"Y3Vyc29y"})'));
		assert.match(expanded, /"identity":"reviewer"/u);
		assert.match(
			expanded,
			/1 storage unavailable\n3 storages visited on this page\n12 storage scan steps open\n5 storages settled by publication/u,
		);
		const covered = screen(
			renderListResult(
				result({ rows: [], nextCursor: null, coverage: { complete: true, storagesVisited: 1, unavailable: [] } }),
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			),
		);
		assert.match(covered, /0 conversations on this page; end of scan/u);
		assert.doesNotMatch(covered, /storage visited|inventory covered|next page available/iu);
	});

	it("summarizes each inspect view against its returned bounds", () => {
		const history = {
			view: "history",
			sessionId: "s",
			conversationId: 1,
			entries: [{}, {}],
			nextCursor: { after: 1 },
			order: "newestFirst",
			detail: "redacted",
		};
		assert.match(
			screen(
				renderInspectResult(result(history), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
			),
			/2 entries on this history page/,
		);
		assert.match(
			screen(
				renderInspectResult(result(history), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
			),
			/next page available/,
		);
		const primaryPage = {
			kind: "ordinary-primary",
			view: "exact",
			sessionId: "p",
			entries: [{ id: "f392f536" }],
			page: { offset: 0, endOffset: 16000, totalUnits: 24000 },
			nextCursor: { view: "exact" },
		};
		const primaryCard = screen(
			renderInspectResult(result(primaryPage), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
		);
		assert.match(primaryCard, /Retained entry text 0–16000 of 24000/);
		assert.match(primaryCard, /next page available/);
		assert.match(
			screen(
				renderInspectResult(
					result({ ...primaryPage, page: { ...primaryPage.page, endOffset: 24000 }, nextCursor: undefined }),
					{ ...cardKeys, expanded: false, isPartial: false },
					theme,
					context(),
				),
			),
			/Retained text complete/,
		);
		const search = {
			view: "search",
			sessionId: "s",
			conversationId: 1,
			matches: [{}],
			nextCursor: { after: 1 },
			coverage: { scannedEntries: 12, scannedBytes: 90, complete: false },
			detail: "literal",
		};
		assert.match(
			screen(renderInspectResult(result(search), { ...cardKeys, expanded: false, isPartial: false }, theme, context())),
			/1 match on this page; next page available\n12 entries scanned/,
		);
		assert.match(
			screen(renderInspectResult(result(search), { ...cardKeys, expanded: false, isPartial: false }, theme, context())),
			/next page available/,
		);
		const exact = {
			view: "exact",
			sessionId: "s",
			conversationId: 1,
			entryId: 5,
			offset: 0,
			text: "{}",
			nextOffset: 1200,
			truncated: true,
			omissions: { providerSignatures: 2, imagePayloads: 1, redactedThinking: 0 },
		};
		const exactText = screen(
			renderInspectResult(result(exact), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
		);
		assert.match(exactText, /Entry 5 from offset 0; next page available/);
		assert.match(exactText, /2 provider signatures omitted\n1 image payload omitted/);
		const activity = {
			view: "activity",
			sessionId: "s",
			conversationId: 1,
			turns: [{}, {}],
			nextCursor: { after: 1 },
			coverage: { scannedEntries: 7, complete: false },
			detail: "newest turns first",
		};
		assert.match(
			screen(
				renderInspectResult(result(activity), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
			),
			/2 turns on this activity page; next page available/,
		);
		assert.match(
			screen(
				renderInspectResult(result(activity), { ...cardKeys, expanded: true, isPartial: false }, theme, context()),
			),
			/7 entries scanned/,
		);
		const saved = {
			view: "result",
			sessionId: "s",
			conversationId: 1,
			submissionId: 9,
			status: "done",
			entryId: 1,
			answerEntryId: 2,
			answer: "Final",
			usage: {},
		};
		const savedText = screen(
			renderInspectResult(result(saved), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
		);
		assert.match(savedText, /Assistant answer retained · done/);
		assert.match(savedText, /^Final$/mu);
	});

	it("keeps an empty or bounded page calibrated to the covered ancestry", () => {
		const empty = {
			view: "search",
			sessionId: "s",
			conversationId: 1,
			matches: [],
			nextCursor: null,
			coverage: { scannedEntries: 30, complete: true },
			detail: "literal",
		};
		const text = screen(
			renderInspectResult(result(empty), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
		);
		assert.match(text, /0 matches on this page\n30 entries scanned\nReached the end of the selected scan/);
		assert.doesNotMatch(text, /no matches|absent|not found/i);
	});

	it("keeps an unavailable release distinct from proof that no host runs", () => {
		const card = createAgentToolCards().agent_abort.renderResult(
			{ ...result(undefined, "No verified native host endpoint; writer release is unconfirmed"), isError: true },
			{ ...cardKeys, expanded: false, isPartial: false },
			theme,
			context(),
		);
		assert.match(screen(card), /writer release is unconfirmed/u);
		assert.doesNotMatch(screen(card), /not running|remains active/u);
	});

	it("shows unplaced inputs in a compact status and placement in admission and report receipts", () => {
		const options = { ...cardKeys, expanded: false, isPartial: false };
		const compact = (extra: Record<string, unknown>) =>
			result({
				format: "compact",
				omitted: [],
				conversation: {
					identity: "storage-a",
					conversationId: 1,
					busy: true,
					availability: "live",
					queue: { inbox: 2, submissions: 2 },
					timers: 0,
					context: "unknown",
					omitted: [],
					detail: { tool: "agent_status", sessionId: "storage-a", detail: true },
					...extra,
				},
			});
		const status = createAgentToolCards().agent_status;
		const render = (extra: Record<string, unknown>, expanded = false) =>
			screen(status.renderResult(compact(extra), { ...options, expanded }, theme, context()), 180);
		const unplacedStatus = render({ unplaced: 2, oldest: 372000 });
		assert.match(unplacedStatus, /^\nWorking\nDurable agent · live host observation\n/u);
		assert.match(unplacedStatus, /^2 unplaced inputs · oldest 6m 12s$/mu);
		assert.doesNotMatch(unplacedStatus, /queued input|0 timers/u);
		for (const extra of [{ unplaced: 0 }, {}]) {
			assert.match(render(extra), /^2 queued inputs$/mu);
			assert.doesNotMatch(render(extra), /unplaced|0 timers/u);
		}
		assert.match(render({ unplaced: 0 }, true), /"unplaced":0/u);
		const line = /placed at the recipient's next tool boundary/u;
		const receipt = { submissionId: 9, conversationId: 1, deduped: false, identity: "storage-a" };
		const unplaced = screen(
			renderSendResult(result({ ...receipt, placement: "unplaced" }), options, theme, context()),
			180,
		);
		assert.match(unplaced, /submission 9 · unplaced/u);
		assert.doesNotMatch(unplaced, line);
		assert.match(
			screen(
				renderSendResult(
					result({ ...receipt, placement: "unplaced" }),
					{ ...options, expanded: true },
					theme,
					context({ expanded: true }),
				),
				180,
			),
			line,
		);
		const placed = screen(
			renderSteerResult(result({ ...receipt, placement: "placed" }), options, theme, context()),
			180,
		);
		assert.match(placed, /submission 9 · placed/u);
		assert.doesNotMatch(placed, line);
		assert.doesNotMatch(
			screen(renderSendResult(result({ ...receipt, placement: "queued" }), options, theme, context()), 180),
			/submission 9 ·/u,
		);
		const spawn = createAgentToolCards().agent_spawn;
		const spawnReceipt = result({ sessionId: "storage-a", admission: { ...receipt, placement: "unplaced" } });
		const spawned = screen(spawn.renderResult(spawnReceipt, options, theme, context()), 180);
		assert.match(spawned, /submission 9 · unplaced/u);
		assert.doesNotMatch(spawned, line);
		assert.match(screen(spawn.renderResult(spawnReceipt, { ...options, expanded: true }, theme, context()), 180), line);
		const retained = screen(
			renderSendResult(
				result({ sourceId: "report:one", ownerId: "storage-a", acknowledged: false, placement: "unplaced" }),
				options,
				theme,
				context({ args: { mode: "report" } }),
			),
			180,
		);
		assert.match(retained, /acknowledgement pending · unplaced/u);
		assert.doesNotMatch(retained, line);
		const parked = screen(
			renderSendResult(
				result({
					sourceId: "report:one",
					ownerId: "storage-a",
					acknowledged: false,
					placement: "unplaced",
					delivery: "parked",
				}),
				options,
				theme,
				context({ args: { mode: "report" } }),
			),
			180,
		);
		assert.match(parked, /delivery parked; the report is not placed/u);
		assert.doesNotMatch(parked, line);
	});

	it("preserves withdrawn receipt placement without a context-placement or future-delivery claim", () => {
		const options = { ...cardKeys, expanded: false, isPartial: false };
		const native = { identity: "storage-a", conversationId: 1, submissionId: 9, placement: "withdrawn" };
		for (const source of [
			native,
			{ sessionId: "storage-a", admitted: true, placement: "withdrawn" },
			{ sourceId: "report:one", acknowledged: false, placement: "withdrawn" },
			{ sourceId: "report:two", acknowledged: true, delivery: "admitted", placement: "withdrawn" },
		]) {
			const receipt = projectReportReceipt(source) as Record<string, unknown>;
			assert.equal(receipt.placement, "withdrawn");
			for (const render of [renderSendResult, renderSteerResult]) {
				const output = screen(render(result(receipt), options, theme, context()), 180);
				assert.match(output, /withdrawn/u);
				assert.doesNotMatch(output, /not in the recipient's inbox or transcript/u);
				const disclosed = screen(
					render(result(receipt), { ...options, expanded: true }, theme, context({ expanded: true })),
					180,
				);
				assert.match(disclosed, /not in the recipient's inbox or transcript/u);
				assert.doesNotMatch(output, / · placed\b|next tool boundary|delivered to|queued for/u);
			}
		}
		const spawn = createAgentToolCards().agent_spawn;
		const receipt = result({ sessionId: "storage-a", admission: native });
		const spawned = screen(spawn.renderResult(receipt, options, theme, context()), 180);
		assert.match(spawned, /withdrawn/u);
		assert.doesNotMatch(spawned, / · placed\b|next tool boundary|not in the recipient's inbox or transcript/u);
		const expanded = screen(spawn.renderResult(receipt, { ...options, expanded: true }, theme, context()), 180);
		assert.match(expanded, /not in the recipient's inbox or transcript/u);
	});

	it("shows a declared work item with its dependencies and a closed item with its final report row", () => {
		const card = createAgentToolCards().agent_work,
			options = { ...cardKeys, expanded: false, isPartial: false };
		const dependency = (n: number, state: OpenWorkDependencyView["state"]): OpenWorkDependencyView => ({
			sessionId: `producer-${n}`,
			submissionId: n,
			requestId: `input-${n}`,
			state,
			inspect: { tool: "agent_inspect", view: "result", sessionId: `producer-${n}`, submissionId: n },
		});
		const item: OpenWorkView = {
			requestId: "request-1",
			submissionId: 3,
			requester: "storage-a",
			replyTo: "storage-a",
			origin: "model",
			note: "Two reviews remain",
			state: "open",
			declaredAt: 1,
			updatedAt: 1,
			dependencies: [
				dependency(1, "open"),
				dependency(2, "state-note"),
				dependency(3, "arrived"),
				dependency(4, "open"),
				dependency(5, "open"),
			],
		};
		const open = screen(card.renderResult(result({ action: "continue", item }), options, theme, context()), 180);
		assert.match(open, /Work declared · request request-1 · open\n5 dependencies/u);
		assert.match(open, /Final report to storage-a/u);
		assert.doesNotMatch(open, /Two reviews remain/u);
		assert.match(open, /producer-2 · submission 2 · state-note/u);
		assert.match(open, /2 more lines/u);
		assert.doesNotMatch(open, /producer-5/u);
		const declaration = screen(
			card.renderResult(
				result({ action: "continue", item }),
				{ ...options, expanded: true },
				theme,
				context({ expanded: true }),
			),
			180,
		);
		assert.match(declaration, /Two reviews\s+remain/u);
		assert.match(declaration, /input-5/u);
		const report = {
			sourceId: "report:work-final",
			requestId: "work-final:1:request-1",
			ownerId: "storage-a",
			acknowledged: false,
			createdAt: 2,
		};
		const closed = screen(
			card.renderResult(
				result({
					action: "complete",
					requestId: "request-1",
					status: "failed",
					deduped: true,
					report,
					item: { ...item, state: "closed" },
				}),
				options,
				theme,
				context(),
			),
			180,
		);
		assert.match(closed, /Work already closed \(failed\) · request request-1/u);
		assert.doesNotMatch(closed, /Final report retained|Two reviews remain/u);
		const empty: OpenWorkDetails = { action: "continue", item: { ...item, dependencies: [], updatedAt: 2 } };
		const emptyOutput = screen(card.renderResult(result(empty), options, theme, context()), 180);
		assert.match(emptyOutput, /Work declared · request request-1 · open\n0 dependencies/u);
		assert.doesNotMatch(emptyOutput, /withdrawn|Work closed/u);
		const unavailable: OpenWorkDetails = {
			action: "continue",
			item: {
				...item,
				dependencies: [{ ...dependency(1, "open"), unavailable: `Producer facts missing ${"x".repeat(300)}` }],
			},
		};
		const unavailableCard = card.renderResult(result(unavailable), options, theme, context());
		assert.match(screen(unavailableCard, 240), /Producer facts missing/u);
		assert.match(screen(unavailableCard, 52), /\d+ more lines/u);
		for (const status of ["stopped", "reset"] as const) {
			const retained: OpenWorkDetails = {
				action: "complete",
				requestId: item.requestId,
				status,
				deduped: true,
				item: {
					...item,
					state: "closed",
					close: {
						status,
						message: "Stopped",
						at: 2,
						reportRequestId: report.requestId,
						delivery: "terminal",
						read: {
							tool: "agent_inspect",
							view: "result",
							sessionId: "storage-a:2",
							submissionId: item.submissionId,
							finalReport: true,
							offset: 0,
						},
					},
				},
			};
			const output = screen(
				card.renderResult(result(retained), { ...options, expanded: true }, theme, context({ expanded: true })),
				180,
			);
			assert.ok(output.includes(`Work already closed (${status})`));
			assert.match(output, /Final report delivery: terminal/u);
			assert.doesNotMatch(output, /Final report retained|acknowledgement pending/u);
		}
		const call = screen(
			card.renderCall(
				{
					action: "continue",
					request: "request-1",
					results: [{ sessionId: "producer-1", submissionId: 1 }],
					note: "Two reviews remain",
				},
				theme,
				context(),
			),
			180,
		);
		assert.match(call, /agent_work/u);
		assert.match(call, /^agent_work request request-1\ncontinue · 1 result reference/mu);
	});

	it("shows admission receipts, fork, rewind, configure, abort, and command outcomes", () => {
		const receipt = { submissionId: 9, conversationId: 1, deduped: false, identity: "storage-a" };
		const send = screen(
			renderSendResult(result(receipt), { ...cardKeys, expanded: false, isPartial: false }, theme, context()),
		);
		assert.match(send, /Message admitted for storage-a/);
		assert.match(send, /submission 9/);
		assert.match(
			screen(renderSteerResult(result(receipt), { ...cardKeys, expanded: false, isPartial: false }, theme, context())),
			/Steer admitted/,
		);
		assert.match(
			screen(
				createAgentToolCards().agent_fork.renderResult(
					result({ conversationId: 2, identity: "storage-a:2", deduped: false }),
					{ ...cardKeys, expanded: false, isPartial: false },
					theme,
					context(),
				),
			),
			/Fork created · storage-a:2/,
		);
		const rewind = screen(
			createAgentToolCards().agent_rewind.renderResult(
				result({ conversationId: 3, identity: "storage-a:3", predecessorEntryId: 5, submissionId: 11, deduped: false }),
				{ ...cardKeys, expanded: true, isPartial: false },
				theme,
				context(),
			),
		);
		assert.match(rewind, /Rewind submitted · storage-a:3/);
		assert.match(rewind, /Forked before entry 5/);
		assert.match(rewind, /submission 11/);
		assert.match(
			screen(
				createAgentToolCards().agent_configure.renderResult(
					result({ sessionId: "storage-a", outcome: "applied" }),
					{ ...cardKeys, expanded: false, isPartial: false },
					theme,
					context(),
				),
			),
			/Configuration applied · storage-a/,
		);
		const abort = createAgentToolCards().agent_abort.renderResult(
			result({ conversationId: 1, identity: "storage-a", background: false }),
			{ ...cardKeys, expanded: false, isPartial: false },
			theme,
			context(),
		);
		assert.match(screen(abort), /Abort requested · storage-a/);
		assert.match(screen(renderAbortCall({ sessionId: "storage-a", release: true }, theme, context())), /release host/);
		const release = createAgentToolCards().agent_abort.renderResult(
			result({ aborted: { identity: "storage-a" }, retiring: false, blockers: ["pending timer"], writesPlaced: 0 }),
			{ ...cardKeys, expanded: false, isPartial: false },
			theme,
			context(),
		);
		assert.match(screen(release), /Host remains active/);
		assert.match(screen(release), /pending timer/);
		const command = createAgentToolCards().agent_command.renderResult(
			result({ name: "inventory", conversationId: 1, identity: "storage-a", text: "3 native contributions" }),
			{ ...cardKeys, expanded: false, isPartial: false },
			theme,
			context(),
		);
		assert.match(screen(command), /Command completed\n3 native contributions/u);
		const reload = createAgentToolCards().agent_command.renderResult(
			result({ sessionId: "storage-a", inventory: { contributions: [{}, {}] }, reloaded: true }),
			{ ...cardKeys, expanded: false, isPartial: false },
			theme,
			context(),
		);
		assert.match(screen(reload), /Host registrations reloaded/);
		assert.match(screen(reload), /2 native contributions installed/);
	});

	it("labels compact receipts, native results, partial, and error states", () => {
		const self = screen(
			renderCompactResult(
				result({ taskId: 5, status: "task" }),
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context({ args: { sessionId: "s", summary: "s" } }),
			),
		);
		assert.match(self, /Summary admitted · task 5/);
		assert.match(self, /Summary admitted · task 5/);
		const native = screen(
			renderCompactResult(
				result({ taskId: 6, status: "completed", entryId: 7 }),
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context({ args: { sessionId: "s" } }),
			),
		);
		assert.match(native, /Compaction completed · task 6/);
		assert.match(native, /summary entry 7/);
		assert.match(
			screen(
				renderCompactResult(
					result("queued"),
					{ ...cardKeys, expanded: false, isPartial: true },
					theme,
					context({ args: { summary: "s" } }),
				),
			),
			/Compaction pending/,
		);
		const error = renderCompactResult(
			result("refused"),
			{ ...cardKeys, expanded: true, isPartial: false },
			theme,
			context({ args: { summary: "s" }, isError: true }),
		);
		assert.match(screen(error), /refused/);
		assert.doesNotMatch(screen(error), /receipt/);
	});

	it("falls back to a bounded preview for unexpected values and labels errors", () => {
		const raw = screen(
			renderListResult(
				result("inventory unreadable"),
				{ ...cardKeys, expanded: false, isPartial: false },
				theme,
				context(),
			),
		);
		assert.match(raw, /inventory unreadable/);
		assert.match(
			screen(
				renderListResult(
					result("denied\x1b[2J"),
					{ ...cardKeys, expanded: false, isPartial: false },
					theme,
					context({ isError: true }),
				),
			),
			/^denied$/mu,
		);
		assert.doesNotMatch(
			screen(
				renderListResult(
					result("denied\x1b[2J"),
					{ ...cardKeys, expanded: false, isPartial: false },
					theme,
					context({ isError: true }),
				),
			),
			/\x1b/,
		);
		assert.match(
			screen(
				createAgentToolCards().agent_attach.renderResult(
					result(undefined),
					{ ...cardKeys, expanded: false, isPartial: true },
					theme,
					context(),
				),
			),
			/Partial result/,
		);
		assert.match(
			screen(
				createAgentToolCards().agent_attach.renderResult(
					result(undefined),
					{ ...cardKeys, expanded: true, isPartial: false },
					theme,
					context({ isError: true }),
				),
			),
			/Tool error/,
		);
	});

	it("sanitizes and bounds expanded control evidence without cutting an astral character", () => {
		const bounds = screen(
			createAgentToolCards().agent_attach.renderResult(
				result({ sessionId: "storage-a" }, `${"x".repeat(31_999)}\u202e😀OMITTED`),
				{ ...cardKeys, expanded: true, isPartial: false },
				theme,
				context(),
			),
			800,
		).replace(/\n/gu, "");
		assert.ok(bounds.includes(`${"x".repeat(31_999)}😀[Truncated: showing 32000 of 32007 characters]`));
		assert.doesNotMatch(bounds, /\u202e|OMITTED/u);
	});
});

function assertNoticeFits(card: { render(width: number): readonly string[] }): void {
	for (const width of [20, 60, 120]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
}

describe("agent result notice card", () => {
	it("shows sourced sender names and plain kinds without optional-fact placeholders", () => {
		const id = "12345678-1234-4234-8234-123456789abc";
		const cases = [
			{
				details: {
					identity: id,
					name: "Catalog reader",
					kind: "receipt",
					status: "done",
					provider: "provider",
					modelId: "model",
					thinkingLevel: "high",
				},
				heading: "Answer received",
				sender: "Catalog reader",
			},
			{ details: { identity: id, handle: "@reader", kind: "report" }, heading: "Report received", sender: "@reader" },
			{
				details: { senderIdentity: id, senderKind: "session", name: "Parser session", kind: "message" },
				heading: "Message received",
				sender: "Parser session",
			},
			{
				details: {
					senderIdentity: id,
					senderKind: "session",
					observedPurpose: "Review the parser",
					kind: "message",
					provider: "provider",
				},
				heading: "Message received",
				sender: "Review the parser",
			},
			{
				details: { senderIdentity: id, senderKind: "session", kind: "message" },
				heading: "Message received",
				sender: id,
			},
			{
				details: {
					senderIdentity: id,
					senderKind: "session",
					name: "Parser session",
					kind: "report",
					threadId: "retained-thread",
					threadTitle: "Parser contract",
					operatorMessage: "The sourced event body",
				},
				heading: "Thread notice · Parser contract",
				sender: "Parser session",
			},
			{
				details: {
					identity: id,
					name: "Fallback reader",
					kind: "receipt",
					status: "done",
					liveOwner: false,
					fallback: true,
				},
				heading: "Answer received",
				sender: "Fallback reader",
			},
			{ details: {}, heading: "Message received", sender: undefined },
		];
		for (const { details, heading, sender } of cases) {
			const card = renderPeerNoticeCard({ content: "Stored model body", details }, theme, false, cardKeys);
			assert.ok(card);
			const lines = screen(card, 240)
				.split("\n")
				.filter((line) => line.trim());
			assert.equal(lines[0]?.trim(), `[agent] ${heading}`);
			if (sender) assert.ok(lines[1]?.includes(`from ${sender}`));
			assert.doesNotMatch(lines[0] ?? "", /unknown|unavailable/u);
			if ("threadId" in details) {
				assert.match(lines.join("\n"), /The sourced event body/u);
				assert.doesNotMatch(lines.join("\n"), /Stored model body/u);
			}
			if (details.liveOwner === false) assert.match(lines.join("\n"), /No live recipient; this is a retained copy/u);
			const expanded = renderPeerNoticeCard({ content: "Stored model body", details }, theme, true, cardKeys);
			assert.ok(expanded);
			if (Object.keys(details).length) assert.ok(screen(expanded, 240).includes(id));
			assertNoticeFits(card);
		}
	});

	it("shows an unnamed session's full identity on a wide peer headline", () => {
		const identity = "12345678-1234-4234-8234-123456789abc";
		const card = renderPeerNoticeCard(
			{ content: "Direct message", details: { senderIdentity: identity, senderKind: "session", kind: "message" } },
			theme,
			false,
			cardKeys,
		);
		assert.ok(card);
		assert.equal(
			screen(card, 240)
				.split("\n")
				.find((line) => line.trim())
				?.trim(),
			`[agent] Message received`,
		);
		assert.doesNotMatch(
			screen(card, 240)
				.split("\n")
				.find((line) => line.trim()) ?? "",
			/…|unknown|unavailable/u,
		);
		assert.match(screen(card, 240), new RegExp(`from ${identity}`));
		assert.ok(card.render(24).every((line) => visibleWidth(line) <= 24));
	});

	it("preserves full source identities in expanded details", () => {
		const sourceId = `report:${"r".repeat(700)}`;
		const senderIdentity = "12345678-1234-4234-8234-123456789abc";
		const card = renderPeerNoticeCard(
			{ content: "Report body", details: { name: "Reader", kind: "report", senderIdentity, sourceId } },
			theme,
			true,
			cardKeys,
		);
		assert.ok(card);
		const text = screen(card, 800);
		assert.ok(text.includes(`Report source: ${sourceId}`));
		assert.ok(text.includes(`Sender ID: ${senderIdentity}`));
	});

	it("keeps a check-in headline when elapsed time, cost and configuration are absent", () => {
		const card = renderPeerNoticeCard(
			{ content: "Stored guidance", details: { name: "Reader", message: "Current step: review", checkIn: {} } },
			theme,
			false,
			cardKeys,
		);
		assert.ok(card);
		const lines = screen(card, 160)
			.split("\n")
			.filter((line) => line.trim());
		assert.equal(lines[0]?.trim(), "[agent] Check-in: Work continues");
		assert.match(lines.join("\n"), /Current step: review/u);
		assert.doesNotMatch(lines[0] ?? "", /unknown|unavailable|elapsed|conversation total/u);
	});
	it("renders a receipt heading, Markdown body, and expanded source details", () => {
		const collapsed = renderAgentPeerMessage(
			{
				role: "custom",
				customType: "agent.peer",
				display: true,
				timestamp: 1,
				content: "**Review:** fix the token.\n\nKeep the identifier.",
				details: {
					kind: "receipt",
					submissions: [{ submissionId: 9 }],
					identity: "storage-a",
					status: "done",
					answer: "**Review:** fix the token.\n\nKeep the identifier.",
				},
			},
			{ ...cardKeys, expanded: false, outputPad: 1 },
			theme,
		);
		assert.ok(collapsed);
		const text = screen(collapsed);
		assert.match(text, /\[agent\] Answer received\n\s*from storage-a/u);
		assert.match(text, /\.\.\. \((?:\d+ more lines?, )?ctrl\+o to expand\)/u);
		assert.doesNotMatch(text, /Source details:|submissionId:|\/agent opens/u);
		assert.match(text, /Review: fix the token\./);
		assert.match(text, /Keep the identifier\./);
		assert.doesNotMatch(text, /\*\*|submissionId:/);
		const expanded = renderAgentPeerMessage(
			{
				role: "custom",
				customType: "agent.peer",
				display: true,
				timestamp: 1,
				content: "Body",
				details: {
					kind: "receipt",
					submissions: [{ submissionId: 9 }],
					identity: "storage-a",
					status: "done",
					answer: "**Review:** fix the token.\n\nKeep the identifier.",
				},
			},
			{ ...cardKeys, expanded: true, outputPad: 1 },
			theme,
		);
		assert.ok(expanded);
		const expandedText = screen(expanded);
		assert.match(expandedText, /Source details/);
		assert.match(expandedText, /Submission 9/u);
		assert.match(expandedText, /Sender ID: storage-a/u);
	});

	it("uses the resolved display label in place of the raw identity", () => {
		const card = renderAgentPeerMessage(
			{
				role: "custom",
				customType: "agent.peer",
				display: true,
				timestamp: 1,
				content: "Done",
				details: {
					kind: "receipt",
					answer: "Done",
					identity: "6de48f73-1111-4111-8111-111111111111",
					label: "poem task",
					status: "done",
				},
			},
			{ ...cardKeys, expanded: false, outputPad: 1 },
			theme,
		);
		assert.ok(card);
		const text = screen(card);
		assert.match(text, /\[agent\] Answer received\n\s*from poem task/u);
		assert.doesNotMatch(text, /6de48f73/);
	});

	for (const cost of [0.125, 0, null])
		it(`renders a check-in with elapsed time and cost ${cost}`, () => {
			const checkIn = { conversationId: 1, requestId: "task", origin: "model", elapsedMs: 1_800_000, cost };
			const digest =
				"Tool calls: 4. Current tool: bash, 8 minutes since tool-call entry. Latest reply: tests in progress.";
			const message = {
				role: "custom" as const,
				customType: "agent.peer",
				display: true,
				timestamp: 1,
				content: "Agent “reader” still working, not finished. Assess the task.\n\nUnrelated report body.",
				details: { label: "reader", senderIdentity: "storage-b", sourceId: "checkin:1:1", message: digest, checkIn },
			};
			const before = structuredClone(message);
			for (const expanded of [false, true]) {
				const card = renderAgentPeerMessage(message, { ...cardKeys, expanded, outputPad: 1 }, theme);
				assert.ok(card);
				const text = screen(card, 180);
				assert.match(text, /\[agent\] Check-in: Work continues\n\s*from reader · 30m/u);
				if (cost === null) assert.doesNotMatch(text, /conversation total|unavailable/u);
				else assert.match(text, new RegExp(`\\$${cost.toFixed(3).replace(".", "\\.")} conversation total`, "u"));
				assert.match(text, /Tool calls: 4/u);
				assert.doesNotMatch(text, /Unrelated report body|· report|· finished|Reported result/u);
				for (const width of [20, 60, 120]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
			}
			assert.deepEqual(message, before);
		});

	it("bounds a check-in digest in the expanded notice", () => {
		const card = renderPeerNoticeCard(
			{
				content: "not a finished answer",
				details: {
					label: "reader",
					message: `${"x".repeat(32_000)}OMITTED`,
					checkIn: { conversationId: 1, requestId: "task", origin: "model", elapsedMs: 60_000, cost: null },
				},
			},
			theme,
			true,
			cardKeys,
		);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /Truncated: showing 32000 of 32007 UTF-16 code units/u);
		assert.doesNotMatch(text, /OMITTED|not a finished answer/u);
	});

	it("renders hours and reads the check-in body from report.message", () => {
		const card = renderPeerNoticeCard(
			{
				content: "channel text",
				details: {
					label: "reader",
					message: "Current tool: bash.",
					checkIn: { conversationId: 1, requestId: "task", origin: "model", elapsedMs: 11_100_000, cost: 0 },
				},
			},
			theme,
			false,
			cardKeys,
		);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /Check-in: Work continues\n\s*from reader · 3h05m elapsed/u);
		assert.match(text, /Current tool: bash/u);
		assert.doesNotMatch(text, /185m/u);
	});

	it("labels a report and an unanswered receipt without claiming acceptance", () => {
		const reportCard = renderAgentPeerMessage(
			{
				role: "custom",
				customType: "agent.peer",
				display: true,
				timestamp: 1,
				content: "Progress report",
				details: { kind: "report", senderIdentity: "storage-b", sourceId: "report:1", acknowledged: false },
			},
			{ ...cardKeys, expanded: false, outputPad: 1 },
			theme,
		);
		assert.ok(reportCard);
		const report = screen(reportCard);
		assert.match(report, /\[agent\] Report received\n\s*from storage-b/u);
		assert.match(report, /Progress report/);
		const unansweredCard = renderAgentPeerMessage(
			{
				role: "custom",
				customType: "agent.peer",
				display: true,
				timestamp: 1,
				content: "No answer",
				details: { kind: "receipt", identity: "storage-a", status: "unanswered", reason: "aborted" },
			},
			{ ...cardKeys, expanded: false, outputPad: 1 },
			theme,
		);
		assert.ok(unansweredCard);
		const unanswered = screen(unansweredCard);
		assert.match(unanswered, /\[agent\] Input ended without an answer\n\s*from storage-a/u);
		assert.doesNotMatch(unanswered, /result received|Answer received/u);
		assert.match(unanswered, /aborted/);
	});

	it("shows source name, model, reasoning, warnings, exact IDs, and the full escaped body", () => {
		const hostile = `[2J‮${"long line\n".repeat(3000)}END`;
		const card = renderAgentPeerMessage(
			{
				role: "custom",
				customType: "agent.peer",
				display: true,
				timestamp: 1,
				content: hostile,
				details: {
					kind: "receipt",
					operatorMessage: hostile,
					submissions: [{ submissionId: 9, entryId: 4, answerEntryId: 5 }],
					requestId: "req-1",
					identity: "storage-a",
					status: "done",
					name: "Message reviewer",
					provider: "SelectedProvider",
					modelId: "MixedCase-Model",
					thinkingLevel: "high",
					liveOwner: false,
					saved: false,
				},
			},
			{ ...cardKeys, expanded: true, outputPad: 1 },
			theme,
		);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /\[agent\] Answer received\n\s*from Message reviewer/u);
		assert.match(text, /Sender name: Message reviewer/);
		assert.match(text, /SelectedProvider\/MixedCase-Model · high/);
		assert.match(text, /No live recipient; this is a retained copy/);
		assert.match(text, /Receipt not saved/);
		assert.match(text, /Submission 9/);
		assert.match(text, /entry 4/);
		assert.match(text, /answer entry 5/);
		assert.match(text, /Request: req-1/);
		assert.match(text, /END/);
		assert.doesNotMatch(text, /Truncated/);
		assert.doesNotMatch(text, /[‮]/u);
		for (const width of [20, 60, 120]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
	});

	it("takes the authored answer from receipt details rather than the model envelope", () => {
		const content =
			"Agent “reader” finished. Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\nSECOND READY\n\nUse agent_inspect for retained source evidence.";
		const card = renderAgentPeerMessage(
			{
				role: "custom",
				customType: "agent.peer",
				display: true,
				timestamp: 1,
				content,
				details: { kind: "receipt", label: "reader", identity: "storage-a", status: "done", answer: "SECOND READY" },
			},
			{ ...cardKeys, expanded: false, outputPad: 1 },
			theme,
		);
		assert.ok(card);
		const text = screen(card);
		assert.match(text, /\[agent\] Answer received\n\s*from reader/u);
		assert.match(text, /SECOND READY/);
		assert.match(text, /\.\.\. \((?:\d+ more lines?, )?ctrl\+o to expand\)/u);
		assert.doesNotMatch(text, /Source details:|\/agent opens/u);
		assert.doesNotMatch(text, /Results do not establish/);
		assert.doesNotMatch(text, /agent_inspect/);
		assert.doesNotMatch(text, /Agent “reader” finished\./);
	});

	it("uses a padded two-tier header and keeps the body distinct", () => {
		const message = {
			role: "custom" as const,
			customType: "agent.peer",
			display: true,
			timestamp: 1,
			content: "A short answer.\n\n",
			details: {
				kind: "receipt",
				identity: "storage-a",
				answer: "A short answer.",
				label: "A very long task label ".repeat(8),
				provider: "provider",
				modelId: "model",
				thinkingLevel: "high",
				status: "done",
			},
		};
		const before = structuredClone(message);
		const card = renderAgentPeerMessage(message, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		assert.ok(card);
		for (const width of [80, 140]) {
			const lines: string[] = card.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(lines.length, 7);
			assert.equal(lines[0]?.trim(), "");
			assert.equal(lines[1]?.trim(), "[agent] Answer received");
			assert.match(lines[2] ?? "", /from A very long task label/u);
			assert.match(lines[2] ?? "", /…$/u);
			assert.equal(lines[3]?.trim(), "");
			assert.equal(lines[4]?.trim(), "A short answer.");
			assert.equal(lines[5]?.trim(), "... (ctrl+o to expand)");
			assert.equal(lines[6]?.trim(), "");
			assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(lines.join("\n"), /Open:|Source details|opens the dashboard/);
		}
		assert.deepEqual(message, before);
	});

	it("bounds Markdown by visual lines and reveals the full body and source only when expanded", (t) => {
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(
			new nativeTui.KeybindingsManager({
				...nativeTui.TUI_KEYBINDINGS,
				"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
			}),
		);
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const content = `${Array.from({ length: 12 }, (_, index) => `- Result ${index + 1}: ${"word ".repeat(20)}`).join("\n")}\n\nFINAL_RESULT`;
		const message = {
			role: "custom" as const,
			customType: "agent.peer",
			display: true,
			timestamp: 1,
			content,
			details: {
				label: "reader",
				provider: "provider",
				modelId: "model",
				thinkingLevel: "high",
				status: "done",
				kind: "receipt",
				answer: content,
				submissions: [{ submissionId: 7 }],
			},
		};
		const collapsed = renderAgentPeerMessage(message, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		const expanded = renderAgentPeerMessage(message, { ...cardKeys, expanded: true, outputPad: 1 }, theme);
		assert.ok(collapsed && expanded);
		for (const width of [80, 140]) {
			const preview: string[] = collapsed.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(
				preview.length,
				9,
				"two padded lines, a two-tier header, one separator, three body lines and one hint",
			);
			const full: string[] = expanded.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.match(preview[7] ?? "", /\.\.\. \((?:\d+ more lines?, )?ctrl\+o to expand\)/u);
			assert.equal(preview[3]?.trim(), "");
			assert.deepEqual(preview.slice(4, 7), full.slice(4, 7));
			assert.equal(preview.filter((line) => /to expand/u.test(line)).length, 1);
			assert.doesNotMatch(preview.join("\n"), /^\s*…\s*$/mu);
			assert.doesNotMatch(preview.join("\n"), /FINAL_RESULT|Source details|Open:|opens the dashboard/);
			assert.match(full.join("\n"), /FINAL_RESULT/);
			assert.match(full.join("\n"), /Submission 7/u);
			assert.equal(
				full
					.filter((line) => line.trim())
					.at(-1)
					?.trim(),
				"Submission 7",
			);
			assert.doesNotMatch(full.join("\n"), /more lines,|Source details:/);
			assert.ok(collapsed.render(width).every((line) => visibleWidth(line) <= width));
			assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
			collapsed.invalidate();
			assert.deepEqual(
				collapsed.render(width).map((line) => stripVTControlCharacters(line).trimEnd()),
				preview,
			);
		}
		assert.equal(message.content, content);
	});

	it("matches Pi tool padding between adjacent short notices", () => {
		const message = {
			role: "custom" as const,
			customType: "agent.peer",
			display: true,
			timestamp: 1,
			content: "Short answer.",
			details: {
				kind: "receipt",
				label: "reader",
				identity: "storage-a",
				provider: "provider",
				modelId: "model",
				thinkingLevel: "high",
				status: "done",
				answer: "Short answer.",
			},
		};
		for (const width of [80, 140]) {
			const components = Array.from({ length: 4 }, () => new CustomMessageComponent(message, renderAgentPeerMessage));
			const lines = components
				.flatMap((component) => component.render(width))
				.map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(
				lines.length,
				32,
				"four native separators and four padded two-tier cards with header separators and hints",
			);
			assert.equal(lines.filter((line) => line.trim() === "").length, 16);
			assert.equal(
				lines
					.filter((line) => line.trim())
					.at(-1)
					?.trim(),
				"... (ctrl+o to expand)",
			);
			const first = components[0];
			assert.ok(first);
			first.setExpanded(true);
			const full = screen(first, width);
			assert.match(full, /Source details/);
			assert.match(full, /Sender ID: storage-a/u);
		}
	});

	it("builds the same card from stored entry data for an agent conversation", () => {
		const card = renderPeerNoticeCard(
			{ content: "Model envelope", details: { kind: "receipt", label: "reader", status: "done", answer: "Body text" } },
			theme,
			false,
			cardKeys,
		);
		assert.ok(card);
		assert.match(screen(card), /\[agent\] Answer received\n\s*from reader/u);
		assert.match(screen(card), /Body text/);
	});
});

describe("agent tool card factory", () => {
	it("binds call and result renderers for every agent tool", () => {
		const cards = createAgentToolCards();
		assert.deepEqual(Object.keys(cards).sort(), [
			"agent_abort",
			"agent_attach",
			"agent_brief",
			"agent_collaborate",
			"agent_command",
			"agent_compact",
			"agent_configure",
			"agent_fork",
			"agent_inspect",
			"agent_intent",
			"agent_list",
			"agent_place",
			"agent_profile",
			"agent_reset",
			"agent_rewind",
			"agent_send",
			"agent_spawn",
			"agent_status",
			"agent_steer",
			"agent_work",
		]);
		for (const [name, card] of Object.entries(cards)) {
			assert.equal(typeof card.renderCall, "function", `${name} renderCall`);
			assert.equal(typeof card.renderResult, "function", `${name} renderResult`);
			assert.ok(screen(card.renderCall({}, theme, context())).includes(name));
		}
		const registered: Pick<ToolDefinition, "renderCall" | "renderResult"> = cards.agent_status;
		assert.equal(typeof registered.renderCall, "function");
		assert.equal(typeof registered.renderResult, "function");
	});
});
