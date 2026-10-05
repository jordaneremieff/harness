/**
 * Native Pi Durable form of the stash extension.
 *
 * The ordinary entrypoint emits one contribution; the agent session host
 * installs the extension returned by `create(host)` beside its built-in tools.
 * The external stash store and its artifacts stay the single source of truth;
 * this module supplies the native tools, capacity guidance, distillation task,
 * and agent commands over that store.
 */
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, Message, Models, Static } from "@earendil-works/pi-ai";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { CAPACITY_NOTICE_HEADER, capacityConfig, capacityDirectiveLines } from "./capacity.ts";
import {
	type DistillPayload,
	buildDistillPrompt,
	DISTILL_SYSTEM_PROMPT,
	parseDistillPayload,
	prepareDistillSource,
} from "./distill.ts";
import {
	type DistillInput,
	type IndependentCommandLaunch,
	captureBranch,
	creationRequest,
	readDistillInput,
} from "./launch.ts";
import { resumeCommand } from "./format.ts";
import {
	STASH_COMPLETE_DESCRIPTION,
	STASH_EDIT_DESCRIPTION,
	STASH_LIST_DESCRIPTION,
	STASH_READ_DESCRIPTION,
	STASH_ROTATE_DESCRIPTION,
	STASH_SECTION_TEXT,
	STASH_WRITE_DESCRIPTION,
} from "./guidance.ts";
import { emptyListText, ListOutputSchema, recentListResult } from "./list-result.ts";
import { CompleteParams, EditParams, ListParams, ReadParams, RotateParams, WriteParams } from "./params.ts";
import { buildPickupMessage } from "./pickup.ts";
import { readStashResult } from "./read-result.ts";
import { redactPayload } from "./redact.ts";
import { searchStashes } from "./search.ts";
import {
	editStash,
	listStashes,
	readStash,
	resolveStash,
	resolveStoreDir,
	rotateStash,
	transitionStash,
	writeReplayableStash,
} from "./store.ts";
import { boundedOutput, sanitizeTerminalText } from "./text.ts";

/** What the host supplies to one Durable extension instance. */
export interface StashDurableHost {
	readonly durable: typeof Durable;
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	readonly launchIndependent: IndependentCommandLaunch;
	readonly signal: AbortSignal;
	/** Register a shutdown cleanup; the host awaits it after aborting the signal. */
	onClose(dispose: () => void | Promise<void>): void;
	readonly inventory: StashDurableInventory;
}

export interface StashDurableInventory {
	readonly contributions: readonly {
		readonly name: string;
		readonly source: string;
		readonly commands: readonly { readonly name: string; readonly description: string }[];
	}[];
	readonly ordinaryOnly: readonly string[];
}

export interface StashDurableCommand {
	readonly name: string;
	readonly description: string;
	run(call: StashDurableCommandCall): Promise<string>;
}

export interface StashDurableCommandCall {
	readonly args: string;
	readonly data?: JsonValue;
	readonly conversation: Durable.Conversation;
	/** The host's open Harness, for task-level control such as abortTask(). */
	readonly harness: Durable.Harness;
	readonly context: Context;
	readonly host: StashDurableHost;
	/** Unique per invocation and stable across retries of the same invocation. */
	readonly invocationId: string;
}

export interface StashDurableContribution {
	readonly name: string;
	readonly source: string;
	create(host: StashDurableHost): Durable.Extension;
	readonly commands?: readonly StashDurableCommand[];
}

const safe = (value: string) => sanitizeTerminalText(value).text;
const safeLine = (value: string) => safe(value).replace(/\n/g, "↵");

/** Copy tool details into JSON-closed values without undefined-valued keys. */
function jsonDetails(value: Record<string, unknown>): Durable.JsonObject {
	return JSON.parse(JSON.stringify(value)) as Durable.JsonObject;
}

function readFailure(result: Extract<Awaited<ReturnType<typeof readStash>>, { ok: false }>): Error {
	const candidates = result.candidates?.length ? ` Candidates: ${result.candidates.map(safeLine).join(", ")}.` : "";
	return new Error(`${safeLine(result.error)}.${candidates}`);
}

async function withStashTarget<T>(
	handovers: string,
	id: string,
	signal: AbortSignal | undefined,
	change: (dir: string, id: string) => Promise<T>,
): Promise<T> {
	if (signal?.aborted) throw new Error("stash lifecycle change cancelled");
	const target = await resolveStash(handovers, id);
	if ("error" in target) throw readFailure(target);
	return withFileMutationQueue(target.path, async () => {
		if (signal?.aborted) throw new Error("stash lifecycle change cancelled");
		return change(handovers, target.id);
	});
}

