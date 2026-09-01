import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Api, Message, Model, StopReason, Usage } from "@earendil-works/pi-ai";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createSyntheticSourceInfo,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type PromptTemplate,
} from "@earendil-works/pi-coding-agent";
import type { JsonValue, TranscriptEvent, UsageSummary } from "vitest-evals";

import type {
	CheckResult,
	EvaluationCase,
	EvaluationCheck,
	Participant,
	SubjectAdapter,
	SubjectVariant,
	ThinkingLevel,
} from "../types.mts";

interface PiPromptResource {
	name: string;
	description: string;
	argumentHint?: string;
	source: { path: string } | { inline: string };
}

interface PiVariantConfig {
	promptTemplates?: PiPromptResource[];
	skills?: Array<{ path: string }>;
	extensions?: Array<{ path: string }>;
	contextFiles?: Array<{ path: string; content: string }>;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	tools?: string[];
	extensionFlags?: Record<string, boolean | string>;
}

interface PiCaseInput {
	seed: Array<{ role: "user" | "assistant"; content: string }>;
	prompt: string;
	fixture?: JsonValue;
}

function jsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function asRecord(value: JsonValue, field: string): Record<string, JsonValue> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return value;
}

export function parseExtensionFlagValues(value: unknown, variantId: string): Map<string, boolean | string> | undefined {
	if (value === undefined) return undefined;
	const field = `variant ${variantId}.config.extensionFlags`;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	) {
		throw new Error(`${field} must be an object`);
	}
	const result = new Map<string, boolean | string>();
	for (const [name, flagValue] of Object.entries(value)) {
		if (name === "") throw new Error(`${field} keys must be non-empty`);
		if (typeof flagValue !== "boolean" && typeof flagValue !== "string") {
			throw new Error(`${field}.${name} must be a boolean or string`);
		}
		result.set(name, flagValue);
	}
	return result;
}

function parseVariant(variant: SubjectVariant): PiVariantConfig {
	return asRecord(variant.config, `variant ${variant.id}.config`) as unknown as PiVariantConfig;
}

function parseCase(evaluationCase: EvaluationCase): PiCaseInput {
	const input = asRecord(evaluationCase.input, `case ${evaluationCase.id}.input`) as unknown as Partial<PiCaseInput>;
	if (!Array.isArray(input.seed) || typeof input.prompt !== "string" || input.prompt === "") {
		throw new Error(`case ${evaluationCase.id} needs seed messages and a prompt`);
	}
	for (const message of input.seed) {
		if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
			throw new Error(`case ${evaluationCase.id} has an invalid seed message`);
		}
	}
	return input as PiCaseInput;
}

