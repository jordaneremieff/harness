import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ImageContent,
	Context as ProviderContext,
	Models,
	ModelsRequestTransforms,
	ProviderRequestOptions,
	TextContent,
} from "@earendil-works/pi-ai";
import {
	createLocalBashOperations,
	DEFAULT_MAX_BYTES,
	createSyntheticSourceInfo,
	createExtensionRuntime,
	ModelRegistry,
	ExtensionRunner,
	type BuildSystemPromptOptions,
	type NormalizedBuildSystemPromptOptions,
	type SessionManager,
	type BeforeAgentStartEvent,
	type Extension,
	type InputSource,
	type ModelRuntime,
	type PromptTemplate,
	type Skill,
	stripFrontmatter,
	truncateTail,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

/** Read the public event getter after every handler has changed the shared prompt options. */
export function createWorkerPromptObserver(): { extension: Extension; read: () => string } {
	let event: BeforeAgentStartEvent | undefined;
	const sourceInfo = createSyntheticSourceInfo("<agent-prompt-host>", { source: "host" });
	return {
		extension: {
			path: sourceInfo.path, resolvedPath: sourceInfo.path, sourceInfo,
			handlers: new Map([["before_agent_start", [async (current: unknown) => { event = current as BeforeAgentStartEvent; }]]]),
			tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
		},
		read: () => {
			if (!event) throw new Error("The prompt event has not run");
			return event.systemPrompt;
		},
	};
}

/** Render through the public host event without invoking application extensions. */
export async function renderWorkerPrompt(options: BuildSystemPromptOptions, session: SessionManager, runtime: ModelRuntime): Promise<{ options: NormalizedBuildSystemPromptOptions; read: () => string }> {
	const observer = createWorkerPromptObserver();
	const runner = new ExtensionRunner([observer.extension], createExtensionRuntime(), options.cwd, session, new ModelRegistry(runtime));
	const result = await runner.emitBeforeAgentStart("", undefined, options);
	return { options: result.systemPromptOptions, read: observer.read };
}

/** A session-local facade. The shared runtime retains provider and credential ownership. */
export function createWorkerModels(runtime: ModelRuntime, getRunner: () => ExtensionRunner | undefined, prepareStructuralContext: (context: ProviderContext) => ProviderContext = (context) => context): Models {
	function requestOptions<T extends ProviderRequestOptions & ModelsRequestTransforms>(options?: T) {
		return Object.assign({}, options, {
			transformHeaders: async (headers: Parameters<NonNullable<ModelsRequestTransforms["transformHeaders"]>>[0]) => {
				const transformed = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
				const runner = getRunner();
				return runner?.hasHandlers("before_provider_headers")
					? runner.emitBeforeProviderHeaders(transformed)
					: transformed;
			},
			onResponse: async (...args: Parameters<NonNullable<ProviderRequestOptions["onResponse"]>>) => {
				await options?.onResponse?.(...args);
				const runner = getRunner();
				if (runner?.hasHandlers("after_provider_response")) {
					await runner.emit({ type: "after_provider_response", status: args[0].status, headers: args[0].headers });
				}
			},
		});
	}
	return {
		getProviders: runtime.getProviders.bind(runtime),
		getProvider: runtime.getProvider.bind(runtime),
		getModels: runtime.getModels.bind(runtime),
		getModel: runtime.getModel.bind(runtime),
		refresh: runtime.refresh.bind(runtime),
		checkAuth: runtime.checkAuth.bind(runtime),
		getAvailable: runtime.getAvailable.bind(runtime),
		getAuth: runtime.getAuth.bind(runtime),
		login: runtime.login.bind(runtime),
		logout: runtime.logout.bind(runtime),
		stream: (model, context, options) => runtime.stream(model, context, requestOptions(options)),
		complete: (model, context, options) => runtime.complete(model, context, requestOptions(options)),
		streamSimple: (model, context, options) => runtime.streamSimple(model, context, requestOptions(options)),
		completeSimple: (model, context, options) => runtime.completeSimple(model, prepareStructuralContext(context), requestOptions(options)),
		streamDeferred: (model, handle, options) => runtime.streamDeferred(model, handle, requestOptions(options)),
		fetchDeferred: (model, handle, options) => runtime.fetchDeferred(model, handle, requestOptions(options)),
		cancelDeferred: (model, handle, options) => runtime.cancelDeferred(model, handle, requestOptions(options)),
	};
}

export interface WorkerInputResources {
	skills: readonly Skill[];
	promptTemplates: readonly PromptTemplate[];
}

export interface WorkerInputContent {
	text: string;
	images?: ImageContent[];
}

export function normalizeWorkerUserContent(content: string | (TextContent | ImageContent)[]): WorkerInputContent {
	if (typeof content === "string") return { text: content };
	const images = content.filter((part): part is ImageContent => part.type === "image");
	return {
		text: content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n"),
		...(images.length ? { images } : {}),
	};
}

/** Quotes group arguments; unquoted whitespace separates them. Values are never re-expanded. */
function templateArguments(source: string): string[] {
	const values: string[] = [];
	let value = "";
	let quote = "";
	for (const character of source) {
		if (quote) {
			if (character === quote) quote = "";
			else value += character;
		} else if (character === "'" || character === '"') {
			quote = character;
		} else if (/\s/u.test(character)) {
			if (value) values.push(value);
			value = "";
		} else {
			value += character;
		}
	}
	if (value) values.push(value);
	return values;
}

function templateContent(content: string, args: string[]): string {
	return content.replace(
		/\$\{((?:\d+|ARGUMENTS|@):-[^}]*|@:\d+(?::\d+)?)\}|\$(ARGUMENTS|@|\d+)/gu,
		(original, braced: string | undefined, plain: string | undefined) => {
			const token = braced ?? plain ?? "";
			const fallback = braced?.match(/^(\d+|ARGUMENTS|@):-(.*)$/su);
			const target = fallback?.[1] ?? token;
			const value =
				target === "@" || target === "ARGUMENTS"
					? args.join(" ")
					: /^\d+$/u.test(target)
						? (args[Number(target) - 1] ?? "")
						: undefined;
			if (fallback) return value || fallback[2];
			const slice = braced?.match(/^@:(\d+)(?::(\d+))?$/u);
			if (slice) {
				const start = Math.max(0, Number(slice[1]) - 1);
				return args.slice(start, slice[2] === undefined ? undefined : start + Number(slice[2])).join(" ");
			}
			return braced === undefined && value !== undefined ? value : original;
		},
	);
}

