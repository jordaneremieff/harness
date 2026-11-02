import assert from "node:assert/strict";
import test from "node:test";
import { convertTools, resolveGoogleFunctionCallingMode, supportsGoogleStrictToolSampling } from "@earendil-works/pi-ai/api/google-shared";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEventBus, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { registerRex } from "./index.ts";
import { requestVariants, toolSpecs, validateRequest } from "./schema.ts";
import type { RexResult } from "./core.ts";

const strictBuiltins = [createReadToolDefinition("/test"), createEditToolDefinition("/test"), createWriteToolDefinition("/test")];

test("every provider declaration is a plain object root even when a strict built-in selects validated Google tool calling", () => {
	for (const spec of toolSpecs) {
		const schema = JSON.parse(JSON.stringify(spec.parameters)) as { type?: string; anyOf?: unknown; oneOf?: unknown; required?: string[]; properties: Record<string, { type?: string; enum?: string[]; patternProperties?: unknown }> };
		assert.equal(schema.type, "object", spec.name);
		assert.equal(schema.anyOf, undefined, spec.name);
		assert.equal(schema.oneOf, undefined, spec.name);
		assert.ok(schema.required?.includes("op"), spec.name);
		assert.ok(schema.properties.op?.enum?.length, spec.name);
		for (const [name, property] of Object.entries(schema.properties)) {
			assert.ok(property.type, `${spec.name}.${name} declares a type`);
			assert.equal(property.patternProperties, undefined, `${spec.name}.${name}`);
		}
	}
	for (const modelId of ["gemini-4-argon", "gemini-3.8-flash"]) {
		const tools = [...strictBuiltins, ...toolSpecs.map((spec) => ({ name: spec.name, description: spec.description, parameters: spec.parameters }))];
		const strict = supportsGoogleStrictToolSampling(modelId);
		assert.equal(strict, true);
		assert.equal(resolveGoogleFunctionCallingMode(tools, undefined, strict), "VALIDATED");
		const declarations = convertTools(tools, false, strict)?.[0]?.functionDeclarations ?? [];
		assert.deepEqual(declarations.map((declaration) => declaration.name), tools.map((tool) => tool.name));
		for (const declaration of declarations) {
			const parameters = declaration.parametersJsonSchema as { type?: string; anyOf?: unknown };
			assert.equal(parameters.type, "object", `${modelId} ${declaration.name}`);
			assert.equal(parameters.anyOf, undefined, `${modelId} ${declaration.name}`);
		}
	}
});

test("the provider declaration accepts exactly the union of its operation shapes", () => {
	for (const spec of toolSpecs) {
		const declared = Object.keys(spec.parameters.properties);
		const shapes = requestVariants[spec.name].flatMap((shape) => Object.keys(shape.properties));
		assert.deepEqual(new Set(declared), new Set(shapes), spec.name);
	}
	const owned = toolSpecs.find((spec) => spec.name === "rex_owned");
	assert.deepEqual(owned?.parameters.required, ["op"], "cleanup's required recordId is enforced by the runtime boundary, not the widened declaration");
	assert.deepEqual(toolSpecs.find((spec) => spec.name === "rex_native")?.parameters.required, ["op", "kind"]);
});

