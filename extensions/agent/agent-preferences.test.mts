import { validPresets, validPreferences } from "./preference-schema.ts";
import { machineConfig } from "./settings-fixture.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

const preferenceOverride = process.env.PI_HARNESS_FILE;
delete process.env.PI_HARNESS_FILE;
after(() => { if (preferenceOverride !== undefined) process.env.PI_HARNESS_FILE = preferenceOverride; });
import type { Api, Model } from "@earendil-works/pi-ai";
import { readAgentPreferences, resolveExecutionPreset, effectiveExecutionSelection, renderAgentPreferences, parseExecutionSelection, parsePreferenceSnapshot } from "./agent-preferences.ts";

const catalogModel = { provider: "acme", id: "model-x", name: "Test", api: "openai-completions", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as Model<Api>;
const catalog = { getModel: (provider: string, model: string) => provider === "acme" && model === "model-x" ? catalogModel : undefined, getModels: () => [catalogModel] };
const document = () => ({ version: 1, presets: { review: { model: "acme/model-x", thinkingLevel: "high", role: "Review sources", checkInMinutes: 2, notes: "Prefer source evidence" } }, preferences: { excludedModels: ["acme/model-x"], excludedProviders: ["other"], contextBudgetTokens: { "acme/model-x": 2000 }, quotaSubstitutionOrder: ["review", "absent"], reportingNotes: "State catalog limits" } });
function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "agent-preferences-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

it("validates closed structured presets and delegation preferences", () => {
 assert.equal(validPresets(document().presets), true);
 assert.equal(validPreferences(document().preferences), true);
 for (const value of [[], { review: { model: "acme/model-x", cwd: "." } }, { Review: { model: "acme/model-x" } }, { ["a".repeat(65)]: { model: "acme/model-x" } }, { review: { model: "not-exact" } }, { review: { model: "acme/model-x", thinkingLevel: "unbounded" } }, { review: { model: "acme/model-x", checkInMinutes: "2" } }, { review: { model: "acme/model-x", notes: "\ud800" } }]) assert.equal(validPresets(value), false);
 for (const value of [{ extra: true }, { excludedModels: ["model-x"] }, { contextBudgetTokens: { "acme/model-x": 0 } }, { contextBudgetTokens: { "acme/model-x": 1.5 } }, { excludedProviders: "acme" }]) assert.equal(validPreferences(value), false);
});

it("enforces numeric, collection, and character bounds in structured fields", () => {
 for (const field of ["role", "notes"] as const) {
  assert.equal(validPresets({ review: { model: "acme/model-x", [field]: "x".repeat(2000) } }), true);
  assert.equal(validPresets({ review: { model: "acme/model-x", [field]: "x".repeat(2001) } }), false);
 }
 for (const minutes of [-1, 35792]) assert.equal(validPresets({ review: { model: "acme/model-x", checkInMinutes: minutes } }), false);
 for (const minutes of [0, 0.5, 35791]) assert.equal(validPresets({ review: { model: "acme/model-x", checkInMinutes: minutes } }), true);
 assert.equal(validPresets(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { model: "acme/model-x" }]))), false);
 for (const key of ["excludedModels", "excludedProviders", "quotaSubstitutionOrder"] as const) assert.equal(validPreferences({ [key]: Array.from({ length: 65 }, (_, i) => key === "excludedModels" ? `acme/m${i}` : `p${i}`) }), false);
 assert.equal(validPreferences({ contextBudgetTokens: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`acme/m${i}`, 1])) }), false);
 assert.equal(validPreferences({ reportingNotes: "x".repeat(4001) }), false);
});

