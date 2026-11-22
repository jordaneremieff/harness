import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { Collector } from "./collector.ts";
import pillarsExtension from "./index.ts";
import { Deduplicator } from "./observation.ts";

type ContextFields = Pick<ExtensionContext, "cwd" | "hasUI" | "signal" | "model" | "thinkingLevel">;
type Emit = (name: string, event: unknown) => Promise<void>;

function observationHost(ctx: ContextFields, otherTools = 0): Emit {
	const handlers = new Map<string, unknown>();
	const api: Pick<
		ExtensionAPI,
		| "on"
		| "registerTool"
		| "registerCommand"
		| "registerEntryRenderer"
		| "registerMessageRenderer"
		| "getAllTools"
		| "events"
	> = {
		events: { emit() {}, on: () => () => {} },
		on(name, handler) {
			handlers.set(name, handler);
			return () => {
				handlers.delete(name);
			};
		},
		registerTool() {},
		registerCommand() {},
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		getAllTools: () => [
			...Array.from({ length: otherTools }, (_, index) => ({
				name: `other_${index}`,
				exposure: "deferred" as const,
				description: "Synthetic catalog entry",
				parameters: obj({}, { open: true }),
				sourceInfo: {
					path: "builtin:mcp",
					source: "builtin",
					scope: "temporary" as const,
					origin: "top-level" as const,
				},
			})),
			{
				name: "pillars",
				exposure: "direct",
				description: "Synthetic source tool",
				parameters: obj({}, { open: true }),
				sourceInfo: {
					path: fileURLToPath(new URL("./index.ts", import.meta.url)),
					source: "synthetic",
					scope: "temporary",
					origin: "top-level",
				},
			},
		],
	};
	pillarsExtension(api as ExtensionAPI);
	return async (name, event) => {
		const handler = handlers.get(name);
		assert.ok(typeof handler === "function");
		await handler(event, ctx);
	};
}

async function withObservationHost(run: (emit: Emit) => Promise<void>, otherTools = 0): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pillars-observation-order-"));
	const corpus = join(root, "corpus");
	const previous = {
		PI_PILLARS_DIR: process.env.PI_PILLARS_DIR,
		PI_PILLARS_COLLECT: process.env.PI_PILLARS_COLLECT,
		PI_PILLARS_CORPUS: process.env.PI_PILLARS_CORPUS,
	};
	try {
		await mkdir(corpus);
		await writeFile(join(corpus, "README.md"), "# Inventory\n[Example](principle-example.md)\n");
		await writeFile(join(corpus, "GOVERNANCE.md"), "# Governance\nRead the selected source.\n");
		await writeFile(join(corpus, "principle-example.md"), "# Example\nUse checked evidence.\n");
		process.env.PI_PILLARS_DIR = join(root, "store");
		process.env.PI_PILLARS_COLLECT = "1";
		process.env.PI_PILLARS_CORPUS = corpus;
		const emit = observationHost(
			{
				cwd: root,
				hasUI: false,
				signal: new AbortController().signal,
				model: undefined,
				thinkingLevel: "off",
			},
			otherTools,
		);
		await emit("session_start", { reason: "startup" });
		await run(emit);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
}

const request = { toolName: "pillars", toolCallId: "own-source", input: { resource: "inventory" } };

test("own-tool deduplication precedes the first source-read await", async (t) => {
	let admissions = 0;
	t.mock.method(Deduplicator.prototype, "admit", () => {
		admissions++;
		return "admitted";
	});
	t.mock.method(Collector.prototype, "admit", () => false);
	await withObservationHost(async (emit) => {
		const pending = emit("tool_call", request);
		try {
			assert.equal(admissions, 1);
		} finally {
			await pending;
		}
	});
});

test("a tool catalog larger than 256 entries still attributes the own source tool", async (t) => {
	const stages: string[] = [];
	t.mock.method(Collector.prototype, "admit", (cell: { observationStage: string }) => {
		stages.push(cell.observationStage);
		return false;
	});
	await withObservationHost(async (emit) => {
		await emit("tool_call", request);
		await emit("tool_result", { ...request, content: [], isError: false });
	}, 300);
	assert.deepEqual(stages, ["tool_request", "tool_result"]);
});

test("an observation uses the current collector after its source read", async (t) => {
	const owners: Collector[] = [];
	const admissions: Collector[] = [];
	t.mock.method(Collector.prototype, "flush", async function (this: Collector) {
		owners.push(this);
	});
	t.mock.method(Collector.prototype, "admit", function (this: Collector) {
		admissions.push(this);
		return false;
	});
	await withObservationHost(async (emit) => {
		await emit("turn_end", {});
		const pending = emit("tool_call", request);
		const started = emit("session_start", { reason: "startup" });
		await emit("turn_end", {});
		await Promise.all([pending, started]);
		assert.equal(owners.length, 2);
		assert.notEqual(owners[0], owners[1]);
		assert.deepEqual(admissions, [owners[1]]);
	});
});
