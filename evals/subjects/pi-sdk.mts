import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
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
	EvaluationLimits,
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
	cwd?: string;
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
	const config = asRecord(variant.config, `variant ${variant.id}.config`) as unknown as PiVariantConfig;
	if (config.cwd !== undefined && (typeof config.cwd !== "string" || config.cwd.trim() === "")) {
		throw new Error(`variant ${variant.id}.config.cwd must be a non-empty directory path`);
	}
	return config;
}

export function resolvePiCwd(variant: SubjectVariant, suitePath: string): string | undefined {
	const { cwd } = parseVariant(variant);
	if (cwd === undefined) return undefined;
	const path = resourcePath(cwd, suitePath);
	if (!statSync(path).isDirectory()) throw new Error(`variant ${variant.id}.config.cwd must resolve to a directory`);
	return path;
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

function promptResource(prompt: PiPromptResource, suitePath: string): JsonValue {
	if ("path" in prompt.source) {
		const path = resourcePath(prompt.source.path, suitePath);
		return { type: "prompt", name: prompt.name, source: "file", path, digest: digest(readFileSync(path)) };
	}
	return { type: "prompt", name: prompt.name, source: "inline", digest: digest(prompt.source.inline) };
}

function fileResources(type: "skill" | "extension", entries: Array<{ path: string }>, suitePath: string): JsonValue[] {
	return entries.map((entry) => {
		const path = resourcePath(entry.path, suitePath);
		return { type, source: "file", path, digest: digest(readFileSync(path)) };
	});
}

function resolvePiSubject({ suitePath, variant }: { suitePath: string; variant: SubjectVariant }): JsonValue {
	const config = parseVariant(variant);
	parseExtensionFlagValues(config.extensionFlags, variant.id);
	const resources: JsonValue[] = [];
	for (const prompt of config.promptTemplates ?? []) resources.push(promptResource(prompt, suitePath));
	resources.push(...fileResources("skill", config.skills ?? [], suitePath));
	resources.push(...fileResources("extension", config.extensions ?? [], suitePath));
	for (const context of config.contextFiles ?? []) {
		resources.push({ type: "context", name: context.path, source: "inline", digest: digest(context.content) });
	}
	if (config.systemPrompt !== undefined)
		resources.push({ type: "system-prompt", source: "inline", digest: digest(config.systemPrompt) });
	for (const append of config.appendSystemPrompt ?? []) {
		resources.push({ type: "append-system-prompt", source: "inline", digest: digest(append) });
	}
	resources.push({ type: "tools", source: "inline", digest: digest(JSON.stringify(config.tools ?? [])) });
	const cwd = resolvePiCwd(variant, suitePath);
	return { resources, ...(cwd === undefined ? {} : { cwd }) };
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

function systemTranscriptEvent(message: Extract<Message, { role: "system" }>): TranscriptEvent {
	return {
		type: "message",
		role: "system",
		content: textContent(message.content),
		metadata: {
			timestamp: message.timestamp,
			...(message.sections === undefined ? {} : { sections: jsonValue(message.sections) }),
			...(message.toolsAdded === undefined ? {} : { toolsAdded: jsonValue(message.toolsAdded) }),
			...(message.toolsRemoved === undefined ? {} : { toolsRemoved: jsonValue(message.toolsRemoved) }),
		},
	};
}

function assistantTranscriptEvents(message: Extract<Message, { role: "assistant" }>): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
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
	return events;
}

function toolResultTranscriptEvent(message: Extract<Message, { role: "toolResult" }>): TranscriptEvent {
	const content = textContent(message.content);
	return {
		type: "tool_result",
		toolCallId: message.toolCallId,
		name: message.toolName,
		content,
		...(message.isError ? { error: { message: content || "Tool failed" } } : {}),
	};
}

export function normalizePiTranscript(messages: Message[]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			events.push(systemTranscriptEvent(message));
			continue;
		}
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: textContent(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			events.push(...assistantTranscriptEvents(message));
			continue;
		}
		events.push(toolResultTranscriptEvent(message));
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

type ParsedPiCheck =
	| { id: string; type: "contains-exact"; values: string[] }
	| { id: string; type: "omits-exact"; values: string[] }
	| { id: string; type: "max-characters"; maximum: number }
	| { id: string; type: "tool-call"; name: string; argumentsContain: string[]; present?: boolean }
	| {
			id: string;
			type: "tool-result";
			name: string;
			isError?: boolean;
			contentContains: string[];
			contentOmits: string[];
	  };

function assertCheckConfigFields(
	caseId: string,
	check: EvaluationCheck,
	config: Record<string, JsonValue>,
	allowed: string[],
): void {
	for (const field of Object.keys(config)) {
		if (!allowed.includes(field)) {
			throw new Error(`case ${caseId} check ${check.id}.config has unsupported field ${field}`);
		}
	}
}

function checkStringArray(
	caseId: string,
	check: EvaluationCheck,
	config: Record<string, JsonValue>,
	field: string,
	optional = false,
): string[] {
	const values = config[field];
	if (values === undefined && optional) return [];
	if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
		throw new Error(`case ${caseId} check ${check.id} needs string ${field} values`);
	}
	return values as string[];
}

