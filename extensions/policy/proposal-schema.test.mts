/** Provider-facing descriptions do not replace strict recursive proposal admission. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { RuleRegistry, validateLocalCandidate } from "./local-rules.ts";
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
	const tool = registered.get("policy_propose")!;
	return {
		registry,
		registered,
		bytes: () => readFile(join(dir, "rules.jsonl")),
		execute: (args: Request) => {
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
		const tool = registered.get("policy_propose")!;
		const schema = JSON.parse(JSON.stringify(tool.parameters));
		const branches = schema.anyOf.filter(
			(branch: { properties: { match?: { properties: { cli?: unknown } } } }) =>
				branch.properties.match?.properties.cli,
		);
		assert.equal(branches.length, 2);
		assert.deepEqual(
			branches.map((branch: { properties: { operation: { const: string } } }) => branch.properties.operation.const),
			["add", "replace"],
		);
		for (const branch of branches) {
			assert.deepEqual(branch.properties.match.properties.cli.properties.subcommand, {
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
					operation: branch.properties.operation.const,
					...(branch.properties.operation.const === "replace" ? { expectedRevision: "000000000000" } : {}),
					match: { ...commandRequest().match, cli: { profile: "git", subcommand } },
				};
				const accepted = Array.isArray(subcommand) && subcommand.length === 1 && subcommand[0] === "push";
				assert.equal(transport.Check(input), accepted, JSON.stringify(input));
				const validate = () =>
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
		assert.equal(transport.Check(missing), false);
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

describe("finite proposal description and recursive admission", () => {
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
			const candidate = snapshot.pending[0].candidate!;
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
