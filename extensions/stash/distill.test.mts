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
	escapeRawControlChars,
	extractArtifacts,
	isHintedDistill,
	parseDistillPayload,
	readOptionalEnv,
	resolveDistillModel,
	resolveDistillThinking,
	startDistillJob,
	validatePayload,
	type DistillPayload,
	type DistillStreamFunction,
} from "./distill.ts";
import { listStashes } from "./store.ts";
import {
	completedDistillStream,
	controlledDistillStream,
	testAssistantMessage,
	testModel,
	transcriptEntries,
} from "./test-fixtures.mts";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const NOW = new Date("2027-03-01T08:00:00Z");

function sessionEntries() {
	return transcriptEntries([
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
	]);
}

function fakeFactory(reply: string) {
	const calls: { prompted: string[] } = { prompted: [] };
	const factory: DistillStreamFunction = (model, context, options) => {
		const user = context.messages.find((message) => message.role === "user");
		assert.ok(user && typeof user.content === "string");
		calls.prompted.push(user.content);
		return completedDistillStream(reply)(model, context, options);
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

const baseOptions = (
	factory: DistillStreamFunction,
	extra: Partial<Parameters<typeof startDistillJob>[0]> = {},
): Parameters<typeof startDistillJob>[0] => ({
	model: testModel({ contextWindow: 100000 }),
	cwd: "/workspace",
	thinkingLevel: "low" as const,
	hint: "port the first tool",
	entries: sessionEntries(),
	project: "/workspace",
	branch: "main",
	sessionId: "sess-9",
	storeDir: dir,
	timeoutMs: 60_000,
	streamSimple: factory,
	settings: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }),
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
		const text = entriesToTranscript(
			transcriptEntries([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "internal reasoning" },
							{ type: "text", text: "Retry." },
						],
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
			]),
		);
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
		assert.ok(
			withArtifacts.indexOf("Observed references are candidates") < withArtifacts.indexOf("Session transcript:"),
		);
	});

	it("preserves concrete references from tool output after the transcript", () => {
		const artifacts = extractArtifacts([
			"Changed /workspace/src/adapter.ts for TASK-123. See https://example.com/issues/TASK-123.",
			"Repeated /workspace/src/adapter.ts and ignored /workspace/node_modules/pkg/index.js.",
		]);
		assert.deepEqual(artifacts, ["https://example.com/issues/TASK-123", "TASK-123", "/workspace/src/adapter.ts"]);
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
		const prompt = buildDistillPrompt("session-model inheritance and hint-scoping for /stash new", transcript, [
			"/workspace/harness/prompts",
			"/workspace/harness/extensions/stash/distill.ts",
		]);
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

	it("accepts literal control characters inside string values", () => {
		// Reproduces the observed failure: a literal newline inside "summary"
		// previously failed JSON.parse with "Bad control character in string
		// literal" and discarded a finished distillation.
		const payloadText = [
			"Here is the artifact:",
			"```json",
			'{\n  "title": "Tool migration",',
			'  "summary": "line one',
			"line two after a literal newline",
			'\tand a tab-indented line",',
			'  "tags": ["migration"]',
			"}",
			"```",
		].join("\n");
		const result = parseDistillPayload(payloadText);
		assert.equal(result.kind, "payload");
		if (result.kind === "payload") {
			assert.equal(result.payload.summary, "line one\nline two after a literal newline\n\tand a tab-indented line");
		}
	});

	it("escapes control characters only inside string literals", () => {
		const text = '{\n\t"title": "a\nb",\n\t"n": 1\n}';
		assert.equal(escapeRawControlChars(text), '{\n\t"title": "a\\nb",\n\t"n": 1\n}');
	});

	it("leaves existing escape sequences untouched", () => {
		const text = '{"title": "a\\nb\\u0007c", "summary": "s"}';
		assert.equal(escapeRawControlChars(text), text);
		const parsed = parseDistillPayload(text);
		assert.equal(parsed.kind, "payload");
		if (parsed.kind === "payload") assert.equal(parsed.payload.title, "a\nb\u0007c");
	});

	it("repairs a raw control character immediately after a literal backslash", () => {
		// A literal backslash ending a line followed by a raw newline: the newline is
		// not an escape continuation, and previously the pair failed JSON.parse as
		// "Bad escaped character", discarding a finished distillation.
		const text = `{"title": "a\\
b", "summary": "s"}`;
		const result = parseDistillPayload(text);
		assert.equal(result.kind, "payload");
		if (result.kind === "payload") assert.equal(result.payload.title, "a\\\nb");
	});

	it("escapes other raw control characters through the unicode fallback", () => {
		const bel = String.fromCharCode(7);
		const cr = String.fromCharCode(13);
		const text = `{"title": "a${bel}", "summary": "s${cr}t"}`;
		const result = parseDistillPayload(text);
		assert.equal(result.kind, "payload");
		if (result.kind === "payload") {
			assert.equal(result.payload.title, `a${bel}`);
			assert.equal(result.payload.summary, `s${cr}t`);
		}
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
		assert.throws(
			() => validatePayload({ title: "T", summary: "S", decisions: "nope" }),
			/"decisions" must be an array/,
		);
		assert.throws(() => validatePayload({ title: "T", summary: "S", files: [1] }), /"files" entries must be strings/);
		assert.throws(
			() => validatePayload({ title: "T", summary: "S", tags: ["t".repeat(81)] }),
			/"tags" entry exceeds 80/,
		);
		assert.throws(
			() => validatePayload({ title: "T", summary: "S", decisions: Array(201).fill("d") }),
			/"decisions" exceeds 200/,
		);
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
		const listed = await listStashes(dir, { limit: 50 });
		assert.ok(listed.some((entry) => entry.meta.id === outcome.record.id));
	});

	it("redacts credential-shaped transcript content before the distiller", async () => {
		const secret = "sk-ant-oa" + "t01-abcdefghijklmnopqrstuvwxyz123456";
		const entries = transcriptEntries([
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
		]);
		const { factory, calls } = fakeFactory(JSON.stringify(VALID_PAYLOAD));
		await startDistillJob(baseOptions(factory, { entries })).result;
		assert.equal(calls.prompted.length, 1);
		assert.ok(!calls.prompted[0].includes(secret), "the secret must not reach the distiller");
		assert.match(calls.prompted[0], /\[REDACTED\]/);
	});

	it("redacts userinfo credentials from the observed references", async () => {
		const entries = transcriptEntries([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					content: [{ type: "text", text: "Deployed from https://deployer:p4ssw0rd123@example.com/repo" }],
					isError: false,
				},
			},
		]);
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
		const entries = transcriptEntries([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					content: [{ type: "text", text: "Deployed from https://alice:longpassword(foo)@example.com/path" }],
					isError: false,
				},
			},
		]);
		const { factory, calls } = fakeFactory(JSON.stringify(VALID_PAYLOAD));
		await startDistillJob(baseOptions(factory, { entries })).result;
		assert.equal(calls.prompted.length, 1);
		assert.ok(
			!calls.prompted[0].includes("longpassword"),
			"the password must be gone before extraction truncates the URL",
		);
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

	it("passes the selected model, exact instructions, no tools, and configured stream controls", async () => {
		const model = testModel();
		let received: Parameters<DistillStreamFunction> | undefined;
		const streamSimple: DistillStreamFunction = (...args) => {
			received = args;
			return completedDistillStream(JSON.stringify(VALID_PAYLOAD))(...args);
		};
		const settings = SettingsManager.inMemory({
			retry: { enabled: false, provider: { maxRetries: 2, timeoutMs: 1234, maxRetryDelayMs: 5678 } },
			transport: "sse",
			websocketConnectTimeoutMs: 2345,
			thinkingBudgets: { high: 4567 },
		});
		const outcome = await startDistillJob(baseOptions(streamSimple, { model, settings, thinkingLevel: "high" })).result;
		assert.equal(outcome.ok, true);
		assert.ok(received);
		assert.equal(received[0], model);
		assert.equal(getCurrentSystemPrompt(received[1].messages), DISTILL_SYSTEM_PROMPT);
		assert.deepEqual(getCurrentTools(received[1].messages), []);
		assert.equal(received[1].messages.length, 2);
		assert.equal(
			received[1].messages[1].content,
			buildDistillPrompt("port the first tool", entriesToTranscript(sessionEntries())),
		);
		assert.equal(received[2]?.reasoning, "high");
		assert.equal(received[2]?.thinkingBudgets?.high, 4567);
		assert.equal(received[2]?.transport, "sse");
		assert.equal(received[2]?.timeoutMs, 1234);
		assert.equal(received[2]?.maxRetries, 2);
		assert.equal(received[2]?.maxRetryDelayMs, 5678);
		assert.equal(received[2]?.websocketConnectTimeoutMs, 2345);
		assert.equal(received[2]?.maxTokens, undefined, "the provider retains its model-specific output default");
		assert.ok(received[2]?.signal instanceof AbortSignal);
		assert.notEqual(received[2]?.sessionId, "sess-9", "the one-shot request owns a separate cache identity");
	});

	it("disables reasoning and preserves zero HTTP timeout semantics", async () => {
		const streamSimple: DistillStreamFunction = (model, context, options) => {
			assert.equal(options?.reasoning, undefined);
			assert.equal(options?.timeoutMs, 2147483647);
			return completedDistillStream("SKIP_STASH")(model, context, options);
		};
		const settings = SettingsManager.inMemory({ httpIdleTimeoutMs: 0 });
		const outcome = await startDistillJob(baseOptions(streamSimple, { thinkingLevel: "off", settings })).result;
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.equal(outcome.reason, "skip");
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

	const usage: Usage = {
		input: 1000,
		output: 2000,
		cacheRead: 30000,
		cacheWrite: 4000,
		totalTokens: 37000,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.063, total: 0.123 },
	};
	const expectedUsage = {
		inputTokens: 1000,
		outputTokens: 2000,
		cacheReadTokens: 30000,
		cacheWriteTokens: 4000,
		costUsd: 0.123,
	};

	it("reports final usage on successful, skipped, invalid, and failed writes", async () => {
		for (const reply of [JSON.stringify(VALID_PAYLOAD), "SKIP_STASH", "not json"]) {
			const outcome = await startDistillJob(baseOptions(completedDistillStream(reply, usage))).result;
			assert.deepEqual(outcome.usage, expectedUsage);
		}
		const outcome = await startDistillJob(
			baseOptions(completedDistillStream(JSON.stringify(VALID_PAYLOAD), usage), {
				storeDir: join(dir, "absent", "\0invalid"),
			}),
		).result;
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.match(outcome.message ?? "", /stash write failed/);
		assert.deepEqual(outcome.usage, expectedUsage);
	});

	function failedStream(message: string, reportedUsage = usage): DistillStreamFunction {
		return (model) => {
			const stream = createAssistantMessageEventStream();
			const response = {
				...testAssistantMessage("", model, reportedUsage),
				stopReason: "error" as const,
				errorMessage: message,
			};
			stream.push({ type: "error", reason: "error", error: response });
			stream.end();
			return stream;
		};
	}

	it("retries transient errors with identical input and sums each attempt exactly once", async () => {
		let attempts = 0;
		let first: Parameters<DistillStreamFunction> | undefined;
		const streamSimple: DistillStreamFunction = (...args) => {
			if (first) assert.deepEqual(args, first);
			else first = args;
			attempts++;
			return (
				attempts === 1
					? failedStream("503 service unavailable")
					: completedDistillStream(JSON.stringify(VALID_PAYLOAD), usage)
			)(...args);
		};
		const outcome = await startDistillJob(baseOptions(streamSimple)).result;
		assert.equal(outcome.ok, true);
		assert.equal(attempts, 2);
		assert.deepEqual(outcome.usage, {
			inputTokens: 2000,
			outputTokens: 4000,
			cacheReadTokens: 60000,
			cacheWriteTokens: 8000,
			costUsd: 0.246,
		});
	});

	it("enforces retry exhaustion and does not retry deterministic or overflow errors", async () => {
		for (const [message, expectedCalls] of [
			["503 service unavailable", 4],
			["insufficient_quota", 1],
			["maximum context length exceeded; 503", 1],
		] as const) {
			let attempts = 0;
			const streamSimple: DistillStreamFunction = (...args) => {
				attempts++;
				return failedStream(message)(...args);
			};
			const outcome = await startDistillJob(baseOptions(streamSimple)).result;
			assert.equal(outcome.ok, false);
			if (!outcome.ok) assert.equal(outcome.reason, "failed");
			assert.equal(attempts, expectedCalls);
			assert.equal(outcome.usage?.inputTokens, 1000 * expectedCalls);
		}
	});

	it("honors disabled outer retries", async () => {
		let attempts = 0;
		const streamSimple: DistillStreamFunction = (...args) => {
			attempts++;
			return failedStream("503")(...args);
		};
		await startDistillJob(
			baseOptions(streamSimple, { settings: SettingsManager.inMemory({ retry: { enabled: false } }) }),
		).result;
		assert.equal(attempts, 1);
	});

	it("settles a synchronous stream setup exception without writing", async () => {
		const before = (await listStashes(dir, { limit: 200 })).length;
		const outcome = await startDistillJob(
			baseOptions(() => {
				throw new Error("stream setup failed");
			}),
		).result;
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.equal(outcome.reason, "failed");
			assert.match(outcome.message ?? "", /stream setup failed/);
		}
		assert.equal(outcome.usage, undefined);
		assert.equal((await listStashes(dir, { limit: 200 })).length, before);
	});

	it("rejects incomplete or tool-request output even when its text is valid JSON", async () => {
		const before = (await listStashes(dir, { limit: 200 })).length;
		for (const stopReason of ["length", "toolUse"] as const) {
			const streamSimple: DistillStreamFunction = (model) => {
				const stream = createAssistantMessageEventStream();
				const message = { ...testAssistantMessage(JSON.stringify(VALID_PAYLOAD), model, usage), stopReason };
				stream.push({ type: "done", reason: stopReason, message });
				stream.end();
				return stream;
			};
			const outcome = await startDistillJob(baseOptions(streamSimple)).result;
			assert.equal(outcome.ok, false);
			if (!outcome.ok) assert.equal(outcome.reason, "invalid");
			assert.deepEqual(outcome.usage, expectedUsage);
		}
		assert.equal((await listStashes(dir, { limit: 200 })).length, before);
	});

	it("cancels an active stream, retains its terminal usage, and never writes", async () => {
		let aborts = 0;
		const before = (await listStashes(dir, { limit: 200 })).length;
		const streamSimple: DistillStreamFunction = (model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			const partial = testAssistantMessage("partial", model, usage);
			stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
			options?.signal?.addEventListener(
				"abort",
				() => {
					aborts++;
					stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
					stream.end();
				},
				{ once: true },
			);
			return stream;
		};
		const job = startDistillJob(baseOptions(streamSimple));
		await new Promise((resolve) => setImmediate(resolve));
		job.abort();
		job.abort();
		const outcome = await withWatchdog(job.result);
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.equal(outcome.reason, "aborted");
		assert.equal(aborts, 1);
		assert.deepEqual(outcome.usage, expectedUsage);
		assert.equal((await listStashes(dir, { limit: 200 })).length, before);
	});

	it("cancels during retry backoff without duplicating usage or starting another attempt", async () => {
		let attempts = 0;
		const streamSimple: DistillStreamFunction = (...args) => {
			attempts++;
			return failedStream("503")(...args);
		};
		const settings = SettingsManager.inMemory({ retry: { baseDelayMs: 60000 } });
		const job = startDistillJob(baseOptions(streamSimple, { settings }));
		await new Promise((resolve) => setImmediate(resolve));
		job.abort();
		const outcome = await withWatchdog(job.result);
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.equal(outcome.reason, "aborted");
		assert.equal(attempts, 1);
		assert.deepEqual(outcome.usage, expectedUsage);
	});

	it("times out cooperative work and clears the provider signal", async () => {
		let aborted = false;
		const outcome = await withWatchdog(
			startDistillJob(
				baseOptions(
					controlledDistillStream(() => {
						aborted = true;
					}),
					{ timeoutMs: 20 },
				),
			).result,
		);
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.equal(outcome.reason, "aborted");
			assert.match(outcome.message ?? "", /timed out/);
		}
		assert.equal(aborted, true);
	});

	it("settles a noncooperative stream and discards a late valid result", async () => {
		const stream = createAssistantMessageEventStream();
		const before = (await listStashes(dir, { limit: 200 })).length;
		const outcome = await withWatchdog(startDistillJob(baseOptions(() => stream, { timeoutMs: 20 })).result);
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.equal(outcome.reason, "aborted");
		const message = testAssistantMessage(JSON.stringify(VALID_PAYLOAD));
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal((await listStashes(dir, { limit: 200 })).length, before);
	});

	it("preserves artifact bytes and joins multiple text blocks without adding separators", async () => {
		const streamSimple: DistillStreamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			const message = testAssistantMessage("", model);
			message.content = [
				{ type: "text", text: '{"title":"Byte parity",' },
				{ type: "thinking", thinking: "not output" },
				{ type: "text", text: '"summary":"Saved state.","files":["src/a.ts"]}' },
			];
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		};
		const outcome = await startDistillJob(baseOptions(streamSimple)).result;
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(
			await readFile(outcome.path, "utf8"),
			[
				"---",
				'id: "20270301T080000Z-byte-parity"',
				'title: "Byte parity"',
				'created: "20270301T080000Z"',
				'project: "/workspace"',
				'branch: "main"',
				'sessionId: "sess-9"',
				"tags: []",
				'state: "open"',
				"---",
				"",
				"# Byte parity",
				"",
				"Saved state.",
				"",
				"## Files",
				"",
				"- src/a.ts",
				"",
			].join("\n"),
		);
	});
});

describe("distill model and thinking resolution", () => {
	const parent = testModel({ id: "parent-model", provider: "parent", reasoning: true });
	const override = testModel({ id: "cheap-model", provider: "cheap", reasoning: true });
	const unauthed = testModel({ id: "locked-model", provider: "locked", reasoning: true });
	const noReasoning = testModel({ id: "plain", provider: "plain", reasoning: false });

	function registry(models: Model<Api>[], authed: Set<Model<Api>> = new Set(models)) {
		return {
			find(provider: string, id: string) {
				return models.find((model) => model.provider === provider && model.id === id) ?? null;
			},
			getAvailable() {
				return models;
			},
			hasConfiguredAuth(model: Model<Api>) {
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
