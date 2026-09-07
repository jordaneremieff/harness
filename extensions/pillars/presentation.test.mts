import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { emptyShard, zero } from "./capacity.ts";
import { createReader, errorResponse } from "./readback.ts";
import { usageMarkdown } from "./presentation.ts";

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
