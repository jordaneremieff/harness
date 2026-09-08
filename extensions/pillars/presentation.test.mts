import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { AccessPage } from "./access.ts";
import { emptyShard, zero } from "./capacity.ts";
import { accessRenderers, usageMarkdown, usageRenderers } from "./presentation.ts";
import { createReader, errorResponse, MEANING, type Page } from "./readback.ts";

test("operator pages preserve evidence meaning, continuation, and narrow terminal widths", async () => {
	const day = "2026-09-07";
	const shard = emptyShard(day);
	for (let i = 0; i < 25; i++)
		shard.cells.push({
			day,
			observationStage: "tool_request",
			resourceClass: "entry",
			resourceId: `entry-${String(i).padStart(2, "0")}`,
			model: "synthetic/model",
			reasoning: "high",
			referenceBodyDigest: "a".repeat(64),
			observerVersion: "0.1.0",
			piVersion: "0.85.1",
			counters: { ...zero(), readRequests: 1 },
		});
	const reader = createReader(() => ({ shards: { [day]: shard } }), { now: () => Date.parse(`${day}T00:00:00Z`) });
	const page = await reader.read({ view: "revisions" });
	assert.equal(page.kind, "page");
	const text = usageMarkdown(page);
	assert.ok(Buffer.byteLength(text) <= 32768);
	assert.ok(text.includes("/pillars next "));
	assert.ok(text.includes("unpersisted loss: unknown"));
	assert.ok(text.includes("not the selected read-event window"));
	assert.ok(text.includes("readRequests: 25"));
	initTheme("dark", false);
	const component = new Markdown(text, 0, 0, getMarkdownTheme());
	for (const width of [20, 40, 100]) {
		component.invalidate();
		const lines = component.render(width);
		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	reader.clear();
	const error = usageMarkdown(errorResponse("store_corrupt"));
	assert.ok(error.includes("invalid"));
	assert.ok(error.includes("Only retained persisted aggregates"));
});

const plain = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");
const bareTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function usagePageFixture(): Page {
	return {
		schema: "pillars-usage-response",
		schemaVersion: 2,
		kind: "page",
		enabled: true,
		window: { fromDay: "2026-02-06", toDay: "2026-03-08", requestedDays: 30, retentionDays: 30 },
		meaning: MEANING,
		coverage: {
			retainedDayShards: 1,
			liveCollectors: "unknown",
			wholeWindowCoverage: "unknown",
			unpersistedLoss: "unknown",
			dataState: "retained_aggregates",
			captureScope: "validated_retained_shards_not_live_observer_census",
			captureOmissions: [],
		},
		storageEvidence: {
			scope: "retained_shard_detection_days_not_selected_event_window",
			assessment: "no_incidents_recorded",
			checkpointWriteFailures: 0,
			foldedEvents: 0,
			receiptQuotaDays: 0,
			unresolvedAccessEvents: 0,
			forkResets: 0,
			forkDroppedEvents: 0,
			pendingDroppedEvents: 0,
		},
		totals: zero(),
		summary: { foldedResourceIdentities: 0, revisionRows: 0, revisionView: "revisions" },
		pagination: { pageNumber: 1, pageCount: 1, totalRows: 0 },
		view: "overview",
		byResource: [],
	};
}

test("tool renderers name the call, hide result bodies by default, and expand on request", () => {
	initTheme("dark", false);
	const access = accessRenderers();
	const usage = usageRenderers();
	const ok = { isError: false };
	const page: AccessPage = {
		schema: "pillars-source",
		resource: "governance",
		referenceBodyDigest: "a".repeat(64),
		bodyBytes: 64,
		offset: 0,
		endOffset: 32,
		text: "line one\nline two",
		nextOffset: 32,
	};
	const rendered = (text: string): string =>
		plain(text)
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""))
			.join("\n");

	assert.match(
		rendered(access.renderCall({ resource: "governance" }, bareTheme).render(120).join("\n")),
		/pillars governance/,
	);
	assert.match(rendered(access.renderCall(undefined, bareTheme).render(120).join("\n")), /pillars inventory/);
	assert.match(
		rendered(access.renderCall({ resource: "governance", offset: 32 }, bareTheme).render(120).join("\n")),
		/offset 32/,
	);
	assert.match(
		rendered(usage.renderCall({ view: "revisions", windowDays: 7 }, bareTheme).render(120).join("\n")),
		/pillars_usage \(revisions, 7 days\)/,
	);
	assert.match(rendered(usage.renderCall({ cursor: "ab12-_X9" }, bareTheme).render(120).join("\n")), /continuation/);

	const collapsed = rendered(
		access
			.renderResult(
				{ content: [{ type: "text", text: JSON.stringify(page) }], details: page },
				{ expanded: false, isPartial: false },
				bareTheme,
				ok,
			)
			.render(240)
			.join("\n"),
	);
	assert.match(collapsed, /governance \(32 of 64 bytes\)/);
	assert.match(collapsed, /continuation available/);
	assert.match(collapsed, /\.\.\. \(ctrl\+o to expand\)/);
	assert.doesNotMatch(collapsed, /line one/);

	const expanded = rendered(
		access
			.renderResult(
				{ content: [{ type: "text", text: JSON.stringify(page) }], details: page },
				{ expanded: true, isPartial: false },
				bareTheme,
				ok,
			)
			.render(240)
			.join("\n"),
	);
	assert.match(expanded, /governance \(32 of 64 bytes\)/);
	assert.match(expanded, /line one\nline two/);
	assert.doesNotMatch(expanded, /ctrl\+o/);

	const failed = rendered(
		access
			.renderResult(
				{ content: [{ type: "text", text: "Pillars source: source_changed." }], details: undefined },
				{ expanded: false, isPartial: false },
				bareTheme,
				{ isError: true },
			)
			.render(240)
			.join("\n"),
	);
	assert.match(failed, /Pillars source: source_changed\./);

	const refused = rendered(
		access
			.renderResult(
				{ content: [{ type: "text", text: "{}" }], details: { schema: "pillars-source-error", code: "invalid_input" } },
				{ expanded: false, isPartial: false },
				bareTheme,
				ok,
			)
			.render(240)
			.join("\n"),
	);
	assert.match(refused, /invalid_input/);

	const evidence = usagePageFixture();
	const usageCollapsed = rendered(
		usage
			.renderResult(
				{ content: [{ type: "text", text: JSON.stringify(evidence) }], details: evidence },
				{ expanded: false, isPartial: false },
				bareTheme,
				ok,
			)
			.render(240)
			.join("\n"),
	);
	assert.match(usageCollapsed, /overview \(page 1 of 1, read requests: 0, 2026-02-06 through 2026-03-08\)/);
	assert.match(usageCollapsed, /\.\.\. \(ctrl\+o to expand\)/);
	assert.doesNotMatch(usageCollapsed, /Pillars access evidence/);

	const usageExpanded = rendered(
		usage
			.renderResult(
				{ content: [{ type: "text", text: JSON.stringify(evidence) }], details: evidence },
				{ expanded: true, isPartial: false },
				bareTheme,
				ok,
			)
			.render(240)
			.join("\n"),
	);
	assert.match(usageExpanded, /Pillars access evidence/);

	const usageFailed = rendered(
		usage
			.renderResult(
				{ content: [{ type: "text", text: "{}" }], details: errorResponse("cursor_expired") },
				{ expanded: false, isPartial: false },
				bareTheme,
				ok,
			)
			.render(240)
			.join("\n"),
	);
	assert.match(usageFailed, /pillars_usage: The frozen capture expired or was replaced\./);
});

test("the host tool row renders collapsed by default and toggles with setExpanded", () => {
	initTheme("dark", false);
	const access = accessRenderers();
	const page: AccessPage = {
		schema: "pillars-source",
		resource: "governance",
		referenceBodyDigest: "a".repeat(64),
		bodyBytes: 64,
		offset: 0,
		endOffset: 32,
		text: "line one\nline two",
	};
	const component = new ToolExecutionComponent(
		"pillars",
		"source-call",
		{ resource: "governance" },
		undefined,
		access,
		{ requestRender() {} } as unknown as TUI,
		".",
	);
	component.updateResult({ content: [{ type: "text", text: JSON.stringify(page) }], details: page, isError: false });
	const collapsed = plain(component.render(240).join("\n"));
	assert.match(collapsed, /pillars governance/);
	assert.match(collapsed, /\.\.\. \(ctrl\+o to expand\)/);
	assert.doesNotMatch(collapsed, /line one/);
	component.setExpanded(true);
	const expanded = plain(component.render(240).join("\n"));
	assert.match(expanded, /line one/);
	assert.match(expanded, /line two/);
	component.setExpanded(false);
	assert.doesNotMatch(plain(component.render(240).join("\n")), /line one/);
});
