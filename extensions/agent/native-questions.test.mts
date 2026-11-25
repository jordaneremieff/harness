import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { onStoredCommit } from "./commit-observation.ts";
import { nativeContinuityText } from "./continuity-facts.ts";
import { DurableHost } from "./durable-host.ts";
import { runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";
import { fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { acquireHost } from "./host-client.ts";
import { AgentManager } from "./manager.ts";
import { savedTranscript } from "./primary-transcript-fixture.mts";
import { recordReport } from "./durable-controls.ts";
import { retainedReportRequest } from "./delivery-store.ts";
import {
	endQuestionDeliveries,
	nativeQuestionRefusal,
	openNativeQuestions,
	reconcileNativeQuestions,
	releaseNativeQuestion,
	reserveNativeQuestion,
} from "./native-questions.ts";
import {
	DURABLE_TARGET_QUESTION,
	endedQuestionText,
	MAX_OPEN_QUESTIONS,
	noticeText,
	primarySessionEnded,
} from "./peer-questions.ts";

const ROOT = ROOT_CONVERSATION_ID as ConversationId;
const context = BACKGROUND_CONTEXT;

it("keeps a Durable asker's open questions in its storage, closes them only from the asked session, and keeps them after reopen", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "native-questions-"));
	const storageId = randomUUID();
	const options = {
		...hostOptions(join(root, "host.sqlite"), await fixtureRuntime("answer"), fixtureRegistry()),
		storageId,
	};
	let host = await DurableHost.open(options, context);
	t.after(async () => {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	});
	const primary = randomUUID();
	const other = randomUUID();
	const ask = (id: string, peer = primary) =>
		host.harness.commit(
			(tx) => reserveNativeQuestion(tx, ROOT, { id, peer, message: "Are retries idempotent?", at: 1 }),
			context,
		);
	const open = () => host.harness.commit((tx) => openNativeQuestions(tx, ROOT), context);
	const arrive = (requestId: string, sender: string) =>
		host.request(
			"submit",
			{
				sessionId: storageId,
				message: `Report from ${sender}:\nAnswer`,
				requestId,
				inputClass: "report",
				inputSender: sender,
				origin: "model",
			},
			context,
		);

	assert.equal(await ask(`question:${storageId}:1`), "reserved");
	assert.equal(await ask(`question:${storageId}:1`), "open", "a replayed ask reserves nothing new");
	assert.equal(await ask(`question:${storageId}:2`), "reserved");
	assert.equal(await ask(`question:${storageId}:3`), "reserved");

	await arrive(`reply:question:${storageId}:1`, other);
	assert.equal((await open()).length, 3, "a reply from another session closes nothing");
	await arrive(`reply:question:${storageId}:1`, primary);
	await arrive(`notice:question:${storageId}:2`, primary);
	assert.deepEqual(
		(await open()).map((item) => item.id),
		[`question:${storageId}:3`],
	);
	assert.equal(await ask(`question:${storageId}:1`), "closed", "a replayed ask cannot reopen an answered question");
	await host.harness.commit((tx) => releaseNativeQuestion(tx, ROOT, `question:${storageId}:3`), context);
	assert.equal((await open()).length, 0);

	for (let index = 0; index < MAX_OPEN_QUESTIONS; index++) await ask(`question:${storageId}:full-${index}`);
	assert.equal(await ask(`question:${storageId}:one-more`), "full");

	await host.close();
	host = await DurableHost.open(options, context);
	const retained = await open();
	assert.equal(retained.length, MAX_OPEN_QUESTIONS, "open questions survive a reopen");
	assert.deepEqual(retained[0], {
		id: `question:${storageId}:full-0`,
		peer: primary,
		at: 1,
		excerpt: "Are retries idempotent?",
	});
	const note = nativeContinuityText(storageId, 9, [], {
		headId: 9,
		items: [],
		questions: { open: retained.slice(0, 1), ended: [] },
	});
	assert.match(
		note,
		new RegExp(
			`no reply or non-reply notice here: \\n\\{"sessionId":"${primary}","question":"question:${storageId}:full-0"\\}`,
			"u",
		),
	);
	assert.doesNotMatch(
		nativeContinuityText(storageId, 9, [], { headId: 9, items: [], questions: { open: [], ended: [] } }),
		/Questions this session/u,
	);
});