function requiredToolName(caseId: string, check: EvaluationCheck, config: Record<string, JsonValue>): string {
	if (typeof config.name !== "string" || config.name === "") {
		throw new Error(`case ${caseId} check ${check.id} needs a tool name`);
	}
	return config.name;
}

function parseValuesCheck(
	caseId: string,
	check: EvaluationCheck,
	config: Record<string, JsonValue>,
	type: "contains-exact" | "omits-exact",
): ParsedPiCheck {
	assertCheckConfigFields(caseId, check, config, ["values"]);
	return { id: check.id, type, values: checkStringArray(caseId, check, config, "values") };
}

function parseMaxCharactersCheck(
	caseId: string,
	check: EvaluationCheck,
	config: Record<string, JsonValue>,
	type: "max-characters",
): ParsedPiCheck {
	assertCheckConfigFields(caseId, check, config, ["maximum"]);
	if (typeof config.maximum !== "number") {
		throw new Error(`case ${caseId} check ${check.id} needs a numeric maximum`);
	}
	return { id: check.id, type, maximum: config.maximum };
}

function parseToolCallCheck(
	caseId: string,
	check: EvaluationCheck,
	config: Record<string, JsonValue>,
	type: "tool-call",
): ParsedPiCheck {
	assertCheckConfigFields(caseId, check, config, ["name", "argumentsContain", "present"]);
	const name = requiredToolName(caseId, check, config);
	if (config.present !== undefined && typeof config.present !== "boolean") {
		throw new Error(`case ${caseId} check ${check.id} needs a boolean present value`);
	}
	return {
		id: check.id,
		type,
		name,
		argumentsContain: checkStringArray(caseId, check, config, "argumentsContain", true),
		...(config.present === undefined ? {} : { present: config.present }),
	};
}

function parseToolResultCheck(
	caseId: string,
	check: EvaluationCheck,
	config: Record<string, JsonValue>,
	type: "tool-result",
): ParsedPiCheck {
	assertCheckConfigFields(caseId, check, config, ["name", "isError", "contentContains", "contentOmits"]);
	const name = requiredToolName(caseId, check, config);
	if (config.isError !== undefined && typeof config.isError !== "boolean") {
		throw new Error(`case ${caseId} check ${check.id} needs a boolean isError value`);
	}
	return {
		id: check.id,
		type,
		name,
		...(config.isError === undefined ? {} : { isError: config.isError }),
		contentContains: checkStringArray(caseId, check, config, "contentContains", true),
		contentOmits: checkStringArray(caseId, check, config, "contentOmits", true),
	};
}

