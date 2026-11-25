import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	convertTools,
	resolveGoogleFunctionCallingMode,
	supportsGoogleStrictToolSampling,
} from "@earendil-works/pi-ai/api/google-shared";
import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	createEventBus,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { compile, type Schema } from "@earendil-works/pi-schema";
import { registerRex } from "./index.ts";
import { prepareRequest, requestVariants, ResultSchema, toolSpecs, validateRequest } from "./schema.ts";
import type { RexResult } from "./core.ts";

const strictBuiltins = [
	createReadToolDefinition("/test"),
	createEditToolDefinition("/test"),
	createWriteToolDefinition("/test"),
];

test("every provider declaration is a plain object root even when a strict built-in selects validated Google tool calling", () => {
	for (const spec of toolSpecs) {
		const schema = JSON.parse(JSON.stringify(spec.parameters)) as {
			type?: string;
			anyOf?: unknown;
			oneOf?: unknown;
			required?: string[];
			properties: Record<string, { type?: string; enum?: string[]; patternProperties?: unknown }>;
		};
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
	const google: Model<"google-generative-ai"> = {
		api: "google-generative-ai",
		provider: "google",
		id: "vendor-gemini-4-argon",
		name: "Strict tool test",
		baseUrl: "https://example.invalid",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 8192,
		maxTokens: 1024,
	};
	for (const model of [google, { ...google, id: "deployment-alias", compat: { supportsStrictMode: true } }]) {
		const tools = [
			...strictBuiltins,
			...toolSpecs.map((spec) => ({ name: spec.name, description: spec.description, parameters: spec.parameters })),
		];
		const strict = supportsGoogleStrictToolSampling(model);
		assert.equal(strict, true);
		assert.equal(resolveGoogleFunctionCallingMode(tools, undefined, strict), "VALIDATED");
		const declarations = convertTools(tools, false, strict)?.[0]?.functionDeclarations ?? [];
		assert.deepEqual(
			declarations.map((declaration) => declaration.name),
			tools.map((tool) => tool.name),
		);
		for (const declaration of declarations) {
			const parameters = declaration.parametersJsonSchema as { type?: string; anyOf?: unknown };
			assert.equal(parameters.type, "object", `${model.id} ${declaration.name}`);
			assert.equal(parameters.anyOf, undefined, `${model.id} ${declaration.name}`);
		}
	}
});

test("the provider declaration accepts exactly the union of its operation shapes", () => {
	for (const spec of toolSpecs) {
		const declared = Object.keys(spec.parameters.properties);
		const shapes = requestVariants[spec.name].flatMap((shape) => {
			assert.ok(shape.properties && typeof shape.properties === "object");
			return Object.keys(shape.properties);
		});
		assert.deepEqual(new Set(declared), new Set(shapes), spec.name);
	}
	const owned = toolSpecs.find((spec) => spec.name === "rex_owned");
	assert.deepEqual(
		owned?.parameters.required,
		["op"],
		"cleanup's required recordId is enforced by the runtime boundary, not the widened declaration",
	);
	assert.deepEqual(toolSpecs.find((spec) => spec.name === "rex_native")?.parameters.required, ["op", "kind"]);
});

test("the terminal declaration states the key syntax that input accepts", () => {
	const keys = toolSpecs.find((spec) => spec.name === "rex_terminal")?.parameters.properties.keys;
	assert.match(String(keys?.description), /modifiers joined by \+.*enter, ctrl\+c or shift\+left/u);
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
		["rex_owned", { op: "observe", recordId: "call-1", maxBytes: 1024, timeoutMs: 1000 }],
		["rex_owned", { op: "observe", phase: "pending", offset: 1, limit: 4 }],
		["rex_owned", { op: "reconcile", recordId: "call-1", release: true, note: "handled" }],
		["rex_owned", { op: "cleanup", recordId: "call-1", forget: true }],
		["rex_status", { op: "snapshot", timeoutMs: 1000 }],
		["rex_status", { op: "unbind", timeoutMs: 1000 }],
		[
			"rex_status",
			{
				op: "bind",
				timeoutMs: 1000,
				target: { server: "unix:///rex", session, block: "block:00000000-0000-0000-0000-000000000002" },
			},
		],
	];
	for (const [tool, args] of accepted) {
		const declaration = toolSpecs.find((spec) => spec.name === tool);
		assert.ok(declaration);
		assert.equal(
			compile(declaration.parameters).check(args),
			true,
			`${tool} provider declaration accepts ${JSON.stringify(args)}`,
		);
		const validated = validateRequest(tool, args);
		assert.equal(
			validated.ok,
			true,
			`${tool} ${JSON.stringify(args)} ${(validated as { error?: string }).error ?? ""}`,
		);
		if (validated.ok)
			assert.equal(
				validated.request,
				args,
				"validation returns the same arguments, so policy saw exactly what executes",
			);
	}
	const rejected: Array<[keyof typeof requestVariants, unknown, RegExp]> = [
		["rex_environment", { op: "create", kind: "session", label: "x" }, /op must be one of environment, resolve/],
		["rex_environment", { op: "resolve" }, /\/kind missing/],
		[
			"rex_environment",
			{ op: "resolve", kind: "split" },
			/kind must be one of session, window, block, client for the selected resolve/,
		],
		["rex_environment", { op: "environment", query: "x" }, /query applies only to op resolve$/],
		["rex_environment", { op: "environment", kind: "block" }, /kind applies only to op resolve$/],
		["rex_environment", { op: "environment", pane: "1" }, /\/pane unknown field/],
		["rex_environment", { op: "environment", target: { session, pane: "1" } }, /\/target\/pane unknown field/],
		["rex_environment", { op: "environment", target: { source: "ambient" } }, /\/target\/source/],
		["rex_environment", { op: "environment", timeoutMs: 10 }, /\/timeoutMs/],
		["rex_terminal", { op: "create", kind: "session" }, /\/label missing/],
		["rex_terminal", { op: "create", label: "x" }, /\/kind missing/],
		["rex_terminal", { op: "create", kind: "session", label: "x", ratio: 100 }, /\/ratio/],
		["rex_terminal", { op: "create", kind: "session", label: "x", command: [] }, /\/command/],
		["rex_terminal", { op: "inspect", view: "events" }, /\/view/],
		["rex_terminal", { op: "inspect", label: "x" }, /label applies only to op create$/],
		["rex_terminal", { op: "input", text: "x", maxBytes: 4096 }, /maxBytes applies only to op inspect$/],
		["rex_terminal", { op: "input", kind: "split", text: "x" }, /kind applies only to op create$/],
		["rex_terminal", { op: "input" }, /input requires text or keys/],
		["rex_terminal", { op: "input", text: "" }, /\/text/],
		["rex_terminal", { op: "input", keys: [] }, /\/keys/],
		["rex_terminal", { op: "input", text: 5 }, /\/text expected string, got integer/],
		["rex_wait", { op: "wait" }, /condition must be one of child_exit, text, status/],
		["rex_wait", { op: "wait", condition: "text" }, /\/text missing/],
		["rex_wait", { op: "wait", condition: "status" }, /\/state missing/],
		["rex_wait", { op: "wait", condition: "status", state: "finished" }, /\/state/],
		["rex_wait", { op: "wait", condition: "child_exit", text: "x" }, /text applies only to condition text$/],
		[
			"rex_wait",
			{ op: "wait", condition: "child_exit", maxSnapshots: 4 },
			/maxSnapshots applies only to condition text, status$/,
		],
		[
			"rex_wait",
			{ op: "wait", condition: "text", text: "x", state: "done" },
			/state applies only to condition status$/,
		],
		["rex_native", { op: "native" }, /kind must be one of catalog, describe, api, lua, action/],
		["rex_native", { op: "native", kind: "describe" }, /\/method missing/],
		["rex_native", { op: "native", kind: "api", method: "m", query: "x" }, /query applies only to kind catalog$/],
		["rex_native", { op: "native", kind: "api", method: "m", code: "x" }, /code applies only to kind lua$/],
		["rex_native", { op: "native", kind: "lua" }, /\/code missing/],
		["rex_native", { op: "native", kind: "lua", code: "x", args: [] }, /\/args/],
		["rex_native", { op: "native", kind: "action", method: "m" }, /\/action missing/],
		["rex_native", { op: "native", kind: "catalog", method: "m" }, /method applies only to kind describe, api$/],
		["rex_native", { op: "native", kind: "catalog", limit: 101 }, /\/limit/],
		["rex_owned", { op: "cleanup" }, /\/recordId missing/],
		["rex_owned", { op: "cleanup", recordId: "" }, /\/recordId/],
		["rex_owned", { op: "cleanup", recordId: "x", release: true }, /release applies only to op reconcile$/],
		["rex_owned", { op: "owned", forget: true }, /: forget applies only to op cleanup$/],
		["rex_owned", { op: "reconcile", phase: "closed" }, /phase applies only to op owned, observe$/],
		["rex_owned", { op: "owned", phase: "open" }, /\/phase/],
		["rex_owned", { op: "reconcile", limit: 5 }, /\/limit/],
		["rex_owned", { op: "observe", target: { session } }, /target applies only to op owned, reconcile, cleanup$/],
		["rex_owned", { op: "observe", recover: true }, /recover applies only to op reconcile$/],
		["rex_owned", { op: "observe", maxBytes: 16385 }, /\/maxBytes/],
		["rex_owned", { op: "observe", limit: 5 }, /\/limit/],
		["rex_owned", { op: "forget", recordId: "x" }, /op must be one of owned, observe, reconcile, cleanup/],
		["rex_status", { op: "status" }, /op must be one of snapshot, bind, unbind/],
		["rex_status", { op: "snapshot", target: { block: "" } }, /\/target\/block/],
		["rex_status", { op: "snapshot", timeoutMs: 0 }, /\/timeoutMs/],
		["rex_status", { op: "snapshot", timeoutMs: 300001 }, /\/timeoutMs/],
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

test("a misplaced field names the operation that accepts it in one plain sentence", () => {
	const forget = validateRequest("rex_owned", { op: "owned", forget: true });
	assert.equal(forget.ok, false);
	if (!forget.ok) assert.equal(forget.error, "Invalid rex_owned request: forget applies only to op cleanup");
	const snapshots = validateRequest("rex_wait", { op: "wait", condition: "child_exit", maxSnapshots: 4 });
	assert.equal(snapshots.ok, false);
	if (!snapshots.ok)
		assert.equal(snapshots.error, "Invalid rex_wait request: maxSnapshots applies only to condition text, status");
});

test("a rex_terminal request that names kind without op is prepared as a create without changing its input", () => {
	const split = {
		kind: "split",
		direction: "right",
		focus: false,
		keepOpen: false,
		label: "Reader",
		command: ["reader", "/docs/report.md"],
	};
	const before = structuredClone(split);
	const prepared = prepareRequest("rex_terminal", split);
	assert.deepEqual(prepared, { op: "create", ...split });
	assert.notEqual(prepared, split);
	assert.deepEqual(split, before, "the stored arguments stay unchanged for a host that prepares them again");
	assert.deepEqual(prepareRequest("rex_terminal", prepared), prepared);
	assert.equal(prepareRequest("rex_terminal", prepared), prepared, "a prepared create is returned unchanged");
	assert.deepEqual(prepareRequest("rex_terminal", { op: undefined, kind: "float", label: "x" }), {
		op: "create",
		kind: "float",
		label: "x",
	});
	const validated = validateRequest("rex_terminal", prepared);
	assert.equal(validated.ok, true);
	if (validated.ok) assert.equal(validated.request, prepared);
	const declaration = toolSpecs.find((spec) => spec.name === "rex_terminal")?.parameters;
	assert.ok(declaration);
	assert.ok(declaration.required.includes("op"), "the declared contract still requires op");
	assert.equal(compile(declaration).check(split), false);
	assert.equal(compile(declaration).check(prepared), true);
	const unchanged: Array<[string, unknown]> = [
		["rex_terminal", { op: "inspect", view: "capture" }],
		["rex_terminal", { op: "input", kind: "split", text: "x" }],
		["rex_terminal", { label: "no kind" }],
		["rex_terminal", { kind: undefined, label: "no kind" }],
		["rex_terminal", null],
		["rex_terminal", "create"],
		["rex_terminal", [{ kind: "split" }]],
		[
			"rex_terminal",
			new (class Request {
				kind = "split";
			})(),
		],
		["rex_environment", { kind: "block" }],
		["rex_native", { kind: "lua", code: "return 1" }],
		["rex_owned", { kind: "split" }],
		["rex_wait", { kind: "split" }],
		["rex_status", { kind: "split" }],
	];
	for (const [tool, args] of unchanged)
		assert.equal(prepareRequest(tool, args), args, `${tool} ${JSON.stringify(args)}`);
});

test("descriptions name the owning operation of fields that the flat declaration hides", () => {
	const spec = (tool: string) => toolSpecs.find((entry) => entry.name === tool);
	const field = (tool: string, name: string) =>
		String((spec(tool)?.parameters.properties[name] as { description?: unknown } | undefined)?.description);
	assert.match(field("rex_owned", "forget"), /^Op cleanup only: /);
	assert.match(field("rex_owned", "recover"), /^Op reconcile with one recordId only: /);
	assert.match(field("rex_owned", "release"), /^Op reconcile with one recordId and a note only: /);
	assert.match(field("rex_owned", "note"), /^Op reconcile with release only: /);
	assert.match(field("rex_owned", "phase"), /^Ops owned and observe only: .*open claims only/);
	assert.match(field("rex_owned", "maxBytes"), /^Op observe only: /);
	assert.match(field("rex_owned", "offset"), /^Ops owned, observe and reconcile only: /);
	assert.match(field("rex_wait", "maxSnapshots"), /^Conditions text and status only: .*defaults to 24/);
	assert.match(field("rex_terminal", "maxBytes"), /^Op inspect only: /);
	assert.match(field("rex_terminal", "view"), /^Op inspect only: /);
	assert.match(field("rex_terminal", "observe"), /^Op input only: /);
	assert.match(
		String(spec("rex_native")?.description),
		/Lua reads its arguments from rex\.args; rex\.call\(method, params\) returns the result, or nil and an error string\./,
	);
	assert.match(
		String(spec("rex_wait")?.description),
		/Text waits match the most recent output at each snapshot, so output that scrolls further between snapshots is missed; on busy terminals wait for a final line, a status or child exit\./,
	);
});

test("result validation keeps the envelope closed and nested result objects open", () => {
	const validate = compile(ResultSchema);
	const result = {
		ok: true,
		outcome: "observed",
		records: [{ recordId: "call", server: {}, resources: [], extra: "record metadata" }],
		effects: { state: "none", extra: "effect metadata" },
		coverage: {
			bounded: true,
			extra: "coverage metadata",
			deadline: { effectiveMs: 1000, elapsedMs: 1200, phase: "finalise", overrunMs: 200 },
		},
	};
	assert.equal(validate.check(result), true);
	for (const invalid of [{ effectiveMs: 0 }, { elapsedMs: -1 }, { phase: "other" }, { overrunMs: -1 }]) {
		assert.equal(
			validate.check({
				...result,
				coverage: { ...result.coverage, deadline: { ...result.coverage.deadline, ...invalid } },
			}),
			false,
		);
	}
	assert.equal(validate.check({ ...result, extra: true }), false);
	assert.equal(validate.check({ ...result, effects: { state: "other" } }), false);
	assert.equal(validate.check({ ...result, coverage: { bounded: false } }), false);
	assert.equal(validate.check({ ...result, coverage: { bounded: true, omittedRecordRefs: -1 } }), false);
	assert.equal(validate.check({ ...result, coverage: { bounded: true, truncatedFields: ["unknown"] } }), false);
});

test("ordinary tools reject invalid requests before any core, ownership or status access", async () => {
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, () => unknown>();
	const appended: unknown[] = [];
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool),
		registerCommand: () => {},
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as unknown as ExtensionAPI;
	let cores = 0;
	registerRex(pi, {
		createCore: () => {
			cores++;
			return {
				dispose: () => {},
				execute: async () => {
					throw new Error("Invalid requests must not reach the core.");
				},
			};
		},
	});
	const ctx = {
		cwd: "/test",
		isIdle: () => true,
		sessionManager: { getSessionId: () => "validation-session", getEntries: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
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
			assert.equal(
				JSON.parse(result.content.map((part) => (part.type === "text" ? part.text : "")).join("")).error,
				value.error,
			);
		}
		assert.equal(cores, 0, "no core is created for an invalid request");
		assert.deepEqual(appended, [], "no ownership or status entry is written for an invalid request");
	} finally {
		await handlers.get("session_shutdown")?.();
	}
});
