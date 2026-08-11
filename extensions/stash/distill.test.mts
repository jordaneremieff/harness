import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	boundTranscript,
	buildDistillPrompt,
	DISTILL_SYSTEM_PROMPT,
	entriesToTranscript,
	extractArtifacts,
	isHintedDistill,
	parseDistillPayload,
	readOptionalEnv,
	resolveDistillModel,
	resolveDistillThinking,
	startDistillJob,
	validatePayload,
	type DistillPayload,
	type DistillSession,
} from "./distill.ts";
import { listStashes } from "./store.ts";

const NOW = new Date("2027-03-01T08:00:00Z");

function sessionEntries() {
	return [
		{ type: "message", message: { role: "user", content: "Start the migration work." } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I will port the first tool." },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "src/\n" }],
				isError: false,
			},
		},
		{ type: "compaction", summary: "Early exploration compacted away." },
		{ type: "custom_message", customType: "note", content: "Remember the token budget.", display: true },
	] as any;
}

function fakeFactory(reply: string, opts?: { promptReject?: Error; neverResolves?: boolean; onAbort?: () => void }) {
	const calls: { prompted: string[]; aborts: number; disposed: number } = { prompted: [], aborts: 0, disposed: 0 };
	const factory = async (): Promise<DistillSession> => {
		const session: DistillSession = {
			prompt: async (text: string) => {
				calls.prompted.push(text);
				if (opts?.neverResolves) await new Promise<void>(() => {});
				if (opts?.promptReject) throw opts.promptReject;
			},
			getLastAssistantText: () => reply,
			abort: async () => {
				calls.aborts++;
				opts?.onAbort?.();
			},
			dispose: () => {
				calls.disposed++;
			},
		};
		return session;
	};
	return { factory, calls };
}

function withWatchdog<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const watchdog = setTimeout(() => reject(new Error("the asynchronous test did not settle")), timeoutMs);
		void promise.then(
			(value) => {
				clearTimeout(watchdog);
				resolve(value);
			},
			(error) => {
				clearTimeout(watchdog);
				reject(error);
			},
		);
	});
}

let dir: string;
let oldStore: string | undefined;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "stash-distill-test-"));
	oldStore = process.env.PI_STASH_DIR;
	process.env.PI_STASH_DIR = dir;
});

after(async () => {
	if (oldStore === undefined) delete process.env.PI_STASH_DIR;
	else process.env.PI_STASH_DIR = oldStore;
	await rm(dir, { recursive: true, force: true });
});

const VALID_PAYLOAD: DistillPayload = {
	title: "Tool migration",
	summary: "The first tool ports cleanly; the wrapper template extracts itself.",
	decisions: ["Port one tool end-to-end before planning the rest"],
	nextActions: ["Port cognition-recall next"],
	files: ["src/tools.ts"],
	tags: ["migration"],
};

const baseOptions = (factory: any, extra: any = {}) => ({
	model: { id: "test-model", provider: "test", reasoning: true },
	cwd: "/workspace",
	thinkingLevel: "low" as const,
	hint: "port the first tool",
	entries: sessionEntries(),
	project: "/workspace",
	branch: "main",
	sessionId: "sess-9",
	storeDir: dir,
	timeoutMs: 60_000,
	sessionFactory: factory,
	now: () => NOW,
	...extra,
});

describe("transcript serialization", () => {
	it("renders roles, tool calls, tool results, and compaction notes", () => {
		const text = entriesToTranscript(sessionEntries());
		assert.match(text, /\[USER\]\nStart the migration work/);
		assert.match(text, /\[ASSISTANT\]\nI will port the first tool/);
		assert.match(text, /\[tool call: bash\]/);
		assert.match(text, /\[tool result: bash \(ok\)\]\nsrc\//);
		assert.match(text, /\[compaction summary: Early exploration compacted away\.\]/);
		assert.match(text, /\[custom message\]\nRemember the token budget/);
	});

	it("marks failed tool results and omits thinking content", () => {
		const text = entriesToTranscript([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "internal reasoning" }, { type: "text", text: "Retry." }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "edit",
					content: [{ type: "text", text: "no match" }],
					isError: true,
				},
			},
		] as any);
		assert.doesNotMatch(text, /internal reasoning/);
		assert.match(text, /\[tool result: edit \(error\)\]/);
	});
});

