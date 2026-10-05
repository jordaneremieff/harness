import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomMessageComponent, defineTool, initTheme, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createAgentToolCards, renderAgentPeerMessage, renderPeerNoticeCard } from "./tool-cards.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import register from "./index.ts";

initTheme("dark", false);
const nativeTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
function noticeKeys(t: { after(fn: () => void): void }): void {
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
	t.after(() => nativeTui.setKeybindings(previous));
}
const identity = "01a106df-0000-4000-8000-000000000001";
const model = { provider: "provider", modelId: "model", thinkingLevel: "xhigh" };
const row: AgentConversationSummary = { id: identity, storageId: identity, name: "Parser review", cwd: ".", modifiedAt: 0, owner: "unknown", state: "idle", cost: 0, partial: false, model };
const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
const clean = (component: { render(width: number): string[] }, width = 240) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
const text = (component: { render(width: number): string[] }, width = 240) => clean(component, width).join("\n");
function registeredTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	register({ events: { emit() {}, on: () => () => {} }, on: () => () => {}, registerTool: (tool: ToolDefinition) => { assert.equal(tools.has(tool.name), false, tool.name); tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, getThinkingLevel: () => "xhigh" } as unknown as ExtensionAPI);
	return tools;
}

function nativeTool(name: string, args: Record<string, unknown>, details: unknown, rows: AgentConversationSummary[] = [row], registered?: ToolDefinition) {
	const card = createAgentToolCards(() => rows)[name];
	const tool = registered ?? defineTool({ name, label: name, description: "Native layout fixture", parameters: Type.Object({}), renderCall: card.renderCall, renderResult: card.renderResult, async execute() { throw Error("The fixture does not execute tools."); } });
	const component = new ToolExecutionComponent(name, `call-${name}`, args, undefined, tool, { requestRender() {} } as unknown as TUI, ".");
	component.setArgsComplete(); component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details, isError: false });
	return component;
}

it("all native tool rows share two-tier known headers, native padding and one hint", () => {
	const args = { results: [{ sessionId: identity, submissionId: 1 }], sessionId: identity, action: "read", name: "reload", message: "Task", summary: "Keep facts", view: "history" };
	const cards = createAgentToolCards(() => [row]);
	for (const name of Object.keys(cards)) {
		const component = name === "agent_intent" ? nativeTool(name, { action: "publish", purpose: "Review the parser" }, { arbitrary: true, published: { id: identity, name: row.name, model, thinkingLevel: model.thinkingLevel, intentClaim: { purpose: "Review the parser" } } }) : nativeTool(name, args, { arbitrary: true, sessionId: identity });
		const lines = clean(component);
		assert.equal(lines[0]?.trim(), "", name);
		assert.equal(lines[1]?.trim(), "", name);
		assert.equal(lines.at(-1)?.trim(), "", name);
		const first = lines.findIndex((line) => line.trim());
		assert.ok(lines[first]?.includes(name), name);
		if (name !== "agent_list") {
			assert.ok(lines[first]?.includes("Parser review"), name);
			assert.doesNotMatch(lines[first] ?? "", /provider\/model|xhigh/u, name);
			assert.match(lines[first + 1]?.trim() ?? "", /^provider\/model · xhigh(?: ·|$)/u, name);
		}
		assert.equal(lines.filter((line) => /to expand|expand for full/u.test(line)).length, 1, name);
		assert.doesNotMatch(lines.join("\n"), /^\s*…\s*$|"arbitrary"|unknown provider|unknown model|unavailable thinking/mu, name);
		for (const width of [20, 40, 80]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), name);
		component.setExpanded(true);
		assert.ok(text(component, 600).includes(identity), name);
		assert.match(text(component), /"arbitrary": true/u, name);
		assert.doesNotMatch(text(component), /to expand|expand for full/u, name);
	}
});

it("every registered agent tool has shared factory coverage and both renderer registrations", () => {
	const tools = registeredTools();
	assert.ok(tools.has("agent_intent"));
	assert.deepEqual([...tools.keys()].sort(), Object.keys(createAgentToolCards()).sort());
	for (const [name, tool] of tools) {
		assert.equal(typeof tool.renderCall, "function", name);
		assert.equal(typeof tool.renderResult, "function", name);
	}
});