function digest(value: string | Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function resourcePath(path: string, suitePath: string): string {
	return realpathSync(resolve(dirname(suitePath), path));
}

function resolvePiSubject({ suitePath, variant }: { suitePath: string; variant: SubjectVariant }): JsonValue {
	const config = parseVariant(variant);
	parseExtensionFlagValues(config.extensionFlags, variant.id);
	const resources: JsonValue[] = [];
	for (const prompt of config.promptTemplates ?? []) {
		if ("path" in prompt.source) {
			const path = resourcePath(prompt.source.path, suitePath);
			resources.push({ type: "prompt", name: prompt.name, source: "file", path, digest: digest(readFileSync(path)) });
		} else {
			resources.push({ type: "prompt", name: prompt.name, source: "inline", digest: digest(prompt.source.inline) });
		}
	}
	for (const [type, entries] of [
		["skill", config.skills ?? []],
		["extension", config.extensions ?? []],
	] as const) {
		for (const entry of entries) {
			const path = resourcePath(entry.path, suitePath);
			resources.push({ type, source: "file", path, digest: digest(readFileSync(path)) });
		}
	}
	for (const context of config.contextFiles ?? []) {
		resources.push({ type: "context", name: context.path, source: "inline", digest: digest(context.content) });
	}
	if (config.systemPrompt !== undefined)
		resources.push({ type: "system-prompt", source: "inline", digest: digest(config.systemPrompt) });
	for (const append of config.appendSystemPrompt ?? []) {
		resources.push({ type: "append-system-prompt", source: "inline", digest: digest(append) });
	}
	resources.push({ type: "tools", source: "inline", digest: digest(JSON.stringify(config.tools ?? [])) });
	return { resources };
}

function blocked(message: string, options?: ErrorOptions): Error {
	const error = new Error(message, options);
	error.name = "BlockedError";
	return error;
}

function errorRecord(type: string, error: unknown): Record<string, JsonValue> {
	if (error instanceof Error) return { type, name: error.name, message: error.message };
	return { type, name: "Error", message: String(error) };
}

function inlinePromptTemplates(config: PiVariantConfig, variantId: string): PromptTemplate[] {
	return (config.promptTemplates ?? []).flatMap((prompt) => {
		if ("path" in prompt.source) return [];
		const filePath = `/virtual/evals/${variantId}/${prompt.name}.md`;
		return [
			{
				name: prompt.name,
				description: prompt.description,
				...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
				content: prompt.source.inline,
				filePath,
				sourceInfo: createSyntheticSourceInfo(filePath, { source: "evaluation", scope: "temporary" }),
			},
		];
	});
}

function seedMessages(input: PiCaseInput, participant: Participant, api: Api): Message[] {
	const timestamp = 1_700_000_000_000;
	return input.seed.map((message, index): Message => {
		if (message.role === "user") return { role: "user", content: message.content, timestamp: timestamp + index };
		return {
			role: "assistant",
			content: [{ type: "text", text: message.content }],
			api,
			provider: participant.provider,
			model: participant.model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: timestamp + index,
		};
	});
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(
				part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			);
		})
		.map((part) => part.text)
		.join("");
}

export function normalizePiTranscript(messages: Message[]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: textContent(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = textContent(message.content);
			if (text !== "") {
				events.push({
					type: "message",
					role: "assistant",
					content: text,
					metadata: {
						provider: message.provider,
						model: message.model,
						...(message.responseModel ? { responseModel: message.responseModel } : {}),
						stopReason: message.stopReason,
					},
				});
			}
			for (const part of message.content) {
				if (part.type === "toolCall") {
					events.push({
						type: "tool_call",
						id: part.id,
						name: part.name,
						arguments: part.arguments as Record<string, JsonValue>,
					});
				}
			}
			continue;
		}
		events.push({
			type: "tool_result",
			toolCallId: message.toolCallId,
			name: message.toolName,
			content: textContent(message.content),
			...(message.isError ? { error: { message: textContent(message.content) || "Tool failed" } } : {}),
		});
	}
	return events;
}

export function summarizeUsage(messages: Message[], participant: Participant): UsageSummary {
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let totalTokens = 0;
	let cost = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		inputTokens += message.usage.input;
		outputTokens += message.usage.output;
		reasoningTokens += message.usage.reasoning ?? 0;
		cacheReadTokens += message.usage.cacheRead;
		cacheWriteTokens += message.usage.cacheWrite;
		totalTokens += message.usage.totalTokens;
		cost += message.usage.cost.total;
	}
	return {
		provider: participant.provider,
		model: participant.model,
		inputTokens,
		outputTokens,
		reasoningTokens,
		totalTokens,
		metadata: { cacheReadTokens, cacheWriteTokens, cost },
	};
}

function checkConfig(check: EvaluationCheck): Record<string, JsonValue> {
	return asRecord(check.config, `check ${check.id}.config`);
}

function optionalStringArray(check: EvaluationCheck, config: Record<string, JsonValue>, field: string): string[] {
	const values = config[field];
	if (values === undefined) return [];
	if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
		throw new Error(`check ${check.id} needs string ${field} values`);
	}
	return values as string[];
}

