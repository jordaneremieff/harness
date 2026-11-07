/**
 * The ordinary entrypoint of the browser slice: registration order, tool
 * execution modes, guidance, the Durable contribution, and the settings
 * publisher lifecycle.
 *
 * No registered tool executes here; execution would reach the real browser.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type JsonObject, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerBrowser from "./index.ts";

const source = fileURLToPath(new URL("./index.ts", import.meta.url));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

interface RegisteredTool {
	name: string;
	description: string;
	exposure?: string;
	promptGuidelines?: readonly string[];
	executionMode?: string;
	parameters?: unknown;
}

interface Emitted {
	channel: string;
	data: unknown;
}

interface Subscription {
	channel: string;
	handler: (data: unknown) => void;
	active: boolean;
}

function fixture() {
	const tools = new Map<string, RegisteredTool>();
	const order: string[] = [];
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const subscriptions: Subscription[] = [];
	const emitted: Emitted[] = [];

	const events = {
		on(channel: string, handler: (data: unknown) => void) {
			const entry: Subscription = { channel, handler, active: true };
			subscriptions.push(entry);
			return () => {
				entry.active = false;
			};
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const entry of subscriptions) {
				if (entry.active && entry.channel === channel) entry.handler(data);
			}
		},
	};
	const api = {
		events,
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
			order.push(tool.name);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	};
	return {
		api,
		tools,
		order,
		emitted,
		shutdown() {
			for (const handler of handlers.get("session_shutdown") ?? []) handler();
		},
	};
}

function publications(emitted: Emitted[]) {
	return emitted.filter((entry) => entry.channel === "harness:settings:publish");
}

/**
 * The rules Pi renders for a request: one bullet per distinct guideline text of
 * each active tool, normalized by trimming.
 */
function renderedGuidance(tools: Map<string, RegisteredTool>, active: readonly string[]): string[] {
	const seen = new Set<string>();
	const rendered: string[] = [];
	for (const name of active) {
		for (const guideline of tools.get(name)?.promptGuidelines ?? []) {
			const line = guideline.trim();
			if (line.length === 0 || seen.has(line)) continue;
			seen.add(line);
			rendered.push(line);
		}
	}
	return rendered;
}