it("registered intent cards show observed publish and clear outcomes and expanded raw details", () => {
	const tool = registeredTools().get("agent_intent");
	assert.ok(tool);
	const claim = { purpose: "Review the parser", integration: "Return the checked change", authority: "Operator permits review", scope: { paths: ["src"], branches: ["work"], fullGate: true }, updatedAt: "2026-01-01T00:00:00.000Z" };
	for (const action of ["publish", "clear"]) {
		const args = action === "publish" ? { action, purpose: claim.purpose, integration: claim.integration, authority: claim.authority, scope: claim.scope } : { action };
		const published = { id: identity, name: "Parser review", model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: model.thinkingLevel, ...(action === "publish" ? { intentClaim: claim } : {}) };
		const details = { published, awareness: { self: { id: identity }, presence: { efforts: [], coverage: { complete: false, reasons: ["visit-limit"] } } } };
		const before = structuredClone(details);
		const component = nativeTool("agent_intent", args, details, [], tool);
		const lines = clean(component).filter((line) => line.trim());
		assert.equal(lines[0]?.trim(), "agent_intent · Parser review");
		assert.equal(lines[1]?.trim(), `provider/model · xhigh · action ${action}`);
		assert.ok(text(component).includes(`Intent ${action === "publish" ? "published" : "cleared"} · ${identity}`));
		assert.doesNotMatch(text(component), /"published"|"awareness"|"authority"|"fullGate"|verified|reservation|lock|unknown|unavailable|Model:|thinking|reasoning/u);
		assert.equal((text(component).match(/to expand|expand for full/gu) ?? []).length, 1);
		component.setExpanded(true);
		assert.ok(text(component).includes(`"id": "${identity}"`));
		assert.match(text(component), /"awareness"/u);
		assert.match(text(component), /"visit-limit"/u);
		if (action === "publish") {
			assert.match(text(component), /"authority": "Operator permits review"/u);
			assert.match(text(component), /"fullGate": true/u);
			assert.match(text(component), /"updatedAt": "2026-01-01T00:00:00.000Z"/u);
		}
		assert.doesNotMatch(text(component), /to expand|expand for full/u);
		component.setExpanded(false);
		assert.equal((text(component).match(/provider\/model/gu) ?? []).length, 1);
		assert.deepEqual(details, before);
	}
});

it("intent cards omit absent endpoint facts and keep errors and pending outcomes truthful", () => {
	const cards = createAgentToolCards();
	const before = text(cards.agent_intent.renderCall({ action: "clear" }, theme, { expanded: false, argsComplete: true }));
	assert.match(before, /^agent_intent · this session\naction clear/u);
	assert.doesNotMatch(before, /provider|model|unknown|unavailable/u);
	const component = nativeTool("agent_intent", { action: "publish" }, { published: { id: identity } }, []);
	assert.ok(text(component).includes(`agent_intent · ${identity}`));
	assert.ok(text(component).includes(`Intent cleared · ${identity}`), "the returned claim state, not the requested action, selects the outcome");
	assert.doesNotMatch(text(component), /provider|model|unknown|unavailable/u);
	const error = { content: [{ type: "text" as const, text: "Intent publication requires this live ordinary primary session" }], details: {} };
	const failed = text(cards.agent_intent.renderResult(error, { expanded: false, isPartial: false }, theme, { expanded: false, isError: true }));
	assert.match(failed, /Intent error\nIntent publication requires this live ordinary primary session/u);
	assert.doesNotMatch(failed, /Intent published|Intent cleared/u);
	const pending = text(cards.agent_intent.renderResult({ content: [{ type: "text", text: "Waiting for publication" }], details: { published: { id: identity } } }, { expanded: false, isPartial: true }, theme, { expanded: false }));
	assert.match(pending, /Intent pending/u);
	assert.doesNotMatch(pending, /Intent published|Intent cleared/u);
});

it("peer cards supply the same native inner top and bottom padding as tool rows", () => {
	const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 0, content: "Report text.", details: { kind: "report", senderKind: "session", senderIdentity: identity, ...model, saved: false, liveOwner: true } };
	const peer = new CustomMessageComponent(message, renderAgentPeerMessage);
	const lines = clean(peer);
	assert.equal(lines[0]?.trim(), ""); assert.equal(lines[1]?.trim(), ""); assert.equal(lines.at(-1)?.trim(), "");
	const first = lines.findIndex((line) => line.trim());
	assert.ok(lines[first]?.includes(`[agent] report · ${identity}`));
	assert.doesNotMatch(lines[first] ?? "", /provider\/model|xhigh/u);
	assert.match(lines[first + 1] ?? "", /provider\/model.*xhigh/u);
	assert.doesNotMatch(lines.join("\n"), /Result not saved|unknown|unavailable/u);
	const tool = nativeTool("agent_status", { sessionId: identity }, { arbitrary: true });
	assert.deepEqual(clean(tool).slice(0, 2).map((line) => line.trim()), lines.slice(0, 2).map((line) => line.trim()));
	assert.equal(clean(tool).at(-1)?.trim(), lines.at(-1)?.trim());
});

