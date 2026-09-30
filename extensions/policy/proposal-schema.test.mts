/** Provider-facing descriptions do not replace strict recursive proposal admission. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { proposalRevision, RuleRegistry, validateLocalCandidate } from "./local-rules.ts";
import { type Condition, PROGRAM_LIMITS, validateFactsProgram } from "./program.ts";
import { PolicyProposeParams, registerRuleTools } from "./tools.ts";

const { validateToolArguments } = await import(
	process.env.PI_POLICY_TEST_PI_ROOT
		? pathToFileURL(join(process.env.PI_POLICY_TEST_PI_ROOT, "node_modules/@earendil-works/pi-ai/dist/index.js")).href
		: "@earendil-works/pi-ai"
);
const leaf = (): Condition => ({ op: "eq", path: ["input", "ready"], value: true });
const request = () => ({
	operation: "add",
	id: "sample.condition",
	purpose: "Check the declared input facts.",
	authority: "exact",
	reason: "Use the declared condition.",
	note: "The condition matched.",
	language: "facts/v1",
	applicability: leaf(),
	program: {
		phase: "input",
		when: leaf(),
		action: { kind: "deny" },
		onUnavailable: "skip",
		state: { observe: leaf(), resetWhen: leaf() },
	},
});
type Request = ReturnType<typeof request>;
const positions = ["applicability", "when", "observe", "resetWhen"] as const;
type Position = (typeof positions)[number];
function setCondition(input: Request, position: Position, condition: unknown) {
	if (position === "applicability") input.applicability = condition as Condition;
	else if (position === "when") input.program.when = condition as Condition;
	else input.program.state[position] = condition as Condition;
}
function nested(depth: number): Condition {
	let condition = leaf();
	for (let index = 0; index < depth; index++) condition = { not: condition };
	return condition;
}
function wide(nodes: number): Condition {
	return {
		all: Array.from({ length: 8 }, (_, index) => ({
			all: Array.from({ length: index < 7 ? 16 : nodes - 121 }, leaf),
		})),
	};
}
const context = {
	cwd: "/workspace",
	model: { provider: "sample", id: "sample" },
	sessionManager: { getSessionId: () => "schema-test" },
} as unknown as ExtensionContext;
type Registered = {
	name: string;
	description: string;
	parameters: typeof PolicyProposeParams;
	execute: (id: string, args: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<unknown>;
};
async function setup(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "policy-schema-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const registry = new RuleRegistry(dir, { catalog: [] });
	const registered = new Map<string, Registered>();
	registerRuleTools(
		{ registerTool: (tool: Registered) => registered.set(tool.name, tool) } as unknown as ExtensionAPI,
		{
			registry,
			loadRegistry: () => registry.snapshot(),
		},
	);
	await registry.snapshot();
	const tool = registered.get("policy_propose");
	assert.ok(tool);
	return {
		registry,
		registered,
		bytes: () => readFile(join(dir, "rules.jsonl")),
		execute: (args: Record<string, unknown>) => {
			const validated = validateToolArguments(tool, {
				type: "toolCall",
				id: "schema-call",
				name: tool.name,
				arguments: args,
			});
			assert.deepEqual(validated, args, "host validation preserves the condition input");
			return tool.execute("schema-call", validated, undefined, undefined, context);
		},
	};
}
const transport = Compile(PolicyProposeParams);

describe("command-aware proposal admission", () => {
	const commandRequest = () => ({
		operation: "add",
		id: "git.push",
		purpose: "Protect branch updates.",
		authority: "steer-or-block",
		reason: "Require safe updates.",
		note: "Use a checked lease.",
		match: { command: "git", cli: { profile: "git", subcommand: ["push"] }, anyFlags: ["--force", "-f"] },
		onUnavailable: "deny",
	});
	it("serializes exact-length literal arrays for both CLI operations without changing admission", async (t) => {
		const { registered } = await setup(t);
		const tool = registered.get("policy_propose");
		assert.ok(tool);
		const schema = JSON.parse(JSON.stringify(tool.parameters));
		const cli = schema.properties.match.anyOf.find(
			(branch: { properties: { cli?: unknown } }) => branch.properties.cli,
		);
		assert.ok(cli);
		for (const operation of ["add", "replace"]) {
			assert.deepEqual(cli.properties.cli.properties.subcommand, {
				type: "array",
				items: { type: "string", const: "push" },
				minItems: 1,
				maxItems: 1,
			});
			for (const subcommand of [
				["push"],
				[],
				["fetch"],
				["PUSH"],
				["push", "push"],
				["push", "extra"],
				[1],
				[null],
				"push",
				null,
				undefined,
			]) {
				const input = {
					...commandRequest(),
					operation,
					...(operation === "replace" ? { expectedRevision: "000000000000" } : {}),
					match: { ...commandRequest().match, cli: { profile: "git", subcommand } },
				};
				const accepted = Array.isArray(subcommand) && subcommand.length === 1 && subcommand[0] === "push";
				assert.equal(transport.Check(input), accepted, JSON.stringify(input));
				const validate = (): unknown =>
					validateToolArguments(
						{ ...tool, parameters: schema },
						{
							type: "toolCall",
							id: "cli-schema",
							name: tool.name,
							arguments: input,
						},
					);
				if (accepted) assert.deepEqual(validate(), input);
				else assert.throws(validate, /Validation failed/);
			}
		}
	});
	it("preserves CLI declarations through host validation, proposal persistence, and replay", async (t) => {
		const host = await setup(t);
		const input = commandRequest();
		assert.equal(transport.Check(input), true);
		await host.execute(input as unknown as Request);
		const matcher = (await host.registry.snapshot()).pending[0].candidate?.matcher;
		assert.deepEqual(matcher, {
			kind: "declarative",
			language: "command-shape/v1",
			spec: input.match,
			onUnavailable: "deny",
		});
	});
	it("rejects unsupported option spellings at local admission without limiting literal flags", () => {
		const input = commandRequest();
		for (const field of ["flags", "anyFlags", "absentFlags"] as const) {
			for (const flag of ["--for", "--force=true", "-uf", "--unknown"]) {
				const spec = { ...input.match, [field]: [flag] };
				const candidate = {
					id: input.id,
					purpose: input.purpose,
					authority: input.authority,
					note: input.note,
					matcher: { kind: "declarative", language: "command-shape/v1", spec, onUnavailable: "deny" },
				};
				assert.throws(() => validateLocalCandidate(candidate), /supported Git push option spellings/);
				assert.doesNotThrow(() =>
					validateLocalCandidate({
						...candidate,
						matcher: { ...candidate.matcher, spec: { command: "git", [field]: [flag] } },
					}),
				);
			}
		}
	});
	it("requires explicit unknown behavior for CLI and rejects unsupported profile declarations", () => {
		const input = commandRequest();
		const { onUnavailable: _omitted, ...missing } = input;
		assert.equal(transport.Check(missing), true, "execution enforces operation-by-form requirements");
		assert.throws(
			() =>
				validateLocalCandidate({
					id: input.id,
					purpose: input.purpose,
					authority: input.authority,
					note: input.note,
					matcher: { kind: "declarative", language: "command-shape/v1", spec: input.match },
				}),
			/explicit onUnavailable/,
		);
		for (const cli of [
			{ profile: "git", subcommand: ["fetch"] },
			{ profile: "other", subcommand: ["push"] },
			{ profile: "git", subcommand: ["push", "extra"] },
			{ profile: "git", subcommand: ["push"], ignored: true },
		]) {
			assert.equal(transport.Check({ ...input, match: { ...input.match, cli } }), false);
		}
		assert.equal(transport.Check({ ...input, onUnavailable: "maybe" }), false);
		assert.equal(transport.Check({ ...input, match: { ...input.match, command: "other" } }), false);
		assert.equal(transport.Check({ ...missing, match: { command: "git", anyFlags: ["-f"] } }), true);
	});
});

describe("operation-by-form execution admission", () => {
	it("rejects invalid combinations with field diagnostics before storage", async (t) => {
		const fixture = await setup(t);
		const before = await fixture.bytes();
		const { language: _language, program: _program, ...common } = request();
		const command = { ...common, match: { command: "scan" } };
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[common, /exactly one authoring form/],
			[{ ...command, predicate: "routing.cat-read" }, /exactly one authoring form/],
			[{ ...request(), match: command.match }, /exactly one authoring form/],
			[{ ...request(), predicate: "routing.cat-read" }, /exactly one authoring form/],
			[{ ...command, purpose: undefined }, /purpose/],
			[{ ...command, authority: undefined }, /authority/],
			[{ ...command, note: undefined }, /note/],
			[{ ...command, operation: "replace" }, /expectedRevision/],
			[{ ...command, expectedRevision: "000000000000" }, /expectedRevision/],
			[{ ...common, program: request().program }, /language/],
			[{ ...command, language: "facts/v1" }, /language/],
			[{ ...request(), onUnavailable: "skip" }, /onUnavailable/],
			[{ ...request(), suggestion: { command: "scan" } }, /suggestion/],
			[{ ...common, predicate: "routing.cat-read", onUnavailable: "skip" }, /onUnavailable/],
			[{ ...command, match: { command: "git", cli: { profile: "git", subcommand: ["push"] } } }, /onUnavailable/],
			[
				{
					...request(),
					authority: "steer-or-block",
					program: { ...request().program, action: { kind: "rename-key", path: [], from: "a", to: "b" } },
				},
				/steer-or-block authority requires an input guide or deny action/,
			],
		];
		for (const operation of ["retire", "disable"]) {
			for (const field of [
				"purpose",
				"authority",
				"note",
				"match",
				"predicate",
				"language",
				"program",
				"applicability",
				"scope",
				"suggestion",
				"expectedRevision",
				"onUnavailable",
			]) {
				const values = {
					...request(),
					match: command.match,
					predicate: "routing.cat-read",
					scope: {},
					suggestion: { command: "scan" },
					expectedRevision: "000000000000",
					onUnavailable: "skip",
				};
				cases.push([
					{ operation, id: common.id, reason: common.reason, [field]: values[field as keyof typeof values] },
					new RegExp(field),
				]);
			}
		}
		for (const [input, diagnostic] of cases) {
			const clean = JSON.parse(JSON.stringify(input));
			assert.equal(transport.Check(clean), true, JSON.stringify(clean));
			await assert.rejects(fixture.execute(clean), diagnostic);
			assert.deepEqual(await fixture.bytes(), before);
		}
		assert.equal((await fixture.registry.snapshot()).pending.length, 0);
	});

	it("accepts every add and replace form and both removal operations", async (t) => {
		const fixture = await setup(t);
		const { language, program, ...common } = request();
		const forms = [
			{ language, program },
			{ match: { command: "scan" } },
			{ match: { command: "git", cli: { profile: "git", subcommand: ["push"] } }, onUnavailable: "deny" },
			{ predicate: "routing.cat-read" },
		];
		for (const [index, form] of forms.entries()) {
			const id = `sample.form-${index}`;
			await fixture.execute({ ...common, ...form, id });
			const proposal = (await fixture.registry.snapshot()).pending.find((entry) => entry.ruleId === id);
			assert.ok(proposal);
			await fixture.registry.decide(
				proposal.id,
				"approved",
				undefined,
				{
					surface: "command",
					at: new Date().toISOString(),
					session: "schema-test",
					model: null,
				},
				proposalRevision(proposal),
			);
			const record = (await fixture.registry.snapshot()).records.get(id);
			assert.ok(record);
			await fixture.execute({
				...common,
				...form,
				id,
				operation: "replace",
				expectedRevision: record.definition.revision,
			});
			const replacement = (await fixture.registry.snapshot()).pending.find((entry) => entry.ruleId === id);
			assert.equal(replacement?.operation, "replace");
			assert.ok(replacement);
			await fixture.registry.decide(replacement.id, "rejected", undefined, {
				surface: "command",
				at: new Date().toISOString(),
				session: "schema-test",
				model: null,
			});
		}
		await fixture.execute({ operation: "retire", id: "sample.form-0", reason: "Retire this rule." });
		await fixture.execute({ operation: "disable", id: "sample.form-1", reason: "Disable this rule." });
		assert.deepEqual(
			(await fixture.registry.snapshot()).pending.map((entry) => entry.operation),
			["retire", "disable"],
		);
	});
});

describe("finite proposal description and recursive admission", () => {
	it("preserves the proposal vocabulary through the real Anthropic request converter", async (t) => {
		const { registered } = await setup(t);
		const { stream } = await import(
			process.env.PI_POLICY_TEST_PI_ROOT
				? pathToFileURL(
						join(
							process.env.PI_POLICY_TEST_PI_ROOT,
							"node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
						),
					).href
				: "@earendil-works/pi-ai/api/anthropic-messages"
		);
		let payload:
			| { tools: Array<{ name: string; input_schema: { properties: Record<string, unknown>; required: string[] } }> }
			| undefined;
		const result = await stream(
			{
				provider: "anthropic",
				id: "controlled",
				api: "anthropic-messages",
				name: "Controlled",
				baseUrl: "https://api.anthropic.com",
				reasoning: false,
				input: ["text"],
				contextWindow: 8192,
				maxTokens: 64,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				messages: [
					{
						role: "system",
						content: "Controlled schema inspection",
						toolsAdded: [...registered.values()],
						timestamp: 0,
					},
					{ role: "user", content: "Inspect schemas", timestamp: 0 },
				],
			},
			{
				client: { beta: { messages: { create: () => assert.fail("Schema inspection must not send a request") } } },
				onPayload(value: typeof payload) {
					payload = value;
					throw new Error("schema inspection complete");
				},
			},
		).result();
		assert.match(result.errorMessage ?? "", /schema inspection complete/);
		assert.ok(payload);
		const tool = registered.get("policy_propose");
		assert.ok(tool);
		const schema = JSON.parse(JSON.stringify(tool.parameters));
		const projectedTool = payload.tools.find((item) => item.name === tool.name);
		assert.ok(projectedTool);
		const projected = projectedTool.input_schema;
		assert.deepEqual(
			Object.keys(projected.properties).sort(),
			[
				"applicability",
				"authority",
				"expectedRevision",
				"id",
				"language",
				"match",
				"note",
				"onUnavailable",
				"operation",
				"predicate",
				"program",
				"purpose",
				"reason",
				"scope",
				"suggestion",
			].sort(),
		);
		assert.deepEqual(projected.required, ["operation", "id", "reason"]);
		assert.deepEqual(projected.properties, schema.properties);
		assert.equal(JSON.stringify(projected).split("Conditions use exactly one of").length - 1, 1);
		assert.equal(transport.Check({ operation: "retire", id: "sample.rule", reason: "Retire it." }), true);
		assert.equal(transport.Check({ operation: "add", id: "sample.rule", reason: "Add it." }), true);
	});

	it("declares a bounded flat object with one complete nested grammar statement", async (t) => {
		const { registered } = await setup(t);
		const schema = registered.get("policy_propose")?.parameters;
		assert.ok(schema);
		assert.equal(schema.type, "object");
		for (const key of ["anyOf", "oneOf", "allOf"]) assert.equal(key in schema, false, key);
		assert.deepEqual(schema.required, ["operation", "id", "reason"]);
		const serialized = JSON.stringify(schema);
		assert.ok(Buffer.byteLength(serialized) < 20_000, "the declaration must not repeat operation variants");
		assert.equal(serialized.split("Conditions use exactly one of").length - 1, 1);
		assert.match(serialized, /policy_rules view=authoring/);
	});

	it("registers finite schemas without recursive reference keywords", async (t) => {
		const { registered } = await setup(t);
		assert.deepEqual([...registered.keys()].sort(), ["policy_propose", "policy_rules"]);
		for (const tool of registered.values()) {
			const serialized = JSON.stringify(tool.parameters);
			assert.doesNotMatch(serialized, /"\$(?:ref|defs|dynamicRef|recursiveRef)"/);
		}
		assert.match(JSON.stringify(PolicyProposeParams), /Every nested object receives strict local validation/);
	});

	for (const position of positions) {
		it(`preserves valid nested ${position} through host validation and storage`, async (t) => {
			const fixture = await setup(t);
			const input = request();
			setCondition(input, position, { all: [leaf(), { any: [{ not: leaf() }, leaf()] }] });
			assert.equal(transport.Check(input), true);
			await fixture.execute(input);
			const snapshot = await fixture.registry.snapshot();
			assert.equal(snapshot.records.size, 0);
			assert.equal(snapshot.pending.length, 1);
			const pending = snapshot.pending[0];
			assert.ok(pending);
			const candidate = pending.candidate;
			assert.ok(candidate);
			assert.deepEqual(candidate.applicability, input.applicability);
			assert.equal(candidate.matcher.kind, "declarative");
			if (candidate.matcher.kind === "declarative") assert.deepEqual(candidate.matcher.spec, input.program);
		});

		it(`rejects invalid nested ${position} before any proposal append`, async (t) => {
			const fixture = await setup(t);
			const before = await fixture.bytes();
			const invalid = [
				{ not: { op: "script", path: ["input"], value: "code" } },
				{ not: { ...leaf(), extra: true } },
				{ not: { all: [leaf()], not: leaf() } },
				{ not: { all: [] } },
				{ not: { all: Array.from({ length: PROGRAM_LIMITS.children + 1 }, leaf) } },
				{ not: { op: "eq", path: ["input", "__proto__"], value: true } },
				{ not: { op: "eq", path: ["private"], value: true } },
				{ not: { op: "gt", path: ["input"], value: "3" } },
				{ not: { op: "exists", path: ["input"], value: true } },
				{ not: { op: "lookup", path: ["input"], table: "missing", value: "unique" } },
				{ not: { op: "matches-schema", path: ["result"], schemaData: "missing" } },
				{ not: { op: "eq", path: ["input"], value: "x".repeat(70_000) } },
				nested(PROGRAM_LIMITS.depth + 1),
			];
			for (const condition of invalid) {
				const input = request();
				setCondition(input, position, condition);
				assert.equal(transport.Check(input), true, "finite descriptions defer nested validation");
				await assert.rejects(fixture.execute(input));
				assert.deepEqual(await fixture.bytes(), before);
				assert.equal((await fixture.registry.snapshot()).pending.length, 0);
			}
		});
	}

	it("checks applicability for every authoring form and replacement before storage", async (t) => {
		const fixture = await setup(t);
		const before = await fixture.bytes();
		const { program, language, ...common } = request();
		for (const form of [{ language, program }, { match: { command: "scan" } }, { predicate: "routing.cat-read" }]) {
			for (const operation of ["add", "replace"]) {
				const input = {
					...common,
					...form,
					operation,
					...(operation === "replace" ? { expectedRevision: "000000000000" } : {}),
					applicability: { not: { ...leaf(), unexpected: true } },
				};
				assert.equal(transport.Check(input), true);
				await assert.rejects(fixture.execute(input as Request), /applicability/);
				assert.deepEqual(await fixture.bytes(), before);
			}
		}
	});

	it("keeps the complete shared node budget and accepted depth", async (t) => {
		const fixture = await setup(t);
		const input = request();
		input.program.when = wide(PROGRAM_LIMITS.nodes - 3);
		await fixture.execute(input);
		const before = await fixture.bytes();
		input.id = "sample.excess";
		input.program.when = wide(PROGRAM_LIMITS.nodes - 2);
		assert.equal(validateFactsProgram(input.program), undefined, "program alone fits the budget");
		await assert.rejects(fixture.execute(input), /grammar bounds/);
		assert.deepEqual(await fixture.bytes(), before);
		const deep = request();
		deep.id = "sample.deep";
		deep.program.when = nested(PROGRAM_LIMITS.depth);
		await fixture.execute(deep);
	});

	it("keeps phase/action and authority checks after transport validation", async (t) => {
		const fixture = await setup(t);
		const before = await fixture.bytes();
		const invalidPhase = request();
		invalidPhase.program.phase = "result";
		const invalidAuthority = request();
		invalidAuthority.authority = "steer-or-block";
		Object.assign(invalidAuthority.program, { action: { kind: "rename-key", path: [], from: "a", to: "b" } });
		for (const input of [invalidPhase, invalidAuthority]) {
			assert.equal(transport.Check(input), true);
			await assert.rejects(fixture.execute(input));
			assert.deepEqual(await fixture.bytes(), before);
		}
	});
});