async function checkpointDirectory(cwd: string, handovers: string): Promise<string> {
	const override = process.env.PI_STASH_CHECKPOINT_DIR?.trim();
	const directory = override ? resolve(cwd, override) : join(handovers, "checkpoints");
	if (directory === handovers) throw new Error("The checkpoint directory must differ from PI_STASH_DIR.");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const checkpointPath = await realpath(directory);
	let handoverPath: string | undefined;
	try {
		handoverPath = await realpath(handovers);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (checkpointPath === handoverPath) throw new Error("The checkpoint directory must differ from PI_STASH_DIR.");
	return directory;
}

/** Current git branch through the call's environment; absent when unavailable. */
async function gitBranch(env: ExecutionEnv | undefined, context: Context): Promise<string | undefined> {
	if (!env) return undefined;
	let output = "";
	try {
		const result = await env.exec(
			"git branch --show-current",
			{
				cwd: env.cwd,
				onOutput: (chunk: string) => {
					if (output.length < 4096) output += chunk.slice(0, 4096 - output.length);
				},
			},
			context,
		);
		if (!result.ok || result.value.exitCode !== 0) return undefined;
	} catch {
		return undefined;
	}
	const branch = output.trim().split("\n")[0]?.trim();
	return branch ? branch : undefined;
}

/** Text content of a model message, ignoring non-text parts. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			const value = (part as { text?: unknown }).text;
			if (typeof value === "string") text += value;
		}
	}
	return text;
}

// ─── Capacity guidance ──────────────────────────────────────────────────────

type CapacityDocState = { episode: number };

interface CapacityEstimate {
	estimatedTokens: number;
	intakeTokens: number;
	contextWindow?: number;
	/** Which observation supplied estimatedTokens. */
	source: "reported_usage" | "request_text";
}

interface CapacityLatches {
	checkpoint: boolean;
	decision: boolean;
}

type CapacityMemo = { episode: number; conversation: string; text: string };

/** Total context tokens from provider usage, matching Pi's context-token calculation. */
function usageContextTokens(usage: AssistantMessage["usage"] | undefined): number {
	if (!usage) return 0;
	return usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Newest assistant usage Pi accepts: completed, non-error, and non-zero. */
function reportedUsageFor(messages: readonly Message[]): { message: AssistantMessage; index: number } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		if (usageContextTokens(message.usage) <= 0) continue;
		return { message, index };
	}
	return undefined;
}

function modelContextWindow(
	model: { readonly provider: string; readonly modelId: string } | undefined,
	models: Models,
): number | undefined {
	return model === undefined ? undefined : providerContextWindow(model.provider, model.modelId, models);
}

function providerContextWindow(provider: string, modelId: string, models: Models): number | undefined {
	const found = models.getModel(provider, modelId);
	return found && found.contextWindow > 0 ? found.contextWindow : undefined;
}

/**
 * Estimate context use the way Pi's host does: the newest accepted assistant
 * usage plus a text estimate for the messages after it. Without accepted usage,
 * the whole request text is the estimate. The context window comes from
 * `host.services.modelRuntime` for the usage's model, the stored agent model,
 * or the newest assistant's model.
 */
function estimateContext(
	messages: readonly Message[],
	models: Models,
	agentModel: { readonly provider: string; readonly modelId: string } | undefined,
): CapacityEstimate {
	let totalChars = 0;
	let intakeChars = 0;
	for (const message of messages) {
		const length = contentText(message.content).length;
		totalChars += length;
		if (message.role === "user" || message.role === "toolResult") intakeChars += length;
	}
	const reported = reportedUsageFor(messages);
	let contextWindow = reported
		? providerContextWindow(reported.message.provider, reported.message.model, models)
		: undefined;
	contextWindow ??= modelContextWindow(agentModel, models);
	for (let index = messages.length - 1; contextWindow === undefined && index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") contextWindow = providerContextWindow(message.provider, message.model, models);
	}
	const intakeTokens = Math.ceil(intakeChars / 4);
	if (!reported) {
		return { estimatedTokens: Math.ceil(totalChars / 4), intakeTokens, contextWindow, source: "request_text" };
	}
	let trailingChars = 0;
	for (let index = reported.index + 1; index < messages.length; index++)
		trailingChars += contentText(messages[index]?.content).length;
	return {
		estimatedTokens: usageContextTokens(reported.message.usage) + Math.ceil(trailingChars / 4),
		intakeTokens,
		contextWindow,
		source: "reported_usage",
	};
}