it("peer reports and steer cards use identical known configuration subheadings", () => {
	for (const thinkingLevel of ["xhigh", "off", undefined]) {
		const facts = { provider: "provider", modelId: "model", thinkingLevel: thinkingLevel ?? "" };
		const cards = createAgentToolCards(() => [{ ...row, model: facts }]);
		const steer = cards.agent_steer.renderCall({ sessionId: identity, message: "Task" }, theme, { expanded: false, argsComplete: true });
		const peer = renderPeerNoticeCard({ content: "Report body", details: { kind: "report", senderIdentity: identity, ...facts } }, theme, false);
		assert.ok(peer);
		const expected = `provider/model${thinkingLevel ? ` · ${thinkingLevel}` : ""}`;
		assert.equal(clean(steer).filter((line) => line.trim())[1]?.trim(), expected);
		assert.equal(clean(peer).filter((line) => line.trim())[1]?.trim(), expected);
		assert.doesNotMatch(text(peer), /Model:|Provider:|unknown|unavailable/u);
	}
	const cards = createAgentToolCards();
	const ctx = { expanded: false, argsComplete: true, args: {} };
	const snapshot = { identity, conversationId: 1, name: "Parser review", agent: { model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: model.thinkingLevel }, busy: false };
	const outcomes = [
		["agent_status", { conversation: snapshot }],
		["agent_profile", { identity, name: "Parser review", model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: model.thinkingLevel, role: "Review", revision: "a".repeat(64) }],
		["agent_compact", { status: "completed", compaction: { identity, ...model } }],
	] as const;
	for (const [name, details] of outcomes) {
		const result = cards[name].renderResult({ content: [{ type: "text", text: JSON.stringify(details) }], details }, { expanded: false, isPartial: false }, theme, ctx);
		assert.ok(clean(result).some((line) => line.trim() === "provider/model · xhigh"), name);
		assert.doesNotMatch(text(result), /Model:|Provider:|reasoning/u, name);
	}
});

it("primary report receipts show a full-width truthful delivery outcome and raw JSON only expanded", () => {
	const result = { sessionId: identity, admitted: true, sourceId: "delivery-source", boundary: "Delivery does not prove action or task acceptance" };
	const component = nativeTool("agent_send", { sessionId: identity, mode: "report", message: "Review is complete." }, result, []);
	assert.ok(text(component).includes(`Report delivered to ${identity}`));
	assert.doesNotMatch(text(component), /"sessionId"|"admitted"|01a106df…|^\s*…\s*$/mu);
	assert.equal((text(component).match(/to expand|expand for full/gu) ?? []).length, 1);
	component.setExpanded(true);
	assert.ok(text(component).includes(`"sessionId": "${identity}"`));
	assert.match(text(component), /"admitted": true/u);
	assert.deepEqual(result, { sessionId: identity, admitted: true, sourceId: "delivery-source", boundary: "Delivery does not prove action or task acceptance" });
});

it("known metadata uses the muted subheading while absent metadata creates no placeholder", () => {
	const colors: Array<{ color: string; value: string }> = [];
	const spy = { fg: (color: string, value: string) => { colors.push({ color, value }); return value; }, bold: (value: string) => value } as unknown as Theme;
	const card = createAgentToolCards(() => [row]).agent_steer.renderCall({ sessionId: identity, message: "Task" }, spy, { expanded: false, argsComplete: true });
	assert.equal(text(card).split("\n")[0], "agent_steer · Parser review");
	assert.equal(text(card).split("\n")[1], "provider/model · xhigh");
	assert.ok(colors.some(({ color, value }) => color === "muted" && value === "provider/model · xhigh"));
	const absent = createAgentToolCards().agent_steer.renderCall({ sessionId: identity, message: "Task" }, theme, { expanded: false, argsComplete: true });
	assert.equal(text(absent).split("\n")[0], `agent_steer · ${identity}`);
	assert.equal(text(absent).split("\n")[1], "Task");
	assert.doesNotMatch(text(absent), /unknown|unavailable|thinking/u);
});

