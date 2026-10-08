import { isolateMachineSettings } from "./settings-fixture.mts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	type JsonObject,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	parseFrontmatter,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { memorySearchOutputSchema } from "./search-output.ts";

isolateMachineSettings();

function text(result: ToolResultMessage): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
function details(result: ToolResultMessage): JsonObject {
	assert.equal(result.isError, false, text(result));
	assert.ok(result.details && typeof result.details === "object" && !Array.isArray(result.details));
	return result.details as JsonObject;
}
function digest(value: unknown): string {
	assert.equal(typeof value, "string");
	assert.match(value as string, /^[a-f0-9]{64}$/);
	return value as string;
}

function scriptValue(result: ToolResultMessage): JsonObject {
	assert.equal(result.isError, false, text(result));
	const output = result.content.filter((part) => part.type === "text");
	assert.equal(output.length, 2);
	return JSON.parse(output[1].text) as JsonObject;
}

type Invoke = (name: string, args: JsonObject) => Promise<ToolResultMessage>;

async function readPages(invoke: Invoke, slug: string, digest: string, revision?: string): Promise<string> {
	let offset = 0;
	let collected = "";
	for (let pageNumber = 1; pageNumber <= 8; pageNumber++) {
		const page = details(await invoke("memory_read", { slug, digest, offset, ...(revision ? { revision } : {}) }));
		assert.equal(page.offset, offset);
		assert.equal(page.digest, digest);
		assert.deepEqual(page.lifecycle, { status: "active", supersededBy: null });
		assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= 48 * 1024);
		assert.equal(typeof page.content, "string");
		if (revision) {
			assert.equal(page.source, "history");
			assert.equal(page.revision, revision);
			assert.match(page.authority as string, /Historical evidence only, not current authority/);
		}
		collected += page.content;
		if (pageNumber === 1) assert.equal(page.contentCodePoints, 12000);
		if (!page.hasMore) {
			assert.ok(pageNumber > 1);
			return collected;
		}
		assert.equal(typeof page.nextOffset, "number");
		assert.ok((page.nextOffset as number) > offset);
		offset = page.nextOffset as number;
	}
	throw new Error("Source continuation exceeded fixture bound");
}

async function listCaptures(invoke: Invoke, slug: string): Promise<string[]> {
	const captures: string[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 4; guard++) {
		const page = details(await invoke("memory_history", { slug, limit: 1, ...(cursor ? { cursor } : {}) }));
		captures.push(...(page.revisions as JsonObject[]).map((item) => item.revision as string));
		if (!page.nextCursor) return captures;
		cursor = page.nextCursor as string;
	}
	throw new Error("History continuation exceeded fixture bound");
}