describe("transcript bounding", () => {
	it("leaves a short transcript unchanged", () => {
		const text = "short";
		assert.equal(boundTranscript(text, 100), text);
	});

	it("keeps head and tail with a marked cut for a long transcript", () => {
		const text = "A".repeat(400);
		const bound = boundTranscript(text, 100);
		assert.ok(bound.startsWith("A".repeat(25)));
		assert.ok(bound.endsWith("A".repeat(75)));
		assert.match(bound, /\[300 characters omitted\]/);
		assert.equal(bound.length, 25 + 75 + 4 + "[300 characters omitted]".length);
	});

	it("cuts on code-point boundaries so no lone surrogate reaches the distiller", () => {
		const text = "\u{1F600}".repeat(200);
		const bound = boundTranscript(text, 100);
		assert.doesNotMatch(bound, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		assert.doesNotMatch(bound, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		assert.ok(bound.startsWith("\u{1F600}".repeat(25)));
		assert.ok(bound.endsWith("\u{1F600}".repeat(75)));
		assert.match(bound, /\[100 characters omitted\]/);
	});
});

describe("prompt building", () => {
	it("frames the hint as the stash subject before the transcript", () => {
		const prompt = buildDistillPrompt("focus on the token budget", "transcript body");
		assert.match(prompt, /Operator hint: focus on the token budget/);
		assert.match(prompt, /ONLY effort this stash may cover/);
		assert.match(prompt, /The stash must center the hint/);
		assert.match(prompt, /the title names the hint's subject/);
		assert.match(prompt, /is not the subject/);
		assert.match(prompt, /OUT OF SCOPE/);
		assert.match(prompt, /Observed references are candidates/);
		assert.ok(prompt.indexOf("focus on the token budget") < prompt.indexOf("transcript body"));
		// Every framing directive must precede the transcript: a regression
		// that buries the hint below the transcript body fails these orderings.
		const transcriptAt = prompt.indexOf("Session transcript:");
		for (const directive of [
			"The operator hint below is the ONLY effort this stash may cover.",
			"Operator hint: focus on the token budget",
			"The stash must center the hint",
			"Scope boundary (binding)",
			"OUT OF SCOPE",
			"it is not the subject.",
		]) {
			assert.ok(
				prompt.indexOf(directive) !== -1 && prompt.indexOf(directive) < transcriptAt,
				`directive must precede the transcript: ${directive}`,
			);
		}
	});

	it("keeps the transcript and observed references after the hint block", () => {
		const prompt = buildDistillPrompt("focus on the token budget", "transcript body");
		assert.match(prompt, /Session transcript:\ntranscript body/);
		const withArtifacts = buildDistillPrompt("hint", "body", ["/workspace/src/adapter.ts"]);
		const observedHeading = "Observed references from tool results:";
		assert.match(withArtifacts, /Observed references from tool results:/);
		assert.ok(withArtifacts.indexOf(observedHeading) > withArtifacts.indexOf("Session transcript:"));
		assert.ok(withArtifacts.indexOf("OUT OF SCOPE") < withArtifacts.indexOf(observedHeading));
		assert.ok(withArtifacts.indexOf("Observed references are candidates") < withArtifacts.indexOf("Session transcript:"));
	});

	it("preserves concrete references from tool output after the transcript", () => {
		const artifacts = extractArtifacts([
			"Changed /workspace/src/adapter.ts for TASK-123. See https://example.com/issues/TASK-123.",
			"Repeated /workspace/src/adapter.ts and ignored /workspace/node_modules/pkg/index.js.",
		]);
		assert.deepEqual(artifacts, [
			"https://example.com/issues/TASK-123",
			"TASK-123",
			"/workspace/src/adapter.ts",
		]);
		const prompt = buildDistillPrompt("", "bounded transcript", artifacts);
		assert.match(prompt, /Observed references from tool results:/);
		assert.match(prompt, /- \/workspace\/src\/adapter\.ts/);
	});

	it("deduplicates references and keeps the newest bounded set", () => {
		assert.deepEqual(extractArtifacts(["/tmp/one /tmp/two /tmp/three"], 2), ["/tmp/two", "/tmp/three"]);
		assert.deepEqual(extractArtifacts(["/tmp/one"], 0), []);
	});

	it("marks an absent hint", () => {
		const prompt = buildDistillPrompt("   ", "body");
		assert.match(prompt, /Operator hint: \(none\)/);
		assert.match(prompt, /The session transcript is the subject of this stash\./);
		assert.match(prompt, /No sidequest scope exclusion applies/);
		assert.doesNotMatch(prompt, /must center the hint/);
		assert.doesNotMatch(prompt, /OUT OF SCOPE/);
	});

	it("treats the exact (none) sentinel as unhinted", () => {
		assert.equal(isHintedDistill("(none)"), false);
		const prompt = buildDistillPrompt("(none)", "body");
		assert.match(prompt, /Operator hint: \(none\)/);
		assert.match(prompt, /No sidequest scope exclusion applies/);
		assert.doesNotMatch(prompt, /OUT OF SCOPE/);
		assert.doesNotMatch(prompt, /ONLY effort this stash may cover/);
	});

	it("keeps multi-effort exclusion language ahead of a mainline-plus-sidequest transcript", () => {
		const transcript = [
			"[USER]\nGate harness-surface changes and harden the skill.",
			"[ASSISTANT]\nProposal before changes; uncommitted disputed prompts remain.",
			"[USER]\nSide note: distill only the model inheritance finding for /stash new.",
		].join("\n\n");
		const prompt = buildDistillPrompt(
			"session-model inheritance and hint-scoping for /stash new",
			transcript,
			["/workspace/harness/prompts", "/workspace/harness/extensions/stash/distill.ts"],
		);
		const transcriptAt = prompt.indexOf("Session transcript:");
		assert.ok(transcriptAt > 0);
		assert.ok(prompt.indexOf("OUT OF SCOPE") < transcriptAt);
		assert.ok(prompt.indexOf("decisions, open loops, next actions, files, or tags") < transcriptAt);
		assert.ok(prompt.indexOf("Observed references are candidates") < transcriptAt);
		assert.ok(prompt.indexOf("every decisions, openLoops, nextActions, files, and tags") < transcriptAt);
		assert.match(prompt, /session-model inheritance and hint-scoping/);
		assert.match(prompt, /uncommitted disputed prompts remain/);
	});
});

describe("distiller system prompt", () => {
	it("gives the hint the role of artifact subject with a scope self-check", () => {
		assert.match(DISTILL_SYSTEM_PROMPT, /the artifact is about the hint/);
		assert.match(DISTILL_SYSTEM_PROMPT, /The title names the hint's subject/);
		assert.match(DISTILL_SYSTEM_PROMPT, /first sentence of the summary states the result/);
		assert.match(DISTILL_SYSTEM_PROMPT, /scope boundary/);
		assert.match(DISTILL_SYSTEM_PROMPT, /OUT OF SCOPE/);
		assert.match(DISTILL_SYSTEM_PROMPT, /Every decisions, openLoops, nextActions, files, and tags entry/);
		assert.match(DISTILL_SYSTEM_PROMPT, /Observed references are candidates/);
		assert.match(DISTILL_SYSTEM_PROMPT, /When the hint is "\(none\)", the transcript is the subject/);
		assert.match(DISTILL_SYSTEM_PROMPT, /^You are a session distiller for the stash handover system\./);
	});

	it("preserves the SKIP marker, JSON schema, and caps", () => {
		assert.match(DISTILL_SYSTEM_PROMPT, /SKIP_STASH/);
		assert.match(DISTILL_SYSTEM_PROMPT, /```json/);
		assert.match(DISTILL_SYSTEM_PROMPT, /"title" is required, max 200 characters/);
		assert.match(DISTILL_SYSTEM_PROMPT, /"summary" is required, max 100000 characters/);
		assert.match(DISTILL_SYSTEM_PROMPT, /max 200 items, max 20000 characters each/);
		assert.match(DISTILL_SYSTEM_PROMPT, /"tags" is optional, max 50 items, max 80 characters each/);
		assert.match(DISTILL_SYSTEM_PROMPT, /No prose outside the JSON block/);
	});
});

describe("payload parsing", () => {
	it("accepts a fenced JSON block", () => {
		const result = parseDistillPayload(`Here you go:\n\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\`\n`);
		assert.equal(result.kind, "payload");
		if (result.kind === "payload") assert.equal(result.payload.title, "Tool migration");
	});

	it("accepts raw JSON", () => {
		const result = parseDistillPayload(JSON.stringify(VALID_PAYLOAD));
		assert.equal(result.kind, "payload");
	});

	it("recognizes the SKIP marker, fenced or bare", () => {
		assert.equal(parseDistillPayload("SKIP_STASH").kind, "skip");
		assert.equal(parseDistillPayload("```\nSKIP_STASH\n```").kind, "skip");
	});

	it("rejects empty output and malformed JSON", () => {
		assert.equal(parseDistillPayload("").kind, "invalid");
		const malformed = parseDistillPayload("not json");
		assert.equal(malformed.kind, "invalid");
		if (malformed.kind === "invalid") assert.match(malformed.error, /valid JSON/);
	});
});

describe("payload validation", () => {
	it("accepts the full valid shape", () => {
		const payload = validatePayload(VALID_PAYLOAD);
		assert.equal(payload.title, "Tool migration");
		assert.deepEqual(payload.tags, ["migration"]);
	});

	it("requires a non-empty title and summary within caps", () => {
		assert.throws(() => validatePayload({ title: "  ", summary: "x" }), /"title" must not be empty/);
		assert.throws(() => validatePayload({ title: "T".repeat(201), summary: "x" }), /"title" exceeds 200/);
		assert.throws(() => validatePayload({ title: "T", summary: "" }), /"summary" must not be empty/);
		assert.throws(() => validatePayload({ title: "T", summary: "S".repeat(100_001) }), /"summary" exceeds 100000/);
	});

	it("enforces array shapes and caps", () => {
		assert.throws(() => validatePayload({ title: "T", summary: "S", decisions: "nope" }), /"decisions" must be an array/);
		assert.throws(() => validatePayload({ title: "T", summary: "S", files: [1] }), /"files" entries must be strings/);
		assert.throws(() => validatePayload({ title: "T", summary: "S", tags: ["t".repeat(81)] }), /"tags" entry exceeds 80/);
		assert.throws(() => validatePayload({ title: "T", summary: "S", decisions: Array(201).fill("d") }), /"decisions" exceeds 200/);
	});
});

describe("distill job", () => {
	it("writes a validated artifact with session metadata", async () => {
		const { factory, calls } = fakeFactory(JSON.stringify(VALID_PAYLOAD));
		const job = startDistillJob(baseOptions(factory));
		const outcome = await job.result;
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.match(outcome.record.id, /^20270301T080000Z-tool-migration/);
		assert.equal(outcome.record.project, "/workspace");
		assert.equal(outcome.record.branch, "main");
		assert.equal(outcome.record.sessionId, "sess-9");
		assert.equal(outcome.record.state, "open");
		assert.equal(calls.prompted.length, 1);
		assert.match(calls.prompted[0], /Operator hint: port the first tool/);
		assert.match(calls.prompted[0], /\[USER\]\nStart the migration work/);
		assert.equal(calls.disposed, 1);
		const listed = await listStashes(dir, { limit: 50 });
		assert.ok(listed.some((entry) => entry.meta.id === outcome.record.id));
	});

	it("redacts credential-shaped transcript content before the distiller", async () => {
		const secret = "sk-ant-oa" + "t01-abcdefghijklmnopqrstuvwxyz123456";
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					content: [{ type: "text", text: `export API_KEY=${secret}` }],
					isError: false,
				},
			},
			{ type: "message", message: { role: "user", content: "Keep going." } },
		] as any;
		const { factory, calls } = fakeFactory(JSON.stringify(VALID_PAYLOAD));
		await startDistillJob(baseOptions(factory, { entries })).result;
		assert.equal(calls.prompted.length, 1);
		assert.ok(!calls.prompted[0].includes(secret), "the secret must not reach the distiller");
		assert.match(calls.prompted[0], /\[REDACTED\]/);
	});

	it("redacts userinfo credentials from the observed references", async () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					content: [{ type: "text", text: "Deployed from https://deployer:p4ssw0rd123@example.com/repo" }],
					isError: false,
				},
			},
		] as any;
		const { factory, calls } = fakeFactory(JSON.stringify(VALID_PAYLOAD));
		await startDistillJob(baseOptions(factory, { entries })).result;
		assert.equal(calls.prompted.length, 1);
		assert.ok(!calls.prompted[0].includes("p4ssw0rd123"), "the userinfo password must not reach the distiller");
		assert.match(calls.prompted[0], /https:\/\/deployer:\[REDACTED\]@example\.com/);
	});

	it("redacts userinfo passwords that lossy reference extraction would truncate", async () => {
		// Parentheses are valid in userinfo per RFC 3986 and terminate the
		// reference regex; the pre-extraction redaction must remove the password
		// before the reference is cut.
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					content: [{ type: "text", text: "Deployed from https://alice:longpassword(foo)@example.com/path" }],
					isError: false,
				},
			},
		] as any;
		const { factory, calls } = fakeFactory(JSON.stringify(VALID_PAYLOAD));
		await startDistillJob(baseOptions(factory, { entries })).result;
		assert.equal(calls.prompted.length, 1);
		assert.ok(!calls.prompted[0].includes("longpassword"), "the password must be gone before extraction truncates the URL");
	});

	it("keeps the operator hint verbatim while redacting the transcript", async () => {
		const hint = "capture the auth setup for sk-ant-oa" + "t01-abcdefghijklmnopqrstuvwxyz123456";
		const { factory, calls } = fakeFactory(JSON.stringify(VALID_PAYLOAD));
		await startDistillJob(baseOptions(factory, { hint })).result;
		assert.equal(calls.prompted.length, 1);
		assert.ok(calls.prompted[0].includes(hint), "the operator hint is trusted input and must stay verbatim");
	});

	it("redacts secrets from the written artifact", async () => {
		const secret = "gsk_n4ABC" + "DEF1234567890abcdef1234567890abcdef";
		const reply = JSON.stringify({
			title: "Auth setup",
			summary: `The provider key is ${secret}; rotate it soon.`,
			decisions: [`Keep ${secret} out of the store`],
		});
		const outcome = await startDistillJob(baseOptions(fakeFactory(reply).factory)).result;
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		const artifact = await readFile(outcome.path, "utf8");
		assert.ok(!artifact.includes(secret), "the written artifact must not contain the secret");
		assert.match(artifact, /\[REDACTED\]/);
		assert.match(artifact, /rotate it soon/);
	});

	it("passes the model, cwd, and thinking level to the session factory", async () => {
		let received: any;
		const factory = async (options: any) => {
			received = options;
			return {
				prompt: async () => {},
				getLastAssistantText: () => JSON.stringify(VALID_PAYLOAD),
				abort: async () => {},
				dispose: () => {},
			};
		};
		const job = startDistillJob(baseOptions(factory, { thinkingLevel: "high" }));
		const outcome = await job.result;
		assert.equal(outcome.ok, true);
		assert.equal(received.model.id, "test-model");
		assert.equal(received.cwd, "/workspace");
		assert.equal(received.thinkingLevel, "high");
	});

	it("skips the write when the distiller says SKIP", async () => {
		const { factory, calls } = fakeFactory("SKIP_STASH");
		const before = (await listStashes(dir, { limit: 200 })).length;
		const outcome = await startDistillJob(baseOptions(factory)).result;
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.reason, "skip");
		assert.equal(calls.prompted.length, 1);
		assert.equal((await listStashes(dir, { limit: 200 })).length, before, "a skipped distillation must not write");
	});

	it("writes nothing for an invalid payload", async () => {
		const { factory } = fakeFactory('{"title": 42}');
		const outcome = await startDistillJob(baseOptions(factory)).result;
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.reason, "invalid");
		assert.match(outcome.message ?? "", /"title" must be a string/);
	});

	it("reports a prompt failure without writing", async () => {
		const { factory } = fakeFactory("", { promptReject: new Error("provider exploded") });
		const outcome = await startDistillJob(baseOptions(factory)).result;
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.reason, "failed");
		assert.match(outcome.message ?? "", /provider exploded/);
	});

	it("settles a session factory failure as a failed outcome", async () => {
		const factory = async (): Promise<DistillSession> => {
			throw new Error("session creation failed");
		};
		const outcome = await startDistillJob(baseOptions(factory)).result;
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.reason, "failed");
		assert.match(outcome.message ?? "", /session creation failed/);
	});

	it("times out session creation and disposes a late session", async () => {
		let resolveFactory: ((session: DistillSession) => void) | undefined;
		let disposed = 0;
		const factory = () =>
			new Promise<DistillSession>((resolve) => {
				resolveFactory = resolve;
			});
		const outcome = await withWatchdog(startDistillJob(baseOptions(factory, { timeoutMs: 30 })).result);
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.reason, "aborted");
		assert.match(outcome.message ?? "", /timed out/);
		resolveFactory?.({
			prompt: async () => {},
			getLastAssistantText: () => "",
			abort: async () => {},
			dispose: () => {
				disposed++;
			},
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(disposed, 1);
	});

	it("aborts before the prompt when the job is cancelled during creation", async () => {
		const { factory, calls } = fakeFactory("", { neverResolves: true });
		const job = startDistillJob(baseOptions(factory));
		job.abort();
		const outcome = await job.result;
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.reason, "aborted");
		assert.equal(calls.prompted.length, 0, "a cancelled job must not prompt");
		assert.equal(calls.disposed, 1);
	});

	it("aborts an in-flight prompt and settles without writing", async () => {
		const { factory, calls } = fakeFactory("", { neverResolves: true });
		const job = startDistillJob(baseOptions(factory));
		await new Promise((resolve) => setTimeout(resolve, 10));
		job.abort();
		const outcome = await job.result;
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.reason, "aborted");
		assert.equal(calls.aborts, 1, "the session abort must be triggered");
		assert.equal(calls.prompted.length, 1);
	});

	it("times out a stuck prompt with an aborted outcome", async () => {
		const { factory } = fakeFactory("", { neverResolves: true });
		const outcome = await withWatchdog(startDistillJob(baseOptions(factory, { timeoutMs: 30 })).result);
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.reason, "aborted");
		assert.match(outcome.message ?? "", /timed out/);
	});

	it("disposes the session on every path", async () => {
		const { factory, calls } = fakeFactory("not json");
		const outcome = await startDistillJob(baseOptions(factory)).result;
		assert.equal(outcome.ok, false);
		assert.equal(calls.disposed, 1);
	});
});