it("reads fresh snapshots, preserves digests and resolution, and treats exclusions as facts", (t) => {
	const root = fixture(t);
	const path = join(root, "harness.json");
	const text = JSON.stringify(machineConfig(document()));
	writeFileSync(path, text);
	const snapshot = readAgentPreferences(root, catalog);
	assert.equal(snapshot.source.digest, createHash("sha256").update(text).digest("hex"));
	assert.ok(snapshot.diagnostics.some((fact) => /exclusion/u.test(fact.message)));
	assert.ok(snapshot.diagnostics.some((fact) => /capacity/u.test(fact.message)));
	assert.ok(snapshot.diagnostics.some((fact) => /Unknown preset/u.test(fact.message)));
	assert.ok(snapshot.diagnostics.some((fact) => /Unknown provider/u.test(fact.message)));
	const selection = resolveExecutionPreset(snapshot, { preset: "review", thinkingLevel: "low", checkInMinutes: 0 }, { model: "other/model-y", thinkingLevel: "off" }, { creation: true, role: true, checkIn: true });
	assert.deepEqual(selection.values, { model: "acme/model-x", thinkingLevel: "low", role: "Review sources", checkInMinutes: 0 });
	assert.deepEqual(selection.origins, { model: "preset", thinkingLevel: "explicit", role: "preset", checkInMinutes: "explicit" });
	assert.deepEqual(parseExecutionSelection(selection), selection);
	assert.deepEqual(parsePreferenceSnapshot(snapshot), snapshot);
	writeFileSync(path, JSON.stringify(machineConfig({ presets: { review: { model: "other/model-y" } } })));
	assert.equal(resolveExecutionPreset(snapshot, { preset: "review" }, {}).values.model, "acme/model-x");
	assert.notEqual(readAgentPreferences(root, catalog).source.digest, selection.source.digest);
	assert.deepEqual(effectiveExecutionSelection(selection, "off").thinking, { requested: "low", effective: "off" });
});

it("renders identical guidance for unchanged facts regardless of observation time", (t) => {
	const root = fixture(t);
	for (const content of [undefined, JSON.stringify(machineConfig(document())), "malformed"]) {
		if (content !== undefined) writeFileSync(join(root, "harness.json"), content);
		const first = readAgentPreferences(root, catalog);
		const next = readAgentPreferences(root, catalog);
		first.source.observedAt = "2026-01-01T00:00:00.000Z";
		next.source.observedAt = "2026-01-02T00:00:00.000Z";
		assert.equal(renderAgentPreferences(first), renderAgentPreferences(next));
		assert.doesNotMatch(renderAgentPreferences(next), /2026-01-02/u);
	}
});

it("preserves retained targets and reports unsupported preset fields", (t) => {
	const root = fixture(t); writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig(document())));
	const snapshot = readAgentPreferences(root, catalog);
	const configure = resolveExecutionPreset(snapshot, { preset: "review", model: "acme/override" }, { model: "acme/retained", thinkingLevel: "off" });
	assert.equal(configure.values.model, "acme/override");
	assert.deepEqual(configure.unapplied, ["role", "checkInMinutes"]);
	const reused = resolveExecutionPreset(snapshot, { preset: "review" }, { model: "acme/retained", thinkingLevel: "off" }, { reused: true, checkIn: true });
	assert.equal(reused.values.model, "acme/retained");
	assert.equal(reused.values.checkInMinutes, 2);
	assert.deepEqual(reused.unapplied, ["model", "thinkingLevel", "role"]);
	assert.throws(() => resolveExecutionPreset(snapshot, {}, { model: "acme/retained", thinkingLevel: "high" }, { creation: true }), /defaultPreset.*harness.json/u);
});

it("missing and malformed files never replace explicit selections with inheritance", (t) => {
	const root = fixture(t);
	const path = join(root, "harness.json");
	const absent = readAgentPreferences(root, catalog);
	assert.equal(absent.source.status, "missing");
	assert.throws(() => resolveExecutionPreset(absent, {}, { model: "acme/model-x" }, { creation: true }), /defaultPreset.*harness.json/u);
	assert.equal(resolveExecutionPreset(absent, { model: "acme/model-x" }, {}, { creation: true }).values.model, "acme/model-x");
	assert.throws(() => resolveExecutionPreset(absent, { preset: "review" }, {}), /review.*file is missing/u);
	writeFileSync(path, "not json");
	const malformed = readAgentPreferences(root, catalog);
	assert.equal(malformed.source.status, "invalid");
	assert.throws(() => resolveExecutionPreset(malformed, {}, { model: "acme/model-x" }, { creation: true }), /defaultPreset.*harness.json/u);
	assert.equal(resolveExecutionPreset(malformed, { model: "acme/model-x" }, {}, { creation: true }).values.model, "acme/model-x");
	assert.throws(() => resolveExecutionPreset(malformed, { preset: "review" }, {}), /review.*harness.json/u);
	assert.match(renderAgentPreferences(malformed), /Machine document is invalid/u);
	assert.match(renderAgentPreferences(malformed), /Previous preference text is not current/u);
	rmSync(path); mkdirSync(path);
	assert.equal(readAgentPreferences(root, catalog).source.status, "unavailable");
});

