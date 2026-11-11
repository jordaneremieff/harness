import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PillarsStore } from "./store.ts";
import { utcDay } from "./collector.ts";
import { zero } from "./capacity.ts";

const hostRoot = process.env.PI_PILLARS_TEST_HOST_ROOT;
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(
	hostRoot ? pathToFileURL(join(hostRoot, "dist/index.js")).href : "@earendil-works/pi-coding-agent"
);
const ai: typeof import("@earendil-works/pi-ai") = await import(
	hostRoot
		? pathToFileURL(join(hostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href
		: "@earendil-works/pi-ai"
);

test("Pi discovery, source delivery, callbacks, commands and awaited shutdown use the actual extension", {
	timeout: 30000,
}, async (t) => {
	const root = await mkdtemp(join(process.cwd(), ".pillars-sdk-test-"));
	const previous = process.env.PI_PILLARS_DIR;
	const previousCollect = process.env.PI_PILLARS_COLLECT;
	const previousCorpus = process.env.PI_PILLARS_CORPUS;
	process.env.PI_PILLARS_DIR = join(root, "store");
	process.env.PI_PILLARS_COLLECT = "1";
	const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
	const corpusDir = join(root, "package/pillars");
	process.env.PI_PILLARS_CORPUS = corpusDir;
	const entryBody = "# Synthetic principle\nUse checked evidence.\n";
	let session: InstanceType<typeof sdk.AgentSession> | undefined;
	try {
		await mkdir(corpusDir, { recursive: true });
		await writeFile(join(corpusDir, "README.md"), "# Inventory\n[Example](principle-example.md)\n");
		await writeFile(join(corpusDir, "GOVERNANCE.md"), "# Rules\nRead the matching full body.\n");
		await writeFile(join(corpusDir, "principle-example.md"), entryBody);
		const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const faux = ai.fauxProvider({
			provider: "pillars-test",
			models: [{ id: "reader", reasoning: true, contextWindow: 100000 }],
			tokensPerSecond: 0,
		});
		const modelRuntime = await sdk.ModelRuntime.create({
			credentials: new ai.InMemoryCredentialStore(),
			modelsStore: new ai.InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const loader = new sdk.DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [entry],
			extensionFactories: [sdk.createCodemodeExtension({ models: false })],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const result = await sdk.createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "high",
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(root),
			settingsManager,
			tools: ["read", "pillars", "pillars_usage", "codemode"],
		});
		session = result.session;
		const activeSession = session;
		const errors: string[] = [];
		await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
		const pillarsTool = session.getAllTools().find((tool) => tool.name === "pillars");
		assert.ok(pillarsTool, "the session registers the pillars tool");
		assert.equal(resolve(pillarsTool.sourceInfo.path), entry);
		const command = session.extensionRunner.getRegisteredCommands().find((command) => command.name === "pillars");
		assert.ok(command?.getArgumentCompletions);
		const completions = (prefix: string) => {
			const toolsBefore = activeSession.getActiveToolNames();
			const result = command.getArgumentCompletions?.(prefix);
			assert.deepEqual(activeSession.getActiveToolNames(), toolsBefore);
			assert.notEqual(result, undefined);
			if (result === null) return null;
			assert.ok(Array.isArray(result), "completion returns synchronously");
			return result;
		};
		assert.equal(completions("de")?.[0].value, "derive");
		for (const prefix of ["read p", "read pr", "read pri"]) {
			assert.equal(completions(prefix)?.[0].value, "read principle-example");
		}
		assert.equal(completions("check a hint"), null);
		const callUsageTool = async (name: string, args: import("@earendil-works/pi-ai").ToolCall["arguments"]) => {
			faux.setResponses([
				ai.fauxAssistantMessage(ai.fauxToolCall(name, args)),
				ai.fauxAssistantMessage("Synthetic usage checked."),
			]);
			await activeSession.prompt("Check retained access evidence.");
			const message = activeSession.messages.findLast((item) => item.role === "toolResult");
			assert.ok(message?.role === "toolResult");
			return message;
		};
		const usageText = (message: import("@earendil-works/pi-ai").ToolResultMessage) =>
			message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		const assertUsageOutcomes = async () => {
			const empty = await callUsageTool("pillars_usage", {});
			assert.equal(empty.isError, false);
			assert.deepEqual(empty.details, JSON.parse(usageText(empty)));
			assert.match(usageText(empty), /"kind":"page"/);
			assert.match(usageText(empty), /"totalRows":0/);
			const cursor = await callUsageTool("pillars_usage", { cursor: "abcd" });
			assert.equal(cursor.isError, true);
			assert.match(usageText(cursor), /"code":"cursor_invalid"/);
			assert.match(usageText(cursor), /fresh|Send/);
			assert.deepEqual(cursor.details, JSON.parse(usageText(cursor)));
			const day = utcDay();
			await new PillarsStore(join(root, "store")).commit({ owner: "a".repeat(32), seq: 1, day,
				cells: Array.from({ length: 25 }, (_, index) => ({ day, observationStage: "tool_request", resourceClass: "entry",
					resourceId: `synthetic-${index}`, model: "test/model", reasoning: "high", referenceBodyDigest: "a".repeat(64),
					observerVersion: "1.0.0", piVersion: "1.0.0", counters: { ...zero(), readRequests: 1 } })),
			}, day);
			const paged = await callUsageTool("pillars_usage", { view: "revisions" });
			const next = JSON.parse(usageText(paged)).pagination.nextCursor;
			assert.equal(typeof next, "string");
			await callUsageTool("pillars_usage", {});
			const expired = await callUsageTool("pillars_usage", { cursor: next });
			assert.equal(expired.isError, true);
			assert.match(usageText(expired), /"code":"cursor_expired"/);
			assert.match(usageText(expired), /Send \{\} for a fresh overview/);
			assert.deepEqual(expired.details, JSON.parse(usageText(expired)));
			await rm(join(root, "store"), { recursive: true, force: true });
			await writeFile(join(root, "store"), "Unreadable synthetic aggregate root.");
			try {
				const unreadable = await callUsageTool("pillars_usage", {});
				const diagnostic = usageText(unreadable);
				assert.equal(unreadable.isError, true);
				assert.match(diagnostic, /"kind":"error".*"code":"store_unreadable"/);
				assert.deepEqual(unreadable.details, JSON.parse(diagnostic));
				const caught = await callUsageTool("codemode", { code: 'try { await tools.pillars_usage({}); throw new Error("expected rejection"); } catch (error) { if (JSON.parse(error.message).code !== "store_unreadable") throw error; text(error.message); }' });
				assert.equal(caught.isError, false, usageText(caught));
				assert.ok(usageText(caught).includes(diagnostic));
				const uncaught = await callUsageTool("codemode", { code: "await tools.pillars_usage({});" });
				assert.equal(uncaught.isError, true);
				assert.ok(usageText(uncaught).includes(diagnostic));
			} finally {
				await rm(join(root, "store"), { force: true });
			}
		};
		await assertUsageOutcomes();
		faux.setResponses([
			(context) => {
				assert.ok(ai.getCurrentTools(context.messages).some((tool) => tool.name === "pillars"));
				assert.ok(ai.getCurrentSystemPrompt(context.messages).includes("pillars"));
				return ai.fauxAssistantMessage(
					ai.fauxToolCall("pillars", { resource: "principle-example" }, { id: "source-call" }),
				);
			},
			ai.fauxAssistantMessage(
				ai.fauxToolCall("read", { path: join(root, "package/pillars/GOVERNANCE.md") }, { id: "read-call" }),
			),
			ai.fauxAssistantMessage("Synthetic run finished."),
		]);
		await session.prompt("Consult the synthetic principle and its governance.");
		const messages = session.messages.filter((message) => message.role === "toolResult" && ["source-call", "read-call"].includes(message.toolCallId));
		assert.equal(messages.length, 2);
		const sourceMessage = messages[0];
		assert.ok(sourceMessage?.role === "toolResult");
		const sourceText = sourceMessage.content.find((block) => block.type === "text");
		assert.ok(sourceText && sourceText.type === "text");
		assert.equal(JSON.parse(sourceText.text).text, entryBody);
		const during = await new PillarsStore(join(root, "store")).capture(utcDay());
		assert.ok(
			Object.values(during.shards)
				.flatMap((shard) => shard.cells)
				.some((cell) => cell.observationStage === "tool_request"),
		);
		const assertSource = async (expected: string) => {
			faux.setResponses([
				ai.fauxAssistantMessage(ai.fauxToolCall("pillars", { resource: "principle-example" }, { id: "refresh-source" })),
				ai.fauxAssistantMessage("Synthetic source checked."),
			]);
			await activeSession.prompt("Read the configured synthetic source.");
			const message = activeSession.messages.findLast((item) => item.role === "toolResult");
			assert.ok(message?.role === "toolResult");
			const block = message.content.find((item) => item.type === "text");
			assert.ok(block?.type === "text");
			const source: unknown = JSON.parse(block.text);
			assert.ok(source && typeof source === "object");
			if (expected === "source_unavailable") {
				assert.equal(message.isError, true);
				assert.ok("code" in source);
				assert.equal(source.code, expected);
			} else {
				assert.equal(message.isError, false);
				assert.ok("text" in source);
				assert.equal(source.text, expected);
			}
		};
		const assertCatalogueRefresh = async () => {
			const inventory = "# Inventory\n[Example](principle-example.md)\n";
			const updated = "# Current synthetic principle\nRead the current bytes.\n";
			await writeFile(join(corpusDir, "README.md"), `${inventory}[Missing](principle-missing.md)\n`);
			await writeFile(join(corpusDir, "principle-example.md"), updated);
			for (const prefix of ["read p", "read pr", "read pri"]) {
				assert.equal(completions(prefix)?.[0].value, "read principle-example");
			}
			await assertSource(updated);
			await activeSession.prompt("/pillars browse");
			assert.equal(completions("read "), null);
			await assertSource("source_unavailable");
			await writeFile(join(corpusDir, "README.md"), inventory);
			await writeFile(join(corpusDir, "principle-example.md"), entryBody);
			await activeSession.prompt("/pillars browse");
			assert.equal(completions("read p")?.[0].value, "read principle-example");
			await writeFile(join(corpusDir, "principle-added.md"), "# Added synthetic principle\n");
			await writeFile(join(corpusDir, "README.md"), `${inventory}[Added](principle-added.md)\n`);
			assert.equal(completions("read principle-a"), null);
			await activeSession.prompt("/pillars browse");
			assert.equal(completions("read principle-a")?.[0].value, "read principle-added");
			await writeFile(join(corpusDir, "README.md"), inventory);
			await activeSession.prompt("/pillars browse");
		};
		await assertCatalogueRefresh();
		const assertHelpCommands = async () => {
			const messagesBeforeCommand = activeSession.messages.length;
			await activeSession.prompt("/pillars read principle-example");
			assert.equal(
				activeSession.messages.length,
				messagesBeforeCommand,
				"operator-only source output never enters model context",
			);
			const view = activeSession.sessionManager.getLeafEntry();
			assert.ok(view?.type === "custom" && view.customType === "pillars-view");
			assert.ok((view.data as { text: string }).text.includes(entryBody));
			for (const input of ["/pillars help", "/pillars", "/pillars invalid"]) {
				const before = activeSession.sessionManager.getEntries().length;
				await activeSession.prompt(input);
				assert.equal(activeSession.messages.length, messagesBeforeCommand);
				assert.ok(
					activeSession.sessionManager
						.getEntries()
						.slice(before)
						.some(
							(entry) =>
								entry.type === "custom" &&
								entry.customType === "pillars-view" &&
								(entry.data as { text: string }).text.includes("/pillars derive [hint]"),
						),
				);
			}
			process.env.PI_PILLARS_CORPUS = join(root, "absent-corpus");
			try {
				await activeSession.prompt("/pillars help");
				const help = activeSession.sessionManager.getLeafEntry();
				assert.ok(help?.type === "custom" && (help.data as { text: string }).text.includes("# Pillars commands"));
				assert.equal(completions("read p")?.[0].value, "read principle-example");
				assert.equal(completions("ch")?.[0].value, "check");
				await activeSession.prompt("/pillars browse");
				assert.equal(completions("read "), null);
			} finally {
				process.env.PI_PILLARS_CORPUS = corpusDir;
			}
			assert.equal(completions("read "), null);
			await activeSession.prompt("/pillars browse");
			assert.equal(completions("read p")?.[0].value, "read principle-example");
		};
		await assertHelpCommands();
		const assertJudgmentRefresh = async () => {
			const warnings: string[] = [];
			const stderr = t.mock.method(process.stderr, "write", (text: string | Uint8Array) => { warnings.push(String(text)); return true; });
			try {
				for (const action of ["check", "derive", "review"]) {
					const before = completions("read ");
					assert.ok(before?.length);
					process.env.PI_PILLARS_CORPUS = join(root, "absent-corpus");
					try {
						await activeSession.prompt("/pillars help");
						assert.deepEqual(completions("read "), before);
						faux.setResponses([
							ai.fauxAssistantMessage(ai.fauxToolCall("pillars", { resource: "principle-example" })),
							ai.fauxAssistantMessage("Synthetic judgment refresh checked."),
						]);
						await activeSession.prompt(`/pillars ${action} inspect the configured corpus`);
						await activeSession.waitForIdle();
						assert.deepEqual(completions("read "), before);
						assert.ok(warnings.some((text) => text === "Pillars catalogue refresh failed. The judgment uses the last available catalogue; source reads still verify current body bytes.\n"));
						const result = activeSession.messages.findLast((message) => message.role === "toolResult");
						assert.ok(result?.role === "toolResult");
						assert.equal(result.isError, false);
						assert.match(usageText(result), /Use checked evidence/);
						warnings.length = 0;
					} finally {
						process.env.PI_PILLARS_CORPUS = corpusDir;
					}
					await activeSession.prompt("/pillars browse");
				}
			} finally { stderr.mock.restore(); }
		};
		await assertJudgmentRefresh();
		const assertJudgmentRequests = async () => {
			for (const input of [
				"check",
				"derive",
				'check the "quoted" approach --days 7\nwith context',
				"derive a reusable lesson",
				"review",
				'review why agents miss the "same cue" -- repeatedly\nUse the examples above.',
			]) {
				let received = false;
				faux.setResponses([
					(context) => {
						const message = context.messages.at(-1);
						assert.equal(message?.role, "user");
						const text = JSON.stringify(message?.content);
						assert.ok(text.includes("extension-provided task scaffolding"));
						assert.ok(
							text.includes(
								input.startsWith("check")
									? "Pillars alignment"
									: input.startsWith("review")
										? "expected and observed behavior"
										: "transferable candidate",
							),
						);
						received = true;
						return ai.fauxAssistantMessage("Synthetic judgment request received.");
					},
				]);
				await activeSession.prompt(`/pillars ${input}`);
				await activeSession.waitForIdle();
				assert.equal(received, true);
				const request = activeSession.messages.findLast((message) => message.role === "custom");
				assert.ok(request?.role === "custom" && request.customType === "pillars-request" && request.display);
			}
		};
		await assertJudgmentRequests();
		const assertSteering = async () => {
			for (const action of ["check", "derive", "review"]) {
				let release!: () => void;
				let started!: () => void;
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				const entered = new Promise<void>((resolve) => {
					started = resolve;
				});
				let steered = false;
				faux.setResponses([
					async () => {
						started();
						await held;
						return ai.fauxAssistantMessage("Synthetic active response.");
					},
					(context) => {
						assert.ok(JSON.stringify(context.messages).includes("busy hint"));
						steered = true;
						return ai.fauxAssistantMessage("Synthetic steering received.");
					},
				]);
				const active = activeSession.prompt("Hold the response for a command.");
				await entered;
				try {
					await activeSession.prompt(`/pillars ${action} busy hint`);
				} finally {
					release();
				}
				await active;
				assert.equal(steered, true);
			}
		};
		await assertSteering();
		faux.setResponses([
			ai.fauxAssistantMessage(
				ai.fauxToolCall(
					"pillars",
					{ resource: "principle-example", offset: 1, referenceBodyDigest: "0".repeat(64) },
					{ id: "stale-call" },
				),
			),
			ai.fauxAssistantMessage("Synthetic error checked."),
		]);
		await session.prompt("Read a deliberately stale source continuation.");
		const stale = session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "stale-call",
		);
		assert.ok(stale?.role === "toolResult" && stale.isError);
		assert.ok(stale.content.some((block) => block.type === "text" && block.text.includes("source_changed")));
		for (const [toolName, args, expected] of [
			["pillars", { resource: "principle-example.md" }, /principle-example.*inventory/],
			["pillars_usage", { cursor: "abcd", view: "overview" }, /cursor alone/],
			["pillars", { resource: null }, /resource:.*null.*identifier/],
			["pillars", { offset: -1 }, /offset:.*-1.*integer/],
			["pillars", { referenceBodyDigest: "private\u001b" }, /referenceBodyDigest:.*withheld.*64 lowercase/],
			["pillars_usage", { windowDays: 31 }, /windowDays:.*31.*1.*30/],
			["pillars_usage", { view: "private\u001b" }, /view:.*withheld.*overview/],
			["pillars_usage", { extra: "private\u001b" }, /unsupported field/],
		] as const) {
			faux.setResponses([
				ai.fauxAssistantMessage(ai.fauxToolCall(toolName, args, { id: "invalid-call" })),
				ai.fauxAssistantMessage("Synthetic invalid input checked."),
			]);
			await session.prompt("Check an invalid tool input.");
			const invalid: import("@earendil-works/pi-agent-core").AgentMessage | undefined = session.messages.findLast((message) => message.role === "toolResult");
			assert.ok(invalid?.role === "toolResult");
			const content = invalid.content.find((block) => block.type === "text");
			assert.ok(content?.type === "text");
			const diagnostic = JSON.parse(content.text);
			assert.equal(diagnostic.code, "invalid_input");
			assert.match(diagnostic.message, expected);
			if (toolName === "pillars") assert.equal(invalid.isError, true);
		}
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const captured = await new PillarsStore(join(root, "store")).capture(utcDay());
		const cells = Object.values(captured.shards).flatMap((shard) => shard.cells);
		assert.equal(
			cells.reduce((n, cell) => n + cell.counters.readRequests, 0),
			7,
		);
		assert.equal(
			cells.reduce((n, cell) => n + cell.counters.readResults, 0),
			7,
		);
		assert.equal(
			cells.reduce((n, cell) => n + cell.counters.bodyVerifiedAtObservation, 0),
			6,
		);
		assert.equal(
			cells.reduce((n, cell) => n + cell.counters.resultError, 0),
			1,
		);
		assert.ok(cells.every((cell) => cell.piVersion === sdk.VERSION));
		assert.deepEqual(errors, []);
	} finally {
		try {
			await session?.abort();
			session?.dispose();
		} finally {
			if (previous === undefined) delete process.env.PI_PILLARS_DIR;
			else process.env.PI_PILLARS_DIR = previous;
			if (previousCollect === undefined) delete process.env.PI_PILLARS_COLLECT;
			else process.env.PI_PILLARS_COLLECT = previousCollect;
			if (previousCorpus === undefined) delete process.env.PI_PILLARS_CORPUS;
			else process.env.PI_PILLARS_CORPUS = previousCorpus;
			await rm(root, { recursive: true, force: true });
		}
	}
});
