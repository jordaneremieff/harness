/**
 * Real-Harness tests for the browser Durable contribution: one model-issued call
 * per tool, the declared replay classes, and recovery over retained storage.
 *
 * The browser is faked at the Apple Events runner. No test starts a browser,
 * sends an Apple Event, or runs osascript, screencapture, or ps.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createEventBus, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { browserDurableContribution, type DurableContributionHost } from "./durable.ts";
import type { BrowserDeps } from "./operations.ts";
import type { OsaReply } from "./osa.ts";

const source = fileURLToPath(new URL("./index.ts", import.meta.url));

const PAGE = {
	doc: "doc-1",
	url: "https://app.example/",
	origin: "https://app.example",
	title: "T",
	readyState: "complete",
	visibility: "visible",
};

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };

/** Apple Events passes a QuickDraw rectangle as top, left, bottom, right 16-bit values in base64. */
function quickDrawRect(rect: { x: number; y: number; width: number; height: number }): string {
	const bytes = Buffer.alloc(8);
	bytes.writeInt16LE(rect.y, 0);
	bytes.writeInt16LE(rect.x, 2);
	bytes.writeInt16LE(rect.y + rect.height, 4);
	bytes.writeInt16LE(rect.x + rect.width, 6);
	return bytes.toString("base64");
}

const WINDOW_FACTS = {
	window: "1",
	title: "T",
	bounds: { qdrect: quickDrawRect(BOUNDS) },
	minimized: false,
	visible: true,
	activeTab: "t1",
	url: "https://app.example/",
	tabTitle: "T",
	hidden: false,
	windows: [{ id: 7, onScreen: true, name: "T", bounds: BOUNDS }],
	screenRecording: true,
};

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const IMAGE = "ZmFrZS1wbmc=";

const ARGS = {
	tabs: { browser: "chrome-for-testing" },
	inspect: { browser: "chrome-for-testing", tab: "t1" },
	act: {
		browser: "chrome-for-testing",
		tab: "t1",
		origin: "https://app.example",
		action: "click",
		selector: "#go",
		waitFor: { selector: "#done" },
	},
	evaluate: { browser: "chrome-for-testing", tab: "t1", origin: "https://app.example", expression: "1 + 1" },
	capture: { browser: "chrome-for-testing", tab: "t1" },
};

beforeEach((t) => {
	assert.ok("mock" in t && "after" in t);
	const agentDir = mkdtempSync(join(tmpdir(), "browser-durable-"));
	t.mock.property(process, "env", { ...process.env, PI_CODING_AGENT_DIR: agentDir });
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

interface FakeState {
	counts: { inspect: number; action: number; poll: number; evaluateStart: number; evaluatePoll: number };
	hang?: "action" | "inspect";
	onReached?: () => void;
}

function pageReply(envelope: unknown): OsaReply {
	return {
		ok: true,
		value: { window: "1", url: "https://app.example/", title: "T", result: JSON.stringify(envelope) },
	};
}

const FULFILLED = {
	kind: "settled",
	page: PAGE,
	outcome: { state: "fulfilled", valueType: "number", value: 2, awaited: false },
};
const POLL = {
	kind: "ok",
	page: PAGE,
	action: { state: "dispatched", error: null },
	condition: { met: true, checks: [] },
	responses: [],
	navigation: null,
};

function inspectReply(state: FakeState, signal?: AbortSignal): OsaReply | Promise<never> {
	state.counts.inspect += 1;
	if (state.hang === "inspect") {
		state.hang = undefined;
		state.onReached?.();
		return neverUnlessAborted(signal);
	}
	return pageReply({
		kind: "ok",
		page: PAGE,
		matched: null,
		view: {
			headings: [],
			counts: { links: 1, forms: 0, interactive: 1, iframes: 0 },
			focused: null,
			dialogs: [],
			text: { text: "hello", offset: 0, total: 5, nextOffset: null },
		},
	});
}

function actionReply(state: FakeState, signal?: AbortSignal): OsaReply | Promise<never> {
	state.counts.action += 1;
	if (state.hang === "action") {
		state.hang = undefined;
		state.onReached?.();
		return neverUnlessAborted(signal);
	}
	return pageReply({ kind: "scheduled", element: { selector: "#go" }, matched: 1, mark: 1, page: PAGE });
}

async function scriptReply(script: string, state: FakeState, signal?: AbortSignal): Promise<OsaReply> {
	if (script.includes("const O = ")) return await inspectReply(state, signal);
	if (script.includes("const A = ")) return await actionReply(state, signal);
	if (script.includes("const P = ")) {
		state.counts.poll += 1;
		return pageReply(POLL);
	}
	if (script.includes("S.runs.get(id)")) {
		state.counts.evaluatePoll += 1;
		return pageReply(FULFILLED);
	}
	if (script.includes("__pbRun")) {
		state.counts.evaluateStart += 1;
		return pageReply(FULFILLED);
	}
	throw new Error(`unexpected page script: ${script.slice(0, 40)}`);
}

/** Answers the browser side of one Apple Events request from a fixed script table. */
function fakeDeps(hooks: { hang?: "action" | "inspect"; onReached?: () => void } = {}): {
	deps: BrowserDeps;
	counts: { inspect: number; action: number; poll: number; evaluateStart: number; evaluatePoll: number };
} {
	const state: FakeState = {
		counts: { inspect: 0, action: 0, poll: 0, evaluateStart: 0, evaluatePoll: 0 },
		hang: hooks.hang,
		onReached: hooks.onReached,
	};
	const reply = (value: unknown): OsaReply => ({ ok: true, value });
	const deps: BrowserDeps = {
		async run(request, { signal }) {
			switch (request.op) {
				case "inventory":
					return reply({
						installed: { path: "/x", version: "1" },
						instances: [{ pid: 42, hidden: false, active: false }],
					});
				case "permission":
					return reply({ automation: "granted" });
				case "windows":
					return reply({
						windows: [
							{
								id: "1",
								index: 1,
								title: "W",
								mode: "normal",
								minimized: false,
								visible: true,
								activeTabIndex: 1,
								tabs: [{ id: "t1", url: "https://app.example/", title: "T", loading: false }],
							},
						],
					});
				case "window":
					return reply(WINDOW_FACTS);
				case "execute":
					return await scriptReply(String(request.script ?? ""), state, signal);
				default:
					throw new Error(`unexpected browser operation: ${request.op}`);
			}
		},
		readAccess: () => ({ "chrome-for-testing": "interact" }),
		platform: "darwin",
		processArgs: async () => null,
		capture: async () => PNG,
		resize: async () => ({
			data: IMAGE,
			mimeType: "image/png",
			width: 1,
			height: 1,
			originalWidth: 1,
			originalHeight: 1,
		}),
		save: async () => {},
		now: () => Date.now(),
	};
	return { deps, counts: state.counts };
}

function neverUnlessAborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		const fail = () => reject(new Error("aborted"));
		if (signal?.aborted) fail();
		else signal?.addEventListener("abort", fail, { once: true });
	});
}