it("expected unsaved reports and direct messages omit warnings but genuine receipt failures remain", () => {
	for (const kind of ["report", "message"]) {
		const card = renderPeerNoticeCard({ content: "Direct body", details: { kind, senderIdentity: identity, saved: false, liveOwner: true } }, theme, false);
		assert.ok(card); assert.doesNotMatch(text(card), /Result not saved|unavailable|unanswered/u);
	}
	const failure = renderPeerNoticeCard({ content: "Failure body", details: { kind: "receipt", status: "unanswered", saved: false, liveOwner: false, reason: "aborted", identity } }, theme, false);
	assert.ok(failure);
	assert.match(text(failure), /Result unavailable or unanswered/u);
	assert.match(text(failure), /No live owner; retained result only/u);
	assert.match(text(failure), /Result not saved; retained only by the live owner/u);
	assert.doesNotMatch(text(failure), /aborted|Failure body/u);
	assert.equal((text(failure).match(/to expand|expand for full/gu) ?? []).length, 1);
	const expanded = renderPeerNoticeCard({ content: "Failure body", details: { kind: "receipt", status: "unanswered", saved: false, liveOwner: false, reason: "aborted", identity } }, theme, true);
	assert.ok(expanded);
	assert.match(text(expanded), /aborted/u);
	assert.match(text(expanded), /Failure body/u);
	assert.doesNotMatch(text(expanded), /to expand|expand for full/u);
});

it("native peer notices keep three visual body lines and one hint only when text is hidden", (t) => {
	noticeKeys(t);
	const content = `Opening finding: the parser preserves the complete source. ${"Useful detail follows. ".repeat(70)}FINAL_BODY`;
	const kinds = [
		{ kind: "report" },
		{ kind: "message", senderKind: "session" },
		{ kind: "receipt", status: "done" },
		{ kind: "report", threadId: "source/thread", threadTitle: "Parser contract", operatorMessage: content },
		{ checkIn: {}, message: content },
	];
	for (const facts of kinds) {
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 0, content, details: { senderIdentity: identity, ...model, ...facts } };
		const before = structuredClone(message);
		const component = new CustomMessageComponent(message, renderAgentPeerMessage);
		for (const width of [24, 60, 160]) {
			component.setExpanded(false);
			const collapsed = clean(component, width);
			const first = collapsed.findIndex((line) => line.trim());
			assert.equal(collapsed[first + 2]?.trim(), "");
			const preview = collapsed.slice(first + 3, -1);
			assert.equal(preview.length, 4, JSON.stringify({ facts, width, preview }));
			assert.match(preview[0] ?? "", /Opening finding/u);
			assert.equal(preview.filter((line) => /to expand|expand for full/u.test(line)).length, 1);
			assert.doesNotMatch(preview.slice(0, 3).join("\n"), /FINAL_BODY/u);
			assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
			component.setExpanded(true);
			const expanded = clean(component, width);
			assert.deepEqual(preview.slice(0, 3), expanded.slice(first + 3, first + 6));
			assert.doesNotMatch(expanded.join("\n"), /to expand|expand for full/u);
		}
		assert.match(text(component, 240), /FINAL_BODY/u);
		assert.deepEqual(message, before);
	}
	for (const content of ["Only one body line", "First line\nSecond line\nThird line"]) {
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 0, content, details: { kind: "report", senderIdentity: identity } };
		const component = new CustomMessageComponent(message, renderAgentPeerMessage);
		assert.doesNotMatch(text(component, 160), /to expand|expand for full/u);
		assert.match(text(component, 160), new RegExp(content.split("\n").at(-1) ?? ""));
	}
});