describe("distill model and thinking resolution", () => {
	const parent = { id: "parent-model", provider: "parent", reasoning: true } as any;
	const override = { id: "cheap-model", provider: "cheap", reasoning: true } as any;
	const unauthed = { id: "locked-model", provider: "locked", reasoning: true } as any;
	const noReasoning = { id: "plain", provider: "plain", reasoning: false } as any;

	function registry(models: any[], authed: Set<any> = new Set(models)) {
		return {
			find(provider: string, id: string) {
				return models.find((model) => model.provider === provider && model.id === id) ?? null;
			},
			getAvailable() {
				return models;
			},
			hasConfiguredAuth(model: any) {
				return authed.has(model);
			},
		};
	}

	it("treats empty env values as unset", () => {
		assert.equal(readOptionalEnv(undefined), undefined);
		assert.equal(readOptionalEnv(""), undefined);
		assert.equal(readOptionalEnv("   "), undefined);
		assert.equal(readOptionalEnv(" cheap/model "), "cheap/model");
	});

	it("inherits the parent model when PI_STASH_MODEL is unset", () => {
		const result = resolveDistillModel({
			envModel: undefined,
			parentModel: parent,
			registry: registry([override]),
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.model, parent);
	});

	it("resolves an explicit provider/id model without requiring a parent model", () => {
		const result = resolveDistillModel({
			envModel: "cheap/cheap-model",
			parentModel: undefined,
			registry: registry([override]),
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.model, override);
	});

	it("prefers an authenticated bare-id match and rejects missing or unauthed models", () => {
		const withAuth = resolveDistillModel({
			envModel: "cheap-model",
			parentModel: parent,
			registry: registry([unauthed, override], new Set([override])),
		});
		assert.equal(withAuth.ok, true);
		if (withAuth.ok) assert.equal(withAuth.model, override);

		const missing = resolveDistillModel({
			envModel: "missing/model",
			parentModel: parent,
			registry: registry([override]),
		});
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.match(missing.error, /not in the current registry/);

		const locked = resolveDistillModel({
			envModel: "locked/locked-model",
			parentModel: parent,
			registry: registry([unauthed], new Set()),
		});
		assert.equal(locked.ok, false);
		if (!locked.ok) {
			assert.match(locked.error, /no configured authentication/);
			assert.doesNotMatch(locked.error, /parent-model/);
		}
	});

	it("fails inheritance when no parent model exists", () => {
		const result = resolveDistillModel({
			envModel: undefined,
			parentModel: undefined,
			registry: registry([override]),
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /No model is available/);
	});

	it("inherits parent thinking and defaults to low when the parent has none", () => {
		const inherited = resolveDistillThinking({
			envThinking: undefined,
			parentThinking: "high",
			model: parent,
		});
		assert.equal(inherited.ok, true);
		if (inherited.ok) assert.equal(inherited.level, "high");

		const fallback = resolveDistillThinking({
			envThinking: undefined,
			parentThinking: undefined,
			model: parent,
		});
		assert.equal(fallback.ok, true);
		if (fallback.ok) assert.equal(fallback.level, "low");
	});

	it("accepts an explicit supported thinking level and fails invalid or unsupported levels", () => {
		const ok = resolveDistillThinking({
			envThinking: "medium",
			parentThinking: "high",
			model: parent,
		});
		assert.equal(ok.ok, true);
		if (ok.ok) assert.equal(ok.level, "medium");

		const invalid = resolveDistillThinking({
			envThinking: "turbo",
			parentThinking: "high",
			model: parent,
		});
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.match(invalid.error, /not a valid level/);

		const unsupported = resolveDistillThinking({
			envThinking: "high",
			parentThinking: "low",
			model: noReasoning,
		});
		assert.equal(unsupported.ok, false);
		if (!unsupported.ok) assert.match(unsupported.error, /not supported by plain\/plain/);
	});

	it("clamps an inherited thinking level the model cannot run", () => {
		const result = resolveDistillThinking({
			envThinking: undefined,
			parentThinking: "high",
			model: noReasoning,
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.level, "off");
	});
});
