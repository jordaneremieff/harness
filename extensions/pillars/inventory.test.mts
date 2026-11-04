import assert from "node:assert/strict";
import test from "node:test";
import type { AccessPage } from "./access.ts";
import { browserEntries, type SourceReader } from "./inventory.ts";

const digest = "a".repeat(64);

test("inventory rows quote the source index statements with canonical titles and types", async () => {
	const catalog = {
		resources: [
			{ resourceClass: "inventory" as const, resourceId: "inventory", path: "README.md" },
			{ resourceClass: "governance" as const, resourceId: "governance", path: "GOVERNANCE.md" },
			{ resourceClass: "entry" as const, resourceId: "pattern-frame-inspection", path: "pattern.md" },
		],
	};
	const pages: AccessPage[] = [
		{ schema: "pillars-source", resource: "inventory", referenceBodyDigest: digest, bodyBytes: 200, offset: 0, endOffset: 40, nextOffset: 40, text: "### Patterns\n\n| Pattern | Structure |\n|---|---|\n" },
		{ schema: "pillars-source", resource: "inventory", referenceBodyDigest: digest, bodyBytes: 200, offset: 40, endOffset: 200, text: "| [Frame Inspection](pattern-frame-inspection.md) | At an option set, name the frame. |\n" },
	];
	const requests: unknown[] = [];
	const read: SourceReader = async (request) => {
		requests.push(request);
		const next = pages.shift();
		assert.ok(next);
		return next;
	};
	assert.deepEqual(await browserEntries(catalog, read), [
		{ resource: "inventory", title: "Pillars", type: "inventory", index: "" },
		{ resource: "governance", title: "Pillars Governance", type: "governance", index: "" },
		{ resource: "pattern-frame-inspection", title: "Frame Inspection", type: "pattern", index: "At an option set, name the frame." },
	]);
	assert.deepEqual(requests, [{ resource: "inventory" }, { resource: "inventory", offset: 40, referenceBodyDigest: digest }], "every page of the inventory binds the first page's digest");
});
