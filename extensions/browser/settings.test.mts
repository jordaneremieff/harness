/**
 * Slice-local settings semantics for the browser access map: the structured
 * validator and the environment-over-document selection with its diagnostics.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { readSettings, settings, validAccess } from "./settings.ts";

function fixture(t: TestContext) {
	const agentDir = mkdtempSync(join(tmpdir(), "browser-settings-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	return {
		agentDir,
		write: (value: unknown) => writeFileSync(join(agentDir, "harness.json"), JSON.stringify(value)),
	};
}

describe("browser settings", () => {
	it("the owner and declared schema accept only known browser keys with known access levels", () => {
		const schema = compile(settings.fields.access.schema);
		for (const value of [{}, { chrome: "inspect", brave: "interact", "chrome-for-testing": "interact" }]) {
			assert.equal(validAccess(value), true);
			assert.equal(schema.check(value), true);
		}
		for (const bad of [{ firefox: "inspect" }, { chrome: "read" }, { chrome: true }, ["chrome"], null, "chrome", 42]) {
			assert.equal(validAccess(bad), false, JSON.stringify(bad));
			assert.equal(schema.check(bad), false, JSON.stringify(bad));
		}
	});

	it("uses the document access map", (t) => {
		const f = fixture(t);
		f.write({ version: 1, browser: { access: { brave: "interact" } } });
		const snapshot = readSettings({ agentDir: f.agentDir, env: {} });
		assert.deepEqual(snapshot.values.access, { brave: "interact" });
		assert.equal(snapshot.source.status, "loaded");
		assert.equal(snapshot.records[0]?.name, "browser.access");
		assert.equal(snapshot.records[0]?.origin, "file");
		assert.equal(snapshot.records[0]?.status, "valid");
		assert.deepEqual(snapshot.diagnostics, []);
	});

	it("defaults to an empty access map without a document", (t) => {
		const f = fixture(t);
		const snapshot = readSettings({ agentDir: f.agentDir, env: {} });
		assert.deepEqual(snapshot.values.access, {});
		assert.equal(snapshot.records[0]?.origin, "default");
		assert.equal(snapshot.source.status, "missing");
	});

	it("selects the environment above the document", (t) => {
		const f = fixture(t);
		f.write({ version: 1, browser: { access: { brave: "interact" } } });
		const snapshot = readSettings({
			agentDir: f.agentDir,
			env: { PI_BROWSER_ACCESS: '{"chrome":"inspect"}' },
		});
		assert.deepEqual(snapshot.values.access, { chrome: "inspect" });
		assert.equal(snapshot.records[0]?.origin, "env");
		assert.equal(snapshot.records[0]?.status, "valid");
		assert.deepEqual(snapshot.diagnostics, []);
	});

	it("returns the default with an invalid diagnostic for rejected environment input", (t) => {
		const f = fixture(t);
		f.write({ version: 1, browser: { access: { brave: "interact" } } });
		for (const raw of [
			"not json",
			"[]",
			"null",
			'{"firefox":"inspect"}',
			'{"chrome":"read"}',
			'{"chrome":["inspect"]}',
		]) {
			const snapshot = readSettings({ agentDir: f.agentDir, env: { PI_BROWSER_ACCESS: raw } });
			assert.deepEqual(snapshot.values.access, {}, raw);
			assert.equal(snapshot.records[0]?.origin, "default", raw);
			assert.equal(snapshot.records[0]?.status, "invalid", raw);
			assert.deepEqual(
				snapshot.diagnostics.map(({ field, source, code }) => ({ field, source, code })),
				[{ field: "browser.access", source: "env", code: "invalid" }],
				raw,
			);
		}
	});

	it("reports an unknown key in the browser section", (t) => {
		const f = fixture(t);
		f.write({ version: 1, browser: { access: { chrome: "inspect" }, other: true } });
		const snapshot = readSettings({ agentDir: f.agentDir, env: {} });
		assert.deepEqual(snapshot.values.access, { chrome: "inspect" });
		assert.deepEqual(
			snapshot.diagnostics.map(({ field, source, code }) => ({ field, source, code })),
			[{ field: "browser.other", source: "file", code: "unknown" }],
		);
	});
});