function parseCheck(caseId: string, check: EvaluationCheck): ParsedPiCheck {
	const config = asRecord(check.config, `case ${caseId} check ${check.id}.config`);
	if (check.type === "contains-exact" || check.type === "omits-exact") {
		return parseValuesCheck(caseId, check, config, check.type);
	}
	if (check.type === "max-characters") return parseMaxCharactersCheck(caseId, check, config, check.type);
	if (check.type === "tool-call") return parseToolCallCheck(caseId, check, config, check.type);
	if (check.type === "tool-result") return parseToolResultCheck(caseId, check, config, check.type);
	throw new Error(`case ${caseId} check ${check.id} uses unsupported Pi check type ${check.type}`);
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

function scoreContains(output: string, check: Extract<ParsedPiCheck, { type: "contains-exact" }>): CheckResult {
	const missing = check.values.filter((value) => !output.includes(value));
	return {
		checkId: check.id,
		type: check.type,
		passed: missing.length === 0,
		message: missing.length === 0 ? "All protected spans remain exact." : `Missing exact spans: ${missing.join(" | ")}`,
	};
}

function scoreOmits(output: string, check: Extract<ParsedPiCheck, { type: "omits-exact" }>): CheckResult {
	const present = check.values.filter((value) => output.includes(value));
	return {
		checkId: check.id,
		type: check.type,
		passed: present.length === 0,
		message: present.length === 0 ? "No forbidden text appears." : `Forbidden text appears: ${present.join(" | ")}`,
	};
}

function scoreMaxCharacters(output: string, check: Extract<ParsedPiCheck, { type: "max-characters" }>): CheckResult {
	return {
		checkId: check.id,
		type: check.type,
		passed: output.length <= check.maximum,
		message: `Output has ${output.length} characters; the lexical ceiling is ${check.maximum}.`,
	};
}

function toolCallMessage(name: string, shouldBePresent: boolean, matched: boolean): string {
	if (shouldBePresent && matched) return `A matching tool call to ${name} appears.`;
	if (shouldBePresent) return `No matching tool call to ${name} appears.`;
	if (matched) return `A forbidden matching tool call to ${name} appears.`;
	return `No matching tool call to ${name} appears.`;
}

function scoreToolCall(events: TranscriptEvent[], check: Extract<ParsedPiCheck, { type: "tool-call" }>): CheckResult {
	const matchingCallAppears = events.some((event) => {
		if (event.type !== "tool_call" || event.name !== check.name) return false;
		const serializedArguments = serializedTranscriptValue(event.arguments ?? {});
		return check.argumentsContain.every((value) => serializedArguments.includes(value));
	});
	const shouldBePresent = check.present ?? true;
	return {
		checkId: check.id,
		type: check.type,
		passed: shouldBePresent ? matchingCallAppears : !matchingCallAppears,
		message: toolCallMessage(JSON.stringify(check.name), shouldBePresent, matchingCallAppears),
	};
}

function scoreToolResult(
	events: TranscriptEvent[],
	check: Extract<ParsedPiCheck, { type: "tool-result" }>,
): CheckResult {
	const callsById = new Map(
		events.flatMap((event) => (event.type === "tool_call" ? [[event.id, event] as const] : [])),
	);
	const matchingResultAppears = events.some((event) => {
		if (event.type !== "tool_result") return false;
		const originatingCall = callsById.get(event.toolCallId);
		if ((originatingCall?.name ?? event.name) !== check.name) return false;
		if (check.isError !== undefined && (event.error !== undefined) !== check.isError) return false;
		const content = serializedTranscriptValue(event.content);
		return (
			check.contentContains.every((value) => content.includes(value)) &&
			check.contentOmits.every((value) => !content.includes(value))
		);
	});
	const name = JSON.stringify(check.name);
	return {
		checkId: check.id,
		type: check.type,
		passed: matchingResultAppears,
		message: matchingResultAppears
			? `A matching tool result for ${name} appears.`
			: `No tool result for ${name} matches the configured constraints.`,
	};
}

export function runDeterministicChecks(
	output: string,
	checks: EvaluationCheck[],
	events: TranscriptEvent[],
	caseId = "unscoped",
): CheckResult[] {
	return checks.map((candidate) => {
		const check = parseCheck(caseId, candidate);
		if (check.type === "contains-exact") return scoreContains(output, check);
		if (check.type === "omits-exact") return scoreOmits(output, check);
		if (check.type === "max-characters") return scoreMaxCharacters(output, check);
		if (check.type === "tool-call") return scoreToolCall(events, check);
		return scoreToolResult(events, check);
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

export function collectPiExecutionErrors(
	messages: Message[],
	usage: UsageSummary,
	maximumOutputTokens: number,
): Array<Record<string, JsonValue>> {
	const errors: Array<Record<string, JsonValue>> = [];
	for (const message of messages) {
		if (message.role === "assistant" && message.errorMessage) {
			errors.push({ type: "AssistantError", message: message.errorMessage });
		}
		if (message.role === "assistant" && isAssistantFailureStopReason(message.stopReason)) {
			errors.push({ type: "AssistantStopReason", message: `Assistant stopped with ${message.stopReason}.` });
		}
	}
	if ((usage.outputTokens ?? 0) > maximumOutputTokens) {
		errors.push({
			type: "OutputTokenLimitExceeded",
			message: `Output token usage exceeded ${maximumOutputTokens}`,
		});
	}
	return errors;
}

function validatePiCases({
	cases,
}: {
	suitePath: string;
	subjectKind: string;
	subjectConfig: JsonValue;
	cases: EvaluationCase[];
}): void {
	for (const evaluationCase of cases) {
		parseCase(evaluationCase);
		for (const check of evaluationCase.checks) parseCheck(evaluationCase.id, check);
	}
}

export function scorePostSeedPiTranscript(
	allMessages: Message[],
	seedMessageCount: number,
	checks: EvaluationCheck[],
	caseId = "unscoped",
) {
	let start = 0;
	let remainingSeeds = seedMessageCount;
	while (start < allMessages.length && remainingSeeds > 0) {
		if (allMessages[start].role !== "system") remainingSeeds--;
		start++;
	}
	const newMessages = allMessages.slice(start);
	const assistant = lastAssistant(newMessages);
	const output = assistant ? textContent(assistant.content) : "";
	const events = normalizePiTranscript(newMessages);
	return { newMessages, assistant, output, checks: runDeterministicChecks(output, checks, events, caseId) };
}

type AgentServices = Awaited<ReturnType<typeof createAgentSessionServices>>;

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const error = new Error("The caller cancelled the execution before Pi runtime creation.");
	error.name = "CancellationError";
	throw error;
}

async function resolveExactModel(services: AgentServices, participant: Participant) {
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
	return resolvedModel;
}

function buildResourceEvidence(args: {
	services: AgentServices;
	config: PiVariantConfig;
	cwd: string;
	configuredCwd: string | undefined;
	additionalSkillPaths: string[];
	additionalExtensionPaths: string[];
}): JsonValue {
	const loader = args.services.resourceLoader;
	const actual = {
		extensions: loader.getExtensions().extensions.length,
		skills: loader.getSkills().skills.length,
		prompts: loader.getPrompts().prompts.length,
		contexts: loader.getAgentsFiles().agentsFiles.length,
	};
	const expected = {
		extensions: args.additionalExtensionPaths.length,
		skills: args.additionalSkillPaths.length,
		prompts: (args.config.promptTemplates ?? []).length,
		contexts: (args.config.contextFiles ?? []).length,
	};
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw blocked(
			`Explicit resource cardinality mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
	return jsonValue({
		cwd: args.cwd,
		cwdMode: args.configuredCwd === undefined ? "isolated" : "explicit",
		expected,
		actual,
		diagnostics: {
			services: args.services.diagnostics,
			skills: loader.getSkills().diagnostics,
			prompts: loader.getPrompts().diagnostics,
			themes: loader.getThemes().diagnostics,
			extensions: loader.getExtensions().errors,
		},
	});
}

function seedSessionIfEmpty(
	sessionManager: SessionManager,
	input: PiCaseInput,
	participant: Participant,
	api: Api,
): { messageCount: number; entryCount: number } {
	if (sessionManager.getEntries().length > 0) return { messageCount: 0, entryCount: 0 };
	const seeded = seedMessages(input, participant, api);
	for (const message of seeded) sessionManager.appendMessage(message);
	return { messageCount: seeded.length, entryCount: sessionManager.getEntries().length };
}

interface PiRunContext {
	suitePath: string;
	variant: SubjectVariant;
	config: PiVariantConfig;
	input: PiCaseInput;
	participant: Participant;
	evaluationCase: EvaluationCase;
	limits: EvaluationLimits;
	signal: AbortSignal | undefined;
	grant: Parameters<SubjectAdapter["run"]>[0]["grant"];
	extensionFlagValues: Map<string, boolean | string> | undefined;
	errors: Array<Record<string, JsonValue>>;
	sandbox: string;
	isolatedAgentDir: string;
	cwd: string;
	configuredCwd: string | undefined;
}

interface PiRunState {
	seedMessageCount: number;
	seedEntryCount: number;
	resourceEvidence: JsonValue;
}

interface StartedRun {
	runtime: AgentSessionRuntime;
	sessionManager: SessionManager;
}

function prepareRunContext(args: Parameters<SubjectAdapter["run"]>[0]): PiRunContext {
	const { suitePath, variant, evaluationCase, participant, limits, signal, grant } = args;
	const config = parseVariant(variant);
	const extensionFlagValues = parseExtensionFlagValues(config.extensionFlags, variant.id);
	const input = parseCase(evaluationCase);
	const sandboxParent = resolve(args.runDirectory, "sandboxes");
	mkdirSync(sandboxParent, { recursive: true });
	const sandbox = mkdtempSync(resolve(sandboxParent, `${args.execution.executionId}-`));
	const isolatedAgentDir = resolve(sandbox, "agent");
	const configuredCwd = resolvePiCwd(variant, suitePath);
	const cwd = configuredCwd ?? resolve(sandbox, "cwd");
	mkdirSync(isolatedAgentDir, { recursive: true });
	if (configuredCwd === undefined) mkdirSync(cwd, { recursive: true });
	return {
		suitePath,
		variant,
		config,
		input,
		participant,
		evaluationCase,
		limits,
		signal,
		grant,
		extensionFlagValues,
		errors: [],
		sandbox,
		isolatedAgentDir,
		cwd,
		configuredCwd,
	};
}

async function startAgentRuntime(context: PiRunContext, state: PiRunState): Promise<StartedRun> {
	const { config, suitePath, participant, limits, cwd, isolatedAgentDir } = context;
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: false,
		...(context.grant.credentialSources.home
			? {}
			: { authPath: resolve(isolatedAgentDir, "auth.json"), modelsPath: null }),
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const additionalSkillPaths = (config.skills ?? []).map((resource) => resourcePath(resource.path, suitePath));
	const additionalExtensionPaths = (config.extensions ?? []).map((resource) => resourcePath(resource.path, suitePath));
	const templates = inlinePromptTemplates(config, context.variant.id);
	const additionalPromptTemplatePaths = (config.promptTemplates ?? []).flatMap((prompt) =>
		"path" in prompt.source ? [resourcePath(prompt.source.path, suitePath)] : [],
	);
	const sessionManager = SessionManager.inMemory(cwd);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: isolatedAgentDir,
			settingsManager,
			modelRuntime,
			extensionFlagValues: context.extensionFlagValues,
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
		const resolvedModel = await resolveExactModel(services, participant);
		const model = limitModelOutput(resolvedModel, limits.execution.maxOutputTokensEach);
		state.resourceEvidence = buildResourceEvidence({
			services,
			config,
			cwd,
			configuredCwd: context.configuredCwd,
			additionalSkillPaths,
			additionalExtensionPaths,
		});
		const seeded = seedSessionIfEmpty(sessionManager, context.input, participant, model.api);
		state.seedMessageCount = seeded.messageCount;
		state.seedEntryCount = seeded.entryCount;
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
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: isolatedAgentDir,
		sessionManager,
	});
	return { runtime, sessionManager };
}

function buildPiRunResult(args: {
	session: AgentSessionRuntime["session"];
	participant: Participant;
	allMessages: Message[];
	scoredTranscript: ReturnType<typeof scorePostSeedPiTranscript>;
	state: PiRunState;
	turns: number;
	thinkingChanges: string[];
	modelChanges: Array<{ provider: string; model: string }>;
	runEntries: JsonValue[];
	usage: UsageSummary;
	errors: Array<Record<string, JsonValue>>;
}) {
	const { session, participant, scoredTranscript, state } = args;
	const { assistant, output } = scoredTranscript;
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
				turns: args.turns,
				thinkingChanges: args.thinkingChanges,
				modelChanges: args.modelChanges,
				runEntries: args.runEntries,
				resources: state.resourceEvidence,
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
		events: normalizePiTranscript(args.allMessages),
		usage: args.usage,
		errors: args.errors,
	};
}

async function executePiSession(started: StartedRun, context: PiRunContext, state: PiRunState) {
	const { session } = started.runtime;
	const { config, evaluationCase, participant, limits, signal, errors } = context;
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
		await session.prompt(context.input.prompt, { expandPromptTemplates: true, source: "rpc" });
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
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult",
	);
	const scoredTranscript = scorePostSeedPiTranscript(
		allMessages,
		state.seedMessageCount,
		evaluationCase.checks,
		evaluationCase.id,
	);
	const { newMessages } = scoredTranscript;
	if (termination === "timeout") errors.push({ type: "Timeout", message: "The execution wall-time limit expired." });
	if (termination === "cancelled") errors.push({ type: "Cancelled", message: "The caller cancelled the execution." });
	const runEntryRecords = started.sessionManager.getEntries().slice(state.seedEntryCount);
	const usage = summarizeRunEntryUsage(runEntryRecords, participant);
	errors.push(...collectPiExecutionErrors(newMessages, usage, limits.execution.maxOutputTokensEach));
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
	return buildPiRunResult({
		session,
		participant,
		allMessages,
		scoredTranscript,
		state,
		turns,
		thinkingChanges,
		modelChanges,
		runEntries,
		usage,
		errors,
	});
}

async function disposeRuntime(runtime: AgentSessionRuntime | undefined, sandbox: string): Promise<void> {
	try {
		if (runtime) await runtime.dispose();
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}

async function runPiSubject(args: Parameters<SubjectAdapter["run"]>[0]) {
	throwIfCancelled(args.signal);
	const context = prepareRunContext(args);
	const state: PiRunState = { seedMessageCount: 0, seedEntryCount: 0, resourceEvidence: {} };
	let started: StartedRun | undefined;
	try {
		started = await startAgentRuntime(context, state);
		return await executePiSession(started, context, state);
	} finally {
		await disposeRuntime(started?.runtime, context.sandbox);
	}
}

export const piSdkAdapter: SubjectAdapter = {
	id: "pi-sdk",
	validate: validatePiCases,
	resolve: resolvePiSubject,
	run: runPiSubject,
};