function serializedTranscriptValue(value: JsonValue | undefined): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value ?? null) ?? "null";
}

type PiSessionEntry = ReturnType<SessionManager["getEntries"]>[number];

function summarizeRunEntryUsage(entries: PiSessionEntry[], participant: Participant): UsageSummary {
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let totalTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let cost = 0;
	let toolCalls = 0;
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			usage = entry.message.usage;
			toolCalls += entry.message.content.filter((part) => part.type === "toolCall").length;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (!usage) continue;
		inputTokens += usage.input;
		outputTokens += usage.output;
		reasoningTokens += usage.reasoning ?? 0;
		totalTokens += usage.totalTokens;
		cacheReadTokens += usage.cacheRead;
		cacheWriteTokens += usage.cacheWrite;
		cost += usage.cost.total;
	}
	return {
		provider: participant.provider,
		model: participant.model,
		inputTokens,
		outputTokens,
		reasoningTokens,
		totalTokens,
		toolCalls,
		metadata: { cacheReadTokens, cacheWriteTokens, cost },
	};
}

export function runDeterministicChecks(
	output: string,
	checks: EvaluationCheck[],
	events: TranscriptEvent[],
): CheckResult[] {
	return checks.map((check) => {
		const config = checkConfig(check);
		if (check.type === "contains-exact") {
			const values = config.values;
			if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
				throw new Error(`check ${check.id} needs string values`);
			}
			const missing = values.filter((value) => !output.includes(value as string));
			return {
				checkId: check.id,
				type: check.type,
				passed: missing.length === 0,
				message:
					missing.length === 0 ? "All protected spans remain exact." : `Missing exact spans: ${missing.join(" | ")}`,
			};
		}
		if (check.type === "omits-exact") {
			const values = config.values;
			if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
				throw new Error(`check ${check.id} needs string values`);
			}
			const present = values.filter((value) => output.includes(value as string));
			return {
				checkId: check.id,
				type: check.type,
				passed: present.length === 0,
				message: present.length === 0 ? "No forbidden text appears." : `Forbidden text appears: ${present.join(" | ")}`,
			};
		}
		if (check.type === "max-characters") {
			const maximum = config.maximum;
			if (typeof maximum !== "number") throw new Error(`check ${check.id} needs a numeric maximum`);
			return {
				checkId: check.id,
				type: check.type,
				passed: output.length <= maximum,
				message: `Output has ${output.length} characters; the lexical ceiling is ${maximum}.`,
			};
		}
		if (check.type === "tool-call") {
			const name = config.name;
			if (typeof name !== "string" || name === "") throw new Error(`check ${check.id} needs a tool name`);
			const expectedPresent = config.present;
			if (expectedPresent !== undefined && typeof expectedPresent !== "boolean") {
				throw new Error(`check ${check.id} needs a boolean present value`);
			}
			const argumentsContain = optionalStringArray(check, config, "argumentsContain");
			const matchingCallAppears = events.some((event) => {
				if (event.type !== "tool_call" || event.name !== name) return false;
				const serializedArguments = serializedTranscriptValue(event.arguments ?? {});
				return argumentsContain.every((value) => serializedArguments.includes(value));
			});
			const shouldBePresent = expectedPresent ?? true;
			const passed = shouldBePresent ? matchingCallAppears : !matchingCallAppears;
			return {
				checkId: check.id,
				type: check.type,
				passed,
				message: shouldBePresent
					? matchingCallAppears
						? `A matching tool call to ${JSON.stringify(name)} appears.`
						: `No matching tool call to ${JSON.stringify(name)} appears.`
					: matchingCallAppears
						? `A forbidden matching tool call to ${JSON.stringify(name)} appears.`
						: `No matching tool call to ${JSON.stringify(name)} appears.`,
			};
		}
		if (check.type === "tool-result") {
			const name = config.name;
			if (typeof name !== "string" || name === "") throw new Error(`check ${check.id} needs a tool name`);
			const isError = config.isError;
			if (isError !== undefined && typeof isError !== "boolean") {
				throw new Error(`check ${check.id} needs a boolean isError value`);
			}
			const contentContains = optionalStringArray(check, config, "contentContains");
			const contentOmits = optionalStringArray(check, config, "contentOmits");
			const callsById = new Map(
				events.flatMap((event) => (event.type === "tool_call" ? [[event.id, event] as const] : [])),
			);
			const matchingResultAppears = events.some((event) => {
				if (event.type !== "tool_result") return false;
				const originatingCall = callsById.get(event.toolCallId);
				if ((originatingCall?.name ?? event.name) !== name) return false;
				if (isError !== undefined && (event.error !== undefined) !== isError) return false;
				const content = serializedTranscriptValue(event.content);
				return (
					contentContains.every((value) => content.includes(value)) &&
					contentOmits.every((value) => !content.includes(value))
				);
			});
			return {
				checkId: check.id,
				type: check.type,
				passed: matchingResultAppears,
				message: matchingResultAppears
					? `A matching tool result for ${JSON.stringify(name)} appears.`
					: `No tool result for ${JSON.stringify(name)} matches the configured constraints.`,
			};
		}
		throw new Error(`Pi adapter does not support check type ${check.type}`);
	});
}

