import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import * as Durable from "@earendil-works/pi-durable";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { settings, readSettings, publishSettings, type SettingsPublication } from "./settings.ts";
import {
	readAgentPreferences,
	parsePreferenceSnapshot,
	resolveExecutionPreset,
	renderAgentPreferences,
} from "./agent-preferences.ts";
import { checkInMinutes } from "./durable-checkins.ts";
import { resolveIdleMs } from "./host-process.ts";
import registerAgentExtension from "./index.ts";
import type { AgentContribution } from "./durable-agents.ts";

function fixture(t: { after(fn: () => void): void }) {
	const agentDir = mkdtempSync(join(tmpdir(), "agent-settings-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	return agentDir;
}
function bus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			let set = handlers.get(channel);
			if (!set) {
				set = new Set();
				handlers.set(channel, set);
			}
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
	};
}

it("selects each agent field from injected environment, document, or default without inheritance", (t) => {
	const agentDir = fixture(t);
	writeFileSync(
		join(agentDir, "harness.json"),
		JSON.stringify({
			version: 1,
			agent: {
				idleMinutes: 0.5,
				checkInMinutes: 3,
				presets: { standard: { model: "acme/model-x" } },
				preferences: { defaultPreset: "standard" },
			},
		}),
	);
	const env = {
		PI_AGENT_IDLE_MINUTES: "1.25",
		PI_AGENT_CHECK_IN_MINUTES: "",
		PI_AGENT_PREFERENCES: '{"defaultPreset":"override"}',
		PI_AGENT_PRESETS: '{"override":{"model":"acme/model-x","thinkingLevel":"low"}}',
	};
	const snapshot = readSettings({ agentDir, env });
	assert.equal(snapshot.values.idleMinutes, 1.25);
	assert.equal(snapshot.values.checkInMinutes, 30);
	assert.ok(snapshot.diagnostics.some((fact) => fact.field === "agent.checkInMinutes" && fact.source === "env"));
	assert.equal(snapshot.records.find((record) => record.key === "checkInMinutes")?.status, "invalid");
	assert.equal(resolveIdleMs(undefined, env, agentDir), 75000);
	assert.equal(checkInMinutes(undefined, "model", agentDir, env), 30);
	assert.equal(checkInMinutes(undefined, "model", agentDir, {}), 3);
	assert.equal(checkInMinutes(undefined, "operator", agentDir, env), 0);
	assert.equal(checkInMinutes(0, "model", agentDir, env), 0);
	const preferences = readAgentPreferences(agentDir, undefined, env);
	assert.deepEqual(parsePreferenceSnapshot(preferences), preferences);
	const selection = resolveExecutionPreset(
		preferences,
		{},
		{ model: "acme/parent", thinkingLevel: "high" },
		{ creation: true },
	);
	assert.equal(selection.values.model, "acme/model-x");
	assert.equal(selection.values.thinkingLevel, "low");
	assert.equal(selection.origins.model, "defaultPreset");
	assert.deepEqual(
		snapshot.records.map((record) => record.key),
		["idleMinutes", "checkInMinutes", "presets", "preferences"],
	);
});

it("keeps valid structured settings and env presets usable beside invalid selected fields and documents", (t) => {
	const agentDir = fixture(t);
	writeFileSync(
		join(agentDir, "harness.json"),
		JSON.stringify({
			version: 1,
			agent: {
				idleMinutes: -1,
				checkInMinutes: 0.25,
				presets: { standard: { model: "acme/model-x", unknown: true } },
				preferences: { defaultPreset: "standard" },
				unknown: true,
			},
		}),
	);
	let snapshot = readSettings({ agentDir, env: {} });
	assert.equal(snapshot.values.idleMinutes, 5);
	assert.equal(snapshot.values.checkInMinutes, 0.25);
	assert.deepEqual(snapshot.values.presets, {});
	assert.equal(snapshot.values.preferences.defaultPreset, "standard");
	assert.deepEqual(snapshot.diagnostics.map((fact) => fact.field).sort(), [
		"agent.idleMinutes",
		"agent.presets",
		"agent.unknown",
	]);
	writeFileSync(join(agentDir, "harness.json"), "invalid");
	const env = {
		PI_AGENT_PRESETS: '{"standard":{"model":"acme/model-x"}}',
		PI_AGENT_PREFERENCES: '{"defaultPreset":"standard"}',
	};
	const preferences = readAgentPreferences(agentDir, undefined, env);
	assert.equal(preferences.source.status, "invalid");
	assert.deepEqual(parsePreferenceSnapshot(preferences), preferences);
	assert.equal(resolveExecutionPreset(preferences, {}, {}, { creation: true }).values.model, "acme/model-x");
	assert.match(renderAgentPreferences(preferences), /Preset "standard"/u);
	rmSync(join(agentDir, "harness.json"));
	assert.match(renderAgentPreferences(readAgentPreferences(agentDir, undefined, env)), /Preset "standard"/u);
	snapshot = readSettings({ agentDir, env: { PI_AGENT_PRESETS: "not json" } });
	assert.equal(snapshot.records.find((record) => record.key === "presets")?.status, "invalid");
	assert.deepEqual(snapshot.values.presets, {});
});

