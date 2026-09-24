import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { access, digest } from "./access.ts";
import { type Catalog, loadCatalog } from "./catalog.ts";
import { createReader, validateResponse } from "./readback.ts";

const sourceCases: [string, unknown, RegExp][] = [
	["non-object", null, /input:.*null.*JSON object/],
	["array", [], /input:.*array.*JSON object/],
	["extra field", { extra: "private" }, /input:.*unsupported field.*resource.*offset.*referenceBodyDigest/],
	["resource type", { resource: 7 }, /resource:.*7.*identifier/],
	["null resource", { resource: null }, /resource:.*null.*identifier/],
	["resource pattern", { resource: "../private\u001b" }, /resource:.*string.*identifier/],
	["resource length", { resource: "x".repeat(65) }, /resource:.*65.*identifier/],
	["unknown resource", { resource: "unknown" }, /resource:.*unknown identifier.*inventory/],
	["offset type", { offset: "one" }, /offset:.*string.*integer.*1048576/],
	["null offset", { offset: null }, /offset:.*null.*integer/],
	["offset fraction", { offset: 0.5 }, /offset:.*0.5.*integer/],
	["offset negative", { offset: -1 }, /offset:.*-1.*integer/],
	["offset limit", { offset: 1048577 }, /offset:.*1048577.*1048576/],
	["digest type", { referenceBodyDigest: 7 }, /referenceBodyDigest:.*7.*64 lowercase/],
	["digest pattern", { referenceBodyDigest: "private" }, /referenceBodyDigest:.*string.*64 lowercase/],
	["continuation digest absent", { offset: 1 }, /referenceBodyDigest:.*missing.*nextOffset.*referenceBodyDigest/],
];
for (const [name, input, pattern] of sourceCases) {
	test(`source diagnostic: ${name}`, async () => {
		const result = await access(await loadCatalog(), input);
		assert.equal(result.schema, "pillars-source-error");
		assert.equal("code" in result && result.code, "invalid_input");
		const message = "message" in result ? String(result.message) : "";
		assert.match(message, pattern);
		assert.ok(message.length <= 1024);
		assert.doesNotMatch(message, /private|\u001b/);
	});
}
for (const resource of ["heuristic-verification-reach", "heuristic-metric-reification"]) {
	test(`source filename correction: ${resource}`, async () => {
		const catalog = await loadCatalog();
		const result = await access(catalog, { resource: `${resource}.md` });
		assert.equal(result.schema, "pillars-source-error");
		const message = "message" in result ? String(result.message) : "";
		assert.ok(message.includes(`received "${resource}.md"`));
		assert.ok(message.includes(`{"resource":"${resource}"}`));
		assert.match(message, /inventory/);
		assert.equal((await access(catalog, { resource })).schema, "pillars-source");
	});
}
test("resource suggestions are unique, bounded, and never accept an alias", async () => {
	const catalog: Catalog = { resources: [{ resourceId: "principle-example", resourceClass: "entry", path: "unused" }] };
	for (const resource of ["principle-exampl", "principle-exammple", "principle-exampla", "principle-example.md"]) {
		const result = await access(catalog, { resource });
		assert.equal("code" in result && result.code, "invalid_input");
		assert.ok("message" in result && result.message?.includes('{"resource":"principle-example"}'));
	}
	const ambiguous: Catalog = { resources: [...catalog.resources, { resourceId: "principle-exampla", resourceClass: "entry", path: "unused" }] };
	const result = await access(ambiguous, { resource: "principle-examplb" });
	assert.ok("message" in result && result.message?.includes("inventory"));
	assert.ok("message" in result && !result.message?.includes('Send {"resource":'));
	for (const resource of ["x".repeat(100_000), "\u001b[31m\u202e/private/path", { password: "private" }]) {
		const error = await access(catalog, { resource });
		assert.ok("message" in error && error.message && error.message.length <= 1024);
		assert.doesNotMatch(JSON.stringify(error), /private|\\u001b|\\u202e/);
	}
});

