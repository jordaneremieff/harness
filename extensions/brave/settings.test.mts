import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createEventBus, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import {
	readSettings,
	SETTINGS_PUBLISH,
	SETTINGS_REQUEST,
	type SettingsPublication,
} from "./settings.ts";
import { resolveApiKey, searchBraveWeb } from "./client.ts";
import type { DurableContribution, DurableContributionHost } from "./durable.ts";
import registerBraveSearch from "./index.ts";
import { settings } from "./settings.ts";

function observeSettings(bus: ReturnType<typeof createEventBus>) {
	let publications: SettingsPublication[] = [];
	const dispose = bus.on("harness:settings:publish", (value) => {
		const publication = value as SettingsPublication;
		assert.equal(publication.slice, "brave");
		assert.equal(Object.hasOwn(publication, "values"), false);
		publications = [publication];
	});
	const refresh = () => {
		publications = [];
		bus.emit("harness:settings:request", { version: 1 });
	};
	refresh();
	return { snapshots: () => publications, refresh, dispose };
}

function fixture(t: TestContext) {
	const agentDir = mkdtempSync(join(tmpdir(), "brave-settings-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	return {
		agentDir,
		write: (value: unknown) => writeFileSync(join(agentDir, "harness.json"), JSON.stringify(value)),
	};
}

function ordinary(bus: ReturnType<typeof createEventBus>) {
	const tools = new Map<string, ToolDefinition>();
	const hooks = new Map<string, () => void>();
	const contributions: DurableContribution[] = [];
	bus.on("durable:contribution", (data) => contributions.push(data as DurableContribution));
	registerBraveSearch({
		events: bus,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: (event: string, handler: () => void) => hooks.set(event, handler),
	} as unknown as ExtensionAPI);
	return { tools, contributions, shutdown: () => hooks.get("session_shutdown")?.() };
}

function assertSecretFree(value: unknown) {
	assert.doesNotMatch(JSON.stringify(value), /synthetic-file-token|synthetic-env-token|synthetic-explicit-token/);
}

describe("Brave settings", () => {
	it("rejects document credentials and exposes only unset state with a diagnostic", async (t) => {
		const f = fixture(t);
		f.write({ version: 1, brave: { apiKey: "synthetic-file-token" } });
		const snapshot = readSettings({ agentDir: f.agentDir, env: {} });
		assert.equal(snapshot.values.apiKey, undefined);
		assert.deepEqual(
			snapshot.records.map(({ origin, status, secretState }) => ({ origin, status, secretState })),
			[{ origin: "default", status: "invalid", secretState: "unset" }],
		);
		assert.deepEqual(
			snapshot.diagnostics.map(({ field, source, code }) => ({ field, source, code })),
			[{ field: "brave.apiKey", source: "file", code: "secret" }],
		);
		assertSecretFree(snapshot);
		await assert.rejects(resolveApiKey({ agentDir: f.agentDir, env: {} }), /not configured.*PI_BRAVE_API_KEY/);
	});

	it("selects environment input above a rejected file key and explicit client input above both", async (t) => {
		const f = fixture(t);
		f.write({ version: 1, brave: { apiKey: "synthetic-file-token" } });
		const env = { PI_BRAVE_API_KEY: " synthetic-env-token " };
		const snapshot = readSettings({ agentDir: f.agentDir, env });
		assert.equal(snapshot.values.apiKey, env.PI_BRAVE_API_KEY);
		assert.equal(snapshot.records[0].origin, "env");
		assert.equal(snapshot.records[0].secretState, "set");
		assert.equal(snapshot.records[0].status, "invalid");
		assert.equal(snapshot.diagnostics[0].code, "secret");
		assert.equal(await resolveApiKey({ agentDir: f.agentDir, env }), "synthetic-env-token");
		assert.equal(
			await resolveApiKey({ agentDir: f.agentDir, env, apiKey: " synthetic-explicit-token " }),
			"synthetic-explicit-token",
		);
		let token: string | undefined;
		await searchBraveWeb({ query: "public evidence" }, undefined, {
			agentDir: f.agentDir,
			env,
			apiKey: "synthetic-explicit-token",
			fetch: async (_url, init) => {
				token = init.headers["X-Subscription-Token"];
				return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
			},
		});
		assert.equal(token, "synthetic-explicit-token");
	});

	it("rejects empty, blank, control-bearing and oversized environment credentials without a file fallback", async (t) => {
		const f = fixture(t);
		f.write({ version: 1, brave: { apiKey: "synthetic-file-token" } });
		for (const apiKey of ["", "   ", "synthetic-env-token\n", "x".repeat(4097)]) {
			const env = { PI_BRAVE_API_KEY: apiKey };
			const snapshot = readSettings({ agentDir: f.agentDir, env });
			assert.equal(snapshot.values.apiKey, undefined);
			assert.equal(snapshot.records[0].secretState, "unset");
			assert.equal(snapshot.records[0].origin, "default");
			assert.ok(snapshot.diagnostics.some((item) => item.source === "env" && item.code === "invalid"));
			assertSecretFree(snapshot);
			await assert.rejects(resolveApiKey({ agentDir: f.agentDir, env }), /not configured.*PI_BRAVE_API_KEY/);
		}
	});

	it("marks blank and whitespace environment tokens invalid without document input", (t) => {
		const f = fixture(t);
		for (const apiKey of ["", "   ", "\u00a0"]) {
			const snapshot = readSettings({ agentDir: f.agentDir, env: { PI_BRAVE_API_KEY: apiKey } });
			assert.equal(snapshot.values.apiKey, undefined);
			assert.equal(snapshot.records[0].status, "invalid");
			assert.equal(snapshot.records[0].origin, "default");
			assert.equal(snapshot.records[0].secretState, "unset");
			assert.deepEqual(snapshot.diagnostics.map(({ field, source, code }) => ({ field, source, code })), [
				{ field: "brave.apiKey", source: "env", code: "invalid" },
			]);
		}
	});

	it("documents an environment-only key without a secret value or default", () => {
		const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
		const table = readme.slice(readme.indexOf("<!-- harness:settings:start -->"), readme.indexOf("<!-- harness:settings:end -->"));
		assert.match(table, /PI_BRAVE_API_KEY/);
		assert.match(table, /env-only/);
		assertSecretFree(table);
		assert.equal(Object.hasOwn(settings.fields.apiKey, "default"), false);
	});

	it("publishes fresh redacted ordinary snapshots in both load orders and cleans up on shutdown", (t) => {
		const f = fixture(t);
		f.write({ version: 1, brave: { apiKey: "synthetic-file-token" } });
		t.mock.property(process, "env", { PI_CODING_AGENT_DIR: f.agentDir, PI_BRAVE_API_KEY: "synthetic-env-token" });
		for (const publisherFirst of [false, true]) {
			const bus = createEventBus();
			let publisher: ReturnType<typeof ordinary> | undefined;
			if (publisherFirst) publisher = ordinary(bus);
			const collector = observeSettings(bus);
			if (!publisherFirst) publisher = ordinary(bus);
			const [snapshot] = collector.snapshots();
			assert.equal(snapshot.source.path, join(f.agentDir, "harness.json"));
			assert.equal(snapshot.records[0].secretState, "set");
			assert.equal(snapshot.records[0].origin, "env");
			assert.equal(snapshot.diagnostics[0].code, "secret");
			assert.equal(Object.hasOwn(snapshot, "values"), false);
			assert.equal(Object.hasOwn(snapshot.records[0], "value"), false);
			assertSecretFree(snapshot);
			delete process.env.PI_BRAVE_API_KEY;
			collector.refresh();
			assert.equal(collector.snapshots()[0].records[0].secretState, "unset");
			assert.ok(publisher);
			publisher.shutdown();
			collector.refresh();
			assert.deepEqual(collector.snapshots(), []);
			collector.dispose();
			process.env.PI_BRAVE_API_KEY = "synthetic-env-token";
		}
	});

	it("replaces the factory publisher with host-bound native settings and releases it on close", async (t) => {
		const ordinaryDir = fixture(t);
		ordinaryDir.write({ version: 1, brave: { ordinaryOnly: true, apiKey: "synthetic-file-token-ordinary" } });
		const nativeDir = fixture(t);
		nativeDir.write({ version: 1, brave: { apiKey: "synthetic-file-token-native" } });
		t.mock.property(process, "env", { PI_CODING_AGENT_DIR: ordinaryDir.agentDir });
		const bus = createEventBus();
		const collector = observeSettings(bus);
		const publications: unknown[] = [];
		bus.on(SETTINGS_PUBLISH, (data) => publications.push(data));
		const publisher = ordinary(bus);
		assert.equal(collector.snapshots()[0].source.path, join(ordinaryDir.agentDir, "harness.json"));
		const close: (() => void | Promise<void>)[] = [];
		const host: DurableContributionHost = {
			durable: Durable,
			services: {} as DurableContributionHost["services"],
			cwd: ordinaryDir.agentDir,
			agentDir: nativeDir.agentDir,
			storageId: "brave-settings-test",
			signal: new AbortController().signal,
			onClose: (dispose) => close.push(dispose),
			inventory: { contributions: [], ordinaryOnly: [] },
		};
		const extension = await publisher.contributions[0].create(host);
		assert.equal(close.length, 1);
		const nativeSnapshot = collector.snapshots()[0];
		assert.equal(nativeSnapshot.source.path, join(nativeDir.agentDir, "harness.json"));
		assert.deepEqual(
			nativeSnapshot.diagnostics.map((item) => item.field),
			["brave.apiKey"],
		);
		assert.equal(nativeSnapshot.records[0].secretState, "unset");
		const search = extension.tools?.find((tool) => tool.name === "web_search");
		assert.ok(search?.execute);
		let token: string | undefined;
		let fetches = 0;
		t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
			fetches += 1;
			token = new Headers(init?.headers).get("X-Subscription-Token") ?? undefined;
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		});
		await assert.rejects(search.execute({ query: "evidence" }, {} as never, BACKGROUND_CONTEXT), /not configured/);
		assert.equal(fetches, 0);
		process.env.PI_BRAVE_API_KEY = "synthetic-env-token";
		const result = await search.execute({ query: "evidence" }, {} as never, BACKGROUND_CONTEXT);
		assert.equal(token, "synthetic-env-token");
		assert.equal(fetches, 1);
		assertSecretFree(result);
		publisher.shutdown();
		const before = publications.length;
		collector.refresh();
		assert.equal(publications.length, before + 1, "only the native publisher remains active");
		assert.equal(collector.snapshots()[0].source.path, join(nativeDir.agentDir, "harness.json"));
		assert.equal(collector.snapshots()[0].records[0].secretState, "set");
		assertSecretFree(publications);
		for (const dispose of close) await dispose();
		collector.refresh();
		assert.deepEqual(collector.snapshots(), []);
		collector.dispose();
	});

	it("emits no credential bytes in raw ordinary publications or malformed requests", (t) => {
		const f = fixture(t);
		f.write({ version: 1, brave: { apiKey: "synthetic-file-token" } });
		t.mock.property(process, "env", { PI_CODING_AGENT_DIR: f.agentDir, PI_BRAVE_API_KEY: "synthetic-env-token" });
		const bus = createEventBus();
		const emitted: unknown[] = [];
		bus.on(SETTINGS_PUBLISH, (data) => emitted.push(data));
		const publisher = ordinary(bus);
		assert.equal(emitted.length, 1);
		for (const request of [undefined, null, {}, { version: 2 }, { version: "1" }]) bus.emit(SETTINGS_REQUEST, request);
		assert.equal(emitted.length, 1);
		bus.emit(SETTINGS_REQUEST, { version: 1 });
		assert.equal(emitted.length, 2);
		assertSecretFree(emitted);
		publisher.shutdown();
		bus.emit(SETTINGS_REQUEST, { version: 1 });
		assert.equal(emitted.length, 2);
	});
});