function scanCapacityNotices(messages: readonly Message[], episode: number, conversation: string): CapacityLatches {
	const prefix = `[stash-capacity e=${episode} c=${conversation}`;
	const latches: CapacityLatches = { checkpoint: false, decision: false };
	for (const message of messages) {
		const text = contentText(message.content);
		let index = text.indexOf(prefix);
		while (index >= 0) {
			const end = text.indexOf("]", index);
			if (end < 0) break;
			const tokens = text.slice(index + 1, end).split(/\s+/);
			if (tokens.includes("checkpoint")) latches.checkpoint = true;
			if (tokens.includes("decision")) latches.decision = true;
			index = text.indexOf(prefix, end + 1);
		}
	}
	return latches;
}

function capacityRequest(
	estimate: CapacityEstimate,
	latches: CapacityLatches,
	config: ReturnType<typeof capacityConfig>,
): CapacityLatches {
	if (estimate.contextWindow !== undefined) {
		const percent = (estimate.estimatedTokens / estimate.contextWindow) * 100;
		return {
			checkpoint: !latches.checkpoint && percent >= config.checkpointPercent,
			decision: !latches.decision && percent >= config.decisionPercent,
		};
	}
	const overBudget = config.intakeTokenBudget !== undefined && estimate.intakeTokens >= config.intakeTokenBudget;
	return {
		checkpoint: !latches.checkpoint && overBudget,
		decision: !latches.decision && overBudget,
	};
}

function capacityObservation(estimate: CapacityEstimate): string {
	if (estimate.contextWindow !== undefined) {
		const percent = (estimate.estimatedTokens / estimate.contextWindow) * 100;
		const total = `${percent.toFixed(1)}% (${formatCount(estimate.estimatedTokens)} tokens of ${formatCount(estimate.contextWindow)})`;
		return estimate.source === "reported_usage"
			? `The newest reported assistant usage plus an estimate for later messages gives ${total}. This is not a live provider reading or a safe remaining budget.`
			: `No accepted assistant usage is available. Request text estimates context use at ${total}. This is an estimate, not a provider count or a safe remaining budget.`;
	}
	return `Current context use is unknown. Estimated text intake reached ${formatCount(estimate.intakeTokens)} tokens (text characters / 4, not a context percentage).`;
}

