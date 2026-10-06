import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

const preferenceOverride = process.env.PI_AGENT_PREFERENCES_FILE;
delete process.env.PI_AGENT_PREFERENCES_FILE;
after(() => { if (preferenceOverride !== undefined) process.env.PI_AGENT_PREFERENCES_FILE = preferenceOverride; });
import type { Api, Model } from "@earendil-works/pi-ai";
import { agentPreferencesPath, parseAgentPreferences, readAgentPreferences, resolveExecutionPreset, effectiveExecutionSelection, renderAgentPreferences, parseExecutionSelection, parsePreferenceSnapshot, PREFERENCES_MAX_BYTES } from "./agent-preferences.ts";

const catalogModel = { provider: "acme", id: "model-x", name: "Test", api: "openai-completions", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as Model<Api>;
const catalog = { getModel: (provider: string, model: string) => provider === "acme" && model === "model-x" ? catalogModel : undefined, getModels: () => [catalogModel] };
const document = () => ({ version: 1, presets: { review: { model: "acme/model-x", thinkingLevel: "high", role: "Review sources", checkInMinutes: 2, notes: "Prefer source evidence" } }, preferences: { excludedModels: ["acme/model-x"], excludedProviders: ["other"], contextBudgetTokens: { "acme/model-x": 2000 }, quotaSubstitutionOrder: ["review", "absent"], reportingNotes: "State catalog limits" } });
function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "agent-preferences-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

it("parses a closed bounded machine document and rejects structural errors", () => {
	assert.equal(parseAgentPreferences(JSON.stringify(document())).presets.review.model, "acme/model-x");
	for (const value of [
		{ ...document(), extra: true }, { ...document(), version: 2 }, { version: 1 }, { version: 1, presets: [] },
		{ version: 1, presets: { review: { model: "acme/model-x", cwd: "." } } },
		{ version: 1, presets: { Review: { model: "acme/model-x" } } },
		{ version: 1, presets: { ["a".repeat(65)]: { model: "acme/model-x" } } },
		{ version: 1, presets: { review: { model: "not-exact" } } },
		{ version: 1, presets: { review: { model: "acme/model-x", thinkingLevel: "unbounded" } } },
		{ version: 1, presets: { review: { model: "acme/model-x", checkInMinutes: "2" } } },
		{ version: 1, presets: {}, preferences: { extra: true } },
		{ version: 1, presets: {}, preferences: { excludedModels: ["model-x"] } },
		{ version: 1, presets: {}, preferences: { contextBudgetTokens: { "acme/model-x": 0 } } },
		{ version: 1, presets: {}, preferences: { contextBudgetTokens: { "acme/model-x": 1.5 } } },
		{ version: 1, presets: {}, preferences: { excludedProviders: "acme" } },
	]) assert.throws(() => parseAgentPreferences(JSON.stringify(value)), /Invalid|model requires/u);
	assert.throws(() => parseAgentPreferences(new Uint8Array([0xff])), /encoded data/u);
	assert.throws(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: { review: { model: "acme/model-x", notes: "\ud800" } } })), /malformed text/u);
});

it("enforces numeric, collection, character, and UTF-8 byte bounds", () => {
	for (const field of ["role", "notes"] as const) {
		assert.doesNotThrow(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: { review: { model: "acme/model-x", [field]: "x".repeat(2000) } } })));
		assert.throws(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: { review: { model: "acme/model-x", [field]: "x".repeat(2001) } } })));
	}
	for (const minutes of [-1, 35792]) assert.throws(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: { review: { model: "acme/model-x", checkInMinutes: minutes } } })));
	for (const minutes of [0, 0.5, 35791]) assert.doesNotThrow(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: { review: { model: "acme/model-x", checkInMinutes: minutes } } })));
	assert.throws(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { model: "acme/model-x" }])) })));
	for (const key of ["excludedModels", "excludedProviders", "quotaSubstitutionOrder"] as const) assert.throws(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: {}, preferences: { [key]: Array.from({ length: 65 }, (_, i) => key === "excludedModels" ? `acme/m${i}` : `p${i}`) } })));
	assert.throws(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: {}, preferences: { contextBudgetTokens: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`acme/m${i}`, 1])) } })));
	assert.throws(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: {}, preferences: { reportingNotes: "x".repeat(4001) } })));
	assert.throws(() => parseAgentPreferences(" ".repeat(PREFERENCES_MAX_BYTES + 1)), /UTF-8 bytes/u);
	assert.throws(() => parseAgentPreferences("é".repeat(PREFERENCES_MAX_BYTES)), /UTF-8 bytes/u);
});

