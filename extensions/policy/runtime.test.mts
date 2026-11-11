import { obj, opt, str } from "@earendil-works/pi-schema";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { convertToLlm, type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

import { DEFAULT_LIMITS, PACKAGE_CATALOG } from "./catalog.ts";
import type { NamedData } from "./data.ts";
import { GUIDANCE_ENTRY, GUIDANCE_HISTORY_LIMITS, GUIDANCE_RETIREMENT_ENTRY, messageDigest } from "./guidance-history.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { PolicyMode } from "./mode.ts";
import type { FactsProgram, InputPlan } from "./program.ts";
import type { PolicyRecord } from "./record.ts";
import type { RuleRecord } from "./rule.ts";
import { PolicyRuntime, refusalText } from "./runtime.ts";
import type { ObservationClock } from "./observation-clock.ts";
import { PolicyWriter } from "./store.ts";
import { TELEMETRY_QUEUE_RECORDS } from "./telemetry-files.ts";

const yes = { op: "exists" as const, path: ["input"] };
const success = { op: "eq" as const, path: ["outcome", "kind"], value: "success" };
function rule(id: string, program: FactsProgram): RuleRecord {
	return {
		id,
		source: { kind: "package" },
		matcher: { kind: "declarative", language: "facts/v1", spec: program },
		definition: {
			purpose: `Preserve ${id}.`,
			authority: "exact",
			revision: "123456abcdef",
			state: "active",
			effect:
				program.action.kind === "deny"
					? "block"
					: program.action.kind === "guide"
						? "steer"
						: program.action.kind === "observe"
							? "observe"
							: "correct",
			note: `Rule ${id}.`,
		},
		matcherAvailable: true,
		staleOverride: false,
	};
}
it("binds reset revisions to runtime instance, exact selector, and current period", () => {
	const records = [
		rule("sample", {
			phase: "completion",
			when: success,
			action: { kind: "observe", label: "calls" },
			onUnavailable: "skip",
		}),
	];
	const first = fixture(records);
	const second = fixture(records);
	const single = first.runtime.resetRevision("sample");
	assert.notEqual(single, first.runtime.resetRevision("--all"));
	assert.notEqual(single, second.runtime.resetRevision("sample"));
	assert.throws(() => first.runtime.reset(undefined, "All periods.", single), /revision changed/);
	assert.throws(() => second.runtime.reset(["sample"], "New runtime.", single), /revision changed/);
	first.runtime.reset(["sample"], "Fresh period.", single);
	assert.throws(() => first.runtime.reset(["sample"], "Repeated.", single), /revision changed/);
});

async function writeTelemetrySegment(dir: string, lines: string[]): Promise<void> {
	const segments = join(dir, "telemetry");
	await mkdir(segments, { recursive: true, mode: 0o700 });
	await writeFile(join(segments, "2026-01-01.000001.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

function fixture(
	programs: RuleRecord[],
	mode: PolicyMode = "enforce",
	schema: unknown = obj(
		{ old: opt(str()), name: opt(str()) },
		{ open: false },
	),
	fail = false,
	directory = "/unused",
	toolName = "sample",
	appendGate?: Promise<void>,
	observationClock?: ObservationClock,
) {
	const snapshot: RuleSnapshot = {
		records: new Map(programs.map((r) => [r.id, r])),
		pending: [],
		data: new Map(),
		health: { status: "ok", path: "rules.jsonl" },
	};
	const records: PolicyRecord[] = [];
	const notifications: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const failures: string[] = [];
	const writer = new PolicyWriter(
		"/unused",
		(health) => { if (health.state === "failed") failures.push(health.reason ?? "unknown failure"); },
		async (_dir, batch) => {
			if (fail) throw new Error("disk unavailable");
			records.push(...batch.map((item) => JSON.parse(item.json) as PolicyRecord));
			if (appendGate) await appendGate;
		},
	);
	const session = SessionManager.inMemory("/project", { id: "session" });
	const guidanceEntries = () =>
		session.getEntries().filter((entry) => entry.type === "custom" && entry.customType === GUIDANCE_ENTRY);
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/project",
		model: { provider: "test", id: "model" },
		sessionManager: session,
		getSystemPrompt: () => "",
		ui: { notify: (text: string) => notifications.push(text) },
	} as unknown as ExtensionContext;
	const pi = {
		getAllTools: () => [{ name: toolName, parameters: schema }],
		getActiveTools: () => [toolName],
		appendEntry: (customType: string, data?: unknown) => {
			session.appendCustomEntry(customType, data);
		},
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	let runtime: PolicyRuntime;
	let loadGate: Promise<void> | undefined;
	const load = async () => {
		if (loadGate) await loadGate;
		runtime.sync(snapshot);
		return snapshot;
	};
	const restart = () => {
		runtime = new PolicyRuntime(pi, load, () => mode, directory, () => true, writer, undefined, observationClock);
		runtime.sync(snapshot);
		runtime.attach();
	};
	restart();
	const firstMessage = { role: "user", content: [{ type: "text", text: "Run controlled tools." }], timestamp: 1 };
	const firstEntry = session.appendMessage(firstMessage as never);
	let transcript: Array<Record<string, unknown>> = [
		{ role: "system", content: "", sections: { preamble: "prompt" }, timestamp: 0 },
		firstMessage,
	];
	let turns = 0;
	const advance = () => {
		turns++;
		push({ role: "user", content: [{ type: "text", text: `Turn ${turns}.` }], timestamp: 1 + turns });
	};
	const project = async (next = false) => {
		if (next) advance();
		return (await handlers.get("context_with_system")?.({ type: "context_with_system", messages: transcript }, ctx)) as
			| { messages: Array<Record<string, unknown>>; emitted?: string }
			| undefined;
	};
	const projectedText = (messages: readonly Record<string, unknown>[]) =>
		messages.flatMap((message) => {
			if (message.role !== "user" || !Array.isArray(message.content)) return [];
			const text = message.content
				.filter((block: { type?: string }) => block?.type === "text")
				.map((block: { text?: string }) => block.text ?? "")
				.join("");
			return text.startsWith("[policy]") ? [text] : [];
		});
	const contextText = async (next = false) => {
		const projected = await project(next);
		const lines = projectedText(projected?.messages ?? transcript);
		return lines.length ? lines.join("\n") : undefined;
	};
	const contextEmitted = async (next = false) => (await project(next))?.emitted;
	function push(message: Record<string, unknown>) {
		if (message.role !== "system") session.appendMessage(message as never);
		transcript = [...transcript, message];
	}
	const setTranscript = (messages: Array<Record<string, unknown>>) => {
		transcript = messages;
	};
	const inputs = new Map<string, Record<string, unknown>>();
	const call = async (id: string, input: Record<string, unknown>) => {
		inputs.set(id, input);
		await runtime.toolStart({ toolName, toolCallId: id, args: input }, ctx);
		return runtime.toolCall({ type: "tool_call", toolName, toolCallId: id, input }, ctx);
	};
	const finish = async (id: string, isError = false, details: unknown = {}) =>
		runtime.toolEnd(
			{ toolName, toolCallId: id, isError, result: { content: [{ type: "text", text: "body" }], details } },
			ctx,
		);
	const result = async (id: string, isError = false, details: unknown = {}) =>
		runtime.toolResult(
			{
				type: "tool_result",
				toolName,
				toolCallId: id,
				input: inputs.get(id) ?? {},
				isError,
				content: [{ type: "text", text: "body" }],
				details,
			},
			ctx,
		);
	const views = async () =>
		(
			(await runtime.inspect("state", {}, ctx)) as {
				observationPeriods: Array<{
					id: string;
					count: number;
					projected: number;
					generation: number;
					resetReason: string;
					eligible: boolean;
				}>;
			}
		).observationPeriods;
	return {
		snapshot,
		pi,
		get runtime() { return runtime; },
		restart,
		call,
		finish,
		result,
		views,
		session,
		guidanceEntries,
		firstEntry,
		firstMessage,
		project,
		contextText,
		contextEmitted,
		advance,
		push,
		setTranscript,
		getTranscript: () => transcript,
		records,
		writer,
		ctx,
		notifications,
		handlers,
		failures,
		setMode: (next: PolicyMode) => { mode = next; },
		setLoadGate: (gate: Promise<void> | undefined) => {
			loadGate = gate;
		},
	};
}
const rename = () =>
	rule("rename", {
		phase: "input",
		when: yes,
		action: { kind: "rename-key", path: [], from: "old", to: "name" },
		onUnavailable: "skip",
	});
const guide = () =>
	rule("guide", {
		phase: "context",
		selector: { tools: ["sample"] },
		when: { op: "gte", path: ["state", "count"], value: 1 },
		action: { kind: "guide", text: "Inspect the completed outcome." },
		onUnavailable: "skip",
		state: { observe: success, once: "period" },
	});
const repeatableGuide = (id = "context.guide") =>
	rule(id, {
		phase: "context",
		when: { op: "exists", path: ["context"] },
		action: { kind: "guide", text: "Keep the earlier notice in place." },
		onUnavailable: "skip",
	});

function shellRule(effect: "block" | "steer" = "block", key = "routing.cat-read"): RuleRecord {
	const row = PACKAGE_CATALOG.find((record) => record.id === key);
	assert.ok(row, "routing.cat-read");
	return {
		id: row.id,
		source: { kind: "package" },
		matcher: row.matcher,
		definition: {
			purpose: row.purpose,
			authority: row.authority,
			revision: row.revision,
			state: "active",
			effect,
			note: row.note,
		},
		matcherAvailable: true,
		staleOverride: false,
	};
}
describe("observation time ownership", () => {
	it("uses process elapsed time for completions and cooldown despite wall regression", async (t) => {
		let wall = 1_700_000_000_000;
		let monotonic = 20;
		t.mock.method(Date, "now", () => wall);
		t.mock.method(performance, "now", () => monotonic);
		const observed = rule("elapsed", {
			phase: "context", when: { op: "gte", path: ["state", "count"], value: 1 },
			action: { kind: "guide", text: "Elapsed observation notice." }, onUnavailable: "skip",
			state: { observe: success, cooldownMs: 10, window: { maxEvents: 4, maxAgeMs: 100 } },
		});
		const f = fixture([observed]);
		t.after(() => f.writer.close());
		await f.call("elapsed-call", {});
		wall -= 1_000;
		monotonic += 5;
		await f.result("elapsed-call");
		await f.finish("elapsed-call");
		assert.equal((await f.views())[0].count, 1);
		assert.match((await f.contextText()) ?? "", /Elapsed observation notice/);
		assert.equal((await f.views())[0].projected, 1);
		assert.equal((await f.views())[0].eligible, false);
		monotonic += 9;
		assert.equal((await f.views())[0].eligible, false);
		monotonic++;
		assert.equal((await f.views())[0].eligible, true);
		assert.equal((await f.views())[0].count, 1);
	});

	it("retains wall-clock freshness for approved named data", async (t) => {
		let wall = 1_700_000_000_000;
		t.mock.method(Date, "now", () => wall);
		t.mock.method(performance, "now", () => 20);
		const gate = rule("wall-data", { phase: "input",
			when: { op: "lookup", path: ["input", "name"], table: "values", value: "unique" },
			action: { kind: "deny" }, data: ["values"], onUnavailable: "skip" });
		const f = fixture([gate]);
		t.after(() => f.writer.close());
		f.snapshot.data.set("values", { kind: "table", name: "values", revision: "aabbccddeeff", source: "synthetic",
			capturedAt: wall, maxAgeMs: 10, rows: [{ key: "blue", value: "target" }] });
		assert.ok(await f.call("fresh", { name: "blue" }));
		wall += 10;
		assert.equal(await f.call("stale", { name: "blue" }), undefined);
		wall -= 11;
		assert.equal(await f.call("future", { name: "blue" }), undefined);
	});
});

describe("starter intervention effects", () => {
	it("preserves explicit effects for synthetic command rules", async (t) => {
		const alpha = rule("synthetic.alpha", { phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "skip" });
		alpha.matcher = { kind: "declarative", language: "command-shape/v1", spec: { command: "alpha" } };
		const beta = rule("synthetic.beta", { phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "deny" });
		beta.matcher = { kind: "declarative", language: "command-shape/v1", onUnavailable: "deny", spec: { command: "beta" } };
		const f = fixture([alpha, beta], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		assert.match((await f.call("alpha", { command: "alpha 1" }))?.reason ?? "", /Rule synthetic\.alpha:/);
		assert.match((await f.call("beta", { command: "beta" }))?.reason ?? "", /Rule synthetic\.beta:/);
		assert.equal(await f.call("other", { command: "gamma" }), undefined);
		assert.equal(await f.call("operand", { command: "echo alpha" }), undefined);
	});
	it("keeps slow traversal gates but delivers preferences only after success", async (t) => {
		const rows = PACKAGE_CATALOG.filter((row) => row.matcher.kind === "code").map((row): RuleRecord => ({
			id: row.id, source: { kind: "package" }, matcher: row.matcher,
			definition: { ...row, state: "active" }, matcherAvailable: true, staleOverride: false,
		}));
		const f = fixture(rows, "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		const sourceInfo = { path: "builtin:fixture", source: "builtin", scope: "temporary" as const, origin: "top-level" as const };
		f.pi.getAllTools = () => [
			{ name: "bash", description: "Synthetic command", parameters: obj({ command: str() }, { open: true }), exposure: "direct", sourceInfo },
			{ name: "read", description: "Synthetic reader", parameters: obj({ path: str() }, { open: true }), exposure: "direct", sourceInfo },
		];
		f.pi.getActiveTools = () => ["bash", "read"];
		assert.match((await f.call("traversal", { command: "find src -type f" }))?.reason ?? "", /Rule form\.find-discovery:/);
		assert.equal(await f.call("failed-reader", { command: "cat notes.md" }), undefined);
		assert.equal(await f.result("failed-reader", true), undefined);
		assert.equal(await f.call("reader", { command: "cat notes.md" }), undefined);
		assert.match(JSON.stringify(await f.result("reader")), /read tool for file contents/);
		assert.equal(await f.call("details", { command: "fd -t f -l . src docs tests | awk '{print $5, $9}' | sort -k2 | head -n 200" }), undefined);
	});
});

describe("integrated catalogue guidance", () => {
	const bundledFixture = (toolName: "bash" | "read") => {
		const rows = PACKAGE_CATALOG.map((row): RuleRecord => ({ id: row.id, source: { kind: "package" }, matcher: row.matcher,
			definition: { ...row, state: "active" }, matcherAvailable: true, staleOverride: false }));
		const f = fixture(rows, "enforce", toolName === "bash" ? obj({ command: str() }, { open: true }) : obj({ path: str() }), false, "/unused", toolName);
		const sourceInfo = { path: "builtin:fixture", source: "builtin", scope: "temporary" as const, origin: "top-level" as const };
		f.pi.getAllTools = () => [
			{ name: "bash", description: "Synthetic command", parameters: obj({ command: str() }, { open: true }), exposure: "direct", sourceInfo },
			{ name: "read", description: "Synthetic reader", parameters: obj({ path: str() }), exposure: "direct", sourceInfo },
		];
		f.pi.getActiveTools = () => ["bash", "read"];
		return f;
	};

	it("guides a successful single-file sed slice without denying execution", async (t) => {
		const f = bundledFixture("bash");
		t.after(() => f.writer.close());
		const input = { command: "sed -n '4,8p' src/sample.ts" };
		assert.equal(await f.call("slice", input), undefined);
		const original = { content: [{ type: "text" as const, text: "Synthetic source lines." }], isError: false, details: undefined };
		const patch = await f.runtime.toolResult({ type: "tool_result", toolName: "bash", toolCallId: "slice", input, ...original }, f.ctx);
		const final = { ...original, ...patch };
		const note = f.snapshot.records.get("routing.sed-slice")?.definition.note;
		assert.ok(note);
		assert.ok(JSON.stringify(final.content).includes(note));
		assert.equal(final.isError, false);
		await f.runtime.toolEnd({ toolName: "bash", toolCallId: "slice", result: final, isError: final.isError }, f.ctx);
		assert.equal(f.records[0].outcome, "success");
		assert.notEqual(f.records[0].blocked, true);
	});

	it("projects the qualified volume notice after several complete read results", async (t) => {
		const f = bundledFixture("read");
		t.after(() => f.writer.close());
		for (let index = 0; index < 3; index++) {
			const id = `read-${index}`;
			const input = { path: `src/synthetic-${index}.txt` };
			assert.equal(await f.call(id, input), undefined);
			const original = { content: [{ type: "text" as const, text: "a".repeat(24_000) }], isError: false, details: undefined };
			const patch = await f.runtime.toolResult({ type: "tool_result", toolName: "read", toolCallId: id, input, ...original }, f.ctx);
			const final = { ...original, ...patch };
			await f.runtime.toolEnd({ toolName: "read", toolCallId: id, result: final, isError: final.isError }, f.ctx);
			if (index < 2) assert.equal(await f.contextEmitted(), undefined);
		}
		const note = f.snapshot.records.get("resources.output-volume")?.definition.note;
		assert.ok(note);
		assert.ok((await f.contextEmitted())?.includes(note));
		const state = await f.runtime.inspect("state", {}, f.ctx) as { observationPeriods: Array<{ id: string; windowTotal: number }> };
		assert.equal(state.observationPeriods.find((period) => period.id === "resources.output-volume")?.windowTotal, 72_000);
		assert.match(note, /does not establish unnecessary breadth.*Preserve required complete reads/);
	});

	it("preserves the tool error for incompatible fd cap and exec arguments", async (t) => {
		const f = bundledFixture("bash");
		t.after(() => f.writer.close());
		const input = { command: "fd --max-results 4 -x echo {} src" };
		assert.equal(await f.call("invalid-fd", input), undefined);
		const original = { content: [{ type: "text" as const, text: "Synthetic fd error: --max-results conflicts with -x." }], isError: true, details: undefined };
		const patch = await f.runtime.toolResult({ type: "tool_result", toolName: "bash", toolCallId: "invalid-fd", input, ...original }, f.ctx);
		assert.equal(patch, undefined);
		assert.equal(original.content[0].text, "Synthetic fd error: --max-results conflicts with -x.");
		assert.equal(original.isError, true);
		await f.runtime.toolEnd({ toolName: "bash", toolCallId: "invalid-fd", result: original, isError: true }, f.ctx);
		assert.equal(f.records[0].outcome, "execution-error");
		assert.equal(await f.contextEmitted(), undefined);
	});
});

describe("separate denial evidence", () => {
	it("explains an unreadable group before the rule note and admits readable harmless control", async (t) => {
		const gate = rule("synthetic.git", { phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "deny" });
		gate.definition.note = "Synthetic restriction: leave repository publication unchanged.";
		gate.matcher = { kind: "declarative", language: "command-shape/v1", onUnavailable: "deny",
			spec: { command: "git", cli: { profile: "git", subcommand: ["push"] } } };
		const f = fixture([gate], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		assert.equal((await f.call("group", { command: "(true)" }))?.reason,
			"[policy] Rule synthetic.git: Policy could not determine whether this command matches the rule. Evidence unavailable: unsupported-shell (shell group). The rule denies unavailable evidence. No matching command was established. Use plain literal commands joined with && or ; when that preserves the task. Rule note: Synthetic restriction: leave repository publication unchanged.");
		assert.equal(await f.call("harmless-loop", { command: "for f in a b; do echo $f; done" }), undefined);
		assert.equal(await f.call("harmless-substitution", { command: "echo $(date)" }), undefined);
		assert.equal((await f.call("push", { command: "git push" }))?.reason,
			"[policy] Rule synthetic.git: Synthetic restriction: leave repository publication unchanged. Matched command: git push");
	});
	it("keeps the cause, parse reason and accepted form before the note for every unavailable command reason", () => {
		const gate = rule("synthetic.git", { phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "deny" });
		gate.definition.note = "Synthetic restriction: leave repository publication unchanged.";
		const records = new Map([[gate.id, gate]]);
		// The shell reader, Git option decoder and command evaluator supply these reason codes.
		for (const reason of [
			"command-byte-limit", "word-limit", "stage-limit", "parse-limit", "nested-depth-limit", "option-limit",
			"malformed-shell", "malformed-for-syntax", "unsupported-shell", "unsupported-for-syntax",
			"unexpanded-heredoc", "unexpanded-arithmetic", "unexpanded-parameter", "unexpanded-backtick",
			"dynamic-prefix", "unsupported-prefix", "unresolved-command", "opaque-command-operand", "shell-evidence-unavailable",
			"dynamic-command", "dynamic-word", "unsupported-global-option", "unsupported-option", "invalid-option-form",
			"missing-value", "missing-subcommand", "future-evidence-code",
		]) {
			const plan = { corrections: [], evaluations: [{ id: gate.id, deny: true, truth: "unknown", unavailableReasons: [reason] }] } as unknown as InputPlan;
			const text = refusalText(plan, records, []) ?? "";
			assert.ok(text.startsWith("[policy] Rule synthetic.git: Policy could not determine whether this command matches the rule."), reason);
			assert.ok(text.includes(`Evidence unavailable: ${reason}`), reason);
			assert.ok(text.includes("No matching command was established. Use plain literal commands joined with && or ; when that preserves the task. Rule note:"), reason);
			assert.ok(text.endsWith(gate.definition.note), reason);
			assert.doesNotMatch(text, /Matched command:/, reason);
		}
	});
	it("admits a supported harmless loop but denies unknown execution without a false match", async (t) => {
		const gate = rule("synthetic.git", { phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "deny" });
		gate.definition.note = "Use a permitted command shape.";
		gate.matcher = { kind: "declarative", language: "command-shape/v1", onUnavailable: "deny",
			spec: { command: "git", cli: { profile: "git", subcommand: ["push"] } } };
		const f = fixture([gate], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		assert.equal(await f.call("loop", { command: 'for f in $(fd -t f design | head -n 20); do wc -c "$f"; done' }), undefined);
		assert.equal(await f.call("newline-loop", { command: "for x in a; do\necho safe; done" }), undefined);
		for (const [id, command, reason] of [
			["wrapper", "timeout 1 echo safe", "opaque-command-operand"],
			["dynamic", "$command", "unresolved-command"],
			["empty-list", "for x in a; do echo safe;; done", "malformed-for-syntax"],
			["empty-pipe", "for x in a; do echo safe |; done", "malformed-for-syntax"],
		]) {
			const denied = await f.call(id, { command });
			assert.ok(denied);
			assert.match(denied.reason, /Rule synthetic\.git:/);
			assert.ok(denied.reason.includes(reason));
			assert.match(denied.reason, /No matching command was established/);
			assert.doesNotMatch(denied.reason, /Matched command:/);
		}
		assert.match((await f.call("push-loop", { command: "for x in a; do git push; done" }))?.reason ?? "", /Matched command: git push/);
		gate.matcher.onUnavailable = "skip";
		const skip = fixture([gate], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => skip.writer.close());
		assert.equal(await skip.call("skip", { command: "timeout 1 echo safe" }), undefined);
	});
	it("labels two qualified rules independently and respects their selected guidance effects", async (t) => {
		const fd = shellRule("block", "bounds.fd-uncapped");
		fd.definition.note = "For plain discovery use --max-results N; it conflicts with --list-details, --exec and --exec-batch. Bound selected input for those forms.";
		const cap = shellRule("block", "bounds.false-cap");
		cap.definition.note = "Bound selected input. Move the cap only when changed input preserves the task, not for global sorting or totals.";
		const command = "fd -t f -l . src docs tests | awk '{print $5, $9}' | sort -k2 | head -n 200";
		for (const effect of ["block", "steer"] as const) {
			for (const row of [fd, cap]) row.definition.effect = effect;
			const f = fixture([fd, cap], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
			t.after(() => f.writer.close());
			const denied = await f.call(effect, { command });
			if (effect === "steer") assert.equal(denied, undefined);
			else {
				assert.ok(denied);
				assert.equal(denied.reason.split("\n").filter((line) => line.includes("Rule ")).length, 2);
				assert.match(denied.reason, /Rule bounds\.fd-uncapped:.*conflicts with --list-details/);
				assert.match(denied.reason, /Rule bounds\.false-cap:.*not for global sorting/);
				assert.equal((denied.reason.match(/Matched command:/g) ?? []).length, 2);
			}
		}
	});
	it("counts whole omitted diagnostics within the shared byte bound", () => {
		const records = new Map(Array.from({ length: 30 }, (_, index) => {
			const row = rule(`deny.${index}`, { phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "skip" });
			row.definition.note = "Keep this restriction explicit. ".repeat(5);
			return [row.id, row] as const;
		}));
		const plan = { corrections: [], evaluations: [...records.keys()].map((id) => ({ id, deny: true, truth: true })) } as unknown as InputPlan;
		const text = refusalText(plan, records, []) ?? "";
		const visible = (text.match(/Rule deny\./g) ?? []).length;
		assert.ok(visible > 0 && visible < records.size);
		assert.ok(text.endsWith(`Omitted ${records.size - visible} rule diagnostics.`));
		assert.ok(Buffer.byteLength(text) <= 2048);
	});
});

describe("command-specific refusal guidance", () => {
	const cases: Array<[string, string, string[]]> = [
		["routing.cat-read", "cat notes.md", ["read path=notes.md"]],
		["routing.sed-slice", "sed -n '17,23p' notes.md", ["read path=notes.md offset=17 limit=7"]],
		["routing.sed-slice", "sed -n '9p' notes.md", ["read path=notes.md offset=9 limit=1"]],
		["routing.head-slice", "head -n 8 notes.md", ["read path=notes.md limit=8"]],
		["routing.head-slice", "ghead -12 notes.md", ["read path=notes.md limit=12"]],
		["routing.head-slice", "head notes.md", []],
		["routing.head-slice", "head --lines=3 a.md b.md", ["read path=a.md limit=3", "read path=b.md limit=3"]],
		["routing.tail-slice", "tail -n +45 notes.md", ["read path=notes.md offset=45"]],
		["routing.tail-slice", "tail +45 notes.md", ["read path=notes.md offset=45"]],
		["routing.inline-script-read", `python3 -c "print(open('notes.md').read())"`, ["read path=notes.md"]],
		["routing.inline-script-read", `node -e 'console.log(require("fs").readFileSync("notes.md", "utf8"))'`, ["read path=notes.md"]],
		["routing.cat-read", 'cat "notes with spaces.md"', ['read path="notes with spaces.md"']],
		["routing.cat-read", 'cat "$FILE"', []],
		["routing.cat-pipe", "cat data.json | jq .", []],
		["routing.cat-read", "cat '~/notes.md'", []],
		["routing.cat-read", "cat @notes.md", []],
		["routing.cat-read", "cat file://notes.md", []],
		["routing.cat-read", 'cat "notes\u00a0file.md"', []],
		["routing.cat-read", `cat sk-${"x".repeat(24)}`, []],
		["routing.cat-read", "cd subdir && cat notes.md", []],
		["routing.cat-read", "pushd subdir; cat notes.md", []],
		["routing.cat-read", "popd; cat notes.md", []],
		["routing.cat-read", "env -C subdir cat notes.md", []],
		["routing.cat-read", "env --chdir=subdir cat notes.md", []],
		["routing.cat-read", "cat *.md", []],
		["routing.cat-read", "cat -- -notes.md", ["read path=-notes.md"]],
		["routing.head-slice", "head -n 2 -n 7 notes.md", []],
		["routing.head-slice", "head -2 --lines=7 notes.md", []],
		["routing.head-slice", "head -n 2 -- -n7 notes.md", ["read path=-n7 limit=2", "read path=notes.md limit=2"]],
		["routing.head-slice", "head --lines=2 -- notes.md", ["read path=notes.md limit=2"]],
		["routing.tail-slice", "tail -n +2 -n +7 notes.md", []],
		["routing.tail-slice", "tail -n +2 -c 7 notes.md", []],
		["routing.tail-slice", "tail --lines=+2 -- -notes.md", ["read path=-notes.md offset=2"]],
		["routing.sed-slice", "sed -n -e '3p' 1,2p notes.md", []],
		["routing.sed-slice", "sed -n '3p' 1,2p", ['read path="1,2p" offset=3 limit=1']],
		["routing.sed-slice", "sed -n '3p' -- notes.md", []],
		["routing.sed-slice", "sed -n -- '3p' -notes.md", []],
		["routing.sed-slice", "sed -n '3p' -e '7p' notes.md", []],
		["routing.sed-slice", "sed -n -f script.sed '3p' notes.md", []],
		["routing.sed-slice", "sed -n '3p' @notes.md", []],
		["routing.head-slice", "head -n 2 '~/notes.md'", []],
	];
	for (const [key, command, suggestions] of cases) {
		it(`preserves stored guidance for ${command}`, async (t) => {
			const record = shellRule("block", key);
			record.id = "local.reader";
			record.definition.note = "Use your selected reader.";
			record.definition.suggestion = { command: "reader", flags: ["--plain"] };
			const before = structuredClone(record);
			const f = fixture([record], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
			t.after(() => f.writer.close());
			const denied = await f.call("read-call", { command });
			assert.ok(denied);
			const lines = denied.reason.split("\n");
			assert.ok(lines[0].startsWith("[policy] Rule local.reader: Use your selected reader. Suggested form: reader --plain. Matched command:"));
			assert.deepEqual(lines.filter((line) => line.startsWith("For this command:")), suggestions.map((value) => `For this command: ${value}`));
			assert.deepEqual(record, before);
		});
	}
});

describe("compact command inspection", () => {
	it("omits non-matching evaluations and counts rules once across input views", async (t) => {
		const records = PACKAGE_CATALOG.map(
			({ id, matcher, ...definition }): RuleRecord => ({
				id,
				source: { kind: "package" },
				matcher,
				definition: { ...definition, state: "active" },
				matcherAvailable: true,
				staleOverride: false,
			}),
		);
		const f = fixture(records, "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		for (const command of ["rg -n -m 12 'x' dir/", "cd /x && rg -n 'a' index.ts | head; echo done"]) {
			const preview = (await f.runtime.inspect("preview", { tool: "bash", input: { command } }, f.ctx)) as {
				decision: { denied: boolean };
				nonMatchingRules: number;
				input: { evaluations: unknown[] };
				results: unknown[];
			};
			assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 2500);
			assert.equal(preview.decision.denied, false);
			assert.deepEqual(preview.input.evaluations, []);
			assert.deepEqual(preview.results, []);
			assert.equal(preview.nonMatchingRules, records.filter((row) => row.matcher.kind === "code" && row.definition.effect === "block").length + 1);
		}
	});

	it("names the matched nested segment without unrelated command text", async (t) => {
		const f = fixture([shellRule()], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		const denied = await f.call("nested", {
			command: "printf safe && echo ready | wc -c; printf '%s' $(cat notes.md)",
		});
		assert.ok(denied);
		assert.ok(denied.reason.startsWith(`[policy] Rule ${shellRule().id}: ${shellRule().definition.note}`));
		assert.match(denied.reason, /Matched command: cat notes\.md/);
		assert.doesNotMatch(denied.reason, /printf safe|echo ready/);
		await f.finish("nested", true);
		await f.writer.close();
		assert.doesNotMatch(JSON.stringify(f.records[0].policy), /notes\.md/);
	});

	it("does not attribute a denial to a matched guidance-only rule", async (t) => {
		const guide = shellRule("steer");
		const blocker = rule("restriction", {
			phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "skip",
		});
		const f = fixture([guide, blocker], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		const denied = await f.call("mixed", { command: "cat notes.md" });
		assert.equal(denied?.reason, "[policy] Rule restriction: Rule restriction.");
	});

	it("bounds and redacts segments before denial projection", async (t) => {
		const blocker: RuleRecord = {
			...shellRule(),
			matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "scan" } },
		};
		const f = fixture([blocker], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		const denied = await f.call("bounded", {
			command: `echo unrelated; scan --token sample-private-value ${"界".repeat(500)}`,
		});
		assert.ok(denied);
		assert.match(denied.reason, /Matched command: scan --token \[redacted\]/);
		assert.doesNotMatch(denied.reason, /sample-private-value|unrelated/);
		assert.ok(Buffer.byteLength(denied.reason.split("Matched command: ")[1]) <= 240);
		assert.ok(Buffer.byteLength(denied.reason) <= 2048);
	});
});

function commandTable(value: string): NamedData {
	return {
		kind: "table",
		name: "commands",
		revision: "aabbccddeeff",
		source: "approved-commands",
		capturedAt: Date.now() - 1000,
		maxAgeMs: 60000,
		rows: [{ key: "printf safe", value }],
	};
}
function correctedBash(blocker: RuleRecord, mode: PolicyMode = "enforce", target = "cat notes.md") {
	const correction = rule("command.correction", {
		phase: "input",
		selector: { tools: ["bash"] },
		when: { op: "exists", path: ["input", "command"] },
		action: { kind: "substitute", path: ["command"], table: "commands" },
		data: ["commands"],
		onUnavailable: "skip",
	});
	const f = fixture(
		[correction, blocker],
		mode,
		obj({ command: str() }, { open: false }),
		false,
		"/unused",
		"bash",
	);
	f.snapshot.data.set("commands", commandTable(target));
	return f;
}

function recoveryRule(): RuleRecord {
	const row = PACKAGE_CATALOG.find((entry) => entry.id === "recovery.repeated-errors");
	assert.ok(row?.matcher.kind === "declarative" && row.matcher.language === "facts/v1");
	return rule(row.id, row.matcher.spec);
}

async function completed(f: ReturnType<typeof fixture>, id: string, error: boolean) {
	await f.call(id, {});
	await f.result(id, error);
	await f.finish(id, error);
}

describe("pre-call shell guidance", () => {
	const shellFixture = (mode: PolicyMode = "enforce") =>
		fixture([shellRule()], mode, obj({ command: str() }, { open: true }), false, "/unused", "bash");
	it("projects once before tools, without consuming rule guidance state", async () => {
		const f = shellFixture();
		const before = await f.views();
		const result = (await f.handlers.get("before_agent_start")?.({}, f.ctx)) as {
			message: { customType: string; content: string; display: boolean };
		};
		assert.equal(result.message.customType, "policy_shell_contract");
		assert.equal(result.message.display, false);
		assert.match(result.message.content, /Shell contract snapshot/);
		assert.deepEqual(await f.views(), before);
		assert.equal(await f.runtime.beforeAgentStart(f.ctx), undefined);
		await f.handlers.get("session_tree")?.({}, f.ctx);
		await f.handlers.get("session_compact")?.({}, f.ctx);
		f.runtime.reset(undefined, "Operator reset");
		assert.equal(await f.runtime.beforeAgentStart(f.ctx), undefined);
		await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
		assert.match((await f.runtime.beforeAgentStart(f.ctx)) ?? "", /Shell contract snapshot/);
	});

	it("honors modes and authority health without consuming the latch", async () => {
		for (const mode of ["observe", "notice"] as const) {
			const f = shellFixture(mode);
			assert.equal(await f.runtime.beforeAgentStart(f.ctx), undefined);
			f.setMode("annotate");
			assert.match((await f.runtime.beforeAgentStart(f.ctx)) ?? "", /Shell contract snapshot/);
		}
		const f = shellFixture();
		f.snapshot.health = { status: "degraded", path: "rules.jsonl", message: "unreadable", repair: "repair" };
		assert.equal(await f.runtime.beforeAgentStart(f.ctx), undefined);
		f.snapshot.health = { status: "ok", path: "rules.jsonl" };
		assert.match((await f.runtime.beforeAgentStart(f.ctx)) ?? "", /Shell contract snapshot/);
	});

	it("requires active bash and retries when the active tool set changes", async () => {
		const f = fixture([shellRule()]);
		assert.equal(await f.runtime.beforeAgentStart(f.ctx), undefined);
		f.pi.getActiveTools = () => ["bash"];
		assert.match((await f.runtime.beforeAgentStart(f.ctx)) ?? "", /Shell contract snapshot/);
	});

	it("has one latch across overlapping callbacks and rejects stale work", async () => {
		const f = shellFixture();
		let release: () => void = () => {};
		f.setLoadGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const first = f.runtime.beforeAgentStart(f.ctx);
		const second = f.runtime.beforeAgentStart(f.ctx);
		release();
		assert.equal((await Promise.all([first, second])).filter(Boolean).length, 1);
		const stale = shellFixture();
		stale.setLoadGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const pending = stale.runtime.beforeAgentStart(stale.ctx);
		await stale.handlers.get("session_shutdown")?.({}, stale.ctx);
		release();
		assert.equal(await pending, undefined);
	});
});

describe("completion-triggered recovery guidance", () => {
	it("counts final failures across tools and retains a triggered notice through same-batch success", async () => {
		const f = fixture([recoveryRule()]);
		await f.call("first", {});
		await f.runtime.toolStart({ toolName: "other", toolCallId: "second", args: {} }, f.ctx);
		await f.runtime.toolCall({ type: "tool_call", toolName: "other", toolCallId: "second", input: {} }, f.ctx);
		await f.call("success", {});
		await f.result("first", true);
		await f.finish("first", true);
		assert.equal(await f.contextEmitted(), undefined);
		await f.runtime.toolResult(
			{
				type: "tool_result",
				toolName: "other",
				toolCallId: "second",
				input: {},
				isError: true,
				content: [{ type: "text", text: "failure" }],
				details: {},
			},
			f.ctx,
		);
		await f.runtime.toolEnd({ toolName: "other", toolCallId: "second", isError: true, result: {} }, f.ctx);
		await f.result("success");
		await f.finish("success");
		assert.equal((await f.views())[0].count, 0);
		assert.match((await f.contextText()) ?? "", /actual failed assumption or tool contract/);
		assert.equal(await f.contextEmitted(), undefined);
		await completed(f, "third", true);
		assert.equal(await f.contextEmitted(), undefined);
		await completed(f, "fourth", true);
		assert.match((await f.contextText()) ?? "", /explicit operator approval/);
		await completed(f, "fifth", true);
		assert.match((await f.contextText()) ?? "", /repeatable/);
		await f.finish("fifth", true);
		assert.equal(await f.contextEmitted(), undefined);
	});

	it("coalesces continued failures and preserves notices through compaction without repeating idle context", async () => {
		const f = fixture([recoveryRule()]);
		for (let i = 0; i < 5; i++) await completed(f, `failure-${i}`, true);
		const before = (await f.runtime.inspect("state", {}, f.ctx)) as { retainedGuidance: unknown[] };
		assert.equal(before.retainedGuidance.length, 1);
		await f.handlers.get("session_compact")?.({}, f.ctx);
		await f.handlers.get("turn_start")?.({}, f.ctx);
		assert.match((await f.contextText()) ?? "", /Two consecutive/);
		assert.equal(await f.contextEmitted(), undefined);
	});

	it("retains notices omitted by the shared projection byte bound", async () => {
		const a = recoveryRule();
		const b = recoveryRule();
		b.id = "second-guide";
		assert.ok(a.matcher.kind === "declarative" && a.matcher.language === "facts/v1");
		assert.ok(b.matcher.kind === "declarative" && b.matcher.language === "facts/v1");
		a.matcher = structuredClone(a.matcher);
		b.matcher = structuredClone(b.matcher);
		a.matcher.spec.action = { kind: "guide", text: "a".repeat(1500) };
		b.matcher.spec.action = { kind: "guide", text: "b".repeat(1500) };
		const f = fixture([a, b]);
		await completed(f, "first", true);
		await completed(f, "second", true);
		assert.match((await f.contextText()) ?? "", /a{1500}/);
		assert.match((await f.contextText()) ?? "", /b{1500}/);
		assert.equal(await f.contextEmitted(), undefined);
	});

	it("counts the final flag rather than an earlier result error", async () => {
		const f = fixture([recoveryRule()]);
		await completed(f, "first", true);
		await f.call("patched", {});
		await f.result("patched", true);
		await f.finish("patched", false);
		await completed(f, "third", true);
		assert.equal(await f.contextEmitted(), undefined);
		assert.equal((await f.views())[0].count, 1);
	});

	it("uses a rolling strict age bound without expiring an already triggered notice", async (t) => {
		let now = Date.now();
		t.mock.method(Date, "now", () => now);
		const f = fixture([recoveryRule()], "enforce", undefined, false, "/unused", "sample", undefined, { now: () => now });
		await completed(f, "old", true);
		now += DEFAULT_LIMITS.errorWindowMs;
		await completed(f, "new", true);
		assert.equal(await f.contextEmitted(), undefined);
		now += DEFAULT_LIMITS.errorWindowMs - 1;
		await completed(f, "pair", true);
		now += DEFAULT_LIMITS.errorWindowMs * 2;
		assert.match((await f.contextText()) ?? "", /Two consecutive/);
		await completed(f, "fresh", true);
		assert.equal(await f.contextEmitted(), undefined);
	});

	it("ignores error-like success text, preflight failure, partial results, and duplicate endings", async () => {
		const f = fixture([recoveryRule()]);
		await f.call("unexecuted", {});
		await f.finish("unexecuted", true);
		await f.call("partial", {});
		await f.handlers.get("tool_execution_update")?.({}, f.ctx);
		await f.call("text", {});
		await f.runtime.toolResult(
			{
				type: "tool_result",
				toolName: "sample",
				toolCallId: "text",
				input: {},
				isError: false,
				content: [{ type: "text", text: "ERROR failed invalid" }],
				details: {},
			},
			f.ctx,
		);
		await f.finish("text", false);
		await completed(f, "failure", true);
		await f.finish("failure", true);
		assert.equal(await f.contextEmitted(), undefined);
		assert.equal((await f.views())[0].count, 1);
	});

	for (const hostMode of ["tui", "rpc", "json", "print"] as const)
		for (const mode of ["observe", "notice", "annotate", "enforce"] as const)
			it(`${hostMode}/${mode}: completion guidance follows the effect matrix`, async () => {
				const f = fixture([recoveryRule()], mode);
				await completed(f, "first", true);
				await completed(f, "second", true);
				const output = await f.project();
				assert.equal(output?.emitted !== undefined, mode === "annotate" || mode === "enforce");
			});

	for (const change of [
		"revision",
		"disable",
		"retire",
		"scope",
		"reset",
		"mode",
		"degraded",
		"tree",
		"shutdown",
		"reload",
		"new",
		"resume",
		"fork",
	])
		it(`${change}: invalidates retained guidance`, async () => {
			const r = recoveryRule();
			const f = fixture([r]);
			await completed(f, "first", true);
			await completed(f, "second", true);
			switch (change) {
				case "revision":
					r.definition.revision = "fedcba654321";
					break;
				case "disable":
					r.override = {
						state: "disabled",
						reason: "test",
						againstDefinitionRevision: r.definition.revision,
						audit: { surface: "command", session: "session", model: null, at: new Date().toISOString() },
					};
					break;
				case "retire":
					r.definition.state = "retired";
					break;
				case "scope":
					r.definition.scope = { cwdPrefixes: ["/elsewhere"] };
					break;
				case "reset":
					f.runtime.reset([r.id], "operator reset");
					break;
				case "mode":
					f.setMode("observe");
					break;
				case "degraded":
					f.snapshot.health = { ...f.snapshot.health, status: "degraded" };
					break;
				case "tree":
					await f.handlers.get("session_tree")?.({}, f.ctx);
					break;
				case "shutdown":
					await f.handlers.get("session_shutdown")?.({}, f.ctx);
					break;
				default:
					await f.handlers.get("session_start")?.({ reason: change }, f.ctx);
			}
			assert.equal(await f.contextEmitted(), undefined);
			delete r.definition.scope;
			f.setMode("enforce");
			f.snapshot.health = { status: "ok", path: "rules.jsonl" };
			assert.equal(await f.contextEmitted(), undefined);
		});
});

describe("persistent context guidance placement", () => {
	type Message = Record<string, unknown>;
	const notices = (messages: readonly Message[]) =>
		messages.filter((message) => {
			if (message.role !== "user" || !Array.isArray(message.content)) return false;
			return message.content.some(
				(block: { type?: string; text?: string }) =>
					block?.type === "text" && block.text?.startsWith("[policy]") === true,
			);
		});

	it("preserves the complete request prefix with retained shell and guidance notes", async (t) => {
		const row = PACKAGE_CATALOG.find((entry) => entry.id === "bounds.fd-uncapped");
		assert.ok(row);
		const shell: RuleRecord = { id: row.id, source: { kind: "package" }, matcher: row.matcher,
			definition: { ...row, state: "active" }, matcherAvailable: true, staleOverride: false };
		const f = fixture([shell, repeatableGuide()], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		t.after(() => f.writer.close());
		const prepared = await f.handlers.get("before_agent_start")?.({}, f.ctx) as {
			message: { customType: string; content: string; display: boolean };
		};
		assert.match(prepared.message.content, /Shell contract snapshot/);
		f.session.appendCustomMessageEntry(prepared.message.customType, prepared.message.content, prepared.message.display);
		f.setTranscript([f.getTranscript()[0], ...convertToLlm(f.session.buildSessionProjection().messages).map((message) => ({ ...message }))]);
		let previous: string[] = [];
		for (let request = 0; request < 3; request++) {
			const projected = await f.project(request > 0);
			assert.ok(projected);
			const current = projected.messages.map((message) => JSON.stringify(message));
			assert.deepEqual(current.slice(0, previous.length), previous);
			assert.equal(current.filter((message) => message.includes("Shell contract snapshot")).length, 1);
			assert.equal(notices(projected.messages).length, request + 2);
			previous = current;
		}
	});

	it("keeps every earlier request block byte-identical across eight requests", async () => {
		const f = fixture([repeatableGuide()]);
		let previous: readonly Message[] = [];
		let firstNotice: Message | undefined;
		for (let request = 1; request <= 8; request++) {
			const result = await f.project(request > 1);
			assert.ok(result, `request ${request}`);
			for (let index = 0; index < previous.length; index++)
				assert.equal(JSON.stringify(result.messages[index]), JSON.stringify(previous[index]));
			const projected = notices(result.messages);
			assert.equal(projected.length, request);
			if (firstNotice) assert.deepEqual(projected[0], firstNotice);
			else firstNotice = projected[0];
			previous = result.messages;
		}
		assert.equal(f.guidanceEntries().length, 8);
		await f.writer.close();
	});

	it("adds no duplicate record or message on a retry at the same boundary", async () => {
		const f = fixture([repeatableGuide()]);
		const first = await f.project();
		assert.ok(first?.emitted);
		const second = await f.project();
		assert.ok(second);
		assert.equal(second.emitted, undefined);
		assert.equal(JSON.stringify(second.messages), JSON.stringify(first.messages));
		assert.equal(f.guidanceEntries().length, 1);
		await f.writer.close();
	});

	it("does not rewrite historical guidance after a rule or mode change", async () => {
		const f = fixture([repeatableGuide()]);
		const first = await f.project();
		assert.ok(first);
		const frozen = notices(first.messages)[0];
		assert.ok(frozen);
		f.setMode("observe");
		const observed = await f.project();
		assert.ok(observed);
		assert.deepEqual(notices(observed.messages)[0], frozen);
		const record = f.snapshot.records.get("context.guide");
		assert.ok(record);
		record.definition.revision = "fedcba654321";
		f.setMode("enforce");
		const revised = await f.project();
		assert.ok(revised);
		assert.deepEqual(notices(revised.messages)[0], frozen);
		await f.writer.close();
	});

	it("keeps system patches in their original relative order around frozen guidance", async () => {
		const f = fixture([repeatableGuide()]);
		const first = await f.project();
		assert.ok(first);
		f.push({ role: "system", content: "", sections: { skills: "one" }, timestamp: 2 });
		f.push({ role: "user", content: [{ type: "text", text: "next" }], timestamp: 3 });
		const second = await f.project();
		assert.ok(second);
		assert.deepEqual(
			second.messages.map((message) => message.role),
			["system", "user", "user", "system", "user", "user"],
		);
		assert.deepEqual(second.messages[3], {
			role: "system",
			content: "",
			sections: { skills: "one" },
			timestamp: 2,
		});
		await f.writer.close();
	});

	const textOf = (message: Message | undefined) =>
		Array.isArray(message?.content)
			? (message.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("")
			: "";
	const guidanceHealth = async (f: ReturnType<typeof fixture>) =>
		(await f.runtime.inspect("health", {}, f.ctx)) as {
			guidance: { status: string; records: number; epoch?: string };
		};
	/** The request Pi would send after the session changed: its projection behind the system message. */
	const requestFromSession = (f: ReturnType<typeof fixture>, extra: Message[] = []) =>
		f.setTranscript([
			f.getTranscript()[0] as Message,
			...(f.session.buildSessionProjection().messages as unknown as Message[]),
			...extra,
		]);
	/** Three requests, each leaving a record on the newest conversation message. */
	const threeRecords = async (f: ReturnType<typeof fixture>) => {
		const ids = [f.firstEntry];
		await f.project();
		for (let turn = 0; turn < 2; turn++) {
			f.advance();
			ids.push(
				f.session
					.getEntries()
					.filter((entry) => entry.type === "message")
					.at(-1)?.id as string,
			);
			await f.project();
		}
		return ids;
	};
	const afterMessage = (messages: readonly Message[], text: string) => {
		const index = messages.findIndex((message) => message.role !== "system" && textOf(message) === text);
		assert.ok(index >= 0, text);
		return messages[index + 1];
	};

	for (const signalled of [true, false]) {
		it(`keeps guidance whose source survives real compaction and retires a removed source${signalled ? "" : " without a compaction signal"}`, async () => {
			const f = fixture([repeatableGuide()]);
			const ids = await threeRecords(f);
			assert.equal(f.guidanceEntries().length, 3);
			f.setMode("observe");
			f.session.appendCompaction("Earlier work.", ids[2] as string, 1000);
			if (signalled) await f.handlers.get("session_compact")?.({}, f.ctx);
			requestFromSession(f);
			const projection = f.getTranscript();
			assert.equal(projection.some((message) => textOf(message) === "Run controlled tools."), false);
			const kept = await f.project();
			assert.ok(kept);
			assert.equal(notices(kept.messages).length, 1);
			assert.deepEqual(afterMessage(kept.messages, "Turn 2."), notices(kept.messages)[0]);
			const health = await guidanceHealth(f);
			assert.equal(health.guidance.records, 1);
			assert.equal(health.guidance.status, "ok");
			const stable = await f.project();
			assert.equal(JSON.stringify(stable?.messages), JSON.stringify(kept.messages));
			await f.writer.close();
		});
	}

	it("keeps surviving guidance when an older retained edit and branch summary precede real compaction", async () => {
		const f = fixture([repeatableGuide()]);
		const first = f.firstEntry;
		await f.project();
		f.advance();
		const second = f.session.getLeafId() as string;
		await f.project();
		f.session.appendContextEdit(first, { content: [{ type: "text", text: "Edited first request." }] });
		f.session.branchWithSummary(f.session.getLeafId() as string, "Abandoned detour.");
		await f.handlers.get("session_tree")?.({}, f.ctx);
		requestFromSession(f);
		f.advance();
		await f.project();
		f.setMode("observe");
		const before = await guidanceHealth(f);
		f.session.appendCompaction("Earlier work.", second, 1000);
		requestFromSession(f);
		const kept = await f.project();
		assert.ok(kept);
		const survivors = notices(kept.messages);
		assert.ok(survivors.length >= 1);
		assert.deepEqual(afterMessage(kept.messages, "Turn 1."), survivors[0]);
		const health = await guidanceHealth(f);
		assert.equal(health.guidance.status, "ok");
		assert.notEqual(health.guidance.epoch, before.guidance.epoch);
		assert.match(health.guidance.epoch ?? "", new RegExp(`:${f.session.getLeafId()}$`));
		await f.writer.close();
	});

	it("retires only the record whose source a context edit replaced", async () => {
		const f = fixture([repeatableGuide()]);
		await f.project();
		f.advance();
		await f.project();
		f.setMode("observe");
		f.session.appendContextEdit(f.firstEntry, { content: [{ type: "text", text: "Edited first request." }] });
		requestFromSession(f);
		const edited = await f.project();
		assert.ok(edited);
		assert.equal(notices(edited.messages).length, 1);
		assert.deepEqual(afterMessage(edited.messages, "Turn 1."), notices(edited.messages)[0]);
		const health = await guidanceHealth(f);
		assert.equal(health.guidance.records, 1);
		assert.equal(health.guidance.status, "ok");
		await f.writer.close();
	});

	const ledger = async (f: ReturnType<typeof fixture>) =>
		((await f.runtime.inspect("state", {}, f.ctx)) as {
			guidanceRecords: Array<{ id: string; timestamp: number }>;
		}).guidanceRecords;
	const retirements = (f: ReturnType<typeof fixture>) =>
		f.session.getEntries().filter((entry) => entry.type === "custom" && entry.customType === GUIDANCE_RETIREMENT_ENTRY);
	const editSource = async (f: ReturnType<typeof fixture>, text: string) => {
		f.session.appendContextEdit(f.firstEntry, { content: [{ type: "text", text }] });
		requestFromSession(f);
		return f.project();
	};

	it("preserves retired identities and complete projection after a source digest reversal and restart", async () => {
		const f = fixture([repeatableGuide()]);
		try {
			const initial = await editSource(f, "alpha");
			const first = await ledger(f);
			const initialTip = f.session.getLeafId() as string;
			await editSource(f, "beta");
			const before = await editSource(f, "alpha");
			assert.ok(before);
			const records = await ledger(f);
			assert.equal(records.length, 1);
			assert.notEqual(records[0].id, first[0].id);
			assert.equal(retirements(f).length, 2);
			const previous = f.runtime;
			f.restart();
			assert.notEqual(f.runtime, previous);
			const restored = await f.project();
			assert.deepEqual(await ledger(f), records);
			assert.deepEqual(restored?.messages, before.messages);
			assert.equal((await guidanceHealth(f)).guidance.status, "ok");
			f.setMode("observe");
			f.session.branch(initialTip);
			await f.handlers.get("session_tree")?.({}, f.ctx);
			requestFromSession(f);
			assert.deepEqual((await f.project())?.messages, initial?.messages);
			assert.deepEqual(await ledger(f), first);
		} finally {
			await f.writer.close();
		}
	});

	it("bounds active guidance across more historical creations than the record limit and restores the same branch", async () => {
		const f = fixture([repeatableGuide()]);
		try {
			await editSource(f, "alpha");
			for (let cycle = 0; cycle <= GUIDANCE_HISTORY_LIMITS.records; cycle++) {
				await editSource(f, "beta");
				await editSource(f, "alpha");
				assert.equal((await ledger(f)).length, 1);
			}
			assert.equal(f.guidanceEntries().length, 1 + 2 * (GUIDANCE_HISTORY_LIMITS.records + 1));
			const records = await ledger(f);
			f.setMode("observe");
			const before = await f.project();
			assert.equal(notices(before?.messages ?? []).length, 1);
			const tip = f.session.getLeafId() as string;
			f.session.branch(f.firstEntry);
			await f.handlers.get("session_tree")?.({}, f.ctx);
			requestFromSession(f);
			assert.equal(await f.project(), undefined);
			assert.deepEqual(await ledger(f), []);
			f.session.branch(tip);
			await f.handlers.get("session_tree")?.({}, f.ctx);
			requestFromSession(f);
			const fromTree = await f.project();
			assert.deepEqual(await ledger(f), records);
			assert.deepEqual(fromTree?.messages, before?.messages);
			f.restart();
			const restored = await f.project();
			assert.deepEqual(await ledger(f), records);
			assert.deepEqual(restored?.messages, before?.messages);
			assert.equal((await guidanceHealth(f)).guidance.status, "ok");
		} finally {
			await f.writer.close();
		}
	});

	it("persists retirement before replacement and preserves the allowance while retirement writes fail", async () => {
		const f = fixture([repeatableGuide()]);
		try {
			await editSource(f, "alpha");
			const retiredId = (await ledger(f))[0].id;
			const projected = (await f.views())[0].projected;
			const append = f.pi.appendEntry.bind(f.pi);
			const writes: string[] = [];
			let failing = true;
			f.pi.appendEntry = (type, data) => {
				writes.push(type);
				if (type === GUIDANCE_RETIREMENT_ENTRY && failing) throw new Error("storage unavailable");
				append(type, data);
			};
			assert.equal(await editSource(f, "beta"), undefined);
			assert.deepEqual(writes, [GUIDANCE_RETIREMENT_ENTRY]);
			assert.equal((await guidanceHealth(f)).guidance.status, "persistence-failed");
			assert.equal((await f.views())[0].projected, projected);
			assert.equal(f.guidanceEntries().length, 1);
			assert.equal(retirements(f).length, 0);
			assert.equal(await editSource(f, "alpha"), undefined);
			assert.deepEqual(await ledger(f), []);
			assert.equal((await f.views())[0].projected, projected);
			failing = false;
			writes.length = 0;
			const recovered = await f.project();
			assert.ok(recovered?.emitted);
			assert.deepEqual(writes, [GUIDANCE_RETIREMENT_ENTRY, GUIDANCE_ENTRY]);
			assert.equal((await f.views())[0].projected, projected + 1);
			assert.notEqual((await ledger(f))[0].id, retiredId);
			assert.equal((await guidanceHealth(f)).guidance.status, "ok");
			f.setMode("observe");
			f.restart();
			assert.deepEqual((await f.project())?.messages, recovered.messages);
		} finally {
			await f.writer.close();
		}
	});

	it("writes no retirement when repeated requests and equal-content edits keep the ledger unchanged", async () => {
		const f = fixture([repeatableGuide()]);
		try {
			await editSource(f, "alpha");
			const records = await ledger(f);
			f.setMode("observe");
			await f.project();
			await editSource(f, "alpha");
			f.restart();
			await f.project();
			assert.deepEqual(await ledger(f), records);
			assert.equal(retirements(f).length, 0);
		} finally {
			await f.writer.close();
		}
	});

	for (const limit of ["records", "bytes"] as const) {
		it(`faults before projecting a restored ledger over its ${limit} limit without truncation`, async () => {
			const f = fixture([repeatableGuide()]);
			try {
				const count = limit === "records" ? GUIDANCE_HISTORY_LIMITS.records + 1 : 2;
				const digest = messageDigest(f.firstMessage);
				for (let index = 0; index < count; index++)
					f.session.appendCustomEntry(GUIDANCE_ENTRY, {
						id: `restored-${index}`,
						anchor: { epoch: "earlier", entryId: f.firstEntry, contribution: 0, messageDigest: digest },
						timestamp: index,
						text: limit === "records" ? `[policy] Notice ${index}.` : "x".repeat(GUIDANCE_HISTORY_LIMITS.bytes / 2),
						pins: [],
					});
				assert.equal(await f.project(), undefined);
				assert.equal((await ledger(f)).length, count);
				assert.equal((await guidanceHealth(f)).guidance.status, "capacity");
				assert.equal((await f.views())[0].projected, 0);
				assert.equal(retirements(f).length, 0);
				assert.ok(f.notifications.some((notice) => notice.includes("guidance projection is paused")));
				await f.project();
				assert.equal((await ledger(f)).length, count);
			} finally {
				await f.writer.close();
			}
		});
	}

	it("keeps the context epoch unchanged across ordinary appends", async () => {
		const f = fixture([repeatableGuide()]);
		await f.project();
		const epoch = (await guidanceHealth(f)).guidance.epoch;
		assert.ok(epoch);
		for (let turn = 0; turn < 3; turn++) {
			await f.project(true);
			assert.equal((await guidanceHealth(f)).guidance.epoch, epoch);
		}
		await f.writer.close();
	});

	it("places records by source through duplicate contents and request-only messages", async () => {
		const f = fixture([repeatableGuide()]);
		const twin = { role: "user", content: [{ type: "text", text: "ok" }], timestamp: 40 };
		const memory = { role: "user", content: [{ type: "text", text: "Memory notice." }], timestamp: 90 };
		f.push({ ...twin });
		f.push({ role: "user", content: [{ type: "text", text: "between" }], timestamp: 41 });
		f.push({ ...twin });
		f.setTranscript([...f.getTranscript(), memory]);
		const first = await f.project();
		assert.ok(first?.emitted);
		const indexes = first.messages.flatMap((message, index) => (textOf(message) === first.emitted ? [index] : []));
		assert.equal(indexes.length, 1);
		const placed = first.messages[(indexes[0] as number) - 1];
		assert.equal(textOf(placed), "ok");
		assert.equal(first.messages.filter((message) => textOf(message) === "ok").indexOf(placed as Message), 1);
		assert.equal(textOf(first.messages[(indexes[0] as number) + 1]), "Memory notice.");

		f.setMode("observe");
		f.setTranscript([...f.getTranscript(), { ...twin }, memory]);
		const ambiguous = await f.project();
		assert.equal(ambiguous, undefined);
		const health = await guidanceHealth(f);
		assert.equal(health.guidance.status, "anchor-mismatch");
		f.setMode("enforce");
		assert.equal(await f.contextEmitted(), undefined);
		assert.equal(f.guidanceEntries().length, 1);
		await f.writer.close();
	});

	it("restores only the active branch after tree navigation", async () => {
		const f = fixture([repeatableGuide()]);
		await f.project();
		f.advance();
		await f.project();
		const tip = f.session.getLeafId() as string;
		const full = f.getTranscript();
		f.setMode("observe");
		f.session.branch(f.firstEntry);
		f.setTranscript(full.slice(0, 2));
		await f.handlers.get("session_tree")?.({}, f.ctx);
		assert.equal(await f.project(), undefined);
		assert.equal((await guidanceHealth(f)).guidance.records, 0);
		f.session.branch(tip);
		f.setTranscript(full);
		await f.handlers.get("session_tree")?.({}, f.ctx);
		const restored = await f.project();
		assert.ok(restored);
		assert.equal(notices(restored.messages).length, 2);
		await f.writer.close();
	});

	it("refuses new guidance at capacity without consuming its allowance", async () => {
		const f = fixture([repeatableGuide()]);
		const digest = messageDigest(f.firstMessage);
		for (let index = 0; index < GUIDANCE_HISTORY_LIMITS.records; index++)
			f.session.appendCustomEntry(GUIDANCE_ENTRY, {
				id: `record-${index}`,
				anchor: { epoch: "earlier", entryId: f.firstEntry, contribution: 0, messageDigest: digest },
				timestamp: index,
				text: `[policy] Earlier notice ${index}.`,
				pins: [],
			});
		const result = await f.project();
		assert.ok(result);
		assert.equal(result.emitted, undefined);
		assert.equal(f.guidanceEntries().length, GUIDANCE_HISTORY_LIMITS.records);
		assert.equal((await f.views())[0].projected, 0);
		const health = (await f.runtime.inspect("health", {}, f.ctx)) as {
			guidance: { status: string; records: number; retainedBytes: number };
		};
		assert.equal(health.guidance.status, "capacity");
		assert.equal(health.guidance.records, GUIDANCE_HISTORY_LIMITS.records);
		assert.ok(health.guidance.retainedBytes > 0);
		const noticesBefore = f.notifications.filter((text) => text.includes("Guidance history is full")).length;
		assert.equal(noticesBefore, 1);
		await f.project();
		assert.equal(f.notifications.filter((text) => text.includes("Guidance history is full")).length, 1);
		await f.writer.close();
	});

	it("adds no record and consumes no allowance when persistence fails", async () => {
		const f = fixture([repeatableGuide()]);
		(f.pi as unknown as { appendEntry: () => void }).appendEntry = () => {
			throw new Error("storage unavailable");
		};
		assert.equal(await f.project(), undefined);
		assert.equal(f.guidanceEntries().length, 0);
		assert.equal((await f.views())[0].projected, 0);
		const health = (await f.runtime.inspect("health", {}, f.ctx)) as { guidance: { status: string } };
		assert.equal(health.guidance.status, "persistence-failed");
		await f.writer.close();
	});

	it("ignores malformed stored anchors without changing projection", async () => {
		const f = fixture([repeatableGuide()], "observe");
		f.session.appendCustomEntry(GUIDANCE_ENTRY, {
			id: "bad",
			anchor: { epoch: "earlier", entryId: f.firstEntry, contribution: -1, messageDigest: "short" },
		});
		assert.equal(await f.project(), undefined);
		const health = (await f.runtime.inspect("health", {}, f.ctx)) as {
			guidance: { status: string; records: number };
		};
		assert.equal(health.guidance.records, 0);
		assert.equal(health.guidance.status, "ok");
		await f.writer.close();
	});
});

describe("effective command checks", () => {
	it("blocks an approved correction that introduces a package-denied command without mutating input", async () => {
		const f = correctedBash(shellRule());
		const input = { command: "printf safe" };
		const preview = (await f.runtime.inspect("preview", { tool: "bash", input }, f.ctx)) as {
			input: {
				denied: boolean;
				changed: boolean;
				candidate: unknown;
				evaluations: Array<{ id: string; deny: boolean }>;
			};
		};
		assert.equal(preview.input.denied, true);
		assert.equal(preview.input.changed, false);
		assert.deepEqual(preview.input.candidate, input);
		assert.ok(preview.input.evaluations.some((entry) => entry.id === "routing.cat-read" && entry.deny));
		const decision = await f.call("corrected", input);
		assert.equal(decision?.block, true);
		assert.ok(decision);
		assert.match(decision.reason, /Matched command: \[corrected input omitted\]/);
		assert.doesNotMatch(decision.reason, /cat notes\.md|For this command|path=notes\.md/);
		assert.deepEqual(input, { command: "printf safe" });
		await f.runtime.toolEnd(
			{
				toolName: "bash",
				toolCallId: "corrected",
				isError: true,
				result: { content: [{ type: "text", text: decision.reason }] },
			},
			f.ctx,
		);
		await f.writer.close();
		assert.equal(f.records[0].outcome, "denied");
		assert.equal(f.records[0].policy?.inputCorrected, undefined);
		assert.ok(f.records[0].classes.includes("routing.cat-read"));
	});
	it("applies approved local command shapes to the final candidate", async () => {
		const blocker: RuleRecord = {
			...shellRule(),
			id: "local.walk",
			matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "walk" } },
			source: {
				kind: "local",
				proposalId: "test-proposal",
				approvedAudit: { surface: "command", session: "session", model: null, at: new Date().toISOString() },
			},
		};
		const f = correctedBash(blocker, "enforce", "walk target");
		const input = { command: "printf safe" };
		assert.equal((await f.call("local", input))?.block, true);
		assert.deepEqual(input, { command: "printf safe" });
		await f.writer.close();
	});
	for (const mode of ["observe", "notice", "annotate"] as const)
		it(`${mode} checks actual commands without activating hypothetical candidate matches`, async () => {
			const f = correctedBash(shellRule(), mode);
			const input = { command: "printf safe" };
			assert.equal(await f.call("observed", input), undefined);
			assert.deepEqual(input, { command: "printf safe" });
			await f.result("observed");
			await f.finish("observed");
			await f.writer.close();
			assert.equal(f.records[0].classes.includes("routing.cat-read"), false);
			assert.equal(f.records[0].policy?.inputCorrected, undefined);
		});
	it("refuses a correction when a captured command rule generation changes", async () => {
		const f = correctedBash(shellRule());
		const input = { command: "printf safe" };
		await f.runtime.toolStart({ toolName: "bash", toolCallId: "stale", args: input }, f.ctx);
		f.runtime.reset(["routing.cat-read"], "operator reset");
		const decision = await f.runtime.toolCall(
			{ type: "tool_call", toolName: "bash", toolCallId: "stale", input },
			f.ctx,
		);
		assert.equal(decision?.block, true);
		assert.deepEqual(input, { command: "printf safe" });
		await f.writer.close();
	});
	it("retains an originally matched steer command class when its result is an error", async () => {
		const f = fixture(
			[shellRule("steer")],
			"enforce",
			obj({ command: str() }, { open: true }),
			false,
			"/unused",
			"bash",
		);
		await f.call("failed", { command: "cat notes.md" });
		assert.equal(await f.result("failed", true), undefined);
		await f.finish("failed", true);
		await f.writer.close();
		assert.deepEqual(f.records[0].classes, ["routing.cat-read"]);
		assert.equal(f.records[0].annotated, undefined);
		assert.equal(f.records[0].outcome, "execution-error");
	});
});

describe("normalized execution plans", () => {
	it("keeps every mixed final denial in one plan and leaves arguments unchanged", async () => {
		const f = correctedBash(shellRule());
		const structured = rule("structured.final", {
			phase: "input",
			inputView: "effective",
			when: { op: "eq", path: ["input", "command"], value: "cat notes.md" },
			action: { kind: "deny" },
			onUnavailable: "skip",
		});
		f.snapshot.records.set(structured.id, structured);
		f.runtime.sync(f.snapshot);
		const input = { command: "printf safe" };
		const decision = await f.call("mixed", input);
		assert.equal(decision?.block, true);
		assert.ok(decision);
		assert.deepEqual(input, { command: "printf safe" });
		await f.runtime.toolEnd(
			{
				toolName: "bash",
				toolCallId: "mixed",
				isError: true,
				result: { content: [{ type: "text", text: decision.reason }] },
			},
			f.ctx,
		);
		await f.writer.close();
		const evaluations = f.records[0].policy?.evaluations as Array<{ id: string; inputView?: string; deny: boolean }>;
		assert.deepEqual(
			evaluations.filter((row) => row.inputView === "effective" && row.deny).map((row) => row.id),
			["routing.cat-read", "structured.final"],
		);
	});
	it("refuses corrections after any captured final gate changes its observation period", async () => {
		const gate = rule("final", {
			phase: "input",
			inputView: "effective",
			when: { op: "exists", path: ["input", "blocked"] },
			action: { kind: "deny" },
			onUnavailable: "skip",
		});
		const f = fixture([rename(), gate]);
		const input = { old: "x" };
		await f.runtime.toolStart({ toolName: "sample", toolCallId: "stale-final", args: input }, f.ctx);
		f.runtime.reset([gate.id], "Approved reset");
		assert.equal(
			(await f.runtime.toolCall({ type: "tool_call", toolName: "sample", toolCallId: "stale-final", input }, f.ctx))
				?.block,
			true,
		);
		assert.deepEqual(input, { old: "x" });
		await f.writer.close();
	});
	it("refuses a correction on nonwritable arguments before any input write", async () => {
		const f = fixture([rename()]);
		const input = Object.freeze({ old: "x" });
		assert.equal((await f.call("frozen", input))?.block, true);
		assert.deepEqual(input, { old: "x" });
		await f.writer.close();
	});
	for (const mode of ["observe", "notice", "annotate", "enforce"] as const)
		it(`${mode} previews the same corrected-result then guidance sequence as execution`, async () => {
			const error = rule("error", {
				phase: "result",
				when: { op: "eq", path: ["result", "details", "failed"], value: true },
				action: { kind: "assert-error" },
				onUnavailable: "skip",
			});
			const guide = rule("result.guide", {
				phase: "result",
				when: {
					all: [
						{ op: "exists", path: ["input", "name"] },
						{ op: "eq", path: ["result", "isError"], value: true },
					],
				},
				action: { kind: "guide", text: "Inspect the corrected error." },
				onUnavailable: "skip",
			});
			const f = fixture([rename(), error, guide], mode);
			const input = { old: "x" };
			const preview = (await f.runtime.inspect(
				"preview",
				{ tool: "sample", input, result: { isError: false, details: { failed: true } } },
				f.ctx,
			)) as { resultCorrected: boolean; results: Array<{ id: string; truth: boolean }> };
			assert.deepEqual(input, { old: "x" });
			await f.call("previewed", input);
			const result = await f.result("previewed", false, { failed: true });
			assert.equal(preview.resultCorrected, result?.isError === true);
			assert.equal(preview.results.find((row) => row.id === guide.id)?.truth, mode === "enforce" ? true : undefined);
			assert.equal(result?.content !== undefined, mode === "enforce");
			await f.writer.close();
		});
	it("shares ordinary result conditions between preview and execution and tolerates absent optionals", async () => {
		const check = rule("result.fields", {
			phase: "result",
			when: {
				all: [
					{ op: "eq", path: ["result", "tool"], value: "sample" },
					{ op: "eq", path: ["result", "isError"], value: false },
					{ op: "eq", path: ["result", "details", "failed"], value: true },
					{ op: "eq", path: ["result", "content", "0", "type"], value: "text" },
				],
			},
			action: { kind: "assert-error" },
			onUnavailable: "skip",
		});
		const f = fixture([check]);
		const preview = (await f.runtime.inspect(
			"preview",
			{ tool: "sample", input: {}, result: { details: { failed: true }, content: [{ type: "text", text: "body" }] } },
			f.ctx,
		)) as { resultCorrected: boolean; results: Array<{ truth: unknown }> };
		assert.equal(preview.resultCorrected, true);
		assert.equal(preview.results[0].truth, true);
		await f.call("absent-optionals", {});
		assert.equal((await f.result("absent-optionals", false, { failed: true }))?.isError, true);
		await f.call("missing-optionals", {});
		assert.equal((await f.result("missing-optionals", false))?.isError, undefined);
		await f.writer.close();
	});
	it("uses common applicability before captured matches, guidance, and completed observations", async () => {
		for (const active of [true, false, "unknown"] as const) {
			const record = shellRule("steer");
			record.definition.applicability = { op: "eq", path: ["context", "tools", "read", "active"], value: true };
			const f = fixture([record], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
			if (active === "unknown")
				f.pi.getAllTools = () => {
					throw new Error("Catalog unavailable");
				};
			else if (active) {
				const tools = f.pi.getAllTools();
				f.pi.getAllTools = () => [...tools, { ...tools[0], name: "read" }];
				f.pi.getActiveTools = () => ["bash", "read"];
			}
			await f.call("applicability", { command: "cat notes.md" });
			assert.equal((await f.result("applicability"))?.content !== undefined, active === true);
			await f.finish("applicability");
			assert.equal((await f.views())[0].count, active === true ? 1 : 0);
			await f.writer.close();
			assert.deepEqual(f.records[0].classes, active === true ? [record.id] : []);
		}
	});
	it("keeps unavailable evaluations separate from true match classes and retains required denial guidance", async () => {
		for (const required of [false, true]) {
			const check = rule("schema.check", {
				phase: "input",
				when: { op: "eq", path: ["schema", "valid"], value: false },
				action: { kind: "deny" },
				onUnavailable: required ? "deny" : "skip",
			});
			const f = fixture([check]);
			f.pi.getAllTools = () => [];
			const decision = await f.call("unavailable", {});
			assert.equal(decision?.block, required ? true : undefined);
			if (required) {
				assert.ok(decision);
				assert.match(decision.reason, /Rule schema.check/);
			}
			await f.finish("unavailable", required);
			await f.writer.close();
			assert.deepEqual(f.records[0].classes, []);
			const evaluations = f.records[0].policy?.evaluations as Array<{
				truth: unknown;
				unavailable: boolean;
				deny: boolean;
			}>;
			assert.equal(evaluations[0].truth, "unknown");
			assert.equal(evaluations[0].unavailable, true);
			assert.equal(evaluations[0].deny, required);
		}
	});
	it("invalidates admitted effects when an operator changes the effective action on the same record object", async () => {
		const record = shellRule("steer");
		const f = fixture([record], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
		await f.call("changed-action", { command: "cat notes.md" });
		const before = (await f.views())[0].generation;
		record.override = {
			effect: "block",
			reason: "Require prevention",
			againstDefinitionRevision: record.definition.revision,
			audit: { surface: "command", session: "session", model: null, at: new Date().toISOString() },
		};
		assert.equal(await f.result("changed-action"), undefined);
		await f.finish("changed-action");
		const view = (await f.views())[0];
		assert.notEqual(view.generation, before);
		assert.equal(view.count, 0);
		assert.equal(view.projected, 0);
		await f.writer.close();
	});
	it("routes approved input guidance to a matched successful result without a new turn", async () => {
		const inputGuide = rule("input.guide", {
			phase: "input",
			when: { op: "eq", path: ["input", "name"], value: "special" },
			action: { kind: "guide", text: "Use the approved target." },
			onUnavailable: "skip",
		});
		const f = fixture([inputGuide]);
		await f.call("matching", { name: "special" });
		assert.match(JSON.stringify(await f.result("matching")), /Use the approved target/);
		await f.call("other", { name: "ordinary" });
		assert.equal(await f.result("other"), undefined);
		await f.call("error", { name: "special" });
		assert.equal(await f.result("error", true), undefined);
		await f.writer.close();
	});
});

describe("recorded call explanations", () => {
	it("preserves unknown CLI reason codes through preview, telemetry, and call explanation", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-cli-explain-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const commandRule = rule("cli", {
			phase: "input",
			when: yes,
			action: { kind: "deny" },
			onUnavailable: "deny",
		});
		commandRule.matcher = {
			kind: "declarative",
			language: "command-shape/v1",
			onUnavailable: "deny",
			spec: { command: "git", cli: { profile: "git", subcommand: ["push"] }, anyFlags: ["--force", "-f"] },
		};
		const f = fixture([commandRule], "enforce", obj({ command: str() }, { open: true }), false, dir, "bash");
		const input = { command: "git push $FLAGS" };
		type Evaluation = { truth: string; unavailableReasons: string[] };
		const preview = (await f.runtime.inspect("preview", { tool: "bash", input }, f.ctx)) as {
			input: { denied: boolean; evaluations: Evaluation[] };
		};
		assert.equal(preview.input.denied, true);
		assert.equal(preview.input.evaluations[0].truth, "unknown");
		const reasons = preview.input.evaluations[0].unavailableReasons;
		assert.ok(reasons.length > 0);
		assert.ok(reasons.every((reason) => /^[a-z0-9.-]{1,80}$/.test(reason)));
		assert.equal((await f.call("unknown", input))?.block, true);
		await f.finish("unknown", true);
		await f.writer.close();
		await writeTelemetrySegment(dir, [JSON.stringify(f.records[0])]);
		const explained = (await f.runtime.inspect("explain", { id: "call:unknown" }, f.ctx)) as {
			records: Array<{ policy: { evaluations: Evaluation[] } }>;
		};
		assert.deepEqual(explained.records[0].policy.evaluations[0].unavailableReasons, reasons);
	});
	it("reads current-session unmatched calls and only approved metadata fields", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-explain-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const f = fixture(
			[
				rule("not-selected", {
					phase: "input",
					when: { op: "eq", path: ["tool"], value: "other" },
					action: { kind: "deny" },
					onUnavailable: "skip",
				}),
			],
			"observe",
			obj({}, { open: true }),
			false,
			dir,
		);
		await f.call("trace", {});
		await f.result("trace");
		await f.finish("trace");
		await f.writer.close();
		const record = { ...f.records[0], policy: { ...f.records[0].policy, rawInput: "unretained-example-marker" } };
		await writeTelemetrySegment(dir, [
			JSON.stringify(record),
			JSON.stringify({ ...record, session: "another-session" }),
		]);
		const explained = (await f.runtime.inspect("explain", { id: "call:trace" }, f.ctx)) as {
			records: Array<{
				session: string;
				classes: string[];
				policy: {
					evaluations: Array<{ truth: boolean }>;
					recordedCoverage: { evaluations: { total: number; omitted: number } };
				};
			}>;
		};
		assert.equal(explained.records.length, 1);
		assert.equal(explained.records[0].session, "session");
		assert.deepEqual(explained.records[0].classes, []);
		assert.deepEqual(explained.records[0].policy.evaluations, []);
		assert.deepEqual(explained.records[0].policy.recordedCoverage.evaluations, { total: 1, omitted: 0, irrelevant: 1 });
		assert.equal(JSON.stringify(explained).includes("unretained-example-marker"), false);
	});
});

describe("input transactions and modes", () => {
	it("retains explicit CLI unknown denial when the outer input exceeds snapshot bounds", async () => {
		for (const effect of ["block", "steer"] as const) {
			const commandRule = rule("cli-limit", {
				phase: "input",
				when: yes,
				action: { kind: "deny" },
				onUnavailable: "deny",
			});
			commandRule.definition.authority = "steer-or-block";
			commandRule.definition.effect = effect;
			commandRule.matcher = {
				kind: "declarative",
				language: "command-shape/v1",
				onUnavailable: "deny",
				spec: { command: "git", cli: { profile: "git", subcommand: ["push"] }, anyFlags: ["--force"] },
			};
			const f = fixture([commandRule], "enforce", obj({ command: str() }, { open: true }), false, "/unused", "bash");
			const denial = await f.call("oversize", { command: `git push ${"x".repeat(300000)}` });
			assert.equal(denial?.block === true, effect === "block");
			await f.writer.close();
		}
	});
	it("does not give unavailable input corrections authority when applicability is unknown", async () => {
		const correction = rule("inapplicable", {
			phase: "input",
			when: yes,
			action: { kind: "rename-key", path: [], from: "old", to: "name" },
			onUnavailable: "deny",
		});
		correction.definition.applicability = { op: "eq", path: ["input", "authorized"], value: true };
		const f = fixture([correction]);
		const input = { old: "x".repeat(300000) };
		assert.equal(await f.call("unknown-applicability", input), undefined);
		assert.ok(Object.hasOwn(input, "old"));
		await f.writer.close();
	});
	it("commits one schema-valid candidate and retains no private input in telemetry", async () => {
		const f = fixture([rename()]);
		const input = { old: "private-value" };
		assert.equal(await f.call("a", input), undefined);
		assert.deepEqual(input, { name: "private-value" });
		await f.result("a");
		await f.finish("a");
		await f.writer.close();
		assert.equal(f.records.length, 1);
		assert.doesNotMatch(JSON.stringify(f.records), /private-value|body/);
		assert.equal(f.records[0].policy?.inputCorrected, true);
	});
	it("blocks conflicts and invalid candidates without a partial input write", async () => {
		for (const records of [
			[
				rename(),
				rule("other", {
					phase: "input",
					when: yes,
					action: { kind: "rename-key", path: [], from: "old", to: "different" },
					onUnavailable: "skip",
				}),
			],
			[rename()],
		]) {
			const f = fixture(records, "enforce", obj({ old: str() }, { open: false }));
			const input = { old: "x" };
			assert.equal((await f.call("a", input))?.block, true);
			assert.deepEqual(input, { old: "x" });
			await f.writer.close();
		}
	});
	it("checks original prohibitions before corrections and effective prohibitions before commit", async () => {
		for (const inputView of ["original", "effective"] as const) {
			const denial = rule("deny", {
				phase: "input",
				inputView,
				when: { op: "exists", path: ["input", inputView === "original" ? "old" : "name"] },
				action: { kind: "deny" },
				onUnavailable: "skip",
			});
			const f = fixture([rename(), denial]);
			const input = { old: "x" };
			assert.equal((await f.call("a", input))?.block, true);
			assert.deepEqual(input, { old: "x" });
			await f.writer.close();
		}
	});
	for (const mode of ["observe", "notice", "annotate"] as const)
		it(`${mode} leaves arguments and error flags unchanged`, async () => {
			const assertion = rule("error", {
				phase: "result",
				when: { op: "eq", path: ["result", "details", "failed"], value: true },
				action: { kind: "assert-error" },
				onUnavailable: "skip",
			});
			const f = fixture([rename(), assertion], mode);
			const input = { old: "x" };
			assert.equal(await f.call("a", input), undefined);
			assert.deepEqual(input, { old: "x" });
			assert.equal(await f.result("a", false, { failed: true }), undefined);
			await f.finish("a", false, { failed: true });
			await f.writer.close();
			assert.equal(f.records[0].error, false);
			assert.equal(f.notifications.length > 0, mode === "notice");
		});
	it("checks observational effective predicates against actual arguments", async () => {
		const denial = rule("effective", {
			phase: "input",
			inputView: "effective",
			when: { op: "exists", path: ["input", "name"] },
			action: { kind: "deny" },
			onUnavailable: "skip",
		});
		const f = fixture([rename(), denial], "observe");
		await f.call("a", { old: "x" });
		await f.result("a");
		await f.finish("a");
		await f.writer.close();
		const evaluations = f.records[0].policy?.evaluations as Array<{ id: string; truth: unknown }>;
		assert.equal(evaluations.find((e) => e.id === "effective"), undefined);
		const coverage = f.records[0].policy?.coverage as { evaluations: { irrelevant: number } };
		assert.equal(coverage.evaluations.irrelevant, 1);
	});
	it("unavailable oversized input still honors required checks and preserves optional corrections", async () => {
		const input = { old: "x".repeat(262145) };
		const deny = rule("required", {
			phase: "input",
			when: { op: "eq", path: ["tool"], value: "sample" },
			action: { kind: "deny" },
			onUnavailable: "deny",
		});
		for (const mode of ["observe", "notice", "annotate", "enforce"] as const) {
			const f = fixture([deny], mode);
			assert.equal((await f.call("large", input))?.block, mode === "enforce" ? true : undefined);
			await f.writer.close();
		}
		const optional = fixture([rename()]);
		assert.equal(await optional.call("large", input), undefined);
		assert.equal(input.old.length, 262145);
		assert.equal(Object.hasOwn(input, "name"), false);
		await optional.writer.close();
	});
	it("degraded authority suppresses corrections and denials", async () => {
		const f = fixture([rename()]);
		f.snapshot.health.status = "degraded";
		const input = { old: "x" };
		assert.equal(await f.call("a", input), undefined);
		assert.deepEqual(input, { old: "x" });
		await f.writer.close();
	});
});

type RuntimeFixture = ReturnType<typeof fixture>;
type LifecyclePhase = "start" | "call" | "result" | "end" | "context";
async function prepareLifecyclePhase(f: RuntimeFixture, phase: LifecyclePhase, input: Record<string, unknown>) {
	if (phase === "call") await f.runtime.toolStart({ toolName: "sample", toolCallId: "deferred", args: input }, f.ctx);
	if (phase === "result" || phase === "end" || phase === "context") await f.call("deferred", input);
	if (phase === "end" || phase === "context") await f.result("deferred");
	if (phase === "context") await f.finish("deferred");
}
function invokeLifecyclePhase(f: RuntimeFixture, phase: LifecyclePhase, input: Record<string, unknown>) {
	if (phase === "start") return f.runtime.toolStart({ toolName: "sample", toolCallId: "deferred", args: input }, f.ctx);
	if (phase === "call")
		return f.runtime.toolCall({ type: "tool_call", toolName: "sample", toolCallId: "deferred", input }, f.ctx);
	if (phase === "result") return f.result("deferred", false, { failed: true });
	if (phase === "end") return f.finish("deferred");
	return f.project();
}
async function assertLifecycleSettled(f: RuntimeFixture, phase: LifecyclePhase, input: Record<string, unknown>) {
	if (phase === "start")
		assert.equal(
			((await f.runtime.inspect("health", {}, f.ctx)) as { observations: { pending: number } }).observations.pending,
			0,
		);
	if (phase === "call") assert.deepEqual(input, { old: "x" });
	assert.equal((await f.views()).find((view) => view.id === "guide")?.count, 0);
	assert.equal((await f.views()).find((view) => view.id === "guide")?.projected, 0);
	await f.writer.close();
	assert.equal(f.records.length, phase === "context" ? 1 : 0);
}

describe("asynchronous lifecycle boundaries", () => {
	for (const phase of ["start", "call", "result", "end", "context"] as const)
		it(`does not commit a stale ${phase} callback after a deferred registry read`, async () => {
			const f = fixture([
				rename(),
				guide(),
				rule("assertion", {
					phase: "result",
					when: { op: "eq", path: ["result", "details", "failed"], value: true },
					action: { kind: "assert-error" },
					onUnavailable: "skip",
				}),
			]);
			const input = { old: "x" };
			await prepareLifecyclePhase(f, phase, input);
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			f.setLoadGate(gate);
			const callback = invokeLifecyclePhase(f, phase, input);
			await f.handlers.get("session_tree")?.({}, f.ctx);
			release();
			assert.equal(await callback, undefined);
			f.setLoadGate(undefined);
			await assertLifecycleSettled(f, phase, input);
		});
});

describe("final observations and guidance", () => {
	it("pins complete folded data before replacement and gives the next call the new table", async () => {
		const correction = rule("folded", {
			phase: "input",
			when: yes,
			action: { kind: "substitute", path: ["name"], table: "values" },
			data: ["values"],
			onUnavailable: "skip",
		});
		const f = fixture([correction]);
		const binding: NamedData = {
			kind: "table",
			name: "values",
			collation: "ascii-case-insensitive",
			revision: "111122223333",
			source: "operator-file",
			capturedAt: Date.now() - 1000,
			rows: [{ key: "Lobby", value: "room-first" }],
		};
		f.snapshot.data.set("values", binding);
		const first = { name: "LOBBY" };
		await f.runtime.toolStart({ toolName: "sample", toolCallId: "first", args: first }, f.ctx);
		f.snapshot.data.set("values", {
			...binding,
			revision: "444455556666",
			rows: [{ key: "lobby", value: "room-next" }],
		});
		await f.runtime.toolCall({ type: "tool_call", toolName: "sample", toolCallId: "first", input: first }, f.ctx);
		assert.deepEqual(first, { name: "room-first" });
		const next = { name: "LoBbY" };
		await f.call("next", next);
		assert.deepEqual(next, { name: "room-next" });
		await f.finish("first");
		await f.finish("next");
		await f.writer.close();
		const revisions = f.records.map((record) => {
			const policy = record.policy as { dataSnapshots: Array<{ name: string; revision: string }> };
			return policy.dataSnapshots.find((entry) => entry.name === "values")?.revision;
		});
		assert.deepEqual(revisions, ["111122223333", "444455556666"]);
		assert.doesNotMatch(JSON.stringify(f.records), /room-first|room-next|LoBbY|Lobby/);
	});
	it("rolls back an earlier key repair when folded destination rows conflict", async () => {
		const key = rule("key", {
			phase: "input",
			when: yes,
			action: { kind: "rename-key", path: [], from: "old", to: "name" },
			onUnavailable: "skip",
		});
		const value = rule("value", {
			phase: "input",
			when: yes,
			action: { kind: "substitute", path: ["name"], table: "values" },
			data: ["values"],
			onUnavailable: "skip",
		});
		const f = fixture([key, value]);
		f.snapshot.data.set("values", {
			kind: "table",
			name: "values",
			collation: "ascii-case-insensitive",
			revision: "111122223333",
			source: "operator-file",
			capturedAt: 1,
			rows: [
				{ key: "Lobby", value: "room-a" },
				{ key: "lobby", value: "room-b" },
			],
		});
		const input = { old: "Lobby" };
		assert.equal((await f.call("collision", input))?.block, true);
		assert.deepEqual(input, { old: "Lobby" });
		await f.writer.close();
	});
	it("retains bounded pinned data identities and freshness without row payloads", async () => {
		const correction = rule("value.correction", {
			phase: "input",
			when: yes,
			action: { kind: "substitute", path: ["name"], table: "values" },
			data: ["values"],
			onUnavailable: "skip",
		});
		const missing = rule("missing.data", {
			phase: "completion",
			when: { op: "exists", path: ["outcome"] },
			action: { kind: "observe", label: "metadata" },
			data: ["absent"],
			onUnavailable: "skip",
		});
		const f = fixture([correction, missing]);
		f.snapshot.data.set("values", {
			kind: "table",
			name: "values",
			revision: "111122223333",
			source: "approved-values",
			capturedAt: Date.now() - 1000,
			maxAgeMs: 60000,
			rows: [{ key: "payload-input", value: "payload-output" }],
		});
		f.snapshot.data.set("unused", {
			kind: "table",
			name: "unused",
			revision: "444455556666",
			source: "approved-unused",
			capturedAt: Date.now() - 1000,
			rows: [{ key: "unused-key", value: "unused-value" }],
		});
		const input = { name: "payload-input" };
		await f.call("data", input);
		assert.deepEqual(input, { name: "payload-output" });
		const values = f.snapshot.data.get("values");
		assert.ok(values);
		f.snapshot.data.set("values", { ...values, revision: "aaaabbbbcccc" });
		await f.result("data");
		await f.finish("data");
		await f.writer.close();
		const policy = f.records[0].policy as {
			dataSnapshots: Array<{
				name: string;
				revision?: string;
				status: string;
				ageMs?: number;
				maxAgeMs?: number;
				snapshotAt?: number;
			}>;
			coverage: { dataSnapshots: { total: number; omitted: number } };
		};
		assert.equal(policy.dataSnapshots.find((row) => row.name === "values")?.revision, "111122223333");
		assert.equal(policy.dataSnapshots.find((row) => row.name === "unused")?.revision, "444455556666");
		assert.equal(policy.dataSnapshots.find((row) => row.name === "values")?.status, "ready");
		assert.equal(policy.dataSnapshots.find((row) => row.name === "values")?.maxAgeMs, 60000);
		assert.equal(typeof policy.dataSnapshots.find((row) => row.name === "values")?.snapshotAt, "number");
		assert.equal(typeof policy.dataSnapshots.find((row) => row.name === "values")?.ageMs, "number");
		assert.equal(policy.dataSnapshots.find((row) => row.name === "absent")?.status, "missing");
		assert.deepEqual(policy.coverage.dataSnapshots, { total: 3, omitted: 0 });
		assert.ok(Buffer.byteLength(JSON.stringify(policy.dataSnapshots)) <= 32768);
		assert.doesNotMatch(JSON.stringify(f.records), /payload-input|payload-output|unused-key|unused-value|aaaabbbbcccc/);
	});
	it("reports omitted named-data snapshots within the serialized byte bound", async () => {
		const rules = Array.from({ length: 100 }, (_, index) =>
			rule(`missing.rule${index}`, {
				phase: "completion",
				when: { op: "exists", path: ["outcome"] },
				action: { kind: "observe", label: "metadata" },
				onUnavailable: "skip",
				data: Array.from({ length: 16 }, (_, item) => `binding-${index}-${item}`),
			}),
		);
		const f = fixture(rules);
		await f.call("bounded", {});
		await f.result("bounded");
		await f.finish("bounded");
		await f.writer.close();
		const policy = f.records[0].policy as {
			dataSnapshots: unknown[];
			coverage: { dataSnapshots: { total: number; omitted: number } };
		};
		assert.equal(policy.coverage.dataSnapshots.total, 1600);
		assert.equal(policy.coverage.dataSnapshots.omitted, 1600 - policy.dataSnapshots.length);
		assert.ok(policy.coverage.dataSnapshots.omitted > 0);
		assert.ok(Buffer.byteLength(JSON.stringify(policy.dataSnapshots)) <= 32768);
	});
	it("corrects structural errors before stateless guidance and counts only the final end", async () => {
		const correction = rule("error", {
			phase: "result",
			when: { op: "eq", path: ["result", "details", "failed"], value: true },
			action: { kind: "assert-error" },
			onUnavailable: "skip",
		});
		const annotation = rule("annotation", {
			phase: "result",
			when: { op: "eq", path: ["result", "isError"], value: true },
			action: { kind: "guide", text: "Check the failed result." },
			onUnavailable: "skip",
			state: { observe: { op: "eq", path: ["outcome", "kind"], value: "execution-error" } },
		});
		const f = fixture([correction, annotation]);
		await f.call("a", {});
		const patch = await f.result("a", false, { failed: true });
		assert.equal(patch?.isError, true);
		const last = patch?.content?.at(-1);
		assert.match(last?.type === "text" ? last.text : "", /Check the failed result/);
		assert.equal(f.records.length, 0);
		assert.equal((await f.views()).find((v) => v.id === "annotation")?.count, 0);
		await f.finish("a", true, { failed: true });
		await f.finish("a", true, { failed: true });
		await f.writer.close();
		assert.equal(f.records.length, 1);
		assert.equal(f.records[0].outcome, "execution-error");
		assert.equal((await f.views()).find((v) => v.id === "annotation")?.count, 1);
	});
	it("records denial decisions separately when the host aborts before execution", async () => {
		const f = fixture([rule("deny", { phase: "input", when: yes, action: { kind: "deny" }, onUnavailable: "skip" })]);
		const denial = await f.call("a", {});
		assert.equal(denial?.block, true);
		const controller = new AbortController();
		controller.abort();
		await f.runtime.toolEnd(
			{
				toolName: "sample",
				toolCallId: "a",
				isError: true,
				result: { content: [{ type: "text", text: "Operation aborted" }] },
			},
			{ ...f.ctx, signal: controller.signal },
		);
		await f.writer.close();
		assert.equal(f.records[0].outcome, "unexecuted");
		assert.equal(f.records[0].abortRequested, true);
		assert.equal(f.records[0].errorKind, "aborted");
		assert.equal(f.records[0].blocked, undefined);
		assert.equal(f.records[0].policy?.decision, "deny");
	});
	it("does not infer an execution error cause from an abort request", async () => {
		const f = fixture([guide()]);
		await f.call("error", {});
		await f.result("error", true);
		const controller = new AbortController();
		controller.abort();
		await f.runtime.toolEnd(
			{
				toolName: "sample",
				toolCallId: "error",
				isError: true,
				result: { content: [{ type: "text", text: "Permission denied" }] },
			},
			{ ...f.ctx, signal: controller.signal },
		);
		await f.writer.close();
		assert.equal(f.records[0].outcome, "execution-error");
		assert.equal(f.records[0].abortRequested, true);
		assert.equal(f.records[0].errorKind, "other");
	});

	it("guides only when a configured alternative tool is active", async () => {
		const scoped = guide();
		if (scoped.matcher.kind !== "declarative" || scoped.matcher.language !== "facts/v1") assert.fail();
		scoped.matcher.spec.when = {
			all: [scoped.matcher.spec.when, { op: "eq", path: ["context", "tools", "alternative", "active"], value: true }],
		};
		const f = fixture([scoped]);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		assert.equal(await f.contextEmitted(), undefined);
		const tools = f.pi.getAllTools();
		f.pi.getAllTools = () => [...tools, { ...tools[0], name: "alternative" }];
		assert.equal(await f.contextEmitted(), undefined);
		f.pi.getActiveTools = () => ["sample", "alternative"];
		assert.match((await f.contextText()) ?? "", /Inspect the completed outcome/);
		await f.writer.close();
	});

	it("keeps unavailable tool catalogs unknown under negation", async () => {
		const scoped = guide();
		if (scoped.matcher.kind !== "declarative" || scoped.matcher.language !== "facts/v1") assert.fail();
		scoped.matcher.spec.when = { not: { op: "exists", path: ["context", "tools", "alternative"] } };
		const f = fixture([scoped]);
		f.pi.getAllTools = () => {
			throw new Error("catalog unavailable");
		};
		assert.equal(await f.contextEmitted(), undefined);
		assert.equal((await f.views())[0].projected, 0);
		await f.writer.close();
	});

	it("combines completed count, text volume, and distinct turns for context guidance", async () => {
		const scoped = guide();
		if (scoped.matcher.kind !== "declarative" || scoped.matcher.language !== "facts/v1") assert.fail();
		scoped.matcher.spec.when = {
			all: [
				{ op: "gte", path: ["state", "count"], value: 2 },
				{ op: "gte", path: ["state", "total"], value: 8 },
				{ op: "gte", path: ["state", "turns"], value: 2 },
			],
		};
		scoped.matcher.spec.state = { observe: success, totalPath: ["outcome", "preGuidanceBytes"], once: "period" };
		const f = fixture([scoped]);
		await f.handlers.get("turn_start")?.({}, f.ctx);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		assert.equal(await f.contextEmitted(), undefined);
		await f.handlers.get("turn_start")?.({}, f.ctx);
		await f.call("b", {});
		await f.result("b");
		await f.finish("b");
		assert.match((await f.contextText()) ?? "", /Inspect the completed outcome/);
		await f.writer.close();
		assert.equal(f.records[0].outputBytes, 4);
	});

	it("renders unavailable aggregate metrics explicitly in state inspection", async () => {
		const metric = rule("metric", {
			phase: "completion",
			when: { op: "exists", path: ["outcome"] },
			action: { kind: "observe", label: "amount" },
			onUnavailable: "skip",
			state: { observe: success, totalPath: ["result", "details", "amount"] },
		});
		const f = fixture([metric]);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		const text = JSON.stringify(await f.runtime.inspect("state", {}, f.ctx));
		assert.match(text, /"total":"unavailable"/);
		assert.match(text, /"turnTotal":"unavailable"/);
		await f.writer.close();
	});

	it("preserves unknown preflight outcomes rather than claiming an execution failure", async () => {
		const f = fixture([guide()]);
		await f.runtime.toolStart({ toolName: "sample", toolCallId: "a", args: {} }, f.ctx);
		await f.finish("a", true);
		await f.writer.close();
		assert.equal(f.records[0].outcome, "unexecuted");
		assert.equal(f.records[0].observationComplete, false);
		assert.equal((await f.views())[0].count, 0);
	});
	it("counts selected completions in order and projects grouped context without an extra turn", async () => {
		const f = fixture([guide()]);
		await f.call("first", {});
		await f.call("second", {});
		await f.result("second");
		await f.finish("second");
		assert.equal((await f.views())[0].count, 1);
		await f.result("first");
		await f.finish("first");
		assert.match((await f.contextText()) ?? "", /Inspect the completed outcome/);
		assert.equal(await f.contextEmitted(), undefined);
		await f.writer.close();
		assert.deepEqual(
			f.records.map((r) => r.callId),
			["second", "first"],
		);
		assert.equal((await f.views())[0].projected, 1);
	});
	it("ignores completion state and result effects after reset or semantic revision", async () => {
		for (const change of ["reset", "revision", "disable"]) {
			const f = fixture([guide(), rename()]);
			await f.call("a", { old: "x" });
			if (change === "reset") f.runtime.reset(undefined, "operator reset");
			else if (change === "revision") {
				const record = f.snapshot.records.get("guide");
				assert.ok(record);
				record.definition.revision = "abcdef123456";
			} else {
				const record = f.snapshot.records.get("guide");
				assert.ok(record);
				record.override = {
					state: "disabled",
					reason: "test",
					againstDefinitionRevision: "123456abcdef",
					audit: { surface: "command", session: "session", model: null, at: new Date().toISOString() },
				};
			}
			await f.result("a");
			await f.finish("a");
			assert.equal((await f.views()).find((v) => v.id === "guide")?.count ?? 0, 0);
			await f.writer.close();
		}
	});
	it("preserves observations across compaction and resets on tree navigation", async () => {
		const f = fixture([guide()]);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		assert.equal(f.handlers.has("session_compact"), true);
		assert.equal((await f.views())[0].count, 1);
		await f.handlers.get("session_compact")?.({}, f.ctx);
		assert.equal((await f.views())[0].count, 1);
		await f.handlers.get("session_tree")?.({}, f.ctx);
		assert.equal((await f.views())[0].count, 0);
		assert.equal((await f.views())[0].resetReason, "tree");
		await f.writer.close();
	});
	it("preview does not count outcomes or consume guidance eligibility", async () => {
		const f = fixture([guide(), rename()]);
		await f.call("a", {});
		await f.result("a");
		await f.finish("a");
		const before = await f.views();
		const input = { old: "x" };
		const preview = await f.runtime.inspect("preview", { tool: "sample", input, result: { isError: false } }, f.ctx);
		assert.deepEqual(await f.views(), before);
		assert.deepEqual(input, { old: "x" });
		assert.equal((preview as { stateAdvanced: boolean }).stateAdvanced, false);
		assert.match((await f.contextText()) ?? "", /Inspect the completed outcome/);
		await f.writer.close();
	});
	it("terminal identifier rollover does not disable result corrections", async () => {
		const f = fixture([
			rule("error", {
				phase: "result",
				when: { op: "eq", path: ["result", "details", "failed"], value: true },
				action: { kind: "assert-error" },
				onUnavailable: "skip",
			}),
		]);
		for (let index = 0; index < 8194; index++) {
			const id = `c${index}`;
			await f.call(id, {});
			assert.equal((await f.result(id, false, { failed: true }))?.isError, true);
			await f.finish(id, true);
		}
		const health = (await f.runtime.inspect("health", {}, f.ctx)) as {
			observations: { incomplete: number; recentCompletedIds: number };
		};
		assert.equal(health.observations.incomplete, 0);
		assert.equal(health.observations.recentCompletedIds, 8192);
		await f.writer.close();
		assert.equal(f.records.length, 8194);
	});
	it("writer failure does not cancel later approved mechanisms", async () => {
		const f = fixture([rename()], "enforce", undefined, true);
		await f.call("first", { old: "x" });
		await f.result("first");
		await f.finish("first");
		await f.writer.close();
		assert.deepEqual(f.failures, ["disk unavailable"]);
		const input = { old: "y" };
		await f.call("second", input);
		assert.deepEqual(input, { name: "y" });
	});
});

test("prepares the registered schema at each tool boundary", async () => {
	const schema: Record<string, unknown> = { type: "object", additionalProperties: true };
	const gate = rule("schema.gate", {
		phase: "input",
		selector: { tools: ["sample"] },
		when: { op: "eq", path: ["schema", "valid"], value: false },
		action: { kind: "deny" },
		onUnavailable: "skip",
	});
	const f = fixture([gate], "enforce", schema);
	assert.equal(await f.call("allowed", { extra: true }), undefined);
	schema.additionalProperties = false;
	const denied = await f.call("denied", { extra: true });
	assert.equal(denied?.block, true);
	await f.writer.close();
});

describe("telemetry writer lifecycle", () => {
	it("reads current writer pressure, recovery, and cumulative loss counts in ordinary health", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const f = fixture([], "observe", obj({}, { open: true }), false, "/unused", "sample", gate);
		await f.call("trace", {});
		await f.finish("trace");
		await new Promise((resolve) => setImmediate(resolve));
		const row = f.records[0];
		assert.ok(row);
		for (let index = 1; index < TELEMETRY_QUEUE_RECORDS; index++) assert.equal(f.writer.enqueue(row), true);
		assert.equal(f.writer.enqueue(row), false);
		const health = async () => (await f.runtime.inspect("health", {}, f.ctx)) as { telemetry: ReturnType<PolicyWriter["health"]> };
		assert.deepEqual((await health()).telemetry, f.writer.health());
		assert.equal(f.writer.health().state, "pressure");
		release();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual((await health()).telemetry, f.writer.health());
		assert.equal(f.writer.health().state, "ok");
		assert.equal(f.writer.health().lostRecords, 1);
		assert.ok(f.writer.health().lostBytes > 0);
		await f.writer.close();
	});

	it("closes the writer on shutdown, drains accepted records, and refuses later ones", async () => {
		const f = fixture([], "observe", obj({}, { open: true }));
		await f.call("trace", {});
		await f.finish("trace");
		const accepted = f.records.length;
		assert.ok(accepted > 0);
		await f.handlers.get("session_shutdown")?.({}, f.ctx);
		assert.equal(f.records.length, accepted, "shutdown waits for the accepted batch");
		assert.equal(f.writer.enqueue({ ...f.records[0], callId: "late" }), false);
		await f.handlers.get("session_shutdown")?.({}, f.ctx);
		assert.equal(f.records.length, accepted);
	});
});
