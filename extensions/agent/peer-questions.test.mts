import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	askedText,
	closingQuestion,
	DURABLE_TARGET_QUESTION,
	durableTargetInput,
	foldPeerQuestions,
	MAX_OPEN_QUESTIONS,
	noticeText,
	PEER_QUESTION_ENDED,
	PEER_QUESTION_ENTRY,
	PeerQuestions,
	peerQuestionDetail,
	peerQuestionFields,
	questionText,
	type PeerQuestionFact,
} from "./peer-questions.ts";
import type { AgentManager } from "./manager.ts";
import { machineConfig } from "./settings-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const ASKER = "01a20c9b-ab38-75a2-9fc7-0aae388b2c84";
const OTHER = "01a20c9b-ab54-75a2-9fc7-0ab035fbede0";

function recorder() {
	const facts: PeerQuestionFact[] = [];
	let now = 0;
	const questions = new PeerQuestions(
		(fact) => facts.push(fact),
		() => ++now,
	);
	return { facts, questions };
}

it("opens a question when asked or received and closes it once by its reply, notice or own reply", () => {
	const { facts, questions } = recorder();
	questions.asked("question:a:1", OTHER, "First?");
	questions.asked("question:a:2", OTHER, "Second?");
	assert.equal(questions.closed("question:a:1", "answered"), true);
	assert.equal(questions.closed("question:a:1", "answered"), false, "a repeated reply changes nothing");
	assert.equal(questions.closed("question:unknown:1", "unanswered"), false);
	questions.received("question:b:1", ASKER, questionText("Is it safe?", "question:b:1", ASKER));
	questions.received("question:b:1", ASKER, "Is it safe?");
	assert.deepEqual(
		questions.open().asked.map((item) => item.id),
		["question:a:2"],
	);
	assert.deepEqual(questions.open().received, [{ id: "question:b:1", peer: ASKER, at: 4, excerpt: "Is it safe?" }]);
	questions.replied("question:b:1", ASKER);
	assert.deepEqual(questions.open().received, []);
	questions.received("question:b:1", ASKER, "Is it safe?");
	assert.deepEqual(questions.open().received, [], "a repeated delivery of an answered question opens nothing");
	questions.noticed("question:b:1", ASKER);
	assert.deepEqual(
		facts.map((fact) => fact.event),
		["asked", "asked", "answered", "received", "replied"],
	);
	const restored = new PeerQuestions(() => {});
	restored.restore(
		facts.map(
			(data, index) =>
				({ type: "custom", customType: PEER_QUESTION_ENTRY, data, id: String(index) }) as unknown as SessionEntry,
		),
	);
	assert.deepEqual(restored.open(), questions.open(), "session entries rebuild the same open questions");
});

it("checks a reply against the received question and its asker", () => {
	const { questions } = recorder();
	questions.received("question:b:1", ASKER, "Is it safe?");
	assert.throws(() => questions.replyTarget("other", ASKER), {
		message: "inReplyTo requires the question ID that the question message names",
	});
	assert.throws(() => questions.replyTarget("question:b:2", ASKER), {
		message:
			"inReplyTo question:b:2 names no open question that another session asked here; omit inReplyTo to send an ordinary message",
	});
	assert.throws(() => questions.replyTarget("question:b:1", OTHER), {
		message: `Question question:b:1 came from ${ASKER}; send the reply with sessionId: ${ASKER}`,
	});
	assert.equal(questions.replyTarget("question:b:1", ASKER).peer, ASKER);
});

it("bounds open questions and keeps the asker's words in the excerpt", () => {
	const { questions } = recorder();
	for (let index = 0; index < MAX_OPEN_QUESTIONS; index++) questions.asked(`question:a:${index}`, OTHER, "Why?");
	assert.throws(
		() => questions.assertCanAsk(),
		/open questions; each closes when its reply or non-reply notice arrives/u,
	);
	const delivered = questionText("Line one\n\nline two", "question:a:1", ASKER, "Docs");
	assert.equal(askedText(delivered), "Line one\n\nline two");
	assert.match(delivered, /Answer it with agent_send to sessionId .* with inReplyTo "question:a:1"/u);
	assert.equal(foldPeerQuestions([]).asked.length, 0);
	assert.match(
		noticeText({ id: "question:a:1", peer: ASKER, at: 1, excerpt: "Why?" }, OTHER, "Review"),
		/ended its run without replying to the question you asked \(question:a:1\): "Why\?"/u,
	);
});

