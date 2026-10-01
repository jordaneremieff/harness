import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RuleSnapshot } from "./local-rules.ts";
import type { PolicyMode } from "./mode.ts";
import type { FactsProgram } from "./program.ts";
import type { RuleRecord } from "./rule.ts";
import { PolicyRuntime } from "./runtime.ts";

const piRoot = process.env.PI_POLICY_TEST_PI_ROOT
	? resolve(process.env.PI_POLICY_TEST_PI_ROOT)
	: resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(
	pathToFileURL(join(piRoot, "dist/index.js")).href
);
const nestedAi = join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js");
const ai: typeof import("@earendil-works/pi-ai") = await import(
	pathToFileURL(existsSync(nestedAi) ? nestedAi : resolve(piRoot, "../pi-ai/dist/index.js")).href
);
const version = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")).version;
const guide = "Check the returned evidence before the next action.";
const selected = `[policy] ${guide}`;

function text(message: { content: unknown } | undefined): string {
	assert.ok(message);
	if (typeof message.content === "string") return message.content;
	assert.ok(Array.isArray(message.content));
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function record(id: string, program: FactsProgram): RuleRecord {
	return {
		id,
		source: { kind: "package" },
		matcher: { kind: "declarative", language: "facts/v1", spec: program },
		definition: {
			purpose: "Preserve result guidance.",
			authority: "exact",
			revision: "123456abcdef",
			state: "active",
			effect: program.action.kind === "guide" ? "steer" : "correct",
			note: "Controlled result rule.",
		},
		matcherAvailable: true,
		staleOverride: false,
	};
}
function guidance(state?: FactsProgram["state"], value = guide): RuleRecord {
	return record("result.guide", {
		phase: "result",
		selector: { tools: ["sample_structured", "sample_text"] },
		when: { op: "exists", path: ["result"] },
		action: { kind: "guide", text: value },
		onUnavailable: "skip",
		...(state ? { state } : {}),
	});
}

async function fixture(
	options: {
		rules?: RuleRecord[];
		mode?: PolicyMode;
		enabled?: boolean;
		degraded?: boolean;
		redact?: "text" | "structured";
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "policy-nested-"));
	const faux = ai.fauxProvider({
		provider: "policy-nested-test",
		models: [{ id: "controlled", contextWindow: 100000 }],
		tokensPerSecond: 0,
	});
	const modelRuntime = await sdk.ModelRuntime.create({
		credentials: new ai.InMemoryCredentialStore(),
		modelsStore: new ai.InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const rules = options.rules ?? [guidance()];
	const snapshot: RuleSnapshot = {
		records: new Map(rules.map((rule) => [rule.id, rule])),
		pending: [],
		data: new Map(),
		health: { status: options.degraded ? "degraded" : "ok", path: "rules.jsonl" },
	};
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const events: ToolResultEvent[] = [];
	const errors: string[] = [];
	let now = 10000;
	let runtime: PolicyRuntime;
	const policy: ExtensionFactory = (pi) => {
		if (options.redact)
			pi.on("tool_result", (event) => {
				if (event.toolName !== "sample_structured") return;
				return {
					content: [{ type: "text", text: "redacted" }],
					...(options.redact === "structured" ? { structuredContent: { value: 0, failed: false } } : {}),
				};
			});
		runtime = new PolicyRuntime(
			pi,
			async () => {
				runtime.sync(snapshot);
				return snapshot;
			},
			() => options.mode ?? "enforce",
			root,
			() => options.enabled !== false,
			{ enqueue: () => true, close: async () => {} },
			() => now,
		);
		runtime.sync(snapshot);
		runtime.attach();
		pi.on("tool_result", (event) => {
			events.push(structuredClone(event));
		});
		for (const name of ["sample_structured", "sample_text"])
			pi.registerTool({
				name,
				label: name,
				description: "Return controlled data.",
				parameters: Type.Object({ fail: Type.Optional(Type.Boolean()) }),
				...(name === "sample_structured"
					? { outputSchema: Type.Object({ value: Type.Number(), failed: Type.Boolean() }) }
					: {}),
				async execute(_id, input) {
					const value = { value: 7, failed: input.fail === true };
					return {
						content: [{ type: "text", text: "sample result" }],
						details: { failed: value.failed },
						isError: value.failed,
						...(name === "sample_structured" ? { structuredContent: value } : {}),
					};
				},
			});
	};
	const loader = new sdk.DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [policy, sdk.createCodemodeExtension({ mode: "on" })],
	});
	let session: InstanceType<typeof sdk.AgentSession> | undefined;
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await sdk.createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			resourceLoader: loader,
			settingsManager,
			sessionManager: sdk.SessionManager.inMemory(root),
			modelRuntime,
			model: faux.getModel(),
			tools: ["codemode", "sample_structured", "sample_text"],
		}));
		await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
		const active = session;
		return {
			session: active,
			events,
			state: async () =>
				(await runtime.inspect("state", {}, active.extensionRunner.createContext())) as {
					observationPeriods: Array<{ id: string; projected: number }>;
				},
			advance: (ms: number) => {
				now += ms;
			},
			async run(calls: ToolCall[], check: (context: Context) => void) {
				const before = faux.state.callCount;
				const failures: unknown[] = [];
				faux.setResponses([
					ai.fauxAssistantMessage(calls),
					(context) => {
						try {
							check(context);
						} catch (error) {
							failures.push(error);
						}
						return ai.fauxAssistantMessage("Finished.");
					},
				]);
				await active.prompt("Run the controlled tool calls.");
				assert.equal(faux.state.callCount - before, 2, "only the tool request and its natural follow-up execute");
				assert.equal(faux.getPendingResponseCount(), 0);
				assert.deepEqual(errors, []);
				if (failures.length) throw failures[0];
			},
			guides: () =>
				active.messages.filter(
					(message): message is Extract<typeof message, { role: "custom" }> =>
						message.role === "custom" && message.customType === "policy_result_guidance",
				),
			async close() {
				await active.dispose();
				await rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await session?.dispose();
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
let callSequence = 0;
function script(code: string, id = `nested-${++callSequence}`): ToolCall {
	return ai.fauxToolCall("codemode", { code }, { id });
}
function lastResult(context: Context) {
	const result = context.messages.findLast((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, false, text(result));
	return result;
}

test(`native codemode preserves structured success and error with result guidance (Pi ${version})`, {
	timeout: 30000,
}, async () => {
	const f = await fixture();
	try {
		for (const fail of [false, true]) {
			await f.run(
				[
					script(
						`const value = await tools.sample_structured({fail:${fail}}); if (JSON.stringify(value) !== '${JSON.stringify({ value: 7, failed: fail })}') throw new Error("Wrong shape"); text(value.value);`,
					),
				],
				(context) => {
					assert.match(text(lastResult(context)), /\b7\b/);
					assert.equal(text(context.messages.at(-1)), selected);
					assert.equal(context.messages.at(-1)?.role, "user");
				},
			);
			const result = f.events.findLast((event) => event.toolName === "sample_structured");
			assert.ok(result);
			assert.deepEqual(result.structuredContent, { value: 7, failed: fail });
			assert.equal(result.isError, fail);
			assert.equal(result.content.at(-1)?.type, "text");
			assert.equal(text(result), `sample result\n${selected}`);
		}
		assert.equal(f.guides().length, 2);
		assert.ok(f.guides().every((message) => message.role === "custom" && !message.display));
	} finally {
		await f.close();
	}
});

test("discarded structured and text results deliver guidance after the complete outer tool batch", {
	timeout: 30000,
}, async () => {
	const f = await fixture();
	try {
		await f.run(
			[
				script('await tools.sample_structured({}); text("discarded data");', "structured"),
				script('await tools.sample_text({}); text("discarded text");', "text"),
			],
			(context) => {
				const tail = context.messages.slice(-4);
				assert.deepEqual(
					tail.map((message) => message.role),
					["toolResult", "toolResult", "user", "user"],
				);
				for (const result of tail.slice(0, 2)) assert.doesNotMatch(text(result), /Check the returned evidence/);
				for (const message of tail.slice(2)) assert.equal(text(message), selected);
			},
		);
		assert.equal(f.guides().length, 2);
	} finally {
		await f.close();
	}
});

test("caught nested text errors retain guidance outside the script", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		await f.run(
			[
				script(
					'try { await tools.sample_text({fail:true}); throw new Error("Expected failure"); } catch (error) { if (!error.message.includes("sample result")) throw error; } text("caught");',
				),
			],
			(context) => {
				assert.match(text(lastResult(context)), /caught/);
				assert.equal(text(context.messages.at(-1)), selected);
			},
		);
		assert.equal(f.events.find((event) => event.toolName === "sample_text")?.isError, true);
		assert.equal(f.guides().length, 1);
	} finally {
		await f.close();
	}
});

test("direct annotations preserve structured data without a separate guidance message", {
	timeout: 30000,
}, async () => {
	const f = await fixture();
	try {
		await f.run([ai.fauxToolCall("sample_structured", {}, { id: "direct" })], (context) => {
			assert.equal(text(lastResult(context)), `sample result\n${selected}`);
			assert.equal(context.messages.at(-1)?.role, "toolResult");
		});
		assert.deepEqual(f.events[0].structuredContent, { value: 7, failed: false });
		assert.equal(f.guides().length, 0);
	} finally {
		await f.close();
	}
});

for (const redact of ["text", "structured"] as const)
	test(`earlier ${redact} redaction remains authoritative`, { timeout: 30000 }, async () => {
		const f = await fixture({ redact });
		try {
			const expected = redact === "text" ? `redacted\n${selected}` : { value: 0, failed: false };
			await f.run(
				[
					script(
						`const value = await tools.sample_structured({}); if (JSON.stringify(value) !== ${JSON.stringify(JSON.stringify(expected))}) throw new Error("Redaction lost"); text("safe");`,
					),
				],
				(context) => {
					assert.match(text(lastResult(context)), /safe/);
					assert.equal(text(context.messages.at(-1)), selected);
				},
			);
			const result = f.events.find((event) => event.toolName === "sample_structured");
			assert.ok(result);
			assert.deepEqual(result.structuredContent, redact === "text" ? undefined : expected);
			assert.doesNotMatch(text(result), /sample result/);
		} finally {
			await f.close();
		}
	});

test("approved error assertion precedes guidance and retains the declared data", { timeout: 30000 }, async () => {
	const correctedGuide = guidance();
	assert.equal(correctedGuide.matcher.kind, "declarative");
	if (correctedGuide.matcher.kind === "declarative" && correctedGuide.matcher.language === "facts/v1")
		correctedGuide.matcher.spec.when = { op: "eq", path: ["result", "isError"], value: true };
	const f = await fixture({
		rules: [
			correctedGuide,
			record("result.error", {
				phase: "result",
				selector: { tools: ["sample_structured"] },
				when: { op: "exists", path: ["result"] },
				action: { kind: "assert-error" },
				onUnavailable: "skip",
			}),
		],
	});
	try {
		await f.run(
			[
				script(
					'const value = await tools.sample_structured({}); if (value.value !== 7 || value.failed !== false) throw new Error("Wrong data"); text("corrected");',
				),
			],
			(context) => {
				assert.match(text(lastResult(context)), /corrected/);
				assert.equal(text(context.messages.at(-1)), selected);
			},
		);
		assert.equal(f.events.find((event) => event.toolName === "sample_structured")?.isError, true);
	} finally {
		await f.close();
	}
});

for (const options of [
	{ mode: "observe" as const },
	{ mode: "notice" as const },
	{ enabled: false },
	{ degraded: true },
]) {
	test(`nested guidance stays inactive for ${JSON.stringify(options)}`, { timeout: 30000 }, async () => {
		const f = await fixture(options);
		try {
			await f.run(
				[
					script(
						'const value = await tools.sample_structured({}); if (value.value !== 7) throw new Error("Wrong data"); text("unchanged");',
					),
				],
				(context) => {
					assert.match(text(lastResult(context)), /unchanged/);
					assert.equal(context.messages.at(-1)?.role, "toolResult");
				},
			);
			assert.equal(f.guides().length, 0);
		} finally {
			await f.close();
		}
	});
}

for (const eligibility of ["false", "unknown", "scope", "retired"] as const) {
	test(`ineligible nested guidance stays absent for ${eligibility}`, { timeout: 30000 }, async () => {
		const candidate = record("result.guide", {
			phase: "result",
			selector: { tools: ["sample_structured"] },
			when:
				eligibility === "false" || eligibility === "unknown"
					? { op: "eq", path: ["result", "details", eligibility === "false" ? "failed" : "missing"], value: true }
					: { op: "exists", path: ["result"] },
			action: { kind: "guide", text: guide },
			onUnavailable: "skip",
		});
		if (eligibility === "scope") candidate.definition.scope = { modelProviders: ["another-provider"] };
		if (eligibility === "retired") candidate.definition.state = "retired";
		const f = await fixture({ rules: [candidate] });
		try {
			await f.run(
				[
					script(
						'const value = await tools.sample_structured({}); if (value.value !== 7) throw new Error("Wrong data"); text("unchanged");',
					),
				],
				(context) => {
					assert.match(text(lastResult(context)), /unchanged/);
					assert.equal(context.messages.at(-1)?.role, "toolResult");
				},
			);
			assert.equal(f.guides().length, 0);
		} finally {
			await f.close();
		}
	});
}

for (const state of [{ once: "period" as const }, { once: "turn" as const }, { cooldownMs: 1000 }]) {
	test(`nested guidance consumes one allowance with ${JSON.stringify(state)}`, { timeout: 30000 }, async () => {
		const f = await fixture({
			mode: "annotate",
			rules: [guidance({ observe: { op: "exists", path: ["outcome"] }, ...state })],
		});
		try {
			await f.run(
				[script('await tools.sample_text({}); await tools.sample_structured({}); text("done");')],
				lastResult,
			);
			assert.equal(f.guides().length, 1);
			assert.equal((await f.state()).observationPeriods[0].projected, 1);
			f.advance(1001);
			await f.run([script('await tools.sample_text({}); text("done");')], lastResult);
			assert.equal(f.guides().length, "once" in state && state.once === "period" ? 1 : 2);
		} finally {
			await f.close();
		}
	});
}

test("selected nested guidance is deduplicated, terminal-safe, and byte-bounded", { timeout: 30000 }, async () => {
	const first = guidance(undefined, "same\nline");
	const duplicate = { ...first, id: "result.same" };
	const oversized = guidance({ observe: { op: "exists", path: ["outcome"] }, once: "period" }, "x".repeat(2048));
	oversized.id = "result.oversized";
	const f = await fixture({ rules: [first, duplicate, oversized] });
	try {
		await f.run([script('await tools.sample_text({}); text("done");')], (context) => {
			lastResult(context);
			assert.equal(text(context.messages.at(-1)), "[policy] same line");
		});
		assert.equal(f.guides().length, 1);
		assert.ok(Buffer.byteLength(text(f.guides()[0]), "utf8") <= 2048);
		assert.deepEqual(
			Object.fromEntries((await f.state()).observationPeriods.map((entry) => [entry.id, entry.projected])),
			{
				"result.guide": 1,
				"result.oversized": 0,
				"result.same": 0,
			},
		);
	} finally {
		await f.close();
	}
});