it("peer Markdown and wrapped reasons share the total visual preview bound", (t) => {
	noticeKeys(t);
	for (const source of [
		{ content: "First paragraph\n\nSecond paragraph\n\nFINAL_BODY", details: { kind: "report" } },
		{ content: "```text\nFirst code line\nSecond code line\nThird code line\nFINAL_BODY\n```", details: { kind: "report" } },
		{ content: "FINAL_BODY", details: { kind: "receipt", status: "done", reason: "Reason detail. ".repeat(20) } },
	]) {
		const component = renderPeerNoticeCard({ ...source, details: { senderIdentity: identity, ...source.details } }, theme, false);
		const expanded = renderPeerNoticeCard({ ...source, details: { senderIdentity: identity, ...source.details } }, theme, true);
		assert.ok(component); assert.ok(expanded);
		for (const width of "reason" in source.details ? [24, 60] : [24, 160]) {
			const lines = clean(component, width);
			const first = lines.findIndex((line) => line.trim());
			assert.equal(lines[first + 1]?.trim(), "");
			const preview = lines.slice(first + 2, -1);
			assert.equal(preview.length, 4);
			assert.deepEqual(preview.slice(0, 3), clean(expanded, width).slice(first + 2, first + 5));
			assert.match(preview.at(-1) ?? "", /to expand|expand for full/u);
			assert.doesNotMatch(preview.slice(0, 3).join("\n"), /FINAL_BODY/u);
		}
		assert.match(text(expanded), /FINAL_BODY/u);
	}
});

it("thread notice headers show the subject before known sender and secondary facts without duplicate labels", () => {
	const threadId = `${identity}/${"a".repeat(32)}`;
	const facts = { kind: "report", senderIdentity: identity, name: "Parser review", threadId, threadTitle: "Parser contract", ...model, checkIn: undefined };
	const cases = [
		{ details: facts, header: ["[agent] thread notice · Parser contract", "from Parser review · provider/model · xhigh"] },
		{ details: { ...facts, name: undefined, threadTitle: undefined }, header: [`[agent] thread notice · ${threadId}`, `from ${identity} · provider/model · xhigh`] },
		{ details: { threadId, threadTitle: "Parser contract" }, header: ["[agent] thread notice · Parser contract"] },
		{ details: { threadId, name: "Parser review" }, header: [`[agent] thread notice · ${threadId}`, "from Parser review"] },
		{ details: { ...model, kind: "report", name: "Parser review" }, header: ["[agent] report · Parser review", "provider/model · xhigh"] },
		{ details: { ...model, name: "Parser review", checkIn: { elapsedMs: 90_000, cost: 0 } }, header: ["[agent] still working · Parser review", "provider/model · xhigh · 1m elapsed · $0.000 conversation total"] },
	];
	for (const { details, header } of cases) {
		const card = renderPeerNoticeCard({ content: "Body text", details }, theme, false);
		assert.ok(card);
		const lines = clean(card, 240);
		assert.deepEqual(lines.slice(1, header.length + 1), header);
		assert.equal(lines[header.length + 1], "");
		assert.doesNotMatch(lines.join("\n"), /Model:|Provider:|unknown|unavailable|to expand|expand for full/u);
		for (const label of ["Parser contract", "Parser review", "provider/model"]) {
			assert.ok((lines.join("\n").match(new RegExp(label, "gu")) ?? []).length <= 1, label);
		}
	}
});

it("peer kind, subject and normal body use text while metadata and hints remain muted", (t) => {
	noticeKeys(t);
	const colors: Array<{ color: string; value: string }> = [];
	const bold: string[] = [];
	const spy = { ...theme, fg: (color: string, value: string) => { colors.push({ color, value }); return value; }, bold: (value: string) => { bold.push(value); return value; } } as unknown as Theme;
	const card = renderPeerNoticeCard({ content: "First body line\nSecond body line\nThird body line\nFinal body line", details: { threadId: "source/thread", threadTitle: "Parser contract", name: "Parser review", ...model } }, spy, false);
	assert.ok(card);
	card.render(160);
	assert.deepEqual(bold, ["[agent] thread notice"]);
	for (const value of ["[agent] thread notice", " · Parser contract"]) assert.ok(colors.some((entry) => entry.color === "text" && entry.value === value), value);
	assert.ok(colors.some(({ color, value }) => color === "text" && value.includes("First body line")));
	assert.ok(colors.some(({ color, value }) => color === "muted" && value === "from Parser review · provider/model · xhigh"));
	assert.ok(colors.some(({ color, value }) => color === "muted" && value === "... (ctrl+o to expand)"));
	assert.equal(colors.some(({ color }) => ["accent", "customMessageLabel", "customMessageText", "dim"].includes(color)), false);
	colors.length = 0;
	const failure = renderPeerNoticeCard({ content: "Failure body", details: { status: "failed", reason: "Diagnostic reason" } }, spy, false);
	assert.ok(failure); failure.render(160);
	assert.ok(colors.some(({ color, value }) => color === "warning" && value === "Result unavailable or unanswered"));
	assert.ok(colors.some(({ color, value }) => color === "text" && value === "Diagnostic reason"));
});