function lastAssistant(messages: Message[]): Extract<Message, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

export function limitModelOutput<TApi extends Api>(model: Model<TApi>, maximum: number): Model<TApi> {
	return { ...model, maxTokens: Math.min(model.maxTokens, maximum) };
}

export function isAssistantFailureStopReason(stopReason: StopReason): boolean {
	return stopReason === "length" || stopReason === "error" || stopReason === "aborted";
}

export function scorePostSeedPiTranscript(allMessages: Message[], seedMessageCount: number, checks: EvaluationCheck[]) {
	const newMessages = allMessages.slice(seedMessageCount);
	const assistant = lastAssistant(newMessages);
	const output = assistant ? textContent(assistant.content) : "";
	const events = normalizePiTranscript(newMessages);
	return { newMessages, assistant, output, checks: runDeterministicChecks(output, checks, events) };
}

async function runPiSubject(args: Parameters<SubjectAdapter["run"]>[0]) {
	if (args.signal?.aborted) {
		const error = new Error("The caller cancelled the execution before Pi runtime creation.");
		error.name = "CancellationError";
		throw error;
	}
	const { suitePath, variant, evaluationCase, participant, limits, signal } = args;
	const config = parseVariant(variant);
	const extensionFlagValues = parseExtensionFlagValues(config.extensionFlags, variant.id);
	const input = parseCase(evaluationCase);
	const errors: Array<Record<string, JsonValue>> = [];
	const sandboxParent = resolve(args.runDirectory, "sandboxes");
	mkdirSync(sandboxParent, { recursive: true });
	const sandbox = mkdtempSync(resolve(sandboxParent, `${args.execution.executionId}-`));
	const isolatedAgentDir = resolve(sandbox, "agent");
	const cwd = resolve(sandbox, "cwd");
	mkdirSync(isolatedAgentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	let runtime: AgentSessionRuntime | undefined;

	try {
		const modelRuntime = await ModelRuntime.create({
			allowModelNetwork: false,
			...(args.grant.credentialSources.home
				? {}
				: { authPath: resolve(isolatedAgentDir, "auth.json"), modelsPath: null }),
		});
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const additionalSkillPaths = (config.skills ?? []).map((resource) => resourcePath(resource.path, suitePath));
		const additionalExtensionPaths = (config.extensions ?? []).map((resource) =>
			resourcePath(resource.path, suitePath),
		);
		const templates = inlinePromptTemplates(config, variant.id);
		const additionalPromptTemplatePaths = (config.promptTemplates ?? []).flatMap((prompt) =>
			"path" in prompt.source ? [resourcePath(prompt.source.path, suitePath)] : [],
		);
		const sessionManager = SessionManager.inMemory(cwd);
		let seedMessageCount = 0;
		let seedEntryCount = 0;
		let resourceEvidence: JsonValue = {};

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: isolatedAgentDir,
				settingsManager,
				modelRuntime,
				extensionFlagValues,
				resourceLoaderOptions: {
					additionalSkillPaths,
					additionalExtensionPaths,
					additionalPromptTemplatePaths,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					promptsOverride: (base) => ({ prompts: [...base.prompts, ...templates], diagnostics: base.diagnostics }),
					themesOverride: () => ({ themes: [], diagnostics: [] }),
					agentsFilesOverride: () => ({ agentsFiles: config.contextFiles ?? [] }),
					...(config.systemPrompt !== undefined ? { systemPromptOverride: () => config.systemPrompt } : {}),
					appendSystemPromptOverride: () => config.appendSystemPrompt ?? [],
				},
			});
			const resolvedModel = services.modelRuntime.getModel(participant.provider, participant.model);
			if (!resolvedModel || resolvedModel.provider !== participant.provider || resolvedModel.id !== participant.model) {
				throw blocked(`ModelRuntime did not resolve exact model ${participant.provider}/${participant.model}`);
			}
			try {
				const auth = await services.modelRuntime.getAuth(resolvedModel);
				if (!auth) throw blocked(`No approved credential resolved for ${participant.provider}/${participant.model}`);
			} catch (error) {
				if (error instanceof Error && error.name === "BlockedError") throw error;
				throw blocked(`Approved credential resolution failed for ${participant.provider}/${participant.model}`, {
					cause: error,
				});
			}
			const model = limitModelOutput(resolvedModel, limits.execution.maxOutputTokensEach);
			const loader = services.resourceLoader;
			const actual = {
				extensions: loader.getExtensions().extensions.length,
				skills: loader.getSkills().skills.length,
				prompts: loader.getPrompts().prompts.length,
				contexts: loader.getAgentsFiles().agentsFiles.length,
			};
			const expected = {
				extensions: additionalExtensionPaths.length,
				skills: additionalSkillPaths.length,
				prompts: (config.promptTemplates ?? []).length,
				contexts: (config.contextFiles ?? []).length,
			};
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw blocked(
					`Explicit resource cardinality mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
				);
			}
			resourceEvidence = jsonValue({
				expected,
				actual,
				diagnostics: {
					services: services.diagnostics,
					skills: loader.getSkills().diagnostics,
					prompts: loader.getPrompts().diagnostics,
					themes: loader.getThemes().diagnostics,
					extensions: loader.getExtensions().errors,
				},
			});
			if (sessionManager.getEntries().length === 0) {
				const seeded = seedMessages(input, participant, model.api);
				for (const message of seeded) sessionManager.appendMessage(message);
				seedMessageCount = seeded.length;
				seedEntryCount = sessionManager.getEntries().length;
			}
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
					thinkingLevel: participant.thinking,
					tools: config.tools ?? [],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: isolatedAgentDir,
			sessionManager,
		});
		const session = runtime.session;
		if ((config.extensions?.length ?? 0) > 0) {
			await session.bindExtensions({
				mode: "rpc",
				onError: (error) => {
					errors.push({
						type: "ExtensionHookError",
						message: error.error,
						extensionPath: error.extensionPath,
						event: error.event,
						...(error.stack ? { stack: error.stack } : {}),
					});
				},
			});
		}
		for (const extensionError of session.resourceLoader.getExtensions().errors) {
			errors.push({ type: "ExtensionLoadError", message: extensionError.error, path: extensionError.path });
		}

		let turns = 0;
		let termination: "timeout" | "cancelled" | undefined;
		const thinkingChanges: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "thinking_level_changed") thinkingChanges.push(event.level);
			if (event.type !== "turn_end") return;
			turns += 1;
			const hasContinuation =
				event.message.role === "assistant" && event.message.content.some((part) => part.type === "toolCall");
			if (turns >= limits.execution.maxTurnsEach && hasContinuation) void session.abort();
		});
		const abortFromCaller = () => {
			if (!termination) termination = "cancelled";
			void session.abort();
		};
		signal?.addEventListener("abort", abortFromCaller, { once: true });
		const timeout = setTimeout(() => {
			if (!termination) termination = "timeout";
			void session.abort();
		}, limits.wall.executionTimeoutMs);

		try {
			await session.prompt(input.prompt, { expandPromptTemplates: true, source: "rpc" });
		} catch (error) {
			if (!termination) errors.push(errorRecord("ExecutionError", error));
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromCaller);
			if (session.isStreaming) await session.abort();
			unsubscribe();
		}

		const allMessages = session.messages.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
		const scoredTranscript = scorePostSeedPiTranscript(allMessages, seedMessageCount, evaluationCase.checks);
		const { newMessages, assistant, output } = scoredTranscript;
		let usage = summarizeUsage(newMessages, participant);
		if (termination === "timeout") errors.push({ type: "Timeout", message: "The execution wall-time limit expired." });
		if (termination === "cancelled") errors.push({ type: "Cancelled", message: "The caller cancelled the execution." });
		for (const message of newMessages) {
			if (message.role === "assistant" && message.errorMessage) {
				errors.push({ type: "AssistantError", message: message.errorMessage });
			}
			if (message.role === "assistant" && isAssistantFailureStopReason(message.stopReason)) {
				errors.push({ type: "AssistantStopReason", message: `Assistant stopped with ${message.stopReason}.` });
			}
		}
		const runEntryRecords = sessionManager.getEntries().slice(seedEntryCount);
		usage = summarizeRunEntryUsage(runEntryRecords, participant);
		if ((usage.outputTokens ?? 0) > limits.execution.maxOutputTokensEach) {
			errors.push({
				type: "OutputTokenLimitExceeded",
				message: `Output token usage exceeded ${limits.execution.maxOutputTokensEach}`,
			});
		}
		const modelChanges = runEntryRecords.flatMap((entry) =>
			entry.type === "model_change" ? [{ provider: entry.provider, model: entry.modelId }] : [],
		);
		const runEntries: JsonValue[] = runEntryRecords.map((entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") {
				return jsonValue({ type: entry.type, id: entry.id });
			}
			return jsonValue({
				type: entry.type,
				id: entry.id,
				provider: entry.message.provider,
				model: entry.message.model,
				responseModel: entry.message.responseModel ?? null,
				usage: entry.message.usage,
			});
		});
		return {
			output: {
				value: {
					text: output,
					requested: { provider: participant.provider, model: participant.model, thinking: participant.thinking },
					effective: {
						provider: session.model?.provider ?? participant.provider,
						model: session.model?.id ?? participant.model,
						thinking: session.thinkingLevel,
						responseModel: assistant?.responseModel ?? null,
					},
					turns,
					thinkingChanges,
					modelChanges,
					runEntries,
					resources: resourceEvidence,
				},
				effective: {
					requestedProvider: participant.provider,
					requestedModel: participant.model,
					requestedThinking: participant.thinking,
					provider: session.model?.provider ?? participant.provider,
					model: session.model?.id ?? participant.model,
					thinking: session.thinkingLevel as ThinkingLevel,
					responseModel: assistant?.responseModel ?? null,
				},
				checks: scoredTranscript.checks,
			},
			events: normalizePiTranscript(allMessages),
			usage,
			errors,
		};
	} finally {
		try {
			if (runtime) await runtime.dispose();
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	}
}

export const piSdkAdapter: SubjectAdapter = {
	id: "pi-sdk",
	resolve: resolvePiSubject,
	run: runPiSubject,
};