test("source offset diagnostics distinguish end-of-body and UTF-8 boundaries", async () => {
	const root = await mkdtemp(join(process.cwd(), ".pillars-input-test-"));
	try {
		const path = join(root, "source.md");
		const body = Buffer.from("😀end");
		await writeFile(path, body);
		const catalog: Catalog = { resources: [{ resourceId: "inventory", resourceClass: "inventory", path }] };
		const changed = await access(catalog, { offset: 1, referenceBodyDigest: "0".repeat(64) });
		assert.match("message" in changed ? String(changed.message) : "", /referenceBodyDigest:.*received.*changed.*omit offset and referenceBodyDigest/);
		for (const [offset, pattern] of [[8, /beyond.*7 bytes/], [1, /inside a UTF-8 character/]] as const) {
			const result = await access(catalog, { offset, referenceBodyDigest: digest(body) });
			const message = "message" in result ? String(result.message) : "";
			assert.match(message, pattern);
			assert.match(message, /offset:.*received.*nextOffset/);
			assert.match(message, /omit offset and referenceBodyDigest/);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

const usageCases: [string, unknown, RegExp][] = [
	["non-object", null, /input:.*null.*JSON object/],
	["array", [], /input:.*array.*JSON object/],
	["extra field", { resourceId: "private" }, /input:.*unsupported field.*view.*windowDays.*cursor/],
	["view", { view: "query" }, /view:.*string.*overview.*revisions/],
	["undefined view", { view: undefined }, /view:.*undefined.*overview.*revisions/],
	["days type", { windowDays: "7" }, /windowDays:.*string.*integer.*1.*30/],
	["days low", { windowDays: 0 }, /windowDays:.*0.*integer.*1.*30/],
	["days high", { windowDays: 31 }, /windowDays:.*31.*integer.*1.*30/],
	["days fraction", { windowDays: 1.5 }, /windowDays:.*1.5.*integer/],
	["cursor type", { cursor: 7 }, /cursor:.*7.*nextCursor/],
	["cursor short", { cursor: "a" }, /cursor:.*string.*4.*256.*nextCursor/],
	["cursor long", { cursor: "a".repeat(257) }, /cursor:.*257.*nextCursor/],
	["cursor pattern", { cursor: "\u001bprivate" }, /cursor:.*string.*nextCursor/],
	["cursor with view", { cursor: "abcd", view: "overview" }, /cursor:.*view.*cursor alone/],
	["cursor with days", { cursor: "abcd", windowDays: 1 }, /cursor:.*windowDays.*cursor alone/],
];
for (const [name, input, pattern] of usageCases) {
	test(`usage diagnostic: ${name}`, async () => {
		let captures = 0;
		const reader = createReader(() => { captures++; return { shards: {} }; });
		const result = await reader.read(input);
		validateResponse(result);
		assert.equal(result.kind, "error");
		if (result.kind !== "error") return;
		assert.equal(result.code, "invalid_input");
		assert.match(result.message, pattern);
		assert.ok(result.message.length <= 1024);
		assert.doesNotMatch(result.message, /private|\u001b/);
		assert.equal(captures, 0);
		assert.equal((await reader.read({})).kind, "page");
	});
}
test("invalid cursor encoding and absent capture identify recovery", async () => {
	const reader = createReader(() => ({ shards: {} }));
	for (const [cursor, pattern] of [["abcd", /encoding/], [Buffer.from(`${"a".repeat(22)}:0`).toString("base64url"), /capture/]] as const) {
		const result = await reader.read({ cursor });
		validateResponse(result);
		assert.equal(result.kind, "error");
		if (result.kind !== "error") return;
		assert.equal(result.code, "cursor_invalid");
		assert.match(result.message, pattern);
		assert.match(result.message, /cursor:.*received.*nextCursor.*\{\}/);
	}
});