it("delivers a Durable agent's question to an ordinary primary and returns its reply and non-reply notice as reports", {
	timeout: 180000,
}, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const manager = new AgentManager({
		root: f.root,
		agentDir: f.agentDir,
		packageDir: f.metadata.packageDir,
		acquire: async (metadata, options) => {
			const client = await acquireHost(metadata, { ...options, env: f.env("question") });
			trackHost(t, client.pid);
			return client;
		},
	});
	t.after(() => manager.close());
	const primary = randomUUID();
	const controller = new AbortController();
	t.after(() => controller.abort());
	const questions: Array<{ text: string; details: Record<string, unknown> }> = [];
	let delivered: () => void = () => {};
	await manager.registerPrimary(primary, {
		cwd: f.cwd,
		sessionFile: savedTranscript(f.root, primary),
		signal: controller.signal,
		send(text, details) {
			const value = details as Record<string, unknown>;
			if (value.kind === "report" && String(value.requestId).startsWith("question:")) {
				questions.push({ text, details: value });
				delivered();
			}
		},
	});
	const nextQuestion = () =>
		new Promise<void>((resolve) => {
			delivered = resolve;
		});
	const asker = f.metadata.storageId;
	const caller = { id: primary, cwd: f.cwd, name: "Docs" };

	let arrived = nextQuestion();
	const asked = f.marker("question-asked-1");
	await manager.control(
		"submit",
		{ sessionId: asker, message: `QUESTION_TO:${primary}`, requestId: "ask-1", origin: "model" },
		caller,
	);
	await asked;
	await arrived;
	const first = questions[0];
	const id = String(first.details.requestId);
	assert.match(id, new RegExp(`^question:${asker}:`, "u"));
	assert.equal(first.details.senderIdentity, asker);
	assert.match(
		String(first.details.message),
		new RegExp(
			`^Are retries idempotent\\?\\n\\nReply expected\\. Session ${asker} asked this question \\(${id}\\)`,
			"u",
		),
	);
	const receipt = JSON.parse(readFileSync(join(f.testDir, "question-returns.jsonl"), "utf8").trim()) as {
		content: Array<{ text: string }>;
	};
	assert.match(receipt.content[0].text, /agent_work continue with that request and an empty results list/u);

	const replied = f.marker("question-reply");
	await manager.control(
		"submit",
		{ sessionId: asker, message: "Yes, they reuse the key.", inReplyTo: id, origin: "model" },
		caller,
	);
	await replied;

	arrived = nextQuestion();
	const askedAgain = f.marker("question-asked-2");
	await manager.control(
		"submit",
		{ sessionId: asker, message: `QUESTION_TO:${primary}`, requestId: "ask-2", origin: "model" },
		caller,
	);
	await askedAgain;
	await arrived;
	const second = String(questions[1].details.requestId);
	assert.notEqual(second, id);
	const noticed = f.marker("question-notice");
	await manager.control(
		"report",
		{
			sessionId: asker,
			requestId: `notice:${second}`,
			message: noticeText({ id: second, peer: asker, at: 0, excerpt: "Are retries idempotent?" }, primary, "Docs"),
			questionNotice: second,
			origin: "model",
		},
		caller,
	);
	await noticed;
	const arrivals = readFileSync(join(f.testDir, "question-arrivals.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { arrival: string; text: string });
	assert.deepEqual(
		arrivals.map((item) => item.arrival),
		["question-reply", "question-notice"],
	);
	assert.match(
		arrivals[0].text,
		new RegExp(
			`Reply from session ${primary} \\("Docs"\\) to the question you asked \\(${id}\\):\\n\\nYes, they reuse the key\\.`,
			"u",
		),
	);

	await assert.rejects(
		manager.control("submit", { sessionId: asker, message: "Ready?", expectReply: true, origin: "model" }, caller),
		{ message: DURABLE_TARGET_QUESTION },
	);

	// A question to a primary whose session then ends closes when the agent asks its next question.
	const leaving = randomUUID();
	const leavingController = new AbortController();
	let leavingDelivered: () => void = () => {};
	const leavingArrived = new Promise<void>((resolve) => {
		leavingDelivered = resolve;
	});
	await manager.registerPrimary(leaving, {
		cwd: f.cwd,
		sessionFile: savedTranscript(f.root, leaving),
		signal: leavingController.signal,
		send(_text, details) {
			if ((details as { kind?: unknown }).kind === "report") leavingDelivered();
		},
	});
	const askedLeaving = f.marker("question-asked-3");
	await manager.control(
		"submit",
		{ sessionId: asker, message: `QUESTION_TO:${leaving}`, requestId: "ask-3", origin: "model" },
		caller,
	);
	await askedLeaving;
	await leavingArrived;
	leavingController.abort();
	await manager.closePrimary(leaving, leavingController.signal);
	assert.equal(primarySessionEnded(f.root, leaving), true);
	const askedAfter = f.marker("question-asked-4");
	await manager.control(
		"submit",
		{ sessionId: asker, message: `QUESTION_TO:${primary}`, requestId: "ask-4", origin: "model" },
		caller,
	);
	await askedAfter;
	const returns = readFileSync(join(f.testDir, "question-returns.jsonl"), "utf8").trim().split("\n");
	const last = JSON.parse(returns.at(-1) ?? "{}") as { content: Array<{ text: string }> };
	const ended = last.content.map((part) => part.text).filter((text) => text.includes("closed unanswered"));
	assert.equal(ended.length, 1, JSON.stringify(last.content));
	assert.match(ended[0], new RegExp(`to session ${leaving} closed unanswered: that session has ended`, "u"));
	const statusRead = f.marker("question-status");
	await manager.control(
		"submit",
		{ sessionId: asker, message: `STATUS_OF:${asker}`, requestId: "status-1", origin: "model" },
		caller,
	);
	await statusRead;
	const status = JSON.parse(readFileSync(join(f.testDir, "question-status.json"), "utf8")) as {
		content: Array<{ text: string }>;
	};
	const selected = JSON.parse(status.content[0].text) as {
		conversation: { questions?: Array<{ question: string; sessionId: string }> };
	};
	assert.deepEqual(
		selected.conversation.questions?.map((item) => item.sessionId),
		[primary],
		"the ended question closed; the live recipient's question stays open in the agent's own status",
	);
});

it("closes a Durable asker's questions to ended primaries as unanswered, once each, with one read per session", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "native-questions-ended-"));
	const storageId = randomUUID();
	mkdirSync(join(root, "durable"));
	const options = {
		...hostOptions(join(root, "durable", "host.sqlite"), await fixtureRuntime("answer"), fixtureRegistry()),
		storageId,
	};
	const host = await DurableHost.open(options, context);
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	const controller = new AbortController();
	t.after(async () => {
		controller.abort();
		await manager.close();
		await host.close();
		rmSync(root, { recursive: true, force: true });
	});
	const live = randomUUID();
	const ended = randomUUID();
	await manager.registerPrimary(live, { cwd: root, signal: controller.signal, send() {} });
	for (const [id, peer] of [
		[`question:${storageId}:live`, live],
		[`question:${storageId}:ended-1`, ended],
		[`question:${storageId}:ended-2`, ended],
	] as const)
		await host.harness.commit((tx) => reserveNativeQuestion(tx, ROOT, { id, peer, message: "Ready?", at: 5 }), context);
	const reads: string[] = [];
	const check = (peer: string) => {
		reads.push(peer);
		return primarySessionEnded(root, peer);
	};
	const result = await host.harness.commit((tx) => reconcileNativeQuestions(tx, ROOT, check), context);
	assert.deepEqual(
		result.ended.map((item) => item.id),
		[`question:${storageId}:ended-1`, `question:${storageId}:ended-2`],
	);
	assert.deepEqual(
		result.open.map((item) => item.id),
		[`question:${storageId}:live`],
	);
	assert.deepEqual(reads, [live, ended], "one endpoint read per distinct asked session");
	assert.match(
		endedQuestionText(result.ended),
		new RegExp(
			`^Question question:${storageId}:ended-1 to session ${ended} closed unanswered: that session has ended`,
			"u",
		),
	);
	const again = await host.harness.commit((tx) => reconcileNativeQuestions(tx, ROOT, check), context);
	assert.deepEqual(again.ended, [], "a closed question is reported once");
	reads.length = 0;
	await host.harness.commit((tx) => releaseNativeQuestion(tx, ROOT, `question:${storageId}:live`), context);
	await host.harness.commit((tx) => reconcileNativeQuestions(tx, ROOT, check), context);
	assert.deepEqual(reads, [], "no endpoint read without open questions");
});

