import assert from "node:assert/strict";
import { test } from "node:test";
import { boundOutput } from "@earendil-works/chord/output";
import * as Durable from "@earendil-works/pi-durable";
import { googleContribution } from "./durable.ts";
import { createFake } from "./fake-gws.test-support.mts";
import { RESULT_MAX_BYTES, toolResult } from "./result.ts";
import { sheetsTools } from "./sheets.ts";
import { invoke } from "./tools.ts";

const nativeLimits = { maxBytes: RESULT_MAX_BYTES, maxLines: 2000, retain: "head" } as const;

test("a full 50 by 40 sheets page stays valid JSON inside the native output bound", async () => {
	const rows = Array.from({ length: 50 }, (_, row) => Array.from({ length: 40 }, (_, column) => `r${row}c${column}`));
	const fake = await createFake({
		responses: { "sheets spreadsheets values get": { stdout: { range: "A1:AN50", values: rows } } },
	});
	try {
		const tool = sheetsTools.find((item) => item.name === "sheets_values_get");
		assert.ok(tool);
		const result = await invoke(tool, { spreadsheetId: "s1", range: "A1:AN50" }, fake.runtime);
		const [item] = result.content;
		assert.equal(item.type, "text");
		const text = (item as { text: string }).text;
		assert.ok(!text.includes("\n"), "the envelope must be one line so the line bound cannot split it");
		const bounded = boundOutput(text, nativeLimits);
		assert.equal(bounded.droppedBytes, 0, `the consumer bound dropped ${bounded.droppedBytes} bytes`);
		const envelope = JSON.parse(bounded.text) as { status: string; data: { externalData: { values: string[][] } } };
		assert.equal(envelope.status, "ok");
		assert.equal(envelope.data.externalData.values.length, 50);
		assert.ok(envelope.data.externalData.values.every((row) => row.length === 40));
	} finally {
		await fake.cleanup();
	}
});

test("the native contribution declares the envelope bound as every tool's output limit", () => {
	const bus = { emit: () => {}, on: () => () => {} };
	const contribution = googleContribution("file:///google/durable.ts", bus, () => {});
	const extension = contribution.create({ durable: Durable, agentDir: "/nonexistent", onClose: () => {} });
	assert.ok((extension.tools ?? []).length > 0);
	for (const tool of extension.tools ?? []) {
		assert.deepEqual(tool.outputLimits, { ...nativeLimits }, `tool ${tool.name} declares the envelope bound`);
	}
});

test("an envelope over the byte bound reports one outcome", () => {
	const large = toolResult({
		schemaVersion: 1,
		status: "ok",
		data: { value: "x".repeat(RESULT_MAX_BYTES) },
	});
	const [item] = large.content;
	assert.equal(item.type, "text");
	const envelope = JSON.parse((item as { text: string }).text) as {
		status: string;
		error?: { code: string; retryable: boolean };
	};
	assert.equal(envelope.status, "error");
	assert.equal(envelope.error?.code, "RESULT_TOO_LARGE");
	assert.equal(envelope.error?.retryable, true);
	assert.deepEqual(large.details, { schemaVersion: 1, status: "error" });
	assert.equal(large.isError, true);
});