function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`;
	return `${Math.round(value / 100_000) / 10}M`;
}

function capacityNoticeText(
	estimate: CapacityEstimate,
	request: CapacityLatches,
	episode: number,
	conversation: string,
): string {
	const marker = `[stash-capacity e=${episode} c=${conversation}${request.checkpoint ? " checkpoint" : ""}${request.decision ? " decision" : ""}]`;
	return [
		CAPACITY_NOTICE_HEADER,
		capacityObservation(estimate),
		...capacityDirectiveLines(request.checkpoint, request.decision),
		marker,
	].join("\n\n");
}

// ─── Independent creation ──────────────────────────────────────────────────

type DistillReceipt = {
	status: "completed" | "failed" | "skipped" | "invalid" | "aborted";
	id?: string;
	path?: string;
	title?: string;
	message?: string;
};

type DistillReceiptState = { invocationId?: string; taskId?: number; last?: DistillReceipt };
type CapturedCreation = { input?: Durable.JsonObject };

type DistillTaskState =
	| { phase: "generate"; attempt: number }
	| { phase: "write"; payload: DistillPayload; createdAtMs: number };

// ─── Commands ───────────────────────────────────────────────────────────────

interface StashBinding {
	readonly storeDir: string;
	readonly capacityDoc: Durable.ConversationDocToken<CapacityDocState>;
	readonly receiptDoc: Durable.ConversationDocToken<DistillReceiptState>;
	readonly launchDoc: Durable.ConversationDocFamilyToken<CapturedCreation, null>;
	createDistillTask(
		tx: Durable.Tx,
		conversationId: Durable.ConversationId,
		input: DistillInput,
	): Promise<Durable.TaskId>;
}

const bindings = new WeakMap<StashDurableHost, StashBinding>();

const STASH_DURABLE_USAGE = [
	"/stash — session-continuity handovers (Durable)",
	"",
	"Create:",
	"  /stash new <hint>           create an independent Durable handover; find it through stash_list",
	"",
	"Retrieve & manage:",
	"  /stash get <id> [note]      activate a handover and queue it as the next message",
	"  /stash complete <id> <out>  close an open or active stash with a concrete outcome",
	"  /stash release <id>         return an active stash to open",
	"  /stash reopen <id>          return a closed stash to open",
	"  /stash rotate <id>          archive a stale stash (recoverable)",
	"  /stash capacity [reset]     inspect or explicitly restart the capacity episode",
	"  /stash help                 show this usage",
	"",
	"  <id> may be a full stash id or a unique prefix.",
].join("\n");

function bindingOrThrow(host: StashDurableHost): StashBinding {
	const binding = bindings.get(host);
	if (!binding) throw new Error("The stash Durable extension is not installed for this host.");
	return binding;
}

async function runStashCommand(call: StashDurableCommandCall): Promise<string> {
	const binding = bindingOrThrow(call.host);
	const parts = call.args.trim().split(/\s+/).filter(Boolean);
	const verb = parts[0];
	switch (verb) {
		case "new":
			return await startDistillCommand(binding, call, parts);
		case "get":
			return await pickupCommand(binding, call, parts);
		case "complete":
			return await completeCommand(binding, call.context, parts);
		case "release":
		case "reopen":
		case "rotate":
			return await lifecycleCommand(binding, call.context, verb, parts);
		case "capacity":
			return await capacityCommand(binding, call.conversation, call.context, call.host, parts);
		case "help":
		case undefined:
			return STASH_DURABLE_USAGE;
		default:
			throw new Error(`Unknown /stash action "${safeLine(verb ?? "")}". Use /stash help.`);
	}
}

/** Capture on the caller; structured input admits work only in the independent root. */
async function startDistillCommand(
	binding: StashBinding,
	call: StashDurableCommandCall,
	parts: string[],
): Promise<string> {
	if (call.data !== undefined) {
		const input = readDistillInput(call.data);
		const taskId = await call.conversation.commit(async (tx) => {
			const receipt = await tx.doc(binding.receiptDoc, call.conversation.id);
			if (receipt.invocationId !== undefined) {
				if (receipt.invocationId !== call.invocationId)
					throw new Error("This stash worker already owns another invocation.");
				return receipt.taskId;
			}
			await call.host.durable.configure(tx, call.conversation.id, {
				extensions: [],
				tools: [],
				instructions: DISTILL_SYSTEM_PROMPT,
			});
			const id = await binding.createDistillTask(tx, call.conversation.id, input);
			receipt.invocationId = call.invocationId;
			receipt.taskId = id;
			return id;
		}, call.context);
		return `Stash creation admitted as task ${taskId}.`;
	}
	const hint = parts.slice(1).join(" ").trim();
	if (!hint) throw new Error("Usage: /stash new <hint>");
	if (typeof call.host.launchIndependent !== "function")
		throw new Error("Stash creation requires an independent Durable host provider.");
	const input = await captureNativeCreation(binding, call, hint);
	await call.host.launchIndependent(creationRequest(input, call.invocationId));
	return "";
}

function matchingCreation(data: JsonValue, hint: string): DistillInput {
	const input = readDistillInput(data);
	if (input.hint !== hint) throw new Error("This stash invocation already owns a different hint.");
	return input;
}

/** Command retries retain the first snapshot, including after an uncertain admission response. */
async function captureNativeCreation(
	binding: StashBinding,
	call: StashDurableCommandCall,
	hint: string,
): Promise<DistillInput> {
	const saved = await call.harness.snapshot(binding.launchDoc, call.conversation.id, call.invocationId, call.context);
	if (saved?.input) return matchingCreation(saved.input, hint);
	const source = prepareDistillSource({
		entries: [{ messages: (await call.conversation.context(call.context)).messages }],
	});
	const agent = await call.conversation.agent(call.context);
	const project = agent.cwd ?? call.host.cwd;
	const sessionId =
		call.conversation.id === call.host.durable.ROOT_CONVERSATION_ID
			? call.host.storageId
			: `${call.host.storageId}:${call.conversation.id}`;
	const storeDir = resolve(project, binding.storeDir);
	const branch = await captureBranch(project, call.context.abortSignal);
	const input = jsonDetails({ ...source, hint, project, sessionId, storeDir, ...(branch ? { branch } : {}) });
	return call.conversation.commit(async (tx) => {
		const doc = await tx.doc(binding.launchDoc, call.conversation.id, call.invocationId, null);
		doc.input ??= input;
		return matchingCreation(doc.input, hint);
	}, call.context);
}

async function pickupCommand(binding: StashBinding, call: StashDurableCommandCall, parts: string[]): Promise<string> {
	const { conversation, context, invocationId } = call;
	const id = parts[1];
	if (!id) throw new Error("Usage: /stash get <id> [note]");
	const note = parts.slice(2).join(" ").trim() || undefined;
	const activated = await withStashTarget(binding.storeDir, id, context.abortSignal, (dir, targetId) =>
		transitionStash(dir, targetId, { action: "activate" }),
	);
	const agent = await conversation.agent(context);
	const message = buildPickupMessage(activated.id, activated.content, {
		currentCwd: agent.cwd,
		note,
		activatedAt: activated.changed ? undefined : activated.meta.activatedAt,
	});
	// The invocation identity is the durable submission key: a retry of this
	// invocation reuses its submission, while a second identical invocation
	// (a new id) is a new request.
	const submission = await conversation.submit(
		{ type: "input", content: message, whenBusy: "followUp", requestId: `stash-pickup:${invocationId}` },
		context,
	);
	return `Stash ${activated.id} is active and queued for pickup (submission ${submission.id}).`;
}

async function completeCommand(binding: StashBinding, context: Context, parts: string[]): Promise<string> {
	const id = parts[1];
	const outcome = parts.slice(2).join(" ");
	if (!id || !outcome) throw new Error("Usage: /stash complete <id> <concrete outcome>");
	const transitioned = await withStashTarget(binding.storeDir, id, context.abortSignal, (dir, targetId) =>
		transitionStash(dir, targetId, { action: "close", outcome }),
	);
	return `Closed stash ${transitioned.id}.\nOutcome: ${safeLine(transitioned.meta.outcome ?? outcome.trim())}`;
}

async function lifecycleCommand(
	binding: StashBinding,
	context: Context,
	verb: "release" | "reopen" | "rotate",
	parts: string[],
): Promise<string> {
	const id = parts[1];
	if (!id || parts.length !== 2) throw new Error(`Usage: /stash ${verb} <id>`);
	if (verb === "rotate") {
		const rotated = await withStashTarget(binding.storeDir, id, context.abortSignal, (dir, targetId) =>
			rotateStash(dir, targetId),
		);
		return `Rotated stash ${rotated.id} to the stash archive.`;
	}
	const transitioned = await withStashTarget(binding.storeDir, id, context.abortSignal, (dir, targetId) =>
		transitionStash(dir, targetId, { action: verb }),
	);
	return verb === "release" ? `Released stash ${transitioned.id} back to open.` : `Reopened stash ${transitioned.id}.`;
}

async function capacityCommand(
	binding: StashBinding,
	conversation: Durable.Conversation,
	context: Context,
	host: StashDurableHost,
	parts: string[],
): Promise<string> {
	if (parts.length > 2 || (parts[1] !== undefined && parts[1] !== "reset")) {
		throw new Error("Usage: /stash capacity [reset]");
	}
	let config: ReturnType<typeof capacityConfig>;
	try {
		config = capacityConfig(process.env);
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}
	if (parts[1] === "reset") {
		const episode = await conversation.commit(async (tx) => {
			const doc = await tx.doc(binding.capacityDoc, conversation.id);
			doc.episode += 1;
			return doc.episode;
		}, context);
		return [
			`Stash capacity episode reset to ${episode}.`,
			`Thresholds: checkpoint ${config.checkpointPercent}%; continuity decision ${config.decisionPercent}%.`,
			"Old notices in the context no longer latch; a new crossing can issue one request each.",
		].join("\n");
	}
	const view = await conversation.context(context);
	const agent = await conversation.agent(context);
	const episode = await conversation.commit(
		async (tx) => (await tx.doc(binding.capacityDoc, conversation.id)).episode,
		context,
	);
	const estimate = estimateContext(view.messages, host.services.modelRuntime, agent.model);
	const latches = scanCapacityNotices(view.messages, episode, String(conversation.id));
	return [
		`Stash capacity: ${config.enabled ? "enabled" : "disabled"}.`,
		`Thresholds: checkpoint ${config.checkpointPercent}%; continuity decision ${config.decisionPercent}%.`,
		config.enabled ? `${capacityObservation(estimate)}` : "Observation is disabled by PI_STASH_CAPACITY=0.",
		`Episode ${episode} notices in the active context: checkpoint ${latches.checkpoint}; decision ${latches.decision}.`,
		`Estimated text intake: ${formatCount(estimate.intakeTokens)} tokens; configured budget: ${config.intakeTokenBudget ?? "none"}.`,
		"Requests do not prove a checkpoint was saved. /stash capacity reset explicitly starts a new episode.",
	].join("\n");
}

// ─── Contribution ───────────────────────────────────────────────────────────

type ListToolParams = Static<typeof ListParams>;

async function searchListResult(
	storeDir: string,
	params: ListToolParams & { query: string },
	signal: AbortSignal | undefined,
) {
	const page = await searchStashes(storeDir, params, signal);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(page) }],
		details: jsonDetails({
			...page,
			structuredContent: { ...page, matches: page.matches.map((match) => ({ ...match })) },
		}),
	};
}

async function recentListResultFor(storeDir: string, params: ListToolParams) {
	const limit = params.limit ?? 10;
	const entries = await listStashes(storeDir, { limit, tag: params.tag, state: params.state });
	const result = recentListResult(entries, limit, emptyListText(params.tag, params.state));
	return {
		content: result.content,
		details: jsonDetails({ ...(result.details ?? {}), structuredContent: result.structuredContent }),
		...(result.isError === undefined ? {} : { isError: result.isError }),
	};
}

function listErrorResult(error: unknown, signal: AbortSignal | undefined) {
	if (signal?.aborted) throw error;
	const text = boundedOutput(error instanceof Error ? error.message : String(error)).text;
	return {
		content: [{ type: "text" as const, text }],
		details: jsonDetails({
			structuredContent: {
				kind: "error",
				error: Array.from(safe(text)).slice(0, 1024).join(""),
				coverage: { complete: false },
				nextCursor: null,
			},
		}),
		isError: true,
	};
}

/** Build the contribution the ordinary factory emits. */
export function stashDurableContribution(source: string): StashDurableContribution {
	return {
		name: "stash",
		source,
		create: createStashDurableExtension,
		commands: [
			{
				name: "stash",
				description: "Create, get, complete, release, reopen, rotate, or inspect stashed efforts",
				run: runStashCommand,
			},
		],
	};
}

/** Build the native Durable extension for one session host. */
export function createStashDurableExtension(host: StashDurableHost): Durable.Extension {
	const storeDir = resolveStoreDir(process.env, host.agentDir);

	const capacityDoc = host.durable.defineDoc<CapacityDocState>({
		kind: "stash.capacity",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		initial: () => ({ episode: 1 }),
	});
	const launchDoc = host.durable.defineDocFamily<CapturedCreation, null>({
		kind: "stash.launch",
		version: 1,
		family: true,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		initial: () => ({}),
	});
	const receiptDoc = host.durable.defineDoc<DistillReceiptState>({
		kind: "stash.distill",
		version: 2,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		initial: () => ({}),
	});

	const writeTool = host.durable.defineTool<typeof WriteParams, Durable.JsonObject>({
		name: "stash_write",
		description: STASH_WRITE_DESCRIPTION,
		parameters: WriteParams,
		replay: "safe",
		execute: async (params, api, context) => {
			const agent = await api.agent(context);
			const cwd = api.env?.cwd ?? agent.cwd ?? host.cwd;
			const branch = await gitBranch(api.env, context);
			const sessionId = String(api.conversationId);
			const intent = await api.memo("stash.write", { createdAtMs: Date.now() }, context);
			try {
				const destination = params.checkpoint ? await checkpointDirectory(cwd, storeDir) : storeDir;
				const { record, path } = await writeReplayableStash(
					destination,
					{ ...redactPayload(params), project: cwd, branch, sessionId },
					new Date(intent.createdAtMs),
				);
				if (params.checkpoint) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Saved working checkpoint "${safeLine(record.title)}".\n${safeLine(path)}\nRead this file to recover the synthesis. It is not listed by stash_list and has no /stash pickup shortcut.`,
							},
						],
						details: { path, checkpoint: true },
					};
				}
				const text = [
					`Stashed "${safeLine(record.title)}" as ${record.id}`,
					safeLine(path),
					"",
					"Resume in a new session:",
					`  ${resumeCommand(record.id)}`,
				].join("\n");
				return {
					content: [{ type: "text" as const, text }],
					details: jsonDetails({ id: record.id, path, state: record.state }),
				};
			} catch (error) {
				throw new Error(`stash_write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	const listTool = host.durable.defineTool<typeof ListParams, Durable.JsonObject>({
		name: "stash_list",
		description: STASH_LIST_DESCRIPTION,
		parameters: ListParams,
		replay: "safe",
		execute: async (params, _api, context) => {
			try {
				const query = params.query;
				if (query !== undefined) return await searchListResult(storeDir, { ...params, query }, context.abortSignal);
				if (params.cursor !== undefined)
					throw new Error("cursor requires query; repeat the original query and filters");
				return await recentListResultFor(storeDir, params);
			} catch (error) {
				return listErrorResult(error, context.abortSignal);
			}
		},
	});

	const readTool = host.durable.defineTool<typeof ReadParams, Durable.JsonObject>({
		name: "stash_read",
		description: STASH_READ_DESCRIPTION,
		parameters: ReadParams,
		replay: "safe",
		execute: async (params, _api, _context) => {
			const result = await readStash(storeDir, params.id);
			if ("error" in result) throw readFailure(result);
			const read = readStashResult(result);
			return { content: read.content, details: jsonDetails(read.details) };
		},
	});

	const editTool = host.durable.defineTool<typeof EditParams, Durable.JsonObject>({
		name: "stash_edit",
		description: STASH_EDIT_DESCRIPTION,
		parameters: EditParams,
		replay: "unsafe",
		executionMode: "sequential" as const,
		execute: async (params, _api, context) => {
			const result = await withStashTarget(storeDir, params.id, context.abortSignal, (dir, targetId) =>
				editStash(dir, targetId, params, context.abortSignal),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`${result.changed ? "Updated" : "Unchanged"} stash ${result.id}.`,
							`State: ${result.meta.state} (unchanged).`,
							`Digest: ${result.digest}`,
						].join("\n"),
					},
				],
				details: jsonDetails({
					id: result.id,
					path: result.path,
					state: result.meta.state,
					digest: result.digest,
					changed: result.changed,
				}),
			};
		},
	});

	const completeTool = host.durable.defineTool<typeof CompleteParams, Durable.JsonObject>({
		name: "stash_complete",
		description: STASH_COMPLETE_DESCRIPTION,
		parameters: CompleteParams,
		replay: "unsafe",
		executionMode: "sequential" as const,
		execute: async (params, _api, context) => {
			const transitioned = await withStashTarget(storeDir, params.id, context.abortSignal, (dir, targetId) =>
				transitionStash(dir, targetId, { action: "close", outcome: params.outcome }),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Closed stash ${transitioned.id}.\nOutcome: ${safeLine(transitioned.meta.outcome ?? params.outcome.trim())}`,
					},
				],
				details: jsonDetails({
					id: transitioned.id,
					path: transitioned.path,
					state: transitioned.meta.state,
					closedAt: transitioned.meta.closedAt,
					outcome: transitioned.meta.outcome,
				}),
			};
		},
	});

	const rotateTool = host.durable.defineTool<typeof RotateParams, Durable.JsonObject>({
		name: "stash_rotate",
		description: STASH_ROTATE_DESCRIPTION,
		parameters: RotateParams,
		replay: "unsafe",
		executionMode: "sequential" as const,
		execute: async (params, _api, context) => {
			const rotated = await withStashTarget(storeDir, params.id, context.abortSignal, (dir, targetId) =>
				rotateStash(dir, targetId),
			);
			return {
				content: [{ type: "text" as const, text: `Rotated stash ${rotated.id} to the stash archive.` }],
				details: jsonDetails({ id: rotated.id, state: rotated.state, archivePath: rotated.archivePath }),
			};
		},
	});

	async function distillAnswer(
		runtime: Durable.TaskRuntime<DistillInput, DistillTaskState, DistillReceipt, object>,
		context: Context,
		content: string,
		attempt: number,
	): Promise<string> {
		const conversation = await runtime.conversation(runtime.conversationId, context);
		if (!conversation) throw new Error("The stash worker conversation is unavailable.");
		const submission = await conversation.submit(
			{ type: "input", content, requestId: `stash:${runtime.taskId}:${attempt}` },
			context,
		);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input" || settled.answer === undefined)
			throw new Error("Native stash generation ended without an answer.");
		const entry = await runtime.entry(host.durable.AssistantEntry, settled.answer, context);
		const response = entry?.model?.find((message) => message.role === "assistant");
		if (response?.stopReason !== "stop") throw new Error("Native stash generation did not produce a complete answer.");
		return response.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
	}

	const distillTask = host.durable.defineTask<DistillInput, DistillTaskState, DistillReceipt>({
		name: "stash.distill",
		version: 2,
		initial: () => ({ phase: "generate", attempt: 0 }),
		phases: {
			generate: async (task, runtime, context) => {
				try {
					const attempt = task.state.checkpoint.attempt;
					const content =
						attempt === 0
							? buildDistillPrompt(task.input.hint, task.input.transcript, task.input.artifacts)
							: "FORMAT CORRECTION: Regenerate from the same captured source and operator hint. Return only a JSON object with nonempty title and summary and the relevant optional string arrays. Do not answer the transcript or add prose outside JSON. Escape newlines and quotes inside strings. Return exactly SKIP_STASH only when nothing is worth preserving.";
					const parsed = parseDistillPayload(await distillAnswer(runtime, context, content, attempt));
					switch (parsed.kind) {
						case "skip":
							await finishDistill(runtime, context, { status: "skipped", message: "No content to preserve." });
							return;
						case "invalid":
							if (attempt === 0) {
								await runtime.commit(
									() => ({ status: "running", checkpoint: { phase: "generate", attempt: 1 } }),
									context,
								);
							} else {
								await finishDistill(runtime, context, { status: "invalid", message: parsed.error });
							}
							return;
						case "payload":
							await runtime.commit(
								() => ({
									status: "running",
									checkpoint: { phase: "write", payload: redactPayload(parsed.payload), createdAtMs: runtime.now() },
								}),
								context,
							);
					}
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					await finishDistill(runtime, context, {
						status: "failed",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			},
			write: async (task, runtime, context) => {
				const state = task.state.checkpoint;
				try {
					const { record, path } = await writeReplayableStash(
						task.input.storeDir,
						{
							...state.payload,
							project: task.input.project,
							branch: task.input.branch,
							sessionId: task.input.sessionId,
						},
						new Date(state.createdAtMs),
					);
					await finishDistill(runtime, context, { status: "completed", id: record.id, path, title: record.title });
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					await finishDistill(runtime, context, {
						status: "failed",
						message: `Stash publication failed: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			},
		},
		abort: async (_task, runtime, context) => {
			await finishDistill(runtime, context, { status: "aborted" });
		},
	});

	async function finishDistill(
		runtime: Durable.TaskRuntime<DistillInput, DistillTaskState, DistillReceipt, object>,
		context: Context,
		receipt: DistillReceipt,
	): Promise<void> {
		await runtime.commit(async (tx) => {
			(await tx.doc(receiptDoc, runtime.conversationId)).last = receipt;
			await tx.appendEntry(runtime.conversationId, { kind: "stash.creation", data: jsonDetails(receipt) });
			return {
				status: "terminal",
				outcome:
					receipt.status === "aborted"
						? { status: "aborted" }
						: receipt.status === "failed"
							? { status: "failed", error: { message: receipt.message ?? "Stash creation failed." } }
							: { status: "completed", result: receipt },
			};
		}, context);
	}

	bindings.set(host, {
		storeDir,
		capacityDoc,
		receiptDoc,
		launchDoc,
		createDistillTask: (tx, conversationId, input) =>
			tx.createTask(distillTask, input, { ownership: { kind: "conversation" }, conversationId, background: true }),
	});

	return host.durable.defineExtension({
		name: "stash",
		sections: [host.durable.section("stash", () => STASH_SECTION_TEXT)],
		tools: [writeTool, { ...listTool, outputSchema: ListOutputSchema }, readTool, editTool, completeTool, rotateTool],
		hooks: [
			host.durable.hook(host.durable.GenerationTask, {
				beforeRequest: async (request, api, context) => {
					const config = capacityConfig(process.env);
					if (!config.enabled) return undefined;
					const conversation = String(api.conversationId);
					const doc = await api.snapshot(capacityDoc, api.conversationId, context);
					const episode = doc?.episode ?? 1;
					const pending = await api.memo<CapacityMemo>("capacity", context);
					if (pending !== undefined && pending.episode === episode && pending.conversation === conversation) {
						return undefined;
					}
					const latches = scanCapacityNotices(request.messages, episode, conversation);
					const agent = await api.snapshot(host.durable.AgentDoc, api.conversationId, context);
					const estimate = estimateContext(request.messages, host.services.modelRuntime, agent?.model);
					const crossing = capacityRequest(estimate, latches, config);
					if (!crossing.checkpoint && !crossing.decision) return undefined;
					await api.memo(
						"capacity",
						{ episode, conversation, text: capacityNoticeText(estimate, crossing, episode, conversation) },
						context,
					);
					return undefined;
				},
				onYield: async (_answer: AssistantMessage, api, context) => {
					const pending = await api.memo<CapacityMemo>("capacity", context);
					if (pending === undefined) return undefined;
					const doc = await api.snapshot(capacityDoc, api.conversationId, context);
					const episode = doc?.episode ?? 1;
					if (pending.episode !== episode || pending.conversation !== String(api.conversationId)) return undefined;
					return { continue: pending.text };
				},
			}),
		],
		tasks: [distillTask],
	});
}