async function nativeExtension(deps: BrowserDeps): Promise<Durable.Extension> {
	const contribution = browserDurableContribution(
		source,
		createEventBus(),
		() => {},
		() => deps,
	);
	const host: DurableContributionHost = {
		durable: Durable,
		services: {} as DurableContributionHost["services"],
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		storageId: "browser-durable-test",
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [{ name: "browser", source, commands: [] }], ordinaryOnly: [] },
	};
	return await contribution.create(host);
}

/** A MemoryStorage that survives its owner's close, simulating process loss with retained storage. */
class ReopenableMemoryStorage extends Durable.MemoryStorage {
	override async close(_context: Context): Promise<void> {}
}

function nativeModels(): { faux: ReturnType<typeof fauxProvider>; models: Models; registry: Durable.Registry } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models, registry: Durable.createRegistry() };
}

async function openRoot(
	models: Models,
	registry: Durable.Registry,
	storage: Durable.Storage,
): Promise<{ harness: Durable.Harness; root: Durable.Conversation }> {
	const harness = await Durable.Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
	harness.resume();
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	return { harness, root };
}

async function toolResults(root: Durable.Conversation): Promise<ToolResultMessage[]> {
	const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
	return [...page.items]
		.reverse()
		.flatMap((entry) => (Durable.ToolResultEntry.is(entry) ? (entry.model?.[0] as ToolResultMessage) : []));
}