it("retains structured settings within contract byte bounds without a second document limit", (t) => {
	const agentDir = fixture(t);
	const presets = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`p${i}`, { model: "acme/model-x", role: "x".repeat(2000), notes: "y".repeat(2000) }]));
	const input = JSON.stringify(presets);
	assert.ok(Buffer.byteLength(input) > 65536);
	const snapshot = readAgentPreferences(agentDir, undefined, { PI_AGENT_PRESETS: input });
	assert.equal(Object.keys(snapshot.document?.presets ?? {}).length, 28);
	assert.deepEqual(parsePreferenceSnapshot(snapshot), snapshot);
});

it("rejects invalid declared defaults before selected input without exposing validator details", (t) => {
	const agentDir = fixture(t);
	const cases = [
		{ key: "idleMinutes", invalid: -1, input: "2" },
		{ key: "presets", invalid: { standard: { model: "invalid-default-detail" } }, input: "{}" },
	] as const;
	for (const { key, invalid, input } of cases) {
		const field = settings.fields[key] as { default: unknown; env: string };
		const original = field.default;
		try {
			field.default = invalid;
			for (const env of [{}, { [field.env]: input }]) {
				assert.throws(() => readSettings({ agentDir, env }), {
					name: "Error", message: `Invalid default for agent.${key}`,
				});
			}
		} finally {
			field.default = original;
		}
	}
	assert.equal(readSettings({ agentDir, env: {} }).values.idleMinutes, 5);
	assert.deepEqual(readSettings({ agentDir, env: {} }).values.presets, {});
});

it("rejects unbounded or unsafe structured input without leaking parser or validator text", (t) => {
	const agentDir = fixture(t);
	const valid = { standard: { model: "acme/model-x", notes: "line one\nline two 😀" } };
	assert.deepEqual(readSettings({ agentDir, env: { PI_AGENT_PRESETS: JSON.stringify(valid) } }).values.presets, valid);
	const inputs = [
		" ".repeat(131073),
		JSON.stringify({ standard: { model: "acme/model-x", role: "\u0000" } }),
		JSON.stringify({ standard: { model: "acme/model-x", notes: "\ud800" } }),
		JSON.stringify({ "hidden\u200b": { model: "acme/model-x" } }),
		`${"[".repeat(33)}0${"]".repeat(33)}`,
		JSON.stringify(Array.from({ length: 10001 }, () => 0)),
		'{"standard":',
	];
	for (const input of inputs) {
		const snapshot = readSettings({ agentDir, env: { PI_AGENT_PRESETS: input } });
		assert.deepEqual(snapshot.values.presets, {});
		assert.deepEqual(snapshot.diagnostics, [{
			field: "agent.presets", source: "env", code: "invalid",
			message: "Selected input is invalid; the safe default is in effect.",
		}]);
	}
});

it("isolates default objects, rejects non-JSON numbers, and bounds unknown diagnostics", (t) => {
	const agentDir = fixture(t);
	const snapshot = readSettings({ agentDir, env: {} });
	snapshot.values.presets.modified = { model: "acme/model-x" };
	assert.deepEqual(readSettings({ agentDir, env: {} }).values.presets, {});
	for (const raw of ["", " 1", "01", "+1", "NaN", "Infinity", "1e999", "-1", "35792"]) {
		const result = readSettings({ agentDir, env: { PI_AGENT_IDLE_MINUTES: raw } });
		assert.equal(result.values.idleMinutes, 5);
		assert.equal(result.records[0].status, "invalid");
	}
	assert.equal(readSettings({ agentDir, env: { PI_AGENT_IDLE_MINUTES: "1.25e1" } }).values.idleMinutes, 12.5);
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify({ version: 1, agent: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`extra${i}`, true])) }));
	const crowded = readSettings({ agentDir, env: {} });
	assert.equal(crowded.diagnostics.length, 257);
	assert.equal(crowded.diagnostics.at(-1)?.code, "coverage");
});

