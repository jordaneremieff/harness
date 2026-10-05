import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardPreferences, validDashboardLayout } from "./dashboard-preferences.ts";
import { dashboardSessionState } from "./dashboard-state.ts";

it("only finite current layout fields are accepted; missing and corrupt files use auto", () => {
	assert.deepEqual(validDashboardLayout({ rosterRatio: Infinity, composerRows: 4 }), {});
	for (const value of [null, [], "text", { rosterRatio: 0 }, { rosterRatio: 1 }, { composerRows: NaN }, { composerRows: 5.5 }, { composerRows: Number.MAX_VALUE }]) assert.deepEqual(validDashboardLayout(value), {});
	assert.deepEqual(validDashboardLayout({ rosterRatio: 0.4, composerRows: 7, draft: "private", screen: "console" }), { rosterRatio: 0.4, composerRows: 7 });
	const dir = mkdtempSync(join(tmpdir(), "dashboard-layout-"));
	try {
		const store = dashboardPreferences(dir); const file = join(dir, "agent-dashboard-layout.json");
		assert.deepEqual(store.load(), {});
		for (const text of ["invalid json", "null", "[]", " ".repeat(4097)]) { writeFileSync(file, text); assert.deepEqual(store.load(), {}); }
		writeFileSync(file, '{"rosterRatio":0.4,"composerRows":-2}'); assert.deepEqual(store.load(), { rosterRatio: 0.4 });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
it("atomic private layout publication survives a restart and isolates open primaries", () => {
	const dir = mkdtempSync(join(tmpdir(), "dashboard-layout-"));
	try {
		const store = dashboardPreferences(dir); let loads = 0;
		store.save({ rosterRatio: 0.4, composerRows: 7 });
		const a = dashboardSessionState(`${dir}:a`, () => { loads++; return store.load(); });
		store.save({ rosterRatio: 0.6, composerRows: 9 });
		assert.equal(dashboardSessionState(`${dir}:a`, () => { loads++; return store.load(); }), a);
		assert.equal(loads, 1); assert.deepEqual(a.layout, { rosterRatio: 0.4, composerRows: 7 });
		const b = dashboardSessionState(`${dir}:b`, () => dashboardPreferences(dir).load());
		assert.deepEqual(b.layout, { rosterRatio: 0.6, composerRows: 9 });
		b.layout.composerRows = 12; assert.equal(a.layout.composerRows, 7);
		const file = join(dir, "agent-dashboard-layout.json");
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { rosterRatio: 0.6, composerRows: 9 });
		assert.deepEqual(readdirSync(dir), ["agent-dashboard-layout.json"]);
		store.save({}); assert.deepEqual(dashboardPreferences(dir).load(), {});
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
it("failed atomic rename removes the unpublished file", () => {
	const dir = mkdtempSync(join(tmpdir(), "dashboard-layout-"));
	try {
		mkdirSync(join(dir, "agent-dashboard-layout.json"));
		assert.throws(() => dashboardPreferences(dir).save({ composerRows: 8 }));
		assert.deepEqual(readdirSync(dir), ["agent-dashboard-layout.json"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