it("refuses a Durable question with fields that do not apply to an immediate question", () => {
	assert.equal(nativeQuestionRefusal({}), undefined);
	assert.equal(nativeQuestionRefusal({ mode: "steer" }), undefined);
	for (const field of [
		{ mode: "report" },
		{ deliverAt: "2026-12-01T00:00:00Z" },
		{ replyTo: "other" },
		{ passive: true },
		{ checkInMinutes: 0 },
	])
		assert.match(
			nativeQuestionRefusal(field) ?? "",
			/omit mode report, deliverAt, replyTo, passive and checkInMinutes/u,
		);
});

it("ends the parked report row of a question whose asked session ended, and leaves a delivered one", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "native-questions-rows-"));
	const storageId = randomUUID();
	const host = await DurableHost.open(
		{ ...hostOptions(join(root, "host.sqlite"), await fixtureRuntime("answer"), fixtureRegistry()), storageId },
		context,
	);
	t.after(async () => {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	});
	const gone = randomUUID();
	const question = { id: `question:${storageId}:1`, peer: gone, at: 1, excerpt: "Still there?" };
	await recordReport(
		host.harness,
		{ ownerId: gone, senderIdentity: storageId, message: "Still there?", requestId: question.id, direct: true },
		context,
	);
	await host.harness.commit((tx) => endQuestionDeliveries(tx, [question]), context);
	const row = await host.harness.commit((tx) => retainedReportRequest(tx, gone, question.id), context);
	assert.equal(row?.delivery?.state, "terminal");
	assert.equal(row?.acknowledged, false);
	await host.harness.commit(
		(tx) => endQuestionDeliveries(tx, [{ ...question, id: `question:${storageId}:2` }]),
		context,
	);
});