it("reads a Durable agent's question from its report delivery and turns a reply to it into a closing report", () => {
	assert.deepEqual(peerQuestionDetail({ kind: "report", requestId: "question:agent:7" }), {
		question: "question:agent:7",
	});
	assert.deepEqual(peerQuestionDetail({ kind: "report", requestId: "report:agent:7" }), {});
	assert.deepEqual(peerQuestionDetail({ kind: "message", requestId: "question:agent:7" }), {});
	assert.deepEqual(closingQuestion("reply:question:agent:7"), { id: "question:agent:7", event: "answered" });
	assert.deepEqual(closingQuestion("notice:question:agent:7"), { id: "question:agent:7", event: "unanswered" });
	assert.equal(closingQuestion("report:question:agent:7"), undefined);
	const reply = durableTargetInput(
		"submit",
		{ sessionId: "agent", message: "Yes.", inReplyTo: "question:agent:7" },
		ASKER,
		"Docs",
	);
	assert.deepEqual(reply, {
		method: "report",
		input: {
			sessionId: "agent",
			message: `Reply from session ${ASKER} ("Docs") to the question you asked (question:agent:7):\n\nYes.`,
			requestId: "reply:question:agent:7",
			origin: "model",
		},
	});
	assert.throws(
		() => durableTargetInput("submit", { sessionId: "agent", message: "Ready?", expectReply: true }, ASKER),
		{
			message: DURABLE_TARGET_QUESTION,
		},
	);
	assert.deepEqual(durableTargetInput("submit", { sessionId: "agent", message: "Hi" }, ASKER).method, "submit");
});

it("derives question, reply and notice fields for one primary message", () => {
	assert.deepEqual(peerQuestionFields({ expectReply: true }, "submit", "question:a:1"), { question: "question:a:1" });
	assert.deepEqual(peerQuestionFields({ inReplyTo: "question:a:1" }, "submit", "x"), { inReplyTo: "question:a:1" });
	assert.deepEqual(peerQuestionFields({ questionNotice: "question:a:1" }, "report", "x"), {
		questionNotice: "question:a:1",
	});
	assert.deepEqual(peerQuestionFields({ questionNotice: "question:a:1" }, "submit", "x"), {});
	assert.throws(() => peerQuestionFields({ expectReply: true }, "report", "question:a:1"), /immediate message/u);
	assert.throws(
		() => peerQuestionFields({ expectReply: true, inReplyTo: "question:a:1" }, "submit", "question:a:2"),
		/A reply cannot also expect a reply/u,
	);
});

type Step = { tool: string; args: Record<string, unknown> } | { text: string } | { replyTo: string; message: string };
interface Scripted {
	session: AgentSession;
	manager: SessionManager;
	steps: Step[];
}

function assistant(step: Exclude<Step, { replyTo: string }>): AssistantMessage {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const base = {
		role: "assistant" as const,
		api: testModel.api,
		provider: testModel.provider,
		model: testModel.id,
		usage,
		timestamp: Date.now(),
	};
	return "tool" in step
		? {
				...base,
				content: [
					{
						type: "toolCall",
						id: `call-${Math.random().toString(16).slice(2)}`,
						name: step.tool,
						arguments: step.args as never,
					},
				],
				stopReason: "toolUse",
			}
		: { ...base, content: [{ type: "text", text: step.text }], stopReason: "stop" };
}