/** Expand only known resources. Skill read errors remain visible and preserve the original input. */
export function expandWorkerInput(text: string, resources: WorkerInputResources, runner: ExtensionRunner): string {
	let expanded = text;
	if (expanded.startsWith("/skill:")) {
		const separator = expanded.indexOf(" ");
		const name = expanded.slice(7, separator < 0 ? undefined : separator);
		const skill = resources.skills.find((candidate) => candidate.name === name);
		if (skill) {
			try {
				const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
				const instructions = separator < 0 ? "" : expanded.slice(separator + 1).trim();
				expanded = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
				if (instructions) expanded += `\n\n${instructions}`;
			} catch (error) {
				runner.emitError({
					extensionPath: skill.filePath,
					event: "skill_expansion",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	const invocation = expanded.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/u);
	const template = invocation && resources.promptTemplates.find((candidate) => candidate.name === invocation[1]);
	return template ? templateContent(template.content, templateArguments(invocation?.[2] ?? "")) : expanded;
}

export interface WorkerInputOptions extends WorkerInputContent {
	source?: InputSource;
	expandPromptTemplates?: boolean;
	streaming: boolean | (() => boolean);
	streamingBehavior?: "steer" | "followUp";
}

export type PreparedWorkerInput =
	| { kind: "handled" }
	| ({ kind: "prompt"; streamingBehavior?: "steer" | "followUp" } & WorkerInputContent);

function extensionCommand(runner: ExtensionRunner, text: string): boolean {
	if (!text.startsWith("/")) return false;
	const separator = text.indexOf(" ");
	return runner.getCommand(text.slice(1, separator < 0 ? undefined : separator)) !== undefined;
}

/** Ordinary prompt preflight. The caller owns admission, command context, and execution. */
export async function prepareWorkerInput(
	runner: ExtensionRunner,
	input: WorkerInputOptions,
	resources: WorkerInputResources,
	executeCommand: (text: string) => Promise<void>,
): Promise<PreparedWorkerInput> {
	const expand = input.expandPromptTemplates ?? true;
	if (expand && extensionCommand(runner, input.text)) {
		await executeCommand(input.text);
		return { kind: "handled" };
	}
	const isStreaming = () => (typeof input.streaming === "function" ? input.streaming() : input.streaming);
	let { text, images } = input;
	if (runner.hasHandlers("input")) {
		const result = await runner.emitInput(
			text,
			images,
			input.source ?? "interactive",
			isStreaming() ? input.streamingBehavior : undefined,
		);
		if (result.action === "handled") return { kind: "handled" };
		if (result.action === "transform") {
			text = result.text;
			images = result.images ?? images;
		}
	}
	if (expand) text = expandWorkerInput(text, resources, runner);
	const streaming = isStreaming();
	const streamingBehavior = streaming ? input.streamingBehavior : undefined;
	if (streaming && !streamingBehavior) {
		throw new Error(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);
	}
	return {
		kind: "prompt",
		text,
		...(images === undefined ? {} : { images }),
		...(streamingBehavior ? { streamingBehavior } : {}),
	};
}

/** Direct steer/follow-up methods expand resources, reject commands, and do not emit input. */
export function prepareWorkerQueuedInput(
	runner: ExtensionRunner,
	input: WorkerInputContent,
	resources: WorkerInputResources,
): WorkerInputContent {
	if (extensionCommand(runner, input.text))
		throw new Error("Extension commands cannot be queued. Execute the command directly instead.");
	return { ...input, text: expandWorkerInput(input.text, resources, runner) };
}

export interface WorkerBashOptions {
	runner: ExtensionRunner;
	cwd: string;
	command: string;
	excludeFromContext: boolean;
	signal: AbortSignal;
	shellPath?: string;
	commandPrefix?: string;
	outputDirectory: string;
}

export type WorkerBashMessage = Extract<AgentMessage, { role: "bashExecution" }>;

/** Execute ordinary user bash. The caller owns history placement and the abort controller. */
export async function executeWorkerBash(options: WorkerBashOptions): Promise<WorkerBashMessage> {
	const { runner, cwd, command, excludeFromContext, signal } = options;
	const intercepted = await runner.emitUserBash({ type: "user_bash", cwd, command, excludeFromContext });
	const message = (result: NonNullable<UserBashEventResult["result"]>): WorkerBashMessage => ({
		role: "bashExecution",
		command,
		output: result.output,
		exitCode: result.exitCode,
		cancelled: result.cancelled,
		truncated: result.truncated,
		...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
		timestamp: Date.now(),
		excludeFromContext,
	});
	if (intercepted?.result) return message(intercepted.result);

	const operations = intercepted?.operations ?? createLocalBashOperations({ shellPath: options.shellPath });
	const decoder = new TextDecoder();
	let retained = "";
	let rawBytes = 0;
	let discarded = false;
	let descriptor: number | undefined;
	let fullOutputPath: string | undefined;
	const spill = () => {
		if (descriptor !== undefined) return;
		mkdirSync(options.outputDirectory, { recursive: true, mode: 0o700 });
		fullOutputPath = join(options.outputDirectory, `bash-${randomUUID()}.log`);
		descriptor = openSync(fullOutputPath, "wx", 0o600);
		writeFileSync(descriptor, retained, "utf8");
	};
	const append = (decoded: string) => {
		const clean = Array.from(stripVTControlCharacters(decoded))
			.filter((character) => {
				const code = character.codePointAt(0) ?? 0;
				return (code === 9 || code === 10 || code >= 32) && !(code >= 0xfff9 && code <= 0xfffb);
			})
			.join("");
		if (rawBytes > DEFAULT_MAX_BYTES) spill();
		if (descriptor !== undefined) writeFileSync(descriptor, clean, "utf8");
		retained += clean;
		const maxRetainedCharacters = DEFAULT_MAX_BYTES * 2;
		if (retained.length > maxRetainedCharacters) {
			retained = retained.slice(-maxRetainedCharacters);
			const first = retained.charCodeAt(0);
			if (first >= 0xdc00 && first <= 0xdfff) retained = retained.slice(1);
			discarded = true;
		}
	};
	let exitCode: number | undefined;
	try {
		try {
			signal.throwIfAborted();
			const result = await operations.exec(
				options.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
				cwd,
				{
					signal,
					onData: (data) => {
						rawBytes += data.byteLength;
						append(decoder.decode(data, { stream: true }));
					},
				},
			);
			exitCode = result.exitCode ?? undefined;
		} catch (error) {
			if (!signal.aborted) throw error;
		}
		append(decoder.decode());
		const truncation = truncateTail(retained);
		if (truncation.truncated) spill();
		return message({
			output: truncation.content,
			exitCode: signal.aborted ? undefined : exitCode,
			cancelled: signal.aborted,
			truncated: discarded || truncation.truncated,
			...(fullOutputPath === undefined ? {} : { fullOutputPath }),
		});
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}