it("reads fresh snapshots, preserves digests and resolution, and treats exclusions as facts", (t) => {
	const root = fixture(t);
	const path = agentPreferencesPath(root);
	const text = JSON.stringify(document());
	writeFileSync(path, text);
	const snapshot = readAgentPreferences(root, catalog);
	assert.equal(snapshot.source.digest, createHash("sha256").update(text).digest("hex"));
	assert.ok(snapshot.diagnostics.some((fact) => /exclusion/u.test(fact.message)));
	assert.ok(snapshot.diagnostics.some((fact) => /capacity/u.test(fact.message)));
	assert.ok(snapshot.diagnostics.some((fact) => /Unknown preset/u.test(fact.message)));
	assert.ok(snapshot.diagnostics.some((fact) => /Unknown provider/u.test(fact.message)));
	const selection = resolveExecutionPreset(snapshot, { preset: "review", thinkingLevel: "low", checkInMinutes: 0 }, { model: "other/model-y", thinkingLevel: "off" }, { inherited: true, role: true, checkIn: true });
	assert.deepEqual(selection.values, { model: "acme/model-x", thinkingLevel: "low", role: "Review sources", checkInMinutes: 0 });
	assert.deepEqual(selection.origins, { model: "preset", thinkingLevel: "explicit", role: "preset", checkInMinutes: "explicit" });
	assert.deepEqual(parseExecutionSelection(selection), selection);
	assert.deepEqual(parsePreferenceSnapshot(snapshot), snapshot);
	writeFileSync(path, JSON.stringify({ version: 1, presets: { review: { model: "other/model-y" } } }));
	assert.equal(resolveExecutionPreset(snapshot, { preset: "review" }, {}).values.model, "acme/model-x");
	assert.notEqual(readAgentPreferences(root, catalog).source.digest, selection.source.digest);
	assert.deepEqual(effectiveExecutionSelection(selection, "off").thinking, { requested: "low", effective: "off" });
});

it("renders identical guidance for unchanged facts regardless of observation time", (t) => {
	const root = fixture(t);
	for (const content of [undefined, JSON.stringify(document()), "malformed"]) {
		if (content !== undefined) writeFileSync(agentPreferencesPath(root), content);
		const first = readAgentPreferences(root, catalog);
		const next = readAgentPreferences(root, catalog);
		first.source.observedAt = "2026-01-01T00:00:00.000Z";
		next.source.observedAt = "2026-01-02T00:00:00.000Z";
		assert.equal(renderAgentPreferences(first), renderAgentPreferences(next));
		assert.doesNotMatch(renderAgentPreferences(next), /2026-01-02/u);
	}
});

it("preserves retained targets and reports unsupported preset fields", (t) => {
	const root = fixture(t); writeFileSync(agentPreferencesPath(root), JSON.stringify(document()));
	const snapshot = readAgentPreferences(root, catalog);
	const configure = resolveExecutionPreset(snapshot, { preset: "review", model: "acme/override" }, { model: "acme/retained", thinkingLevel: "off" });
	assert.equal(configure.values.model, "acme/override");
	assert.deepEqual(configure.unapplied, ["role", "checkInMinutes"]);
	const reused = resolveExecutionPreset(snapshot, { preset: "review" }, { model: "acme/retained", thinkingLevel: "off" }, { reused: true, checkIn: true });
	assert.equal(reused.values.model, "acme/retained");
	assert.equal(reused.values.checkInMinutes, 2);
	assert.deepEqual(reused.unapplied, ["model", "thinkingLevel", "role"]);
	const inherited = resolveExecutionPreset(snapshot, {}, { model: "acme/retained", thinkingLevel: "off" }, { inherited: true });
	assert.equal(inherited.origins.model, "inherited");
});