it("keeps bounded document evidence and environment values when a document is invalid", (t) => {
	const agentDir = fixture(t);
	const path = join(agentDir, "alternate.json");
	const input = '{"version":1,"agent":{"idleMinutes":2}}';
	writeFileSync(path, input);
	const options = { agentDir, env: { PI_HARNESS_FILE: "alternate.json" } };
	const snapshot = readSettings(options);
	assert.equal(snapshot.source.path, path);
	assert.equal(snapshot.source.digest, createHash("sha256").update(input).digest("hex"));
	assert.equal(snapshot.values.idleMinutes, 2);
	for (const bytes of [Buffer.from("\ufeff{}"), Buffer.from([0xff]), Buffer.from("{}")]) {
		writeFileSync(path, bytes);
		const invalid = readSettings({ agentDir, env: { ...options.env, PI_AGENT_IDLE_MINUTES: "3" } });
		assert.equal(invalid.source.status, "invalid");
		assert.equal(invalid.source.digest, createHash("sha256").update(bytes).digest("hex"));
		assert.equal(invalid.values.idleMinutes, 3);
		assert.equal(invalid.diagnostics[0].code, "document");
	}
	const invalidPath = readSettings({ agentDir, env: { PI_HARNESS_FILE: "" } });
	assert.equal(invalidPath.source.status, "unavailable");
	assert.equal(invalidPath.diagnostics[0].field, "PI_HARNESS_FILE");
});

it("publishes fresh protocol data without local values and stops after disposal", (t) => {
	const agentDir = fixture(t);
	const events = bus();
	const publications: SettingsPublication[] = [];
	events.on("harness:settings:publish", (value) => publications.push(value as SettingsPublication));
	const dispose = publishSettings(events, { agentDir, env: {} });
	assert.equal(publications.length, 1);
	assert.equal(Object.hasOwn(publications[0], "values"), false);
	assert.equal(publications[0].source.status, "missing");
	for (const request of [null, {}, { version: 2 }, { version: "1" }]) events.emit("harness:settings:request", request);
	assert.equal(publications.length, 1);
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify({ version: 1, agent: { idleMinutes: 2 } }));
	events.emit("harness:settings:request", { version: 1 });
	assert.equal(publications.length, 2);
	assert.equal(publications[1].records[0].value, 2);
	dispose();
	dispose();
	events.emit("harness:settings:request", { version: 1 });
	assert.equal(publications.length, 2);
});

it("replaces the factory publisher with the native host directory and keeps cleanup ownership separate", (t) => {
	const ordinaryDir = fixture(t);
	const nativeDir = fixture(t);
	writeFileSync(join(ordinaryDir, "harness.json"), JSON.stringify({ version: 1, agent: { checkInMinutes: 9 } }));
	writeFileSync(
		join(nativeDir, "harness.json"),
		JSON.stringify({ version: 1, agent: { checkInMinutes: 2, presets: { standard: { model: "acme/model-x" } } } }),
	);
	const prior = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = ordinaryDir;
	t.after(() => {
		if (prior === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = prior;
	});
	const events = bus();
	let contribution: AgentContribution | undefined;
	events.on("durable:contribution", (value) => {
		contribution = value as AgentContribution;
	});
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	registerAgentExtension({
		events,
		on(name: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(name, handler);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
	} as unknown as ExtensionAPI);
	let publications: SettingsPublication[] = [];
	const stopObserving = events.on("harness:settings:publish", (value) => publications.push(value as SettingsPublication));
	t.after(stopObserving);
	const collector = {
		refresh() {
			publications = [];
			events.emit("harness:settings:request", { version: 1 });
			assert.ok(publications.length <= 1, "Only one agent publisher owns the lifecycle");
		},
		snapshots: () => publications,
	};
	collector.refresh();
	assert.equal(collector.snapshots()[0].source.path, join(ordinaryDir, "harness.json"));
	let dispose: (() => void) | undefined;
	assert.ok(contribution);
	contribution.create({
		durable: Durable,
		storageId: "fixture",
		cwd: nativeDir,
		agentDir: nativeDir,
		onClose(fn) {
			dispose = fn;
		},
		services: { modelRuntime: { getModel: () => undefined } },
	});
	collector.refresh();
	assert.equal(collector.snapshots()[0].source.path, join(nativeDir, "harness.json"));
	assert.equal(collector.snapshots()[0].records.find((record) => record.key === "checkInMinutes")?.value, 2);
	writeFileSync(join(nativeDir, "harness.json"), JSON.stringify({ version: 1, agent: { checkInMinutes: 4 } }));
	collector.refresh();
	assert.equal(collector.snapshots()[0].records.find((record) => record.key === "checkInMinutes")?.value, 4);
	const ordinaryShutdown = handlers.get("session_shutdown");
	assert.ok(ordinaryShutdown);
	ordinaryShutdown({}, { sessionManager: { getSessionId: () => "fixture-primary" } });
	collector.refresh();
	assert.equal(collector.snapshots()[0].source.path, join(nativeDir, "harness.json"));
	assert.equal(collector.snapshots()[0].records.find((record) => record.key === "checkInMinutes")?.value, 4);
	assert.ok(dispose);
	dispose();
	dispose();
	collector.refresh();
	assert.deepEqual(collector.snapshots(), []);
});