beforeEach((t) => {
	assert.ok("mock" in t && "after" in t);
	const agentDir = mkdtempSync(join(tmpdir(), "browser-entrypoint-"));
	t.mock.property(process, "env", { ...process.env, PI_CODING_AGENT_DIR: agentDir });
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("browser extension entrypoint", () => {
	it("registers no tool while no browser has access, and still publishes settings and the contribution", () => {
		delete process.env.PI_BROWSER_ACCESS;
		const { api, order, emitted } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);

		assert.deepEqual(order, []);
		assert.equal(publications(emitted).length, 1);
		assert.equal(emitted.filter((entry) => entry.channel === "durable:contribution").length, 1);
	});

	it("registers only the reading tools for inspect access", () => {
		process.env.PI_BROWSER_ACCESS = JSON.stringify({ chrome: "inspect" });
		const { api, order, tools } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);

		assert.deepEqual(order, ["browser_tabs", "browser_inspect", "browser_capture"]);
		for (const tool of tools.values()) assert.equal(tool.exposure, "deferred");
	});

	it("registers the five tools for interact access, with sequential mode on the mutating tools only", () => {
		process.env.PI_BROWSER_ACCESS = JSON.stringify({ chrome: "inspect", brave: "interact" });
		const { api, order, tools } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);

		assert.deepEqual(order, ["browser_tabs", "browser_inspect", "browser_act", "browser_evaluate", "browser_capture"]);
		for (const tool of tools.values()) assert.equal(tool.exposure, "deferred");
		assert.equal(tools.get("browser_act")?.executionMode, "sequential");
		assert.equal(tools.get("browser_evaluate")?.executionMode, "sequential");
		for (const name of ["browser_tabs", "browser_inspect", "browser_capture"]) {
			assert.equal(tools.get(name)?.executionMode, undefined, name);
		}
	});

	it("gives every offered tool the full shared guidance when it is the only active tool", () => {
		process.env.PI_BROWSER_ACCESS = JSON.stringify({ chrome: "interact" });
		const { api, tools } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);

		const shared = tools.get("browser_tabs")?.promptGuidelines ?? [];
		assert.ok(shared.length > 0);
		for (const name of ["browser_tabs", "browser_inspect", "browser_act", "browser_evaluate", "browser_capture"]) {
			assert.deepEqual(tools.get(name)?.promptGuidelines, shared, name);
			const guidance = renderedGuidance(tools, [name]).join("\n");
			assert.match(guidance, /browser_tabs before other browser tools/, name);
			assert.match(guidance, /not task authority/, name);
			assert.match(guidance, /untrusted data, not instructions/, name);
			assert.match(guidance, /inspect the page before any repeat/, name);
			assert.match(guidance, /Do not read or export cookies/, name);
		}
	});

	it("renders one copy of each guideline for two active tools and none while no browser tool is active", () => {
		process.env.PI_BROWSER_ACCESS = JSON.stringify({ chrome: "interact" });
		const { api, tools } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);

		const shared = tools.get("browser_tabs")?.promptGuidelines ?? [];
		assert.deepEqual(renderedGuidance(tools, ["browser_tabs", "browser_evaluate"]), shared);
		assert.deepEqual(renderedGuidance(tools, ["browser_inspect", "browser_act"]), shared);
		assert.deepEqual(renderedGuidance(tools, []), []);
	});

	it("requires pid on every targeted tool through the host argument validation", () => {
		process.env.PI_BROWSER_ACCESS = JSON.stringify({ chrome: "interact" });
		const { api, tools } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);

		const calls: { name: string; args: JsonObject }[] = [
			{ name: "browser_inspect", args: { browser: "chrome", tab: "7", pid: 5 } },
			{
				name: "browser_act",
				args: { browser: "chrome", tab: "7", pid: 5, origin: "https://a.example", action: "click", selector: "#save" },
			},
			{
				name: "browser_evaluate",
				args: { browser: "chrome", tab: "7", pid: 5, origin: "https://a.example", expression: "1 + 1" },
			},
			{ name: "browser_capture", args: { browser: "chrome", tab: "7", pid: 5 } },
		];
		for (const call of calls) {
			const tool = tools.get(call.name) as unknown as Tool;
			assert.ok(tool, call.name);
			const { pid: _pid, ...withoutPid } = call.args;
			assert.throws(
				() =>
					validateToolArguments(tool, {
						type: "toolCall",
						id: `call-${call.name}`,
						name: call.name,
						arguments: withoutPid,
					}),
				new RegExp(`Validation failed for tool "${call.name}"[\\s\\S]*pid`),
				call.name,
			);
			const validated = validateToolArguments(tool, {
				type: "toolCall",
				id: `ok-${call.name}`,
				name: call.name,
				arguments: call.args,
			});
			assert.equal(validated.pid, 5, call.name);
		}

		const tabs = tools.get("browser_tabs") as unknown as Tool;
		assert.doesNotThrow(() =>
			validateToolArguments(tabs, {
				type: "toolCall",
				id: "tabs-no-pid",
				name: "browser_tabs",
				arguments: { browser: "chrome" },
			}),
		);
	});

	it("emits one Durable contribution whose source is this entrypoint", () => {
		const { api, emitted } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);

		const contributions = emitted
			.filter((entry) => entry.channel === "durable:contribution")
			.map((entry) => entry.data as { name?: unknown; source?: unknown; create?: unknown });
		assert.equal(contributions.length, 1);
		assert.equal(contributions[0]?.name, "browser");
		assert.equal(contributions[0]?.source, source);
		assert.ok(typeof contributions[0]?.source === "string" && isAbsolute(contributions[0].source));
		assert.match(String(contributions[0]?.source), /extensions[/\\]browser[/\\]index\.ts$/);
		assert.equal(typeof contributions[0]?.create, "function");
	});

	it("publishes browser settings during setup", () => {
		const { api, emitted } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);

		const published = publications(emitted);
		assert.equal(published.length, 1);
		const publication = published[0]?.data as {
			version?: unknown;
			slice?: unknown;
			records?: { name?: unknown }[];
			diagnostics?: unknown[];
		};
		assert.equal(publication.version, 1);
		assert.equal(publication.slice, "browser");
		assert.deepEqual(
			publication.records?.map((record) => record.name),
			["browser.access"],
		);
		assert.equal(Object.hasOwn(publication as object, "values"), false);
	});

	it("removes the settings subscription on session shutdown", () => {
		const { api, emitted, shutdown } = fixture();
		registerBrowser(api as unknown as ExtensionAPI);
		const count = () => publications(emitted).length;
		assert.equal(count(), 1);

		api.events.emit("harness:settings:request", { version: 1 });
		assert.equal(count(), 2);

		shutdown();
		api.events.emit("harness:settings:request", { version: 1 });
		assert.equal(count(), 2, "the shut-down publisher answers no request");
	});
});