test("runtime validation enforces each operation shape", () => {
	const session = "session:00000000-0000-0000-0000-000000000001";
	const accepted: Array<[keyof typeof requestVariants, unknown]> = [
		["rex_environment", { op: "environment" }],
		["rex_environment", { op: "resolve", kind: "block", query: "editor", target: { session, source: "explicit" } }],
		["rex_terminal", { op: "create", kind: "session", label: "repl", command: ["node"], shell: "none" }],
		["rex_terminal", { op: "inspect", view: "capture", maxBytes: 4096 }],
		["rex_terminal", { op: "input", keys: ["enter"] }],
		["rex_terminal", { op: "input", text: "ls\n", observe: true }],
		["rex_wait", { op: "wait", condition: "child_exit", timeoutMs: 5000 }],
		["rex_wait", { op: "wait", condition: "text", text: "ready", maxSnapshots: 4 }],
		["rex_wait", { op: "wait", condition: "status", state: "done", statusId: "build" }],
		["rex_native", { op: "native", kind: "catalog", query: "session.", limit: 5 }],
		["rex_native", { op: "native", kind: "describe", method: "session.list" }],
		["rex_native", { op: "native", kind: "api", method: "session.list", args: { nested: null, empty: {}, list: [] } }],
		["rex_native", { op: "native", kind: "lua", code: "return 1", args: {} }],
		["rex_native", { op: "native", kind: "action", action: "deploy" }],
		["rex_owned", { op: "owned", phase: "unknown", limit: 1 }],
		["rex_owned", { op: "reconcile", recordId: "call-1", release: true, note: "handled" }],
		["rex_owned", { op: "cleanup", recordId: "call-1", forget: true }],
		["rex_status", { op: "snapshot" }],
		["rex_status", { op: "bind", target: { server: "unix:///rex", session, block: "block:00000000-0000-0000-0000-000000000002" } }],
	];
	for (const [tool, args] of accepted) {
		const validated = validateRequest(tool, args);
		assert.equal(validated.ok, true, `${tool} ${JSON.stringify(args)} ${(validated as { error?: string }).error ?? ""}`);
		if (validated.ok) assert.equal(validated.request, args, "validation returns the same arguments, so policy saw exactly what executes");
	}
	const rejected: Array<[keyof typeof requestVariants, unknown, RegExp]> = [
		["rex_environment", { op: "create", kind: "session", label: "x" }, /op must be one of environment, resolve/],
		["rex_environment", { op: "resolve" }, /\/kind missing/],
		["rex_environment", { op: "resolve", kind: "split" }, /kind must be one of session, window, block, client for the selected resolve/],
		["rex_environment", { op: "environment", query: "x" }, /\/query unknown field/],
		["rex_environment", { op: "environment", target: { session, pane: "1" } }, /\/target\/pane unknown field/],
		["rex_environment", { op: "environment", target: { source: "ambient" } }, /\/target\/source/],
		["rex_environment", { op: "environment", timeoutMs: 10 }, /\/timeoutMs/],
		["rex_terminal", { op: "create", kind: "session" }, /\/label missing/],
		["rex_terminal", { op: "create", label: "x" }, /\/kind missing/],
		["rex_terminal", { op: "create", kind: "session", label: "x", ratio: 100 }, /\/ratio/],
		["rex_terminal", { op: "create", kind: "session", label: "x", command: [] }, /\/command/],
		["rex_terminal", { op: "inspect", view: "events" }, /\/view/],
		["rex_terminal", { op: "inspect", label: "x" }, /\/label unknown field/],
		["rex_terminal", { op: "input" }, /input requires text or keys/],
		["rex_terminal", { op: "input", text: "" }, /\/text/],
		["rex_terminal", { op: "input", keys: [] }, /\/keys/],
		["rex_terminal", { op: "input", text: 5 }, /\/text expected string, got integer/],
		["rex_wait", { op: "wait" }, /condition must be one of child_exit, text, status/],
		["rex_wait", { op: "wait", condition: "text" }, /\/text missing/],
		["rex_wait", { op: "wait", condition: "status" }, /\/state missing/],
		["rex_wait", { op: "wait", condition: "status", state: "finished" }, /\/state/],
		["rex_wait", { op: "wait", condition: "child_exit", text: "x" }, /\/text unknown field/],
		["rex_native", { op: "native" }, /kind must be one of catalog, describe, api, lua, action/],
		["rex_native", { op: "native", kind: "describe" }, /\/method missing/],
		["rex_native", { op: "native", kind: "api", method: "m", query: "x" }, /\/query unknown field/],
		["rex_native", { op: "native", kind: "api", method: "m", code: "x" }, /\/code unknown field/],
		["rex_native", { op: "native", kind: "lua" }, /\/code missing/],
		["rex_native", { op: "native", kind: "lua", code: "x", args: [] }, /\/args/],
		["rex_native", { op: "native", kind: "action", method: "m" }, /\/action missing/],
		["rex_native", { op: "native", kind: "catalog", method: "m" }, /\/method unknown field/],
		["rex_native", { op: "native", kind: "catalog", limit: 101 }, /\/limit/],
		["rex_owned", { op: "cleanup" }, /\/recordId missing/],
		["rex_owned", { op: "cleanup", recordId: "" }, /\/recordId/],
		["rex_owned", { op: "cleanup", recordId: "x", release: true }, /\/release unknown field/],
		["rex_owned", { op: "owned", phase: "open" }, /\/phase/],
		["rex_owned", { op: "reconcile", limit: 5 }, /\/limit/],
		["rex_owned", { op: "forget", recordId: "x" }, /op must be one of owned, reconcile, cleanup/],
		["rex_status", { op: "status" }, /op must be one of snapshot, bind, unbind/],
		["rex_status", { op: "snapshot", target: { block: "" } }, /\/target\/block/],
		["rex_status", "snapshot", /arguments must be a JSON object/],
		["rex_status", null, /arguments must be a JSON object/],
	];
	for (const [tool, args, message] of rejected) {
		const validated = validateRequest(tool, args);
		assert.equal(validated.ok, false, `${tool} ${JSON.stringify(args)}`);
		if (validated.ok) continue;
		assert.equal(validated.outcome, "invalid_request");
		assert.match(validated.error, new RegExp(`^Invalid ${tool} request: `));
		assert.match(validated.error, message, `${tool} ${JSON.stringify(args)}: ${validated.error}`);
		assert.deepEqual(validated.effects, { state: "none" });
		assert.match(validated.coverage.note, /nothing was executed/);
	}
});

