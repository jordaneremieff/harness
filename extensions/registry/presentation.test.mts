import assert from "node:assert/strict";
import { homedir } from "node:os";
import { it, type TestContext } from "node:test";
import {
	initTheme,
	Theme,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	type KeyId,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import { boundResult } from "./format.ts";
import registerRegistry, { type RegistryParams } from "./index.ts";
import { lookup, lookupIsError } from "./lookup.ts";

initTheme("dark", false);

const sourceInfo = {
	path: "/fixtures/extension.ts",
	source: "fixture",
	scope: "temporary" as const,
	origin: "top-level" as const,
};
const toolName = `synthetic_${"registry_".repeat(22)}end`;
const context = {
	cwd: "/fixtures",
	mode: "rpc",
	tools: [],
	hasUI: false,
	isProjectTrusted: () => true,
	model: { provider: "provider", id: "model" },
	thinkingLevel: "high",
	getContextUsage: () => ({ tokens: 7500, contextWindow: 10000, percent: 75 }),
	sessionManager: { getSessionId: () => "session-1", getSessionFile: () => null },
} as unknown as ExtensionToolContext;

function registeredTool() {
	let tool: ToolDefinition<typeof RegistryParams, Record<string, unknown>> | undefined;
	registerRegistry({
		on: () => {},
		events: { emit: () => {}, on: () => () => {} },
		registerTool: (value: NonNullable<typeof tool>) => {
			tool = value;
		},
		getAllTools: () => [
			{ name: "first", sourceInfo, parameters: { title: "Exact schema" } },
			{ name: toolName, sourceInfo, parameters: { title: "Long-name schema" } },
		],
		getActiveTools: () => ["first"],
		getCommands: () => [{ name: "skill:example", source: "skill", sourceInfo }],
	} as unknown as ExtensionAPI);
	assert.ok(tool);
	return tool;
}

function key(t: TestContext, keys: KeyId[]): void {
	const old = getKeybindings();
	setKeybindings(
		new KeybindingsManager(
			{ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand" } },
			{ "app.tools.expand": keys },
		),
	);
	t.after(() => setKeybindings(old));
}

function card(args: Record<string, unknown> = {}): ToolExecutionComponent {
	const definition = toolDisplay().tools[0];
	return new ToolExecutionComponent(
		definition.name,
		"registry-test",
		args,
		{ outputPad: 1 },
		definition,
		{ requestRender() {} } as TUI,
		"/fixtures",
	);
}

function rows(component: ToolExecutionComponent, width = 128): string[] {
	const lines = component.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	return lines.map((line) => stripTerminalSequences(line).slice(1).trimEnd());
}

function screen(component: ToolExecutionComponent, width?: number): string {
	return rows(component, width).join("\n");
}

function resultOf(text: string, details: Record<string, unknown>, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

function settle(component: ToolExecutionComponent, result: AgentToolResult<unknown> & { isError?: boolean }): void {
	component.updateResult({ ...result, isError: result.isError === true });
}

it("shows one Pi expansion hint at the correct position, only for hidden content", (t) => {
	key(t, ["ctrl+g"]);
	const plain = card({ kind: "model", available: false, provider: "p" });
	assert.match(screen(plain), /registry model\nprovider p · cached unavailable only/);
	assert.doesNotMatch(screen(plain), /to expand/);
	settle(plain, resultOf("No matches", {}));
	assert.doesNotMatch(screen(plain), /to expand/);

	const component = card({ cursor: "opaque-input-cursor" });
	assert.deepEqual(rows(component).filter(Boolean), ["registry continuation", "... (ctrl+g to expand)"]);
	component.updateResult(resultOf("", {}), true);
	assert.deepEqual(rows(component).filter(Boolean).slice(1), ["Reading the registry…", "... (ctrl+g to expand)"]);
	settle(component, resultOf("One line", {}));
	assert.deepEqual(rows(component).filter(Boolean), ["registry continuation", "One line", "... (ctrl+g to expand)"]);
	component.setExpanded(true);
	assert.match(screen(component), /cursor: opaque-input-cursor/);
	assert.doesNotMatch(screen(component), /to expand/);
});

it("never advertises a click on an unsettled call without a key", (t) => {
	key(t, []);
	const component = card({ name: toolName, kind: "tool", detail: true, limit: 5 });
	assert.match(screen(component, 40), /registry synthetic_registry_registry_…/);
	assert.doesNotMatch(screen(component), /expand/);
	settle(component, resultOf("A receipt", {}));
	assert.match(screen(component), /A receipt\n\.\.\. \(click to expand\)/);
});

it("renders a real registered overview and tool detail, with full identifiers on expansion", async (t) => {
	key(t, ["ctrl+o"]);
	const tool = registeredTool();
	assert.equal(tool.renderCall, toolDisplay().tools[0].renderCall);
	assert.equal(tool.renderResult, toolDisplay().tools[0].renderResult);
	const overview = card();
	settle(overview, await tool.execute("host", {}, undefined, undefined, context));
	assert.match(screen(overview), /Session overview\nprovider\/model · high · context 75%\n2 tools · 1 active/);
	assert.match(screen(overview), /0 commands · 1 skill · 0 prompts/);
	assert.doesNotMatch(screen(overview), /unknown|unavailable \(/);

	const args = { kind: "tool", name: toolName, detail: true };
	const component = card(args);
	const result = await tool.execute("detail", args, undefined, undefined, context);
	settle(component, result);
	assert.match(screen(component, 80), /Returned 1 of 1 match/);
	assert.equal(rows(component, 80).filter((line) => line.includes("to expand")).length, 1);
	assert.match(screen(component, 800), new RegExp(toolName));
	component.setExpanded(true);
	assert.match(screen(component, 800), new RegExp(`Source for ${toolName}: /fixtures/extension.ts`));
	assert.match(screen(component), /parameters:.*Long-name schema/);
	assert.doesNotMatch(screen(component), /to expand/);
});

it("reports real page scope and renders the exact continuation argument", async () => {
	const tool = registeredTool();
	const args = { kind: "tool", limit: 1 };
	const component = card(args);
	const first = await tool.execute("first", args, undefined, undefined, context);
	settle(component, first);
	assert.match(screen(component), /Returned 1 of 2 matches; continuation available/);
	assert.match(screen(component), /Tool first · configured · active · not callable in this host/);
	assert.doesNotMatch(screen(component), /Next call:|pass cursor=/);
	component.setExpanded(true);
	const cursor = first.details?.cursor;
	assert.equal(typeof cursor, "string");
	assert.ok(screen(component, 2048).includes(`Next call: registry ${JSON.stringify({ cursor })}`));
	const second = card({ cursor });
	assert.equal(typeof cursor, "string");
	settle(second, await tool.execute("second", { cursor: cursor as string }, undefined, undefined, context));
	assert.match(screen(second), /Returned 1 of 2 matches \(offset 1\); no further known matches/);
});

it("shows a missing chat model and a local catalog review without implying remote checks", async () => {
	const tool = registeredTool();
	const modelContext = {
		...context,
		model: undefined,
		scopedModels: [],
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			getError: () => undefined,
			getRegisteredProviderIds: () => [],
		},
	} as unknown as ExtensionToolContext;
	const args = { kind: "model", name: "p/missing" };
	const missing = card(args);
	settle(missing, await tool.execute("model", args, undefined, undefined, modelContext));
	assert.match(screen(missing), /No matches; no further known matches/);
	assert.match(screen(missing), /Chat models only; find classifier and image models via codemode models\.\*/);
	missing.setExpanded(true);
	assert.match(screen(missing), /models\.getModelsOfType\("classifier"\)/);

	const healthArgs = { kind: "model", health: true };
	const health = card(healthArgs);
	settle(health, await tool.execute("health", healthArgs, undefined, undefined, modelContext));
	assert.match(screen(health), /No flagged records in the local catalog review/);
	assert.match(screen(health), /remote health not checked/);
});

it("omits absent model facts and distinguishes cached availability from configured auth", () => {
	const model = card({ kind: "model" });
	settle(
		model,
		resultOf("Catalog boundaries", {
			outcome: "ok",
			catalogBoundary: "Chat only",
			returnedRecords: 2,
			total: 2,
			records: [
				{ kind: "model", name: "provider/present", available: false, configuredAuth: true, contextWindow: 250000 },
				{ kind: "model", name: "provider/limited", available: null, configuredAuth: null, contextWindow: null },
			],
		}),
	);
	assert.match(screen(model), /provider\/present · unavailable \(cached\) · auth configured · 250,000 context/);
	assert.match(screen(model), /provider\/limited\n/);
	assert.doesNotMatch(screen(model), /unknown|· 0 context|thinking/);
});

it("distinguishes settings coverage, context evidence, scan coverage, ambiguity, and producer bounds", async () => {
	const tool = registeredTool();
	for (const [kind, expected] of [
		["setting", /Settings snapshot unavailable/],
		["context_file", /Context paths not yet observed/],
	] as const) {
		const args = { kind };
		const component = card(args);
		settle(component, await tool.execute(kind, args, undefined, undefined, context));
		assert.match(screen(component), expected);
		assert.doesNotMatch(screen(component), /No matches/);
	}
	const contextFiles = card({ kind: "context_file" });
	settle(
		contextFiles,
		resultOf("Prior context path evidence", {
			outcome: "ok",
			query: { kind: "context_file" },
			observed: true,
			total: 1,
			returnedRecords: 1,
			records: [{ kind: "context_file", path: `${homedir()}/fixtures/AGENTS.md` }],
		}),
	);
	assert.match(screen(contextFiles), /Prior context path observation; no file content read\n~\/fixtures\/AGENTS.md/);

	const scan = await lookup({
		params: { kind: "skill", name: "example", contains: "needle" },
		epoch: "fixture",
		session: { cwd: "/fixtures", mode: "rpc" },
		snapshot: {
			tools: [],
			activeTools: [],
			observation: null,
			at: 1000,
			availability: { tools: true, activeTools: true, commands: true },
			commands: [{ name: "example", source: "skill", sourceInfo: { ...sourceInfo, path: "/fixtures/SKILL.md" } }],
		},
		scan: async () => ({
			outcome: "ok",
			matches: [{ line: 4, text: "Needle line" }],
			bytesRead: 100,
			fileSize: 500,
			truncated: true,
			stamp: { path: "/fixtures/SKILL.md", dev: 1, ino: 2, size: 500, mtimeMs: 1, ctimeMs: 1, digest: "0".repeat(64) },
		}),
	});
	const scanCard = card();
	settle(scanCard, resultOf(scan.text, scan.details, lookupIsError(scan.outcome)));
	assert.match(screen(scanCard), /Partial file scan: 1 of 1 known match in skill example; continuation unavailable/);
	assert.match(screen(scanCard), /100 of 500 bytes read/);
	assert.match(screen(scanCard), /Line 4: Needle line/);
	assert.match(screen(scanCard), /\[Partial coverage: absence is not established\]/);

	const partialSettings = card({ kind: "setting" });
	settle(
		partialSettings,
		resultOf("Configured settings receipt", {
			outcome: "partial",
			total: 1,
			returnedRecords: 1,
			records: [{ name: "example.status", kind: "setting", status: "valid", origin: "file" }],
			settingsCoverage: { respondingSlices: ["example"], collection: { malformed: 1 } },
		}),
	);
	assert.match(screen(partialSettings), /Configuration snapshot; responding publishers only · example/);
	assert.match(screen(partialSettings), /1 publication malformed/);
	assert.match(screen(partialSettings), /example\.status · valid · file/);

	const ambiguous = card({ name: "example", contains: "needle" });
	settle(
		ambiguous,
		resultOf("Narrow the query", {
			outcome: "ambiguous",
			candidates: 2,
			returnedRecords: 1,
			continuationStatus: "available",
			cursor: "candidate-page",
			records: [{ kind: "skill", name: "example" }],
		}),
	);
	assert.match(screen(ambiguous), /The query needs one resource: 1 of 2 candidates; continuation available/);

	const blocked = boundResult({
		header: ["registry outcome=ok"],
		footer: [],
		details: { outcome: "ok", total: 1 },
		blocks: [{ lines: ["x".repeat(60_000)], detail: { kind: "tool", name: "large" } }],
		page: { total: 1, offset: 0 },
	});
	const blockedCard = card();
	settle(blockedCard, resultOf(blocked.text, blocked.details));
	assert.match(screen(blockedCard), /page cannot advance/);
	assert.match(screen(blockedCard), /first record exceeds the result bound/);
	assert.doesNotMatch(screen(blockedCard), /No matches|\[Partial coverage/);
});

it("uses Pi's error context for validation, stale cursors and thrown diagnostics, and names structured cancellation", async (t) => {
	const tool = registeredTool();
	const colours = t.mock.method(Theme.prototype, "fg");
	const invalid = card({ name: "" });
	settle(invalid, await tool.execute("invalid", { name: "" }, undefined, undefined, context));
	assert.match(screen(invalid), /name must be 1-256 characters/);
	assert.ok(
		colours.mock.calls.some(({ arguments: [role, text] }) => role === "error" && text.includes("name must be")),
	);

	const readError = card({ kind: "skill", contains: "x" });
	settle(readError, await tool.execute("read", { kind: "skill", contains: "x" }, undefined, undefined, context));
	assert.match(screen(readError), /ENOENT/);

	const first = await tool.execute("first", { kind: "tool", limit: 1 }, undefined, undefined, context);
	const cursor = first.details?.cursor as string;
	const stale = card({ cursor });
	settle(stale, await registeredTool().execute("stale", { cursor }, undefined, undefined, context));
	assert.match(screen(stale), /Stale cursor: the session changed/);

	const cancelled = card({ kind: "tool" });
	settle(cancelled, await tool.execute("cancel", { kind: "tool" }, AbortSignal.abort(), undefined, context));
	assert.match(screen(cancelled), /\nCancelled\n/);

	const thrown = card();
	settle(thrown, resultOf("AbortError: wait cancelled by transport", {}, true));
	assert.match(screen(thrown), /AbortError: wait cancelled by transport/);
	assert.doesNotMatch(screen(thrown), /\nCancelled\n|to expand/);
});

it("discloses bare multiline errors only when the card hides diagnostic text", (t) => {
	key(t, ["ctrl+o"]);
	const component = card();
	const lead = "Read error";
	const detail = `Details: ${"x".repeat(190)}`;
	settle(component, resultOf(`${lead}\n${detail}`, {}, true));
	assert.deepEqual(rows(component, 220).filter(Boolean), ["registry session overview", lead, detail]);

	const narrow = rows(component, 40).filter(Boolean);
	assert.equal(narrow.filter((row) => row.includes("to expand")).length, 1);
	assert.match(narrow.at(-1) ?? "", /more line[s]?, ctrl\+o to expand/);

	component.setExpanded(true);
	assert.deepEqual(rows(component, 220).filter(Boolean), ["registry session overview", lead, detail]);
});

it("does not repeat a structured error lead in evidence", () => {
	const lead = "The file is unreadable";
	const details = { outcome: "io_error", ioError: lead };
	const component = card();
	settle(component, resultOf(lead, details, true));
	assert.deepEqual(rows(component).filter(Boolean), ["registry session overview", lead]);
	settle(component, resultOf(`${lead}\nFile evidence was not read.`, details, true));
	assert.match(screen(component), /to expand/);
	component.setExpanded(true);
	assert.deepEqual(rows(component).filter(Boolean), ["registry session overview", lead, "File evidence was not read."]);
});

it("caps wrapped content, shows exact display bounds, and contains terminal controls", (t) => {
	key(t, ["ctrl+o"]);
	const diagnostic = `Failure:\x1b[31m\u202e ${"x".repeat(240)}`;
	const compact = card();
	settle(compact, resultOf(`${diagnostic}\n${"Y".repeat(400)}`, { malformed: true }, true));
	const collapsed = rows(compact, 40).filter(Boolean);
	assert.equal(collapsed.length, 8, "call, outcome, five wrapped body lines, and hint");
	assert.match(collapsed[1], /^Failure: x+…$/);
	assert.match(collapsed.at(-1) ?? "", /more lines, ctrl\+o to expand/);
	assert.doesNotMatch(collapsed.join("\n"), /[\x1b\u202e]/u);
	compact.setExpanded(true);
	assert.ok(screen(compact, 500).includes("Y".repeat(400)));

	const bounded = card();
	settle(bounded, resultOf(`Plain report\n${"z".repeat(34_000)}`, { outcome: "ok" }));
	bounded.setExpanded(true);
	assert.match(screen(bounded, 480), /\[Truncated: showing 32000 of 34013 characters\]/);
});
