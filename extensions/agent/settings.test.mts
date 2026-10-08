import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import * as Durable from "@earendil-works/pi-durable";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectSettings, readSettings, settingsPublication } from "../../settings/index.ts";
import { settings } from "./settings.ts";
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
	const snapshot = readSettings(settings, { agentDir, env });
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
		settingsPublication(snapshot).records.map((record) => record.key),
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
	let snapshot = readSettings(settings, { agentDir, env: {} });
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
	snapshot = readSettings(settings, { agentDir, env: { PI_AGENT_PRESETS: "not json" } });
	assert.equal(snapshot.records.find((record) => record.key === "presets")?.status, "invalid");
	assert.deepEqual(snapshot.values.presets, {});
});

it("retains structured settings within shared byte bounds without a second document limit", (t) => {
	const agentDir = fixture(t);
	const presets = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`p${i}`, { model: "acme/model-x", role: "x".repeat(2000), notes: "y".repeat(2000) }]));
	const input = JSON.stringify(presets);
	assert.ok(Buffer.byteLength(input) > 65536);
	const snapshot = readAgentPreferences(agentDir, undefined, { PI_AGENT_PRESETS: input });
	assert.equal(Object.keys(snapshot.document?.presets ?? {}).length, 28);
	assert.deepEqual(parsePreferenceSnapshot(snapshot), snapshot);
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
	const collector = collectSettings(events);
	t.after(() => collector.dispose());
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