it("missing and malformed files never replace explicit selections with inheritance", (t) => {
	const root = fixture(t);
	const path = agentPreferencesPath(root);
	const absent = readAgentPreferences(root, catalog);
	assert.equal(absent.source.status, "missing");
	assert.equal(resolveExecutionPreset(absent, {}, { model: "acme/model-x" }).values.model, "acme/model-x");
	assert.throws(() => resolveExecutionPreset(absent, { preset: "review" }, {}), /review.*file is missing/u);
	writeFileSync(path, "not json");
	const malformed = readAgentPreferences(root, catalog);
	assert.equal(malformed.source.status, "unavailable");
	assert.equal(resolveExecutionPreset(malformed, {}, { model: "acme/model-x" }).values.model, "acme/model-x");
	assert.throws(() => resolveExecutionPreset(malformed, { preset: "review" }, {}), /review.*agent-preferences.json/u);
	assert.match(renderAgentPreferences(malformed), /preferences are unavailable/u);
	assert.match(renderAgentPreferences(malformed), /Previous preference text is not current/u);
	rmSync(path); mkdirSync(path);
	assert.equal(readAgentPreferences(root, catalog).source.status, "unavailable");
});

it("keeps valid presets usable when catalog observations fail and rejects inconsistent snapshots", (t) => {
	const root = fixture(t); writeFileSync(agentPreferencesPath(root), JSON.stringify(document()));
	const snapshot = readAgentPreferences(root, { getModel: () => { throw new Error("catalog unavailable"); } });
	assert.equal(snapshot.source.status, "loaded");
	assert.match(snapshot.diagnostics[0].message, /catalog unavailable/u);
	assert.equal(resolveExecutionPreset(snapshot, { preset: "review" }, {}).values.model, "acme/model-x");
	assert.throws(() => parsePreferenceSnapshot({ ...snapshot, document: undefined }), /status does not match/u);
	assert.throws(() => parseAgentPreferences(JSON.stringify({ version: 1, presets: {}, preferences: { contextBudgetTokens: { [`acme/${"x".repeat(512)}`]: 1 } } })), /model identity/u);
});

it("uses the explicit machine file override without cwd discovery", (t) => {
	const root = fixture(t);
	process.env.PI_AGENT_PREFERENCES_FILE = "selected.json";
	t.after(() => { delete process.env.PI_AGENT_PREFERENCES_FILE; });
	assert.equal(agentPreferencesPath(root), join(root, "selected.json"));
	writeFileSync(join(root, "selected.json"), JSON.stringify(document()));
	assert.equal(readAgentPreferences(root, catalog).source.status, "loaded");
	process.env.PI_AGENT_PREFERENCES_FILE = join(root, "absolute.json");
	assert.equal(agentPreferencesPath("other"), join(root, "absolute.json"));
});

it("independent machine roots resolve separate documents with the same preset name", (t) => {
	const first = fixture(t); const second = fixture(t);
	writeFileSync(agentPreferencesPath(first), JSON.stringify({ version: 1, presets: { review: { model: "acme/model-x" } } }));
	writeFileSync(agentPreferencesPath(second), JSON.stringify({ version: 1, presets: { review: { model: "other/model-y" } } }));
	const left = readAgentPreferences(first, catalog); const right = readAgentPreferences(second, catalog);
	assert.equal(resolveExecutionPreset(left, { preset: "review" }, {}).values.model, "acme/model-x");
	assert.equal(resolveExecutionPreset(right, { preset: "review" }, {}).values.model, "other/model-y");
	assert.notEqual(left.source.path, right.source.path); assert.notEqual(left.source.digest, right.source.digest);
	writeFileSync(agentPreferencesPath(first), "malformed");
	assert.equal(readAgentPreferences(first, catalog).source.status, "unavailable");
	assert.deepEqual(readAgentPreferences(second, catalog).document, right.document);
	assert.equal(readAgentPreferences(second, catalog).source.digest, right.source.digest);
});

it("guidance includes current preferences and bounded omitted coverage", (t) => {
	const root = fixture(t); writeFileSync(agentPreferencesPath(root), JSON.stringify(document()));
	const snapshot = readAgentPreferences(root, catalog);
	const text = renderAgentPreferences(snapshot);
	for (const expected of [/Excluded model/u, /Planning context budget/u, /Quota substitution order/u, /Reporting notes/u, /Preset "review"/u, /Diagnostic/u]) assert.match(text, expected);
	const large = { version: 1, presets: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, { model: "acme/model-x", notes: "x".repeat(2000) }])) };
	writeFileSync(agentPreferencesPath(root), JSON.stringify(large));
	const bounded = renderAgentPreferences(readAgentPreferences(root, catalog));
	assert.ok(bounded.length < 12500); assert.match(bounded, /Omitted \d+ lines/u);
});