test("loaded tools preserve a note through correction, review, retirement, reactivation and supersession", {
	timeout: 40000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "memory-lifecycle-runtime-"));
	const corpus = join(root, "corpus");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const previousRoot = process.env.PI_MEMORY_DIR;
	process.env.PI_MEMORY_DIR = corpus;
	const errors: string[] = [];
	const sections: Array<string | undefined> = [];
	let pending: ToolCall | undefined;
	let sequence = 0;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "memory-lifecycle-fixture",
			defaultModel: "controlled",
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(agentDir, "models-cache.json"),
			refreshOnCreate: false,
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
			extensionFactories: [
				createCodemodeExtension({ models: false }),
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName !== "memory_search") return;
						if (event.isError) {
							assert.equal(event.structuredContent, undefined);
							return;
						}
						Value.Assert(memorySearchOutputSchema, event.structuredContent);
						assert.deepEqual(event.structuredContent, event.details);
						assert.deepEqual(
							event.structuredContent,
							JSON.parse(event.content[0].type === "text" ? event.content[0].text : ""),
						);
					});
					pi.registerProvider("memory-lifecycle-fixture", {
						baseUrl: "https://memory.invalid",
						api: "memory-lifecycle-fixture",
						apiKey: "synthetic-fixture-not-a-credential",
						models: [
							{
								id: "controlled",
								name: "Controlled fixture",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 1024,
							},
						],
						streamSimple(model, context) {
							sections.push(getCurrentSystemMessage(context.messages)?.sections?.memory_index ?? undefined);
							const call = pending;
							pending = undefined;
							const reason = call ? "toolUse" : "stop";
							const message: AssistantMessage = {
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								timestamp: Date.now(),
								content: call ? [call] : [{ type: "text", text: "Controlled reply." }],
								stopReason: reason,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							};
							const stream = createAssistantMessageEventStream();
							stream.push({ type: "done", reason, message });
							stream.end();
							return stream;
						},
					});
				},
			],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(root),
			tools: [
				"codemode",
				"memory_search",
				"memory_read",
				"memory_history",
				"memory_write",
				"memory_edit",
				"memory_review",
				"memory_retire",
			],
		}));
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		const model = modelRuntime.getModel("memory-lifecycle-fixture", "controlled");
		assert.ok(model);
		await session.setModel(model);
		assert.deepEqual(session.getActiveToolNames().sort(), [
			"codemode",
			"memory_edit",
			"memory_history",
			"memory_read",
			"memory_retire",
			"memory_review",
			"memory_search",
			"memory_write",
		]);
		const active = session;
		const invoke = async (name: string, args: JsonObject): Promise<ToolResultMessage> => {
			const id = `memory-call-${++sequence}`;
			pending = { type: "toolCall", id, name, arguments: args };
			await active.prompt(`Execute controlled call ${sequence}`);
			const result = active.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
			assert.ok(result?.role === "toolResult", `Missing native result for ${name}`);
			return result;
		};

		const unavailable = await invoke("memory_search", {});
		assert.equal(unavailable.isError, true);
		assert.equal(existsSync(corpus), false);
		const input = {
			slug: "configuration-notes",
			title: "Configuration notes",
			tags: ["configuration"],
			summary: "Use environment references in technical examples.",
			details: `Introductory qualification.\n\n\`api_key=api_key\`\n\n\`\`\`js\npassword=process.env.PASSWORD\n# Fenced example\n\`\`\`\n\n${"Unicode 😀 context. ".repeat(900)}\nTAIL qualification.`,
			sources: "Synthetic operator statement, 2026-01-01.",
			verified: true,
			reviewPolicy: "before-use",
			reviewAfter: "2000-01-01",
		};
		const created = details(await invoke("memory_write", input));
		assert.equal(created.initialized, true);
		const firstDigest = digest(created.digest);
		assert.equal(details(await invoke("memory_read", { slug: "README" })).source, "contract");
		const found = details(
			await invoke("memory_search", { query: ["api_key configuration", "environment references"] }),
		);
		assert.ok(Array.isArray(found.notes));
		const hit = found.notes[0] as JsonObject;
		assert.equal(hit.slug, input.slug);
		assert.equal(hit.digest, firstDigest);
		const composed = scriptValue(
			await invoke("codemode", {
				code: `
const page = await tools.memory_search({ query: ["api_key configuration", "environment references"] });
const browse = await tools.memory_search({});
let refused = false;
try { await tools.memory_search({query: "configuration", cursor: "invalid"}); }
catch (error) { refused = /cursor/.test(error.message); }
const sample = ALL_TOOLS.find(tool => tool.name === "memory_search").description;
return {
  type: typeof page,
  selected: page.notes.filter(note => note.lifecycle.status === "active").map(note => ({
    slug: note.slug, digest: note.digest, policy: note.freshness.policy,
    deadline: note.freshness.deadline, rank: note.rank, formulations: note.formulations.length
  })),
  browseHasDigest: "digest" in browse.notes[0],
  scope: page.countScope, snapshot: page.coverage.frozenSnapshot,
  privateState: "details" in page || "sourceEvidence" in page.notes[0] || "analysis" in page.notes[0],
  declared: sample.includes("digest?: string") && sample.includes("nextCursor:") && sample.includes("freshness:"),
  refused
};`,
			}),
		);
		assert.deepEqual(composed, {
			type: "object",
			selected: [
				{ slug: input.slug, digest: firstDigest, policy: "before-use", deadline: "due", rank: 1, formulations: 2 },
			],
			browseHasDigest: false,
			scope: "source-window",
			snapshot: false,
			privateState: false,
			declared: true,
			refused: true,
		});
		const collected = await readPages(invoke, input.slug, firstDigest);
		const path = join(corpus, `${input.slug}.md`);
		assert.equal(collected, readFileSync(path, "utf8"));
		assert.ok(collected.includes(input.details));
		const edit = {
			slug: input.slug,
			expectedDigest: firstDigest,
			verified: false,
			edits: [{ oldText: "api_key=api_key", newText: "api_key=process.env.API_KEY" }],
		};
		const edited = details(await invoke("memory_edit", edit));
		let currentDigest = digest(edited.digest);
		let current = readFileSync(path, "utf8");
		assert.ok(current.includes("`api_key=process.env.API_KEY`"));
		assert.ok(current.includes("TAIL qualification."));
		assert.equal(parseFrontmatter(current).frontmatter.verified_date, null);
		const stale = await invoke("memory_edit", edit);
		assert.equal(stale.isError, true);
		assert.match(text(stale), /Memory write incomplete: .*digest changed/);
		const receipt = JSON.parse(text(stale).slice("Memory write incomplete: ".length));
		assert.deepEqual(receipt.written, []);
		assert.equal(readFileSync(path, "utf8"), current);
		const staleRead = await invoke("memory_read", { slug: input.slug, digest: firstDigest, offset: 4000 });
		assert.equal(staleRead.isError, true);
		assert.match(text(staleRead), /source changed.*restart memory_read at offset 0/);

		const history = details(await invoke("memory_history", { slug: input.slug, limit: 1 }));
		assert.ok(Array.isArray(history.revisions));
		const prior = history.revisions[0] as JsonObject;
		assert.equal(prior.digest, firstDigest);
		assert.equal(typeof prior.revision, "string");
		const historical = await readPages(invoke, input.slug, firstDigest, prior.revision as string);
		assert.equal(historical, collected);
		assert.equal(readFileSync(path, "utf8"), current);
		assert.equal(
			(await invoke("memory_edit", { slug: input.slug, expectedDigest: currentDigest, edits: edit.edits })).isError,
			true,
		);
		const currentRead = details(await invoke("memory_read", { slug: input.slug }));
		const corrected = details(
			await invoke("memory_edit", {
				slug: input.slug,
				expectedDigest: currentRead.digest,
				verified: false,
				edits: [{ oldText: "api_key=process.env.API_KEY", newText: "api_key=api_key" }],
			}),
		);
		currentDigest = digest(corrected.digest);
		current = readFileSync(path, "utf8");
		assert.equal(parseFrontmatter(current).body, parseFrontmatter(historical).body);
		assert.equal(parseFrontmatter(current).frontmatter.verified_date, null);
		assert.equal(parseFrontmatter(current).frontmatter.status, "active");
		const captures = await listCaptures(invoke, input.slug);
		assert.equal(captures.length, 2);
		assert.equal(new Set(captures).size, 2);

		const unresolved = details(
			await invoke("memory_review", {
				slug: input.slug,
				expectedDigest: currentDigest,
				outcome: "unresolved",
				reason: "The current example needs a source check.",
				sources: "Synthetic current-source comparison.",
			}),
		);
		const unresolvedDigest = digest(unresolved.digest);
		assert.equal(parseFrontmatter(readFileSync(path, "utf8")).body, parseFrontmatter(current).body);
		const flagged = details(await invoke("memory_read", { slug: input.slug, digest: unresolvedDigest }));
		const flaggedFreshness = flagged.freshness as JsonObject;
		assert.equal(flaggedFreshness.policy, "before-use");
		assert.equal(flaggedFreshness.deadline, "due");
		assert.equal(flaggedFreshness.verified, false);
		assert.equal(flaggedFreshness.verifiedDate, null);
		assert.equal((flaggedFreshness.concern as JsonObject).reason, "The current example needs a source check.");
		assert.match(sections.at(-1) ?? "", /configuration-notes: Configuration notes/);
		const observedAgain = details(await invoke("memory_read", { slug: input.slug }));
		assert.equal(observedAgain.digest, unresolvedDigest);
		const confirmed = details(
			await invoke("memory_review", {
				slug: input.slug,
				expectedDigest: unresolvedDigest,
				outcome: "confirmed",
				sources: "Whole synthetic note checked against the current fixture.",
			}),
		);
		currentDigest = digest(confirmed.digest);
		const confirmedRead = details(await invoke("memory_read", { slug: input.slug, digest: currentDigest }));
		const confirmedFreshness = confirmedRead.freshness as JsonObject;
		assert.equal(confirmedFreshness.verified, true);
		assert.equal(confirmedFreshness.verifiedDate, new Date().toISOString().slice(0, 10));
		assert.equal(confirmedFreshness.policy, "before-use");
		assert.equal(confirmedFreshness.reviewAfter, "2000-01-01");
		assert.equal(confirmedFreshness.deadline, "due");
		assert.equal(confirmedFreshness.concern, null);
		assert.equal((confirmedFreshness.lastReview as JsonObject).digest, unresolvedDigest);
		current = readFileSync(path, "utf8");
		const withdrawal = details(
			await invoke("memory_retire", {
				slug: input.slug,
				expectedDigest: currentDigest,
				reason: "The operator withdrew this subject.",
				sources: "Synthetic operator withdrawal.",
			}),
		);
		const withdrawnDigest = digest(withdrawal.digest);
		const withdrawn = details(await invoke("memory_read", { slug: input.slug, digest: withdrawnDigest }));
		assert.deepEqual(withdrawn.lifecycle, { status: "retired", supersededBy: null });
		assert.equal((withdrawn.freshness as JsonObject).verified, true);
		assert.equal(parseFrontmatter(readFileSync(path, "utf8")).body, parseFrontmatter(current).body);
		assert.doesNotMatch(sections.at(-1) ?? "", /configuration-notes:/);
		const withoutRetired = details(await invoke("memory_search", { query: "configuration" }));
		assert.deepEqual(withoutRetired.notes, []);
		assert.equal(withoutRetired.excludedRetired, 1);
		const withRetired = details(await invoke("memory_search", { query: "configuration", includeRetired: true }));
		assert.equal(((withRetired.notes as JsonObject[])[0].lifecycle as JsonObject).status, "retired");
		const ordinaryReview = await invoke("memory_review", {
			slug: input.slug,
			expectedDigest: withdrawnDigest,
			outcome: "confirmed",
			sources: "Synthetic evidence.",
		});
		assert.equal(ordinaryReview.isError, true);
		assert.equal((await invoke("memory_write", { ...input, expectedDigest: withdrawnDigest })).isError, true);
		assert.equal((await invoke("memory_edit", { ...edit, expectedDigest: withdrawnDigest })).isError, true);
		const restored = details(
			await invoke("memory_review", {
				slug: input.slug,
				expectedDigest: withdrawnDigest,
				outcome: "confirmed",
				reactivate: true,
				sources: "Synthetic operator restoration and complete source check.",
				reviewPolicy: "on-change",
				reviewAfter: null,
			}),
		);
		const restoredRead = details(await invoke("memory_read", { slug: input.slug, digest: restored.digest }));
		assert.deepEqual(restoredRead.lifecycle, { status: "active", supersededBy: null });
		assert.equal((restoredRead.freshness as JsonObject).retirement, null);
		assert.equal((restoredRead.freshness as JsonObject).policy, "on-change");
		assert.equal((restoredRead.freshness as JsonObject).deadline, "unscheduled");
		assert.match(sections.at(-1) ?? "", /configuration-notes: Configuration notes/);
		const retiredAgain = details(
			await invoke("memory_retire", {
				slug: input.slug,
				expectedDigest: restored.digest,
				reason: "The subject is withdrawn before its replacement.",
				sources: "Synthetic operator instruction.",
			}),
		);
		currentDigest = digest(retiredAgain.digest);
		current = readFileSync(path, "utf8");
		const plan = { capturedBefore: "9999-01-01T00:00:00.000Z", keepNewest: 1 };
		const fractionalPlan = await invoke("memory_history", {
			slug: input.slug,
			plan: { ...plan, keepNewest: 0.5 },
		});
		assert.equal(fractionalPlan.isError, true);
		assert.match(text(fractionalPlan), /keepNewest|multipleOf|multiple of/i);
		assert.equal((fractionalPlan.details as JsonObject | undefined)?.plan, undefined);
		assert.equal(readFileSync(path, "utf8"), current);
		const planned = details(await invoke("memory_history", { slug: input.slug, plan, limit: 1 }));
		assert.equal((planned.plan as JsonObject).digestsVerified, false);
		assert.equal((planned.plan as JsonObject).scope, "metadata-page");
		assert.equal((planned.revisions as JsonObject[])[0].selection, "keep");
		assert.equal((planned.coverage as JsonObject).bodiesRead, false);
		const plannedNext = details(
			await invoke("memory_history", { slug: input.slug, plan, limit: 1, cursor: planned.nextCursor }),
		);
		assert.equal((plannedNext.revisions as JsonObject[])[0].selection, "candidate");
		assert.equal(readFileSync(path, "utf8"), current);

		const token = `ghp_${"x".repeat(24)}`;
		const refused = await invoke("memory_write", { ...input, slug: "refused", details: `\`\`\`\n${token}\n\`\`\`` });
		assert.equal(refused.isError, true);
		assert.match(text(refused), /details \(recognized token prefix\)/);
		assert.ok(!text(refused).includes(token));
		assert.equal(existsSync(join(corpus, "refused.md")), false);
		const replacement = details(
			await invoke("memory_write", {
				...input,
				slug: "configuration-choice",
				title: "Configuration choice",
				supersedes: [{ slug: input.slug, digest: currentDigest }],
			}),
		);
		assert.deepEqual(replacement.written, ["configuration-choice.md", "configuration-notes.md"]);
		const old = parseFrontmatter(current);
		const superseded = parseFrontmatter(readFileSync(path, "utf8"));
		assert.equal(superseded.body, old.body);
		assert.equal(superseded.frontmatter.status, "superseded");
		assert.equal(superseded.frontmatter.superseded_by, "configuration-choice");
		assert.equal(superseded.frontmatter.verified, old.frontmatter.verified);
		assert.equal(superseded.frontmatter.verified_date, old.frontmatter.verified_date);
		assert.equal(superseded.frontmatter.retirement, undefined);
		const oldPage = details(await invoke("memory_read", { slug: input.slug }));
		assert.deepEqual(oldPage.lifecycle, { status: "superseded", supersededBy: "configuration-choice" });
		const oldContinuation = details(
			await invoke("memory_read", {
				slug: input.slug,
				digest: digest(oldPage.digest),
				offset: oldPage.nextOffset,
			}),
		);
		assert.deepEqual(oldContinuation.lifecycle, oldPage.lifecycle);
		const archivedActive = details(
			await invoke("memory_read", { slug: input.slug, revision: prior.revision, digest: firstDigest }),
		);
		assert.deepEqual(archivedActive.lifecycle, { status: "active", supersededBy: null });
		assert.equal((await invoke("memory_edit", { ...edit, expectedDigest: oldPage.digest })).isError, true);
		assert.equal(
			(
				await invoke("memory_review", {
					slug: input.slug,
					expectedDigest: oldPage.digest,
					outcome: "confirmed",
					reactivate: true,
					sources: "Synthetic evidence.",
				})
			).isError,
			true,
		);
		await invoke("memory_search", {});
		const section = sections.at(-1);
		assert.match(section ?? "", /configuration-choice: Configuration choice/);
		assert.doesNotMatch(section ?? "", /configuration-notes:/);

		for (let index = 0; index < 4096; index++)
			writeFileSync(join(corpus, `filler-${String(index).padStart(4, "0")}.md`), "# Ordinary subject\n");
		for (const suffix of ["a", "b", "c"])
			writeFileSync(join(corpus, `zz-${suffix}.md`), "# Late subject\nlatewindowtoken\n");
		const query = "latewindowtoken";
		const empty = details(await invoke("memory_search", { query, limit: 1 }));
		assert.deepEqual(empty.notes, []);
		assert.equal((empty.scan as JsonObject).windowEnd, 4096);
		assert.equal(typeof empty.nextCursor, "string");
		const next = details(await invoke("memory_search", { query, limit: 1, cursor: empty.nextCursor }));
		assert.equal((next.notes as JsonObject[]).length, 1);
		assert.equal((next.coverage as JsonObject).frozenSnapshot, false);
		const slugs = (next.notes as JsonObject[]).map((note) => note.slug);
		let cursor = next.nextCursor;
		for (let guard = 0; cursor && guard < 5; guard++) {
			const page = details(await invoke("memory_search", { query, limit: 1, cursor }));
			slugs.push(...(page.notes as JsonObject[]).map((note) => note.slug));
			cursor = page.nextCursor;
		}
		assert.deepEqual(slugs, ["zz-a", "zz-b", "zz-c"]);
		const combined = scriptValue(
			await invoke("codemode", {
				code: `
let cursor;
const notes = [], windows = [];
for (let guard = 0; guard < 8; guard++) {
  const page = await tools.memory_search({ query: "latewindowtoken", limit: 1, ...(cursor ? {cursor} : {}) });
  if (typeof page !== "object") throw new Error("Expected a structured page");
  notes.push(...page.notes.map(note => ({slug: note.slug, digest: note.digest, status: note.lifecycle.status})));
  windows.push({returned: page.returned, end: page.scan.windowEnd, complete: page.coverage.traversalComplete});
  cursor = page.nextCursor;
  if (cursor === null) break;
}
if (cursor !== null) throw new Error("Fixture page limit reached");
return {notes, windows};`,
			}),
		);
		assert.deepEqual(
			(combined.notes as JsonObject[]).map((note) => note.slug),
			slugs,
		);
		for (const note of combined.notes as JsonObject[]) {
			digest(note.digest);
			assert.equal(note.status, "unknown");
		}
		assert.equal((combined.windows as JsonObject[])[0].returned, 0);
		assert.equal((combined.windows as JsonObject[])[0].end, 4096);
		assert.equal((combined.windows as JsonObject[])[0].complete, false);
		assert.equal((combined.windows as JsonObject[]).at(-1)?.complete, true);
		assert.equal((await invoke("memory_search", { query: "changedquery", cursor: next.nextCursor })).isError, true);
		writeFileSync(join(corpus, "zz-b.md"), "# Changed source\nlatewindowtoken\n");
		assert.match(text(await invoke("memory_search", { query, cursor: next.nextCursor })), /Source window changed/);
		writeFileSync(join(corpus, "zz-d.md"), "# Inventory change\n");
		assert.match(text(await invoke("memory_search", { query, cursor: empty.nextCursor })), /inventory changed/);
		assert.deepEqual(errors, []);
	} finally {
		if (session) {
			await session.abort();
			session.dispose();
		}
		if (previousRoot === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});
