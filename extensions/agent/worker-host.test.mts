import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type ImageContent,
	InMemoryCredentialStore,
	type Model,
	type ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import {
	type BashOperations,
	type BeforeProviderHeadersEvent,
	createExtensionRuntime,
	createLocalBashOperations,
	createSyntheticSourceInfo,
	DEFAULT_MAX_BYTES,
	type Extension,
	ExtensionRunner,
	type InputEvent,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	truncateTail,
	type UserBashEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createWorkerModels,
	createWorkerPromptObserver,
	executeWorkerBash,
	expandWorkerInput,
	normalizeWorkerUserContent,
	prepareWorkerInput,
	prepareWorkerQueuedInput,
	type WorkerInputResources,
} from "./worker-host.ts";

const model: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "worker-host-test",
	id: "model",
	name: "Model",
	baseUrl: "http://invalid.test",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	headers: { "x-model": "model" },
};
const response: AssistantMessage = {
	role: "assistant",
	content: [],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

type TestEvent = Pick<InputEvent, "text" | "source" | "streamingBehavior"> &
	Pick<BeforeProviderHeadersEvent, "headers"> &
	Pick<UserBashEvent, "command" | "cwd" | "excludeFromContext"> & { status: number };

async function fixture(callbacks: Map<string, Array<(event: TestEvent) => unknown>> = new Map(), allowErrors = false) {
	const handlers: Extension["handlers"] = new Map(
		[...callbacks].map(([name, group]) => [
			name,
			group.map((callback) => async (event: unknown) => callback(event as TestEvent)),
		]),
	);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const sourceInfo = createSyntheticSourceInfo("<worker-host-test>", { source: "test" });
	const extension: Extension = {
		path: sourceInfo.path,
		resolvedPath: sourceInfo.path,
		sourceInfo,
		handlers,
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const runner = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		process.cwd(),
		SessionManager.inMemory(process.cwd()),
		new ModelRegistry(runtime),
	);
	if (!allowErrors)
		runner.onError((error) => assert.fail(`Unexpected extension error: ${error.event}: ${error.error}`));
	return { runtime, runner, extension };
}

const resources: WorkerInputResources = {
	skills: [],
	promptTemplates: [
		{
			name: "review",
			description: "Review",
			content: `$1|$2|$@|\${3:-default}`,
			filePath: "<review>",
			sourceInfo: createSyntheticSourceInfo("<review>", { source: "test" }),
		},
	],
};

describe("ordinary worker input", () => {
	it("dispatches raw extension commands before input, including busy sessions", async () => {
		const { runner, extension } = await fixture(
			new Map([
				[
					"input",
					[
						() => {
							throw new Error("input must not run");
						},
					],
				],
			]),
		);
		extension.commands.set("review", { name: "review", sourceInfo: extension.sourceInfo, handler: async () => {} });
		let command = "";
		const result = await prepareWorkerInput(
			runner,
			{ text: "/review file", streaming: true },
			resources,
			async (text) => {
				command = text;
			},
		);
		assert.deepEqual(result, { kind: "handled" });
		assert.equal(command, "/review file");
	});

	it("chains input transforms before expansion and preserves image sources", async () => {
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const seen: string[] = [];
		const { runner } = await fixture(
			new Map([
				[
					"input",
					[
						(event) => {
							seen.push(event.text);
							assert.equal(event.source, "rpc");
							assert.equal(event.streamingBehavior, "steer");
							return { action: "transform", text: '/review "two words" end', images: [image] };
						},
						(event) => {
							seen.push(event.text);
							return { action: "continue" };
						},
					],
				],
			]),
		);
		const result = await prepareWorkerInput(
			runner,
			{ text: "raw", source: "rpc", streaming: true, streamingBehavior: "steer" },
			resources,
			async () => {
				assert.fail("command");
			},
		);
		assert.deepEqual(seen, ["raw", '/review "two words" end']);
		assert.deepEqual(result, {
			kind: "prompt",
			text: "two words|end|two words end|default",
			images: [image],
			streamingBehavior: "steer",
		});
	});

	it("lets input handlers finish a busy prompt without queue metadata", async () => {
		const { runner } = await fixture(new Map([["input", [() => ({ action: "handled" })]]]));
		assert.deepEqual(await prepareWorkerInput(runner, { text: "ping", streaming: true }, resources, async () => {}), {
			kind: "handled",
		});
	});

	it("requires delivery while busy and omits delivery while idle", async () => {
		const { runner } = await fixture(
			new Map([
				[
					"input",
					[
						(event) => {
							assert.equal(event.streamingBehavior, undefined);
						},
					],
				],
			]),
		);
		await assert.rejects(
			prepareWorkerInput(runner, { text: "hello", streaming: true }, resources, async () => {}),
			/Specify streamingBehavior/u,
		);
		assert.deepEqual(
			await prepareWorkerInput(
				runner,
				{ text: "hello", streaming: false, streamingBehavior: "followUp" },
				resources,
				async () => {},
			),
			{ kind: "prompt", text: "hello" },
		);
	});

	it("does not yield before expansion and activity checks when no input handler exists", async () => {
		const { runner } = await fixture();
		const order: string[] = [];
		let streaming = false;
		const prepared = prepareWorkerInput(runner, {
			text: "/review file", streaming: () => { order.push("activity"); return streaming; }, streamingBehavior: "steer",
		}, resources, async () => assert.fail("command"));
		assert.deepEqual(order, ["activity"]);
		streaming = true;
		assert.deepEqual(await prepared, { kind: "prompt", text: "file||file|default" });
	});

	it("continues at the input dispatch promise without an extra async boundary", async () => {
		const { runner } = await fixture(new Map([["input", [() => ({ action: "continue" })]]]));
		const dispatched = Promise.resolve({ action: "continue" as const });
		runner.emitInput = () => dispatched;
		let streaming = false;
		const prepared = prepareWorkerInput(runner, { text: "hello", streaming: () => streaming, streamingBehavior: "steer" }, resources, async () => {});
		void dispatched.then(() => { streaming = true; });
		assert.deepEqual(await prepared, { kind: "prompt", text: "hello" });
	});

	it("rechecks live activity after asynchronous input handlers", async () => {
		let streaming = false;
		const { runner } = await fixture(
			new Map([
				[
					"input",
					[
						async (event) => {
							assert.equal(event.streamingBehavior, undefined);
							await Promise.resolve();
							streaming = true;
						},
					],
				],
			]),
		);
		assert.deepEqual(
			await prepareWorkerInput(
				runner,
				{ text: "later", streaming: () => streaming, streamingBehavior: "followUp" },
				resources,
				async () => {},
			),
			{ kind: "prompt", text: "later", streamingBehavior: "followUp" },
		);
	});

	it("keeps extension input literal when expansion is disabled, but still emits input", async () => {
		const { runner, extension } = await fixture(
			new Map([
				[
					"input",
					[
						(event) => {
							assert.equal(event.source, "extension");
							return { action: "continue" };
						},
					],
				],
			]),
		);
		extension.commands.set("review", { name: "review", sourceInfo: extension.sourceInfo, handler: async () => {} });
		const result = await prepareWorkerInput(
			runner,
			{ text: "/review file", source: "extension", expandPromptTemplates: false, streaming: false },
			resources,
			async () => {
				assert.fail("command");
			},
		);
		assert.deepEqual(result, { kind: "prompt", text: "/review file" });
	});

	it("expands direct queues without input and rejects extension commands", async () => {
		const { runner, extension } = await fixture(new Map([["input", [() => assert.fail("input")]]]));
		assert.equal(prepareWorkerQueuedInput(runner, { text: "/review first" }, resources).text, "first||first|default");
		extension.commands.set("review", { name: "review", sourceInfo: extension.sourceInfo, handler: async () => {} });
		assert.throws(() => prepareWorkerQueuedInput(runner, { text: "/review first" }, resources), /cannot be queued/u);
	});

	it("supports defaults, slices, whitespace, and one-pass literal argument substitution", async () => {
		const { runner } = await fixture();
		const custom: WorkerInputResources = {
			skills: [],
			promptTemplates: [
				{
					...resources.promptTemplates[0],
					content: `$1|$2|\${@:2:1}|\${@:0}|\${@:-empty}|\${ARGUMENTS:-all}|\${9:-$1}|\${1}|$99`,
				},
			],
		};
		assert.equal(
			expandWorkerInput('/review "$@"\nsecond', custom, runner),
			`$@|second|second|$@ second|$@ second|$@ second|$1|\${1}|`,
		);
		assert.equal(expandWorkerInput("/review", custom, runner), `||||empty|all|$1|\${1}|`);
		assert.equal(expandWorkerInput("/unknown value", custom, runner), "/unknown value");
	});

	it("reads skills at invocation, removes frontmatter, and reports read errors", async () => {
		const root = mkdtempSync(join(tmpdir(), "worker-host-skill-"));
		try {
			const filePath = join(root, "SKILL.md");
			writeFileSync(filePath, "---\nname: sample\n---\n\nSkill body.\n");
			const { runner } = await fixture(new Map(), true);
			const skillResources: WorkerInputResources = {
				promptTemplates: [],
				skills: [
					{
						name: "sample",
						description: "Sample",
						filePath,
						baseDir: root,
						disableModelInvocation: false,
						sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					},
				],
			};
			assert.equal(
				expandWorkerInput("/skill:sample extra", skillResources, runner),
				`<skill name="sample" location="${filePath}">\nReferences are relative to ${root}.\n\nSkill body.\n</skill>\n\nextra`,
			);
			rmSync(filePath);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.event));
			assert.equal(expandWorkerInput("/skill:sample extra", skillResources, runner), "/skill:sample extra");
			assert.deepEqual(errors, ["skill_expansion"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("normalizes user text and current image content without loss", () => {
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		assert.deepEqual(normalizeWorkerUserContent([{ type: "text", text: "a" }, image, { type: "text", text: "b" }]), {
			text: "a\nb",
			images: [image],
		});
		assert.deepEqual(normalizeWorkerUserContent([{ type: "text", text: "a" }]), { text: "a" });
		assert.deepEqual(normalizeWorkerUserContent("a"), { text: "a" });
	});
});

describe("worker Models facade", () => {
	it("adapts every request method after auth and before body consumption without changing the shared runtime", async () => {
		const order: string[] = [];
		const captured: ProviderRequestOptions[] = [];
		const { runtime, runner } = await fixture(
			new Map([
				[
					"before_provider_headers",
					[
						(event) => {
							order.push("headers");
							assert.equal(event.headers["x-model"], "model");
							assert.equal(event.headers["x-auth"], "auth");
							assert.equal(event.headers["x-caller"], "caller");
							event.headers["x-worker"] = "worker";
							event.headers["x-remove"] = null;
						},
					],
				],
				[
					"after_provider_response",
					[
						async (event) => {
							assert.equal(event.status, 201);
							await Promise.resolve();
							order.push("extension-response");
						},
					],
				],
			]),
		);
		async function prepare(options: ProviderRequestOptions = {}) {
			captured.push(options);
			assert.equal(options.headers?.["x-worker"], "worker");
			assert.equal(options.headers?.["x-remove"], null);
			assert.equal(options.timeoutMs, 321);
			assert.equal(options.signal, signal);
			await options.onPayload?.({ value: "payload" }, model);
			await options.onResponse?.({ status: 201, headers: { "x-result": "ok" } }, model);
			order.push("body");
		}
		const stream = (_model: Model<Api>, _context: Context, options?: ProviderRequestOptions) => {
			assert.equal(_model.baseUrl, "http://resolved.invalid.test");
			const output = createAssistantMessageEventStream();
			void prepare(options)
				.then(() => {
					output.push({ type: "start", partial: response });
					output.push({ type: "done", reason: "stop", message: response });
					output.end(response);
				})
				.catch((error) => {
					const failed = { ...response, stopReason: "error" as const, errorMessage: String(error) };
					output.push({ type: "error", reason: "error", error: failed });
					output.end(failed);
				});
			return output;
		};
		runtime.registerNativeProvider({
			id: model.provider,
			name: "Test",
			getModels: () => [model],
			auth: {
				apiKey: {
					name: "Keyless test",
					check: async () => ({ type: "api_key" }),
					resolve: async () => ({
						auth: { baseUrl: "http://resolved.invalid.test", headers: { "x-auth": "auth", "x-remove": "remove" } },
					}),
				},
			},
			stream,
			streamSimple: stream,
			fetchDeferred: (_model, _handle, options) => stream(_model, { messages: [] }, options),
			cancelDeferred: async (_model, _handle, options) => {
				await prepare(options);
			},
		});
		const original = runtime.streamSimple;
		const facade = createWorkerModels(runtime, () => runner);
		const signal = new AbortController().signal;
		const options = {
			signal,
			timeoutMs: 321,
			transformHeaders: (headers: Record<string, string | null>) => {
				order.push("caller-headers");
				return { ...headers, "x-caller": "caller" };
			},
			onPayload: async () => {
				order.push("payload");
			},
			onResponse: async () => {
				order.push("caller-response");
			},
		};
		const handle = { id: "deferred", api: model.api, provider: model.provider, modelId: model.id };
		const calls = [
			() => facade.stream(model, { messages: [] }, options).result(),
			() => facade.complete(model, { messages: [] }, options),
			() => facade.streamSimple(model, { messages: [] }, options).result(),
			() => facade.completeSimple(model, { messages: [] }, options),
			() => facade.streamDeferred(model, handle, options).result(),
			() => facade.fetchDeferred(model, handle, options),
			() => facade.cancelDeferred(model, handle, options),
		];
		for (const call of calls) {
			order.length = 0;
			const result = await call();
			if (result) assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.deepEqual(order, [
				"caller-headers",
				"headers",
				"payload",
				"caller-response",
				"extension-response",
				"body",
			]);
		}
		assert.equal(captured.length, calls.length);
		assert.equal(runtime.streamSimple, original);
		assert.equal(facade.getModel(model.provider, model.id)?.id, model.id);
		assert.ok(facade.getProvider(model.provider));
		assert.equal((await facade.getAuth(model))?.auth.baseUrl, "http://resolved.invalid.test");
	});

	it("resolves the current runner for each hook and passes absent hooks through", async () => {
		const { runtime, runner } = await fixture();
		let current: ExtensionRunner | undefined;
		runtime.registerNativeProvider({
			id: model.provider,
			name: "Test",
			getModels: () => [model],
			auth: {
				apiKey: { name: "Keyless", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) },
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: (_model, _context, options) => {
				assert.equal(options?.headers?.["x-model"], "model");
				const output = createAssistantMessageEventStream();
				void options?.onResponse?.({ status: 200, headers: {} }, model);
				output.push({ type: "start", partial: response });
				output.push({ type: "done", reason: "stop", message: response });
				output.end(response);
				return output;
			},
		});
		const facade = createWorkerModels(runtime, () => current);
		assert.equal((await facade.completeSimple(model, { messages: [] })).stopReason, "stop");
		current = runner;
		assert.equal((await facade.completeSimple(model, { messages: [] })).stopReason, "stop");
	});
});

describe("worker prompt options", () => {
	it("reads upstream rendering after chained structured mutations and forced replacements", async () => {
		const { runtime, extension } = await fixture();
		const observer = createWorkerPromptObserver();
		extension.handlers.set("before_agent_start", [async (event) => {
			const prompt = event as import("@earendil-works/pi-coding-agent").BeforeAgentStartEvent;
			prompt.systemPromptOptions.sections.rules = "STRUCTURED_MARKER";
			prompt.systemPromptOptions.selectedTools = ["read"];
		}]);
		const runner = new ExtensionRunner([observer.extension, extension], createExtensionRuntime(), process.cwd(), SessionManager.inMemory(), new ModelRegistry(runtime));
		const result = await runner.emitBeforeAgentStart("task", undefined, { cwd: process.cwd(), customPrompt: "BASE_MARKER" });
		assert.match(observer.read(), /BASE_MARKER/u);
		assert.match(observer.read(), /STRUCTURED_MARKER/u);
		assert.deepEqual(result.systemPromptOptions.selectedTools, ["read"]);
		result.systemPromptOptions.forceSystemPrompt = "EXACT_MARKER";
		assert.equal(observer.read(), "EXACT_MARKER");
		await runner.emitBeforeAgentStart("next", undefined, { cwd: process.cwd(), customPrompt: "NEXT_MARKER" });
		assert.match(observer.read(), /NEXT_MARKER/u);
		assert.doesNotMatch(observer.read(), /EXACT_MARKER/u);
	});
});

describe("worker user bash", () => {
	it("refuses thrown and invalid user bash hooks without local execution", async () => {
		for (const handler of [() => { throw new Error("hook refused"); }, () => ({ operations: { exec: async () => assert.fail("backend") }, result: { output: "invalid", exitCode: 0, cancelled: false, truncated: false } })]) {
			const { runner } = await fixture(new Map([["user_bash", [handler]]]), true);
			await assert.rejects(executeWorkerBash({ runner, cwd: process.cwd(), command: "unused", excludeFromContext: false, signal: new AbortController().signal, shellPath: "/missing-shell", outputDirectory: "/unused" }), /hook refused|Invalid user_bash/u);
		}
	});
	it("records complete override results without a backend call", async () => {
		const root = mkdtempSync(join(tmpdir(), "worker-bash-"));
		try {
			const { runner } = await fixture(
				new Map([
					[
						"user_bash",
						[
							(event) => {
								assert.equal(event.command, "original");
								assert.equal(event.cwd, root);
								assert.equal(event.excludeFromContext, true);
								return {
									result: {
										output: "replacement",
										exitCode: 7,
										cancelled: false,
										truncated: true,
										fullOutputPath: "provided.log",
										command: "wrong",
										role: "user",
									},
								};
							},
						],
					],
				]),
			);
			const result = await executeWorkerBash({
				runner,
				cwd: root,
				command: "original",
				excludeFromContext: true,
				signal: new AbortController().signal,
				shellPath: "/missing-shell",
				outputDirectory: join(root, "output"),
			});
			assert.equal(result.role, "bashExecution");
			assert.equal(result.command, "original");
			assert.equal(result.output, "replacement");
			assert.equal(result.exitCode, 7);
			assert.equal(result.truncated, true);
			assert.equal(result.fullOutputPath, "provided.log");
			assert.equal(result.excludeFromContext, true);
			assert.equal(existsSync(join(root, "output")), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses extension operations with prefix, streaming cleanup, exit code, and signal", async () => {
		const root = mkdtempSync(join(tmpdir(), "worker-bash-"));
		try {
			const controller = new AbortController();
			const operations: BashOperations = {
				exec: async (command, cwd, options) => {
					assert.equal(command, "prefix\noriginal");
					assert.equal(cwd, root);
					assert.equal(options.signal, controller.signal);
					options.onData(Buffer.from("\u001b[31mred\u001b[0m\r\n\u0000ok\t"));
					const bytes = Buffer.from("😀");
					options.onData(bytes.subarray(0, 2));
					options.onData(bytes.subarray(2));
					return { exitCode: 4 };
				},
			};
			const { runner } = await fixture(new Map([["user_bash", [() => ({ operations })]]]));
			const result = await executeWorkerBash({
				runner,
				cwd: root,
				command: "original",
				commandPrefix: "prefix",
				excludeFromContext: false,
				signal: controller.signal,
				outputDirectory: join(root, "output"),
			});
			assert.equal(result.output, "red\nok\t😀");
			assert.equal(result.exitCode, 4);
			assert.equal(result.cancelled, false);
			assert.equal(result.truncated, false);
			assert.equal(result.fullOutputPath, undefined);
			assert.equal(result.command, "original");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("caps large output and closes its private complete artifact before return", async () => {
		const root = mkdtempSync(join(tmpdir(), "worker-bash-"));
		try {
			const text = `first\n${"abcd\n".repeat(DEFAULT_MAX_BYTES)}last\n`;
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from(text.slice(0, 12)));
					options.onData(Buffer.from(text.slice(12)));
					return { exitCode: 0 };
				},
			};
			const { runner } = await fixture(new Map([["user_bash", [() => ({ operations })]]]));
			const result = await executeWorkerBash({
				runner,
				cwd: root,
				command: "output",
				excludeFromContext: false,
				signal: new AbortController().signal,
				outputDirectory: join(root, "output"),
			});
			assert.equal(result.truncated, true);
			assert.ok(Buffer.byteLength(result.output) <= DEFAULT_MAX_BYTES);
			assert.equal(result.output, truncateTail(text).content);
			assert.ok(result.fullOutputPath);
			assert.equal(readFileSync(result.fullOutputPath, "utf8"), text);
			assert.equal(statSync(result.fullOutputPath).mode & 0o777, 0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains a full artifact for line-only truncation", async () => {
		const root = mkdtempSync(join(tmpdir(), "worker-bash-"));
		try {
			const text = "x\n".repeat(2200);
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from(text));
					return { exitCode: null };
				},
			};
			const { runner } = await fixture(new Map([["user_bash", [() => ({ operations })]]]));
			const result = await executeWorkerBash({
				runner,
				cwd: root,
				command: "lines",
				excludeFromContext: false,
				signal: new AbortController().signal,
				outputDirectory: root,
			});
			assert.equal(result.truncated, true);
			assert.equal(result.exitCode, undefined);
			assert.ok(result.fullOutputPath);
			assert.equal(readFileSync(result.fullOutputPath, "utf8"), text);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not start operations with an already aborted signal", async () => {
		const { runner } = await fixture(
			new Map([["user_bash", [() => ({ operations: { exec: async () => assert.fail("backend") } })]]]),
		);
		const controller = new AbortController();
		controller.abort();
		const result = await executeWorkerBash({
			runner,
			cwd: process.cwd(),
			command: "unused",
			excludeFromContext: false,
			signal: controller.signal,
			outputDirectory: process.cwd(),
		});
		assert.equal(result.cancelled, true);
		assert.equal(result.output, "");
		assert.equal(result.exitCode, undefined);
	});

	it("aborts a real shell process through the public backend", { timeout: 4000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "worker-bash-"));
		const controller = new AbortController();
		let pid: number | undefined;
		try {
			const backend = createLocalBashOperations();
			const operations: BashOperations = {
				exec: (command, cwd, options) => backend.exec(command, cwd, {
					...options,
					onData: (data) => {
						options.onData(data);
						pid = Number(data.toString().trim());
						controller.abort();
					},
				}),
			};
			const { runner } = await fixture(new Map([["user_bash", [() => ({ operations })]]]));
			const result = await executeWorkerBash({
				runner,
				cwd: root,
				command: "printf '%s\\n' \"$$\"; exec sleep 30",
				excludeFromContext: false,
				signal: controller.signal,
				outputDirectory: root,
			});
			assert.equal(result.cancelled, true);
			assert.equal(result.exitCode, undefined);
			assert.ok(pid && pid > 0);
			assert.throws(() => process.kill(pid as number, 0), { code: "ESRCH" });
		} finally {
			controller.abort();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