it("delivers a question, its reply as an event, and one notice when the recipient's run ends without a reply", {
	timeout: 60000,
}, async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "peer-questions-")));
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	for (const dir of [agentDir, sessionsRoot]) mkdirSync(dir);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }),
	);
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify(machineConfig({ presets: {} })));
	const keys = ["PI_OFFLINE", "PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_SESSIONS_DIR", "PI_HARNESS_FILE"];
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, {
		PI_OFFLINE: "1",
		PI_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_AGENT_SESSIONS_DIR: sessionsRoot,
		PI_HARNESS_FILE: join(agentDir, "harness.json"),
	});
	const sessions: AgentSession[] = [];
	t.after(async () => {
		for (const session of sessions) await session.abort();
		const owners = (
			globalThis as unknown as Record<symbol, { managers: Map<string, { close(): void | Promise<void> }> }>
		)[Symbol.for("pi.extension.agent.owners")];
		await owners.managers.get(sessionsRoot)?.close();
		owners.managers.delete(sessionsRoot);
		for (const session of sessions) session.dispose();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const { default: agent } = await import("./index.ts");
	const open = async (name: string, file?: string): Promise<Scripted> => {
		const cwd = join(root, name);
		if (file === undefined) {
			mkdirSync(cwd);
			execFileSync("git", ["init", "--quiet", cwd]);
		}
		const scripted = { steps: [] as Step[] } as Scripted;
		const runtime = await createTestRuntime();
		const stream = (_model: unknown, context: { messages: Message[] }) => {
			let step = scripted.steps.shift() ?? { text: "done" };
			if ("replyTo" in step) {
				const ids = [...JSON.stringify(context.messages).matchAll(/inReplyTo \\"(question:[^\\"]+)\\"/gu)];
				step = {
					tool: "agent_send",
					args: { sessionId: step.replyTo, message: step.message, inReplyTo: ids.at(-1)?.[1] },
				};
			}
			const reply = assistant(step);
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial: reply });
			events.push({ type: "done", reason: reply.stopReason === "toolUse" ? "toolUse" : "stop", message: reply });
			events.end(reply);
			return events;
		};
		runtime.registerNativeProvider({
			id: testModel.provider,
			name,
			getModels: () => [testModel],
			auth: {
				apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) },
			},
			stream,
			streamSimple: stream,
		});
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [async (pi) => agent(pi)],
		});
		await loader.reload();
		const manager =
			file === undefined ? SessionManager.create(cwd, sessionsRoot) : SessionManager.open(file, sessionsRoot);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			settingsManager,
			sessionManager: manager,
			model: testModel,
			resourceLoader: loader,
		});
		// A session with an operator view: agent_yield ends the turn with its card.
		await session.bindExtensions({ mode: "rpc" });
		sessions.push(session);
		return Object.assign(scripted, { session, manager });
	};
	const run = async (s: Scripted, text: string, steps: Step[]) => {
		s.steps.push(...steps);
		await s.session.prompt(text);
		await s.session.waitForIdle();
	};
	const facts = (s: Scripted) =>
		s.manager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === PEER_QUESTION_ENTRY
					? [(entry.data as PeerQuestionFact).event]
					: [],
			);
	const peerTexts = (s: Scripted) =>
		s.manager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === "agent.peer" ? [String(entry.content)] : [],
			);
	const until = async (label: string, check: () => boolean) => {
		for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((done) => setTimeout(done, 50));
		assert.ok(check(), label);
	};

	const a = await open("a");
	const b = await open("b");
	await run(b, "Review payment retries", [{ text: "Reviewing." }]);
	const aId = a.manager.getSessionId();
	const bId = b.manager.getSessionId();
	b.steps.push({ replyTo: aId, message: "Yes, retries reuse the idempotency key." }, { text: "Answered." });
	await run(a, "Ask B about retries", [
		{ tool: "agent_send", args: { sessionId: bId, message: "Are retries idempotent?", expectReply: true } },
		{ text: "Asked." },
	]);
	await until("B replies", () => facts(b).includes("replied"));
	assert.match(peerTexts(b).at(-1) ?? "", /^Are retries idempotent\?\n\nReply expected\. Session /u);
	await until("A receives the reply", () => facts(a).includes("answered"));
	await a.session.waitForIdle();
	assert.ok(
		peerTexts(a).some((text) => text.startsWith(`Reply from session ${bId}`) && text.endsWith("idempotency key.")),
	);

	b.steps.push({ text: "Not now." });
	await run(a, "Ask B again", [
		{ tool: "agent_send", args: { sessionId: bId, message: "Which backoff?", expectReply: true } },
		{ text: "Asked." },
	]);
	await until("A receives the non-reply notice", () => facts(a).includes("unanswered"));
	await a.session.waitForIdle();
	assert.equal(peerTexts(a).filter((text) => text.includes("without replying")).length, 1);
	assert.match(
		peerTexts(a).find((text) => text.includes("without replying")) ?? "",
		/the question you asked \(question:[^)]+\): "Which backoff\?"/u,
	);
	assert.deepEqual(facts(a), ["asked", "answered", "asked", "unanswered"]);
	assert.deepEqual(facts(b), ["received", "replied", "received", "noticed"]);

	// Questions to sessions that end close as unanswered at the next reconciliation point, once each.
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[
		Symbol.for("pi.extension.agent.owners")
	];
	const manager = owners.managers.get(sessionsRoot);
	assert.ok(manager);
	const primary = async () => {
		const id = randomUUID();
		const controller = new AbortController();
		await manager.registerPrimary(id, { cwd: root, signal: controller.signal, send() {} });
		return {
			id,
			end: async () => {
				controller.abort();
				await manager.closePrimary(id, controller.signal);
			},
		};
	};
	const ask = (id: string, message: string) => ({
		tool: "agent_send",
		args: { sessionId: id, message, expectReply: true },
	});
	const lastResult = (s: Scripted, tool: string) => {
		const entry = [...s.manager.getEntries()]
			.reverse()
			.find((item) => item.type === "message" && item.message.role === "toolResult" && item.message.toolName === tool);
		assert.ok(entry?.type === "message" && entry.message.role === "toolResult");
		return entry.message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	};
	const live = await primary();
	const leaving = await primary();
	await run(a, "Ask the live and the leaving session", [
		ask(live.id, "Live?"),
		ask(leaving.id, "Leaving?"),
		{ text: "Asked." },
	]);
	await leaving.end();
	await run(a, "Wait for answers", [{ tool: "agent_yield", args: { note: "Two questions are open." } }]);
	const yielded = lastResult(a, "agent_yield");
	assert.equal(yielded.split("closed unanswered").length - 1, 1, yielded);
	assert.match(yielded, new RegExp(`to session ${leaving.id} closed unanswered: that session has ended`, "u"));

	const second = await primary();
	await run(a, "Ask the second session", [ask(second.id, "Second?"), { text: "Asked." }]);
	await second.end();
	await run(a, "Ask the live session again", [ask(live.id, "Still live?"), { text: "Asked." }]);
	const asked = lastResult(a, "agent_send");
	assert.match(asked, new RegExp(`to session ${second.id} closed unanswered`, "u"));
	assert.doesNotMatch(asked, new RegExp(leaving.id, "u"), "a closed question is reported once");

	const fourth = await primary();
	await run(a, "Ask the fourth session", [ask(fourth.id, "Fourth?"), { text: "Asked." }]);
	await fourth.end();
	const file = a.manager.getSessionFile();
	assert.ok(file);
	await a.session.abort();
	a.session.dispose();
	const reopened = await open("a", file);
	const notices = reopened.manager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === PEER_QUESTION_ENDED ? [String(entry.content)] : [],
		);
	assert.equal(notices.length, 1, JSON.stringify(notices));
	assert.match(notices[0], new RegExp(`to session ${fourth.id} closed unanswered`, "u"));
	const stillOpen = foldPeerQuestions(
		reopened.manager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === PEER_QUESTION_ENTRY ? [entry.data as PeerQuestionFact] : [],
			),
	).asked;
	assert.deepEqual(
		stillOpen.map((item) => item.peer),
		[live.id, live.id],
		"only the live recipient's questions stay open",
	);
});