it("keeps valid presets usable when catalog observations fail and rejects inconsistent snapshots", (t) => {
	const root = fixture(t); writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig(document())));
	const snapshot = readAgentPreferences(root, { getModel: () => { throw new Error("catalog unavailable"); } });
	assert.equal(snapshot.source.status, "loaded");
	assert.match(snapshot.diagnostics[0].message, /catalog checks are unavailable/u);
	assert.equal(resolveExecutionPreset(snapshot, { preset: "review" }, {}).values.model, "acme/model-x");
	assert.throws(() => parsePreferenceSnapshot({ ...snapshot, document: undefined }), /no effective settings/u);
	assert.equal(validPreferences({ contextBudgetTokens: { [`acme/${"x".repeat(512)}`]: 1 } }), false);
});

it("uses the explicit machine file override without cwd discovery", (t) => {
	const root = fixture(t);
	process.env.PI_HARNESS_FILE = "selected.json";
	t.after(() => { delete process.env.PI_HARNESS_FILE; });
	assert.equal(readAgentPreferences(root, catalog).source.path, join(root, "selected.json"));
	writeFileSync(join(root, "selected.json"), JSON.stringify(machineConfig(document())));
	assert.equal(readAgentPreferences(root, catalog).source.status, "loaded");
	process.env.PI_HARNESS_FILE = join(root, "absolute.json");
	assert.equal(readAgentPreferences(root, catalog).source.path, join(root, "absolute.json"));
});

it("independent machine roots resolve separate documents with the same preset name", (t) => {
	const first = fixture(t); const second = fixture(t);
	writeFileSync(join(first, "harness.json"), JSON.stringify(machineConfig({ presets: { review: { model: "acme/model-x" } } })));
	writeFileSync(join(second, "harness.json"), JSON.stringify(machineConfig({ presets: { review: { model: "other/model-y" } } })));
	const left = readAgentPreferences(first, catalog); const right = readAgentPreferences(second, catalog);
	assert.equal(resolveExecutionPreset(left, { preset: "review" }, {}).values.model, "acme/model-x");
	assert.equal(resolveExecutionPreset(right, { preset: "review" }, {}).values.model, "other/model-y");
	assert.notEqual(left.source.path, right.source.path); assert.notEqual(left.source.digest, right.source.digest);
	writeFileSync(join(first, "harness.json"), "malformed");
	assert.equal(readAgentPreferences(first, catalog).source.status, "invalid");
	assert.deepEqual(readAgentPreferences(second, catalog).document, right.document);
	assert.equal(readAgentPreferences(second, catalog).source.digest, right.source.digest);
});

it("guidance includes current preferences and bounded omitted coverage", (t) => {
	const root = fixture(t); writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig(document())));
	const snapshot = readAgentPreferences(root, catalog);
	const text = renderAgentPreferences(snapshot);
	for (const expected of [/Excluded model/u, /Planning context budget/u, /Quota substitution order/u, /Reporting notes/u, /Preset "review"/u, /Diagnostic/u]) assert.match(text, expected);
	const large = { version: 1, presets: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, { model: "acme/model-x", notes: "x".repeat(2000) }])) };
	writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig(large)));
	const bounded = renderAgentPreferences(readAgentPreferences(root, catalog));
	assert.ok(bounded.length < 12500); assert.match(bounded, /Omitted \d+ lines/u);
});

it("creation resolves the machine default only without a model or preset and never imports parent fields", (t) => {
	const root = fixture(t);
	writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: "acme/model-x", thinkingLevel: "high", role: "Review", checkInMinutes: 2 }, spare: { model: "other/model-y" } }, preferences: { defaultPreset: "standard" } })));
	const snapshot = readAgentPreferences(root, catalog);
	const parent = { model: "parent/model-z", thinkingLevel: "max", role: "Parent role", checkInMinutes: 9 };
	const options = { creation: true, role: true, checkIn: true };
	const selection = resolveExecutionPreset(snapshot, {}, parent, options);
	assert.deepEqual(selection.values, snapshot.document?.presets.standard);
	assert.deepEqual(selection.origins, { model: "defaultPreset", thinkingLevel: "defaultPreset", role: "defaultPreset", checkInMinutes: "defaultPreset" });
	assert.deepEqual(selection.presetNames, ["spare", "standard"]);
	assert.equal(selection.source.digest, snapshot.source.digest);
	assert.deepEqual(parseExecutionSelection(selection), selection);
	assert.equal(resolveExecutionPreset(snapshot, { thinkingLevel: "low", checkInMinutes: 0, role: "Explicit" }, parent, options).values.model, "acme/model-x");
	const explicit = resolveExecutionPreset(snapshot, { model: "other/model-y" }, parent, options);
	assert.equal(explicit.preset, undefined);
	assert.deepEqual(explicit.values, { model: "other/model-y", thinkingLevel: "off" });
	assert.equal(explicit.origins.model, "explicit");
	const spare = resolveExecutionPreset(snapshot, { preset: "spare" }, parent, options);
	assert.deepEqual(spare.values, { model: "other/model-y", thinkingLevel: "off" });
	assert.equal(spare.origins.thinkingLevel, "default");
	const mixed = resolveExecutionPreset(snapshot, { preset: "standard", model: "other/model-y" }, parent, options);
	assert.equal(mixed.values.thinkingLevel, "high");
	assert.equal(mixed.origins.model, "explicit");
	assert.equal(mixed.origins.thinkingLevel, "preset");
	assert.deepEqual(resolveExecutionPreset(snapshot, {}, parent).values, { model: parent.model, thinkingLevel: parent.thinkingLevel });
	assert.equal(resolveExecutionPreset(snapshot, {}, parent).preset, undefined);
	assert.equal(resolveExecutionPreset(snapshot, {}, parent, { reused: true }).preset, undefined);
});