test("ordinary tools reject invalid requests before any core, ownership or status access", async () => {
	const tools = new Map<string, ToolDefinition<TSchema>>();
	const handlers = new Map<string, () => unknown>();
	const appended: unknown[] = [];
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<TSchema>) => tools.set(tool.name, tool),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as unknown as ExtensionAPI;
	let cores = 0;
	registerRex(pi, { createCore: () => { cores++; return { dispose: () => {}, execute: async () => { throw new Error("Invalid requests must not reach the core."); } }; } });
	const ctx = { cwd: "/test", isIdle: () => true, sessionManager: { getSessionId: () => "validation-session", getEntries: () => [], getSessionFile: () => undefined } } as unknown as ExtensionToolContext;
	try {
		const cases: Array<[string, unknown]> = [
			["rex_owned", { op: "cleanup" }],
			["rex_owned", { op: "cleanup", forget: true }],
			["rex_terminal", { op: "create", kind: "session" }],
			["rex_native", { op: "native", kind: "lua", code: "return 1", query: "x" }],
			["rex_status", { op: "bind", target: { server: "unix:///rex", session: "s", block: "b", extra: 1 } }],
		];
		for (const [name, args] of cases) {
			const tool = tools.get(name);
			assert.ok(tool);
			const result = await tool.execute(`call-${name}`, args, undefined, undefined, ctx);
			assert.equal(result.isError, true, name);
			const value = result.structuredContent as unknown as RexResult;
			assert.equal(value.outcome, "invalid_request");
			assert.equal(value.effects.state, "none");
			assert.deepEqual(result.details, { outcome: "invalid_request", effects: "none" });
			assert.equal(JSON.parse(result.content.map((part) => (part.type === "text" ? part.text : "")).join("")).error, value.error);
		}
		assert.equal(cores, 0, "no core is created for an invalid request");
		assert.deepEqual(appended, [], "no ownership or status entry is written for an invalid request");
	} finally { await handlers.get("session_shutdown")?.(); }
});