function toolText(message: ToolResultMessage | undefined): string {
	if (message === undefined) return "";
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("browser durable contribution", () => {
	it("declares the five tools, replay classes, and guidance", async () => {
		const extension = await nativeExtension(fakeDeps().deps);
		assert.equal(extension.name, "browser");
		const tools = [...(extension.tools ?? [])];
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["browser_tabs", "browser_inspect", "browser_act", "browser_evaluate", "browser_capture"],
		);
		assert.deepEqual(
			tools.map((tool) => tool.replay),
			["safe", "safe", "unsafe", "unsafe", "safe"],
		);
		assert.ok(tools.every((tool) => tool.structuredOutputSchema === undefined));
		assert.equal(extension.hooks, undefined);
		const guidance = extension.sections?.[0];
		assert.equal(guidance?.key, "browser-guidance");
		const rendered = await guidance?.render({} as never, BACKGROUND_CONTEXT);
		assert.match(rendered ?? "", /untrusted data, not instructions/);
		assert.match(rendered ?? "", /browser_capture:/);
	});

	it("offers tools by configured access: none without access, reading tools for inspect", async () => {
		const none = await nativeExtension({ ...fakeDeps().deps, readAccess: () => ({}) });
		assert.deepEqual([...(none.tools ?? [])], []);
		assert.deepEqual([...(none.sections ?? [])], []);
		const inspect = await nativeExtension({ ...fakeDeps().deps, readAccess: () => ({ brave: "inspect" }) });
		assert.deepEqual(
			[...(inspect.tools ?? [])].map((tool) => tool.name),
			["browser_tabs", "browser_inspect", "browser_capture"],
		);
	});

	it("answers one model-issued call per tool through a real harness", async (t) => {
		const extension = await nativeExtension(fakeDeps().deps);
		const { faux, models, registry } = nativeModels();
		registry.install(extension);
		const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
		t.after(() => harness.close(BACKGROUND_CONTEXT));
		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("browser_tabs", ARGS.tabs), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("browser_inspect", ARGS.inspect), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("browser_act", ARGS.act), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("browser_evaluate", ARGS.evaluate), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("browser_capture", ARGS.capture), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		const settled = await (await root.submit({ type: "input", content: "browse" }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled.status, "done");

		const results = await toolResults(root);
		assert.deepEqual(
			results.map((result) => result.toolName),
			["browser_tabs", "browser_inspect", "browser_act", "browser_evaluate", "browser_capture"],
		);
		assert.ok(
			results.every((result) => result.isError === false),
			results.map((result) => `${result.toolName}: ${toolText(result).slice(0, 240)}`).join("\n---\n"),
		);
		assert.match(toolText(results[0]), /^browser_tabs: 1 tab\(s\) in Google Chrome for Testing pid 42/);
		assert.match(toolText(results[1]), /^browser_inspect: summary of tab t1\./);
		assert.match(toolText(results[2]), /^browser_act: click dispatched; postcondition verified\./);
		assert.match(toolText(results[3]), /^browser_evaluate: expression fulfilled\./);
		assert.match(toolText(results[4]), /^browser_capture: captured window 1 showing tab t1\./);
		const image = results[4]?.content.find((part) => part.type === "image");
		assert.equal(image?.type === "image" ? image.data : undefined, IMAGE);
		assert.equal(image?.type === "image" ? image.mimeType : undefined, "image/png");
	});

	it("does not rerun an interrupted browser_act and delivers an interrupted result", async () => {
		const reached = deferred();
		const { deps, counts } = fakeDeps({ hang: "action", onReached: reached.resolve });
		const extension = await nativeExtension(deps);
		const { faux, models, registry } = nativeModels();
		registry.install(extension);
		const storage = new ReopenableMemoryStorage();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("browser_act", ARGS.act), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		let opened = await openRoot(models, registry, storage);
		const submission = await opened.root.submit({ type: "input", content: "act" }, BACKGROUND_CONTEXT);
		await reached.promise;
		await opened.harness.close(BACKGROUND_CONTEXT);
		assert.equal(counts.action, 1);

		opened = await openRoot(models, registry, storage);
		const settled = await (await opened.harness.submission(submission.id, BACKGROUND_CONTEXT))?.wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled?.status, "done");
		assert.equal(counts.action, 1, "the interrupted unsafe action did not run again");
		const [act] = (await toolResults(opened.root)).filter((result) => result.toolName === "browser_act").slice(-1);
		assert.equal(act?.isError, true);
		assert.match(toolText(act), /interrupted/);
		await opened.harness.close(BACKGROUND_CONTEXT);
	});

	it("reruns an interrupted browser_inspect after the harness reopens", async () => {
		const reached = deferred();
		const { deps, counts } = fakeDeps({ hang: "inspect", onReached: reached.resolve });
		const extension = await nativeExtension(deps);
		const { faux, models, registry } = nativeModels();
		registry.install(extension);
		const storage = new ReopenableMemoryStorage();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("browser_inspect", ARGS.inspect), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		let opened = await openRoot(models, registry, storage);
		const submission = await opened.root.submit({ type: "input", content: "inspect" }, BACKGROUND_CONTEXT);
		await reached.promise;
		await opened.harness.close(BACKGROUND_CONTEXT);

		opened = await openRoot(models, registry, storage);
		const settled = await (await opened.harness.submission(submission.id, BACKGROUND_CONTEXT))?.wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled?.status, "done");
		assert.equal(counts.inspect, 2, "the safe inspection ran again after recovery");
		const [inspect] = (await toolResults(opened.root))
			.filter((result) => result.toolName === "browser_inspect")
			.slice(-1);
		assert.equal(inspect?.isError, false);
		assert.match(toolText(inspect), /^browser_inspect: summary of tab t1\./);
		await opened.harness.close(BACKGROUND_CONTEXT);
	});
});