it("peer width clips use one ellipsis while wide headers and expanded details retain full identities", (t) => {
	noticeKeys(t);
	const threadId = `${identity}/${"a".repeat(32)}`;
	const details = { kind: "report", senderIdentity: identity, threadId, provider: "provider", modelId: `model-${"m".repeat(160)}`, thinkingLevel: "xhigh" };
	const card = renderPeerNoticeCard({ content: "Body line\n".repeat(8), details }, theme, false);
	const expanded = renderPeerNoticeCard({ content: "Body line\n".repeat(8), details }, theme, true);
	assert.ok(card); assert.ok(expanded);
	const wide = text(card, 400);
	assert.ok(wide.includes(threadId));
	assert.ok(wide.includes(`from ${identity}`));
	assert.ok(wide.includes(`provider/${details.modelId}`));
	assert.equal((wide.match(/\.\.\. \(ctrl\+o to expand\)/gu) ?? []).length, 1);
	assert.doesNotMatch(wide, /…/u);
	const narrow = clean(card, 20);
	assert.match(narrow[1] ?? "", /…$/u);
	assert.match(narrow[2] ?? "", /…$/u);
	assert.match(narrow.at(-2) ?? "", /^\.\.\. \(ctrl\+o.*…$/u);
	assert.doesNotMatch(narrow.slice(1, 3).join("\n"), /\.\.\./u);
	assert.ok(card.render(20).every((line) => visibleWidth(line) <= 20));
	assert.ok(text(expanded, 400).includes(`threadId: ${threadId}`));
	assert.ok(text(expanded, 400).includes(`senderIdentity: ${identity}`));
});

it("wide headers preserve full model identities and narrow headers clip only to width", () => {
	const modelId = `model-${"m".repeat(420)}`;
	const cards = createAgentToolCards(() => [{ ...row, model: { ...model, modelId } }]);
	const component = cards.agent_steer.renderCall({ sessionId: identity, message: "Task" }, theme, { expanded: false, argsComplete: true });
	assert.ok(text(component, 600).includes(`provider/${modelId}`));
	assert.doesNotMatch(text(component, 600), /…/u);
	assert.ok(component.render(40).every((line) => visibleWidth(line) <= 40));
	const peer = renderPeerNoticeCard({ content: "Body", details: { kind: "report", senderIdentity: identity, provider: "provider", modelId } }, theme, false);
	assert.ok(peer); assert.ok(text(peer, 600).includes(`provider/${modelId}`));
});

it("structured error previews remain plain and bounded without losing expanded source", () => {
	const error = { error: { message: `First diagnostic\nSecond diagnostic\nThird diagnostic\n${"extra\n".repeat(100)}` } };
	const component = nativeTool("agent_status", { sessionId: identity }, error);
	assert.match(text(component), /First diagnostic\n\s*Second diagnostic\n\s*Third diagnostic/u);
	assert.doesNotMatch(text(component), /extra|"error"|^\s*…\s*$/mu);
	component.setExpanded(true);
	assert.match(text(component), /"error"/u);
	assert.match(text(component), /extra/u);
});

it("source observations update the native header without new discovery or repeated labels", () => {
	const snapshot = { identity, conversationId: 1, name: "Actual name", busy: false, state: "idle", agent: { model: { provider: "actual-provider", modelId: "actual-model" }, thinkingLevel: "low" } };
	const component = nativeTool("agent_configure", { sessionId: identity, model: "actual-provider/actual-model", thinkingLevel: "xhigh" }, { identity, conversationId: 1, status: snapshot }, []);
	const lines = clean(component).filter((line) => line.trim());
	assert.equal(lines[0]?.trim(), "agent_configure · Actual name");
	assert.match(lines[1] ?? "", /actual-provider\/actual-model · low/u);
	assert.match(lines[1] ?? "", /Requested: xhigh/u);
	assert.equal((text(component).match(/Actual name/gu) ?? []).length, 1);
	assert.equal((text(component).match(/actual-provider\/actual-model/gu) ?? []).length, 1);
	component.setExpanded(true); component.setExpanded(false);
	assert.equal((text(component).match(/actual-provider\/actual-model/gu) ?? []).length, 1);
});