it("closes a question in the commit that admits its reply, so no crash leaves an answered question open", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "native-questions-atomic-"));
	const storageId = randomUUID();
	const host = await DurableHost.open(
		{ ...hostOptions(join(root, "host.sqlite"), await fixtureRuntime("answer"), fixtureRegistry()), storageId },
		context,
	);
	t.after(async () => {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	});
	const primary = randomUUID();
	const id = `question:${storageId}:1`;
	await host.harness.commit(
		(tx) => reserveNativeQuestion(tx, ROOT, { id, peer: primary, message: "Ready?", at: 1 }),
		context,
	);
	const commits: Array<{ admits: boolean; closes: boolean }> = [];
	const stop = onStoredCommit(host.harness, (publication) => {
		commits.push({
			admits: publication.changes.some(
				(change) =>
					change.type === "submission" &&
					(change as { value?: { requestId?: string } }).value?.requestId === `reply:${id}`,
			),
			closes: publication.changes.some(
				(change) => change.type === "document" && change.record.kind === "agent.peer-questions",
			),
		});
	});
	t.after(stop);
	await host.request(
		"submit",
		{
			sessionId: storageId,
			message: `Report from ${primary}:\nYes.`,
			requestId: `reply:${id}`,
			inputClass: "report",
			inputSender: primary,
			origin: "model",
		},
		context,
	);
	const admission = commits.find((commit) => commit.admits);
	assert.ok(admission, "the reply was admitted");
	assert.equal(admission.closes, true, "the admitting commit closes the question");
	assert.deepEqual(await host.harness.commit((tx) => openNativeQuestions(tx, ROOT), context), []);
});

it("keeps a question whose report row was retained when a replayed ask fails, and returns its first receipt", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "native-questions-replay-"));
	const storageId = randomUUID();
	const host = await DurableHost.open(
		{ ...hostOptions(join(root, "host.sqlite"), await fixtureRuntime("answer"), fixtureRegistry()), storageId },
		context,
	);
	t.after(async () => {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	});
	const primary = randomUUID();
	const id = `question:${storageId}:7`;
	const question = { id, peer: primary, message: "Which region?", at: 1 };
	const reserve = () => host.harness.commit((tx) => reserveNativeQuestion(tx, ROOT, question), context);
	assert.equal(await reserve(), "reserved");
	// The first attempt retained the direct report row; the host stopped before the tool result.
	await recordReport(
		host.harness,
		{ ownerId: primary, senderIdentity: storageId, message: "Which region?", requestId: id, direct: true },
		context,
	);
	assert.equal(await reserve(), "admitted", "the replay finds the admitted question and delivers nothing again");
	// A replay that dispatched again and failed, as when the asked session is unreachable, releases nothing.
	await host.harness.commit((tx) => releaseNativeQuestion(tx, ROOT, id), context);
	assert.deepEqual(
		(await host.harness.commit((tx) => openNativeQuestions(tx, ROOT), context)).map((item) => item.id),
		[id],
		"the record stays, so the reply closes it or an end of the session closes it and its row",
	);
	// A reservation without a retained row is still released on a failed delivery.
	const other = { ...question, id: `question:${storageId}:8` };
	await host.harness.commit((tx) => reserveNativeQuestion(tx, ROOT, other), context);
	await host.harness.commit((tx) => releaseNativeQuestion(tx, ROOT, other.id), context);
	assert.equal((await host.harness.commit((tx) => openNativeQuestions(tx, ROOT), context)).length, 1);
});
