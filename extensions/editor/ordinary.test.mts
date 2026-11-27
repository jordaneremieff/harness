import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { addEditorApplicationContext, editorApplicationMessage } from "./ordinary-invitations.ts";
import { startPaneService } from "./pane-service.ts";
import { invite, members } from "./participants.ts";
import { answerText } from "./request-answer.ts";
import { Workspace } from "./store.ts";

function call(input: Parameters<typeof fauxToolCall>[1]) {
	return fauxAssistantMessage(fauxToolCall("editor", input), { stopReason: "toolUse" });
}

function latch() {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

function content(message: Parameters<typeof addEditorApplicationContext>[0][number]): string {
	return "content" in message ? String(message.content) : "";
}

const fixture = {
	id: "89ABCDEF-a001-4000-9000-000000000000",
	root: "/project with space",
	thread: "selected-thread",
	doc: "",
	target: { kind: "folder", key: "" },
	quote: "",
	message: "First\tline\r\nSecond line with a joiner: a\u200db",
};

test("ordinary invitation enriches the request context without modifying stored bytes", () => {
	const { type: _type, ...draft } = editorApplicationMessage(fixture);
	assert.deepEqual(draft.details, {
		version: 1,
		source: "editor",
		application: "Editor",
		id: fixture.id,
		subject: "Shared editor thread",
		place: fixture.root,
		reply: "final",
	});
	assert.equal(
		draft.content.split("\n\n", 1)[0],
		"[Editor] #89abcdef · Shared editor thread · /project with space · reply in your final message",
	);
	assert.ok(draft.content.endsWith(fixture.message));
	assert.match(draft.content, /Target: {"kind":"folder","key":""}/);
	const editorMessage = { ...draft, role: "custom", timestamp: 0 } as const;
	const earlier = { ...editorMessage, details: { ...editorMessage.details, source: "another-app" } };
	const enriched = addEditorApplicationContext([earlier, editorMessage, editorMessage]);
	assert.ok(enriched);
	assert.equal(addEditorApplicationContext(enriched), undefined);
	assert.equal(enriched[2], editorMessage);
	assert.match(content(enriched[0]), /\n\nApplication messages:/);
	assert.doesNotMatch(content(enriched[0]), /Editor guidance:/);
	assert.match(content(enriched[1]), /\n\nEditor guidance:/);
	assert.doesNotMatch(content(enriched[1]), /Application messages:/);
	assert.doesNotMatch(editorMessage.content, /Editor guidance:/);

	const standalone = addEditorApplicationContext([editorMessage]);
	assert.ok(standalone);
	assert.match(content(standalone[0]), /Application messages:[^\n]+\n\nEditor guidance:/);
	const premarked = {
		...editorMessage,
		content: editorMessage.content.replace("\n\n", "\n\nFirst application already added this.\n\n"),
		details: { ...editorMessage.details, applicationMessageContext: { explanation: true as const } },
	};
	const later = addEditorApplicationContext([premarked]);
	assert.ok(later);
	assert.match(content(later[0]), /\n\nFirst application already added this\.\n\nEditor guidance:/);
	assert.throws(() => editorApplicationMessage({ ...fixture, root: "/folder\nname" }), /folder path/);
	const selection = editorApplicationMessage({
		...fixture,
		doc: "example.ts",
		target: undefined,
		lines: { start: 2, end: 3 },
		quote: "selected",
		context: "before\nselected\nafter",
		dirty: true,
	});
	assert.match(selection.content, /Lines \(one-based\): 2–3/);
	assert.match(selection.content, /Quoted surrounding lines: "before\\nselected\\nafter"/);
	assert.match(selection.content, /unsaved changes: use editor read/);
});

test("automatic answers fit the thread byte limit without exposing non-text blocks", () => {
	const answer = answerText(fauxAssistantMessage("🌊".repeat(1500)), 2);
	assert.ok(answer && Buffer.byteLength(answer) <= 4096);
	assert.match(answer, /Answer truncated in Editor/);
	assert.match(answer, /addressed 2 other inputs/);
	assert.doesNotMatch(answer, /\uFFFD/u);
	assert.equal(answerText(call({ op: "read", doc: "ignore" })), undefined);
});

test("ordinary Pi places editor invites, restores dropped follow-ups and withdraws switched sessions", {
	timeout: 15_000,
}, async (t) => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "editor-ordinary-")));
	const root = join(dir, "project");
	const agentDir = join(dir, "state");
	const disposers: Array<() => void | Promise<void>> = [];
	t.after(async () => {
		try {
			for (const dispose of disposers.reverse()) await dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	await Promise.all([mkdir(root), mkdir(agentDir, { mode: 0o700 })]);
	const doc = "draft.txt";
	await writeFile(join(root, doc), "Before");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	disposers.push(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const workspace = new Workspace(root, agentDir);
	disposers.push(() => workspace.close());
	const initial = workspace.run({ op: "read", doc }, "Person");
	const rev = initial.rev;
	const { id: thread } = workspace.run({ op: "note", doc, rev, start: 0, end: 6, text: "Change this." }, "Person");
	assert.ok(typeof thread === "string" && typeof rev === "number");

	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	let nestedRead: unknown;
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
					extensionFactories: [
						(pi) => {
							pi.registerTool({
								name: "inspect_editor",
								label: "Inspect Editor result",
								description: "Check the structured nested read result.",
								parameters: obj({}),
								async execute(_id, _input, _signal, _update, ctx) {
									const nested = await ctx.executeTool("editor", { op: "read", root, doc });
									nestedRead = nested.result.structuredContent;
									return { content: [{ type: "text", text: "Checked" }], details: undefined };
								},
							});
						},
					],
				},
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
				tools: ["editor", "inspect_editor", "write", "edit"],
			});
			return { ...result, services, diagnostics: services.diagnostics };
		},
		{ cwd: root, agentDir, sessionManager: SessionManager.inMemory(root) },
	);
	const errors: string[] = [];
	const bind = async (session: typeof runtime.session) => {
		await session.bindExtensions({ onError: (error) => errors.push(error.error) });
	};
	disposers.push(() => runtime.dispose());
	await bind(runtime.session);
	runtime.setRebindSession(bind);
	const session = runtime.session;
	const actor = `ordinary:${session.sessionId}`;
	assert.deepEqual(await members(workspace.dir), []);
	faux.setResponses([call({ op: "join" }), fauxAssistantMessage("Connected")]);
	await session.prompt("Join the Editor.");
	const connected = await members(workspace.dir);
	assert.deepEqual(
		connected.map(({ id }) => id),
		[actor],
	);
	const recipient = connected[0];
	const author = recipient.label;

	const request = {
		id: randomUUID(),
		root,
		thread,
		doc,
		quote: "Before",
		message: "Apply the edit and report in this thread.",
	};
	let prompt = "";
	faux.setResponses([
		({ messages }) => {
			prompt = JSON.stringify(messages);
			return fauxAssistantMessage(fauxToolCall("inspect_editor", {}), { stopReason: "toolUse" });
		},
		call({ op: "edit", root, doc, rev, find: "Before", replace: "After" }),
		call({ op: "reply", root, id: thread, text: "Changed the shared draft." }),
		fauxAssistantMessage("This answer stays in Pi."),
	]);
	workspace.setRequest(thread, request.id, "queued", recipient);
	await invite(workspace.dir, actor, request);
	await session.waitForIdle();
	assert.match(prompt, /Editor guidance:/);
	assert.match(prompt, /Apply the edit and report in this thread/);
	assert.ok(nestedRead && typeof nestedRead === "object" && "text" in nestedRead);
	assert.equal(nestedRead.text, "Before");
	assert.equal(workspace.run({ op: "read", doc }, "Person").text, "After");
	assert.equal(await readFile(join(root, doc), "utf8"), "Before");
	assert.deepEqual(JSON.parse(JSON.stringify(workspace.run({ op: "thread", id: thread }, "Person").messages)), [
		{ author: "Person", text: "Change this." },
		{ author, text: "Changed the shared draft." },
	]);
	assert.equal(workspace.requestStatus(thread, request.id)?.state, "answered");

	const service = await startPaneService({
		root,
		agentDir,
		paneId: randomUUID(),
		participant: recipient,
		appPid: process.pid,
	});
	disposers.push(() => service.close());
	const pane = async (op: string, fields: Record<string, unknown>) => {
		const response = await fetch(`http://127.0.0.1:${service.port}/api`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${service.token}` },
			body: JSON.stringify({ op, ...fields }),
			signal: AbortSignal.timeout(3000),
		});
		const result = await response.json();
		assert.equal(response.status, 200, JSON.stringify(result));
		return result;
	};
	const { cursor } = await pane("events", { since: 0 });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "produced.txt", content: "first\n" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			fauxToolCall("edit", { path: "produced.txt", edits: [{ oldText: "first", newText: "second" }] }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Automatic ordinary answer."),
	]);
	assert.equal(
		(await pane("send", { id: thread, to: actor, message: "Write, edit and report the new file." })).accepted,
		true,
	);
	await session.waitForIdle();
	const { events } = await pane("events", { since: cursor });
	assert.deepEqual(
		events.filter((event: { type: string }) => event.type === "request").map((event: { state: string }) => event.state),
		["queued", "working", "answered"],
	);
	assert.deepEqual(
		events.filter((event: { type: string }) => event.type === "file"),
		[
			{ type: "file", path: "produced.txt", change: "created", by: recipient, thread },
			{ type: "file", path: "produced.txt", change: "modified", by: recipient, thread },
		],
	);
	assert.equal(await readFile(join(root, "produced.txt"), "utf8"), "second\n");
	assert.deepEqual((await pane("state", {})).threads[0].changedFiles, ["produced.txt"]);
	assert.deepEqual((await pane("thread", { id: thread })).messages.at(-1), {
		author,
		text: "Automatic ordinary answer.",
	});

	// A steering message queued during the first turn continues the run; only its last turn answers.
	const steeredTurn = latch();
	const steerQueued = latch();
	faux.setResponses([
		async () => {
			steeredTurn.open();
			await steerQueued.promise;
			return fauxAssistantMessage("Turn one answer.");
		},
		fauxAssistantMessage("Final answer after steering."),
	]);
	assert.equal((await pane("send", { id: thread, to: actor, message: "Answer once the run ends." })).accepted, true);
	await steeredTurn.promise;
	session.agent.steer({ role: "user", content: [{ type: "text", text: "Also cover Y." }], timestamp: Date.now() });
	steerQueued.open();
	await session.waitForIdle();
	assert.deepEqual((await pane("thread", { id: thread })).messages.at(-1), {
		author,
		text: "Final answer after steering.\n\n[This answer also addressed 1 other input.]",
	});

	const entered = latch();
	const release = latch();
	faux.setResponses([
		async () => {
			entered.open();
			await release.promise;
			return fauxAssistantMessage("The busy run stops.");
		},
	]);
	const busy = session.prompt("Run until the test stops the turn.");
	await entered.promise;
	const queued = { ...request, id: randomUUID(), message: "Follow-up kept after Escape." };
	try {
		await invite(workspace.dir, actor, queued);
		assert.equal(session.agent.hasQueuedMessages(), true);
		session.clearQueue();
		assert.equal(session.agent.hasQueuedMessages(), false);
	} finally {
		const stopped = session.abort();
		release.open();
		await stopped;
		await busy;
	}
	assert.equal(
		session.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					typeof entry.content === "string" &&
					entry.content.includes(queued.message),
			).length,
		1,
	);
	let resumedPrompt = "";
	faux.setResponses([
		({ messages }) => {
			resumedPrompt = JSON.stringify(messages);
			return call({ op: "reply", root, id: thread, text: "Recovered the hand-off." });
		},
		fauxAssistantMessage("Done"),
	]);
	await session.prompt("Continue.");
	assert.match(resumedPrompt, /Follow-up kept after Escape/);
	assert.ok(
		JSON.stringify(workspace.run({ op: "thread", id: thread }, "Person").messages).includes("Recovered the hand-off."),
	);

	const enteredAgain = latch();
	const releaseAgain = latch();
	const dropped = { ...request, id: randomUUID(), message: "Follow-up recovered within the current run." };
	let continuedPrompt = "";
	faux.setResponses([
		async () => {
			enteredAgain.open();
			await releaseAgain.promise;
			return fauxAssistantMessage("The first turn finishes.");
		},
		({ messages }) => {
			continuedPrompt = JSON.stringify(messages);
			return fauxAssistantMessage("The follow-up turn finishes.");
		},
	]);
	const active = session.prompt("Wait for another follow-up.");
	await enteredAgain.promise;
	try {
		await invite(workspace.dir, actor, dropped);
		assert.equal(session.agent.hasQueuedMessages(), true);
		session.clearQueue();
	} finally {
		releaseAgain.open();
		await active;
	}
	assert.match(continuedPrompt, /Follow-up recovered within the current run/);

	assert.deepEqual(await runtime.newSession(), { cancelled: false });
	assert.deepEqual(await members(workspace.dir), []);
	faux.setResponses([call({ op: "join" }), fauxAssistantMessage("Connected")]);
	await runtime.session.prompt("Join the Editor as a new session.");
	const nextActor = `ordinary:${runtime.session.sessionId}`;
	assert.notEqual(actor, nextActor);
	assert.deepEqual(
		(await members(workspace.dir)).map(({ id }) => id),
		[nextActor],
	);
	await runtime.dispose();
	disposers.pop();
	assert.deepEqual(await members(workspace.dir), []);
	assert.deepEqual(errors, []);
});