it("explicit model overrides remain observable and only opted-in creation enforces the roster", (t) => {
	const root = fixture(t);
	const write = (enforceRoster: boolean) => writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: "acme/model-x" }, excluded: { model: "other/model-y" } }, preferences: { defaultPreset: "standard", enforceRoster, excludedModels: ["other/model-y"], excludedProviders: ["blocked"] } })));
	write(false);
	const advisory = readAgentPreferences(root, catalog);
	for (const model of ["outside/model-z", "other/model-y", "blocked/model-x", "acme/model-x"]) {
		const selection = resolveExecutionPreset(advisory, { model }, {}, { creation: true });
		assert.equal(selection.origins.model, "explicit");
		assert.match(selection.diagnostics[0].message, /Explicit model override/u);
		if (model === "outside/model-z") assert.match(selection.diagnostics[0].message, /matches no preset/u);
		if (model === "other/model-y" || model === "blocked/model-x") assert.ok(selection.diagnostics.some((fact) => /advisory only/u.test(fact.message)));
	}
	write(true);
	const enforced = readAgentPreferences(root, catalog);
	for (const input of [{ model: "outside/model-z" }, { model: "other/model-y" }, { model: "blocked/model-x" }, { preset: "excluded" }]) {
		assert.throws(() => resolveExecutionPreset(enforced, input, {}, { creation: true }), (error: unknown) => {
			assert.match(String(error), /enforceRoster/u);
			assert.match(String(error), /Presets: \["excluded","standard"\]/u);
			assert.ok(String(error).includes(enforced.source.digest ?? "missing digest"));
			return true;
		});
	}
	assert.equal(resolveExecutionPreset(enforced, {}, {}, { creation: true }).values.model, "acme/model-x");
	assert.equal(resolveExecutionPreset(enforced, { model: "outside/model-z" }, {}).values.model, "outside/model-z", "configure remains a target override, not a creation gate");
	const retained = resolveExecutionPreset(enforced, { model: "outside/model-z", preset: "excluded" }, { model: "outside/retained", thinkingLevel: "low" }, { reused: true });
	assert.equal(retained.values.model, "outside/retained");
	assert.ok(retained.unapplied.includes("model"));
});

it("preset errors always list the file, all names, and the current digest", (t) => {
	const root = fixture(t);
	for (const content of [undefined, "malformed", JSON.stringify(machineConfig({ presets: { standard: { model: "acme/model-x" } }, preferences: { defaultPreset: "absent" } }))]) {
		if (content !== undefined) writeFileSync(join(root, "harness.json"), content);
		const snapshot = readAgentPreferences(root, catalog);
		for (const input of [{ preset: "absent" }, { preset: "INVALID" }, {}]) {
			assert.throws(() => resolveExecutionPreset(snapshot, input, {}, { creation: true }), (error: unknown) => {
				const message = String(error);
				assert.ok(message.includes(snapshot.source.path));
				assert.ok(message.includes(`digest ${snapshot.source.digest ?? "none"}`));
				assert.ok(message.includes(snapshot.source.status === "loaded" ? '["standard"]' : '[]'));
				return true;
			});
		}
	}
	for (const preferences of [{ defaultPreset: "INVALID" }, { enforceRoster: "true" }, { defaultPreset: 1 }]) assert.equal(validPreferences(preferences), false);
});
