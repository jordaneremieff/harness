import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	boundTranscript,
	buildDistillPrompt,
	DISTILL_SYSTEM_PROMPT,
	type DistillPayload,
	escapeRawControlChars,
	extractArtifacts,
	isHintedDistill,
	parseDistillPayload,
	prepareDistillSource,
	projectionToTranscript,
	validatePayload,
} from "./distill.ts";
import { testAssistantMessage, transcriptProjection } from "./test-fixtures.mts";

it("retains input redaction reports without double-counting extracted references", () => {
	const token = "sk-abcdefgh" + "ijklmnop1234";
	const source = prepareDistillSource({
		entries: [
			{
				messages: [
					{
						role: "toolResult",
						toolCallId: "call",
						toolName: "read",
						content: [{ type: "text", text: `Saved /workspace/${token}.md` }],
						isError: false,
						timestamp: 0,
					},
				],
			},
		],
	});
	assert.equal(source.redactions.count, 1);
	assert.deepEqual(source.redactions.classes, { "provider token": 1 });
	assert.ok(!JSON.stringify(source).includes(token));
	assert.ok(source.redactions.contexts[0].includes("Saved /workspace/[REDACTED].md"));
});

function sessionProjection() {
	return transcriptProjection([
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

const VALID_PAYLOAD: DistillPayload = {
	title: "Tool migration",
	summary: "The first tool ports cleanly; the wrapper template extracts itself.",
	decisions: ["Port one tool end-to-end before planning the rest"],
	nextActions: ["Port cognition-recall next"],
	files: ["src/tools.ts"],
	tags: ["migration"],
};

describe("transcript serialization", () => {
	it("renders roles, tool calls, tool results, and compaction notes", () => {
		const text = projectionToTranscript(sessionProjection());
		assert.match(text, /\[USER\]\nStart the migration work/);
		assert.match(text, /\[ASSISTANT\]\nI will port the first tool/);
		assert.match(text, /\[tool call: bash\]/);
		assert.match(text, /\[tool result: bash \(ok\)\]\nsrc\//);
		assert.match(text, /\[compaction summary: Early exploration compacted away\.\]/);
		assert.match(text, /\[custom message\]\nRemember the token budget/);
	});

	it("marks failed tool results and omits thinking content", () => {
		const text = projectionToTranscript(
			transcriptProjection([
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

describe("snapshot preparation", () => {
	it("redacts credential-shaped transcript content before the distiller", () => {
		const secret = "sk-ant-oa" + "t01-abcdefghijklmnopqrstuvwxyz123456";
		const projection = transcriptProjection([
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
		const source = prepareDistillSource(projection);
		const prompt = buildDistillPrompt("capture fixture", source.transcript, source.artifacts);
		assert.ok(!prompt.includes(secret), "the secret must not reach the distiller");
		assert.match(prompt, /\[REDACTED\]/);
	});

	it("redacts userinfo credentials from the observed references", () => {
		const projection = transcriptProjection([
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
		const source = prepareDistillSource(projection);
		const prompt = buildDistillPrompt("capture fixture", source.transcript, source.artifacts);
		assert.ok(!prompt.includes("p4ssw0rd123"), "the userinfo password must not reach the distiller");
		assert.match(prompt, /https:\/\/deployer:\[REDACTED\]@example\.com/);
	});

	it("redacts userinfo passwords that lossy reference extraction would truncate", () => {
		// Parentheses are valid in userinfo per RFC 3986 and terminate the
		// reference regex; the pre-extraction redaction must remove the password
		// before the reference is cut.
		const projection = transcriptProjection([
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
		const source = prepareDistillSource(projection);
		const prompt = buildDistillPrompt("capture fixture", source.transcript, source.artifacts);
		assert.ok(!prompt.includes("longpassword"), "the password must be gone before extraction truncates the URL");
	});

	it("keeps the operator hint verbatim while redacting the transcript", () => {
		const hint = "capture the auth setup for sk-ant-oa" + "t01-abcdefghijklmnopqrstuvwxyz123456";
		const source = prepareDistillSource(sessionProjection());
		const prompt = buildDistillPrompt(hint, source.transcript, source.artifacts);
		assert.ok(prompt.includes(hint), "the operator hint is trusted input and must stay verbatim");
	});

	it("preserves native summaries and text without checkpoints, state, signatures, or excluded shell output", () => {
		const manager = SessionManager.inMemory("/workspace");
		manager.appendMessage({ role: "system", content: "SYSTEM_CHECKPOINT", toolsAdded: [], timestamp: 0 });
		const kept = manager.appendMessage({ role: "user", content: "RETAINED_USER", timestamp: 0 });
		manager.appendMessage({ role: "user", content: "ABANDONED_BRANCH", timestamp: 0 });
		manager.branchWithSummary(kept, "BRANCH_SUMMARY");
		manager.appendCustomMessageEntry("note", "CUSTOM_CONTEXT", false, { hidden: "CUSTOM_DETAILS" });
		manager.appendCustomEntry("state", { hidden: "STATE_ONLY" });
		manager.appendCompaction("OLD_COMPACTION", kept, 0);
		const assistant = testAssistantMessage("VISIBLE_ASSISTANT");
		assistant.content = [
			{ type: "thinking", thinking: "HIDDEN_THINKING", thinkingSignature: "HIDDEN_THINKING_SIGNATURE" },
			{ type: "text", text: "VISIBLE_ASSISTANT", textSignature: "HIDDEN_TEXT_SIGNATURE" },
			{ type: "toolCall", name: "read", id: "call", arguments: {}, thoughtSignature: "HIDDEN_CALL_SIGNATURE" },
		];
		manager.appendMessage(assistant);
		manager.appendMessage({
			role: "bashExecution",
			command: "printf visible",
			output: "SHELL_OUTPUT",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			timestamp: 0,
		});
		manager.appendMessage({
			role: "bashExecution",
			command: "printf hidden",
			output: "EXCLUDED_SHELL",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 0,
		});
		manager.appendCompaction("CURRENT_COMPACTION", kept, 0);
		const rawBefore = JSON.stringify(manager.getEntries());
		const prompt = prepareDistillSource(manager.buildSessionProjection()).transcript;
		assert.match(prompt, /\[compaction summary: CURRENT_COMPACTION\]/);
		assert.match(prompt, /\[branch summary: BRANCH_SUMMARY\]/);
		assert.match(prompt, /\[custom message\]\nCUSTOM_CONTEXT/);
		assert.match(prompt, /RETAINED_USER/);
		assert.match(prompt, /VISIBLE_ASSISTANT/);
		assert.match(prompt, /\[tool call: read\]/);
		assert.match(prompt, /\[bash execution\]\nRan `printf visible`/);
		assert.match(prompt, /SHELL_OUTPUT/);
		assert.match(prompt, /command cancelled/);
		assert.doesNotMatch(
			prompt,
			/SYSTEM_CHECKPOINT|OLD_COMPACTION|ABANDONED_BRANCH|CUSTOM_DETAILS|STATE_ONLY|HIDDEN_|EXCLUDED_SHELL|printf hidden/,
		);
		assert.equal(JSON.stringify(manager.getEntries()), rawBefore);
		assert.equal(manager.buildSessionProjection().messages.filter((message) => message.role === "system").length, 1);
	});

	it("extracts only projected tool references even outside the retained transcript window", () => {
		const manager = SessionManager.inMemory("/workspace");
		manager.appendMessage({ role: "user", content: "a".repeat(80_000), timestamp: 0 });
		const target = manager.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "/workspace/stale-middle.md" }],
			isError: false,
			timestamp: 0,
		});
		manager.appendContextEdit(target, { content: "/workspace/retained-reference.md" });
		manager.appendMessage({ role: "user", content: "z".repeat(160_000), timestamp: 0 });
		const source = prepareDistillSource(manager.buildSessionProjection());
		const transcript = source.transcript;
		const references = source.artifacts.join("\n");
		assert.match(transcript, /characters omitted/);
		assert.doesNotMatch(transcript, /retained-reference.md|stale-middle.md/);
		assert.match(references, /\/workspace\/retained-reference.md/);
		assert.doesNotMatch(references, /stale-middle.md/);
	});
});
