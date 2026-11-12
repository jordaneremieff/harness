/** Session continuity tools plus the interactive /stash pickup workflow. */

import type { Static } from "@earendil-works/pi-schema";
import { toolDisplayPublisher } from "./tool-display.ts";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentToolResult,
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type TurnEndEvent,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { publishSettings, readSettings } from "./settings.ts";
import { artifactId, collectionDirectory, collectionFilter, collectionId } from "./collection.ts";
import {
	CAPACITY_STATE,
	capacityConfig,
	capacityReset,
	capacityStatus,
	capacityTurnEnd,
	band, capacityEpisode, continuityTools, gate, gateState, gateStatus, measureUsage, piAutoThreshold,
	type GateState,
} from "./capacity.ts";
import { budgetAction, budgetContext, budgetNotice, budgetStatus, ORDINARY_COST, type SessionBudget } from "./budget.ts";
import { prepareDistillSource } from "./distill.ts";
import { stashDurableContribution } from "./durable.ts";
import { resumeCommand, stateLabel } from "./format.ts";
import {
	STASH_COMPLETE_DESCRIPTION,
	STASH_COMPLETE_GUIDANCE,
	STASH_EDIT_DESCRIPTION,
	STASH_EDIT_GUIDANCE,
	STASH_LIST_DESCRIPTION,
	STASH_LIST_GUIDANCE,
	STASH_READ_DESCRIPTION,
	STASH_ROTATE_DESCRIPTION,
	STASH_ROTATE_GUIDANCE,
	STASH_WRITE_DESCRIPTION,
	STASH_WRITE_GUIDANCE,
} from "./guidance.ts";
import { captureHint, creationRequest, independentLauncher } from "./launch.ts";
import { emptyListText, ListOutputSchema, recentListResult } from "./list-result.ts";
import { LoadingView, openOperatorFrame, publishOperatorViews, type OperatorView, type ViewHost } from "../../operator-ui/registration.ts";
import { loadArchive, loadRecent, loadSelectedPreview } from "./browser-views.ts";
import type { StashOperations, StashViewState } from "./operator-view.ts";
import { CompleteParams, EditParams, ListParams, ReadParams, RotateParams, WriteParams } from "./params.ts";
import { buildPickupMessage } from "./pickup.ts";
import {
	renderCompleteCall,
	renderCompleteResult,
	renderEditCall,
	renderEditResult,
	renderListCall,
	renderListResult,
	renderReadCall,
	renderReadResult,
	renderRotateCall,
	renderRotateResult,
	renderWriteCall,
	renderWriteResult,
} from "./presentation.ts";
import { readStashResult } from "./read-result.ts";
import { mergeRedactionReports, type RedactionReport, redactionNotice, redactSecretsWithReport } from "./redact.ts";
import { searchStashes } from "./search.ts";
import {
	editStash,
	listStashes,
	readStash,
	resolveStash,
	resolveStoreDir,
	rotateStash,
	type StashLifecycleChange,
	transitionStash,
	writeStash,
} from "./store.ts";
import { boundedOutput, sanitizeTerminalText } from "./text.ts";

type StashExecutionApi = Pick<ExtensionAPI, "exec">;
type StashMessageApi = Pick<ExtensionAPI, "sendUserMessage">;
type StashExtensionApi = Pick<
	ExtensionAPI,
	| "events"
	| "getSettings"
	| "getCommands"
	| "exec"
	| "registerCommand"
	| "registerShortcut"
	| "registerTool"
	| "sendUserMessage"
	| "sendMessage"
	| "on"
	| "appendEntry"
>;

const storeDir = () => resolveStoreDir(process.env, getAgentDir());
/** This extension's entrypoint; the ordinary frame binds the published view to its /stash registration. */
const OWNER = fileURLToPath(import.meta.url);

async function checkpointDirectory(): Promise<string> {
	const { dir: handovers, checkpointDir: directory } = readSettings({ agentDir: getAgentDir() }).values;
	if (directory === handovers) throw new Error("The checkpoint directory must differ from stash.dir.");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const checkpointPath = await realpath(directory);
	let handoverPath: string | undefined;
	try {
		handoverPath = await realpath(handovers);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (checkpointPath === handoverPath) throw new Error("The checkpoint directory must differ from stash.dir.");
	return directory;
}
const safe = (value: string) => sanitizeTerminalText(value).text;
const safeLine = (value: string) => safe(value).replace(/\n/g, "↵");
const noticeSuffix = (report: RedactionReport) => (report.count ? `\n${redactionNotice(report)}` : "");

function notifyCommandRedactions(
	pi: Pick<ExtensionAPI, "sendMessage">,
	ctx: Pick<ExtensionContext, "hasUI">,
	redactions: RedactionReport,
): void {
	if (!redactions.count) return;
	const notice = redactionNotice(redactions);
	pi.sendMessage(
		{ customType: "stash-redaction", content: notice, display: true, details: { redactions } },
		{ triggerTurn: false },
	);
	// Text print ignores custom messages; stderr is its direct notice transport.
	if (!ctx.hasUI) console.error(notice);
}

async function currentBranch(pi: StashExecutionApi, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["branch", "--show-current"], { cwd, signal });
		return result.code === 0 ? result.stdout.trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}

function currentSessionId(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	try {
		return ctx.sessionManager.getSessionId() ?? process.env.PI_SESSION_ID;
	} catch {
		return process.env.PI_SESSION_ID;
	}
}

class CreationStatus {
	private pending = new Set<symbol>();
	private ui: ExtensionContext["ui"] | undefined;
	closed = false;

	begin(ctx: ExtensionContext): () => void {
		if (this.closed || !ctx.hasUI) return () => {};
		const token = Symbol();
		this.pending.add(token);
		this.ui = ctx.ui;
		this.ui.setStatus("stash", "Starting stash creation…");
		return () => {
			if (!this.pending.delete(token) || this.closed) return;
			if (this.pending.size === 0) {
				this.ui?.setStatus("stash", undefined);
				this.ui = undefined;
			}
		};
	}

	close(): void {
		this.closed = true;
		this.pending.clear();
		this.ui?.setStatus("stash", undefined);
		this.ui = undefined;
	}
}

async function startCreation(
	pi: StashExtensionApi,
	ctx: ExtensionCommandContext,
	hint: string,
	status: CreationStatus,
): Promise<void> {
	const finishStatus = status.begin(ctx);
	try {
		// Materialize before the first await; subsequent caller turns cannot alter this source.
		const source = prepareDistillSource(ctx.sessionManager.buildSessionProjection());
		const capturedHint = captureHint(hint);
		const redactions = mergeRedactionReports(source.redactions, capturedHint.redactions);
		notifyCommandRedactions(pi, ctx, redactions);
		const project = ctx.cwd;
		const sessionId = currentSessionId(ctx);
		if (!sessionId) throw new Error("The source session identity is unavailable.");
		const destination = resolve(project, storeDir());
		const launch = independentLauncher(pi.events);
		const invocationId = randomUUID();
		const branch = await currentBranch(pi, project);
		await launch(
			creationRequest(
				{
					...source,
					...capturedHint,
					redactions,
					project,
					sessionId,
					storeDir: destination,
					...(branch ? { branch } : {}),
				},
				invocationId,
			),
		);
	} catch (error) {
		if (status.closed && ctx.hasUI) return;
		const scanned = redactSecretsWithReport(error instanceof Error ? error.message : String(error));
		notifyCommandRedactions(pi, ctx, scanned.report);
		const message = `Could not start stash creation: ${safeLine(scanned.text)}`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else throw new Error(message);
	} finally {
		finishStatus();
	}
}

function readFailure(result: Extract<Awaited<ReturnType<typeof readStash>>, { ok: false }>): Error {
	const candidates = result.candidates?.length ? ` Candidates: ${result.candidates.map(safeLine).join(", ")}.` : "";
	return new Error(`${safeLine(result.error)}.${candidates}`);
}

async function withStashTarget<T>(
	id: string,
	signal: AbortSignal | undefined,
	change: (dir: string, id: string) => Promise<T>,
): Promise<T> {
	if (signal?.aborted) throw new Error("stash lifecycle change cancelled");
	const dir = storeDir();
	const target = await resolveStash(dir, id);
	if ("error" in target) throw readFailure(target);
	return withFileMutationQueue(target.path, async () => {
		if (signal?.aborted) throw new Error("stash lifecycle change cancelled");
		return change(dir, target.id);
	});
}

const changeLifecycle = (id: string, change: StashLifecycleChange, signal?: AbortSignal) =>
	withStashTarget(id, signal, (dir, targetId) => transitionStash(dir, targetId, change, undefined, signal));

const rotateLifecycle = (id: string, signal?: AbortSignal) =>
	withStashTarget(id, signal, (dir, targetId) => rotateStash(dir, targetId, signal));

/** Reserved first-token actions exposed by `/stash` autocomplete. */
const STASH_VERBS: ReadonlyArray<{ value: string; label: string; description: string }> = [
	{ value: "new", label: "new", description: "<hint> · distill the live session into a new stash" },
	{ value: "get", label: "get", description: "<id> [note] · pick up, optionally with an operator note" },
	{ value: "complete", label: "complete", description: "<id> <outcome> · close an open or active stash" },
	{ value: "release", label: "release", description: "<id> · return an active stash to open" },
	{ value: "reopen", label: "reopen", description: "<id> · return a closed stash to open" },
	{ value: "rotate", label: "rotate", description: "<id> · archive a stale stash (recoverable)" },
	{
		value: "capacity",
		label: "capacity",
		description: "[reset] · inspect capacity requests or explicitly start a new episode",
	},
	{ value: "budget", label: "budget", description: "[<context-tokens> <cost-usd>|off] · select per-conversation notice budgets" },
	{ value: "help", label: "help", description: "show /stash usage" },
];

/** Removed retrieval verb. Hard-rejected (never aliased) with the replacement syntax. */
const REMOVED_VERBS: ReadonlyArray<{ verb: string; replacement: string }> = [
	{ verb: "pickup", replacement: "Removed: /stash pickup. Pick up with: /stash get <id>" },
];

/** Full stash id shape. A bare arg matching this is a stale resume string, not a hint. */
const FULL_ID_RE = /^\d{8}T\d{6}Z-[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const STASH_USAGE = [
	"/stash — session-continuity handovers",
	"",
	"Create:",
	"  /stash new <hint>           distill the live session into a new stash (hint guides it)",
	"",
	"Retrieve & manage:",
	"  /stash                      browse & pick up (TUI panel or RPC list)",
	"  /stash get <id> [note]      pick up a stash; the note amends it at pickup time",
	"  /stash complete <id> <out>  close an open or active stash with a concrete outcome",
	"  /stash release <id>         return an active stash to open (dead-session cleanup)",
	"  /stash reopen <id>          return a closed stash to open",
	"  /stash rotate <id>          archive a stale stash (recoverable)",
	"  /stash capacity [reset|release] inspect requests, reset notices, or lift the gate",
	"  /stash budget [<context-tokens> <cost-usd>|off] select or inspect notice budgets",
	"  /stash help                 show this usage",
	"",
	"  <id> may be a full stash id or a unique prefix.",
	"",
	"Agent tools: stash_write, stash_list, stash_read, stash_complete, stash_rotate.",
].join("\n");

type StashCompletionItem = { value: string; label: string; description: string };

/** Stash-id prefix completion shared by the id-bearing verbs. Returns null on any store error. */
async function stashIdCompletions(
	prefix: string,
	make: (id: string, state: string, title: string) => StashCompletionItem,
): Promise<StashCompletionItem[] | null> {
	try {
		const entries = await listStashes(storeDir(), { limit: 50 });
		const lower = prefix.toLowerCase();
		const matches = entries.filter((entry) => entry.meta.id.toLowerCase().startsWith(lower));
		if (matches.length === 0) return null;
		return matches.map((entry) =>
			make(entry.meta.id, safeLine(stateLabel(entry.meta, entry.previewError !== undefined)), entry.meta.title),
		);
	} catch {
		return null;
	}
}

/**
 * `/stash ` argument autocompletion. Bare text lists actions only. After an
 * id-bearing verb, id prefixes complete. Pi's applyCompletion replaces the whole
 * argument text, so id items re-attach their verb.
 */
async function stashArgumentCompletions(argumentText: string): Promise<StashCompletionItem[] | null> {
	const text = argumentText ?? "";
	if (!text.includes(" ")) {
		const verbs = STASH_VERBS.filter((verb) => verb.value.startsWith(text));
		return verbs.length > 0 ? verbs.map(({ value, label, description }) => ({ value, label, description })) : null;
	}
	const firstSpace = text.indexOf(" ");
	const verb = text.slice(0, firstSpace);
	const tail = text.slice(firstSpace + 1);
	// All id-bearing verbs take one id; a second token means the user is past it
	// (for complete, that token begins the outcome; for get, the operator note).
	if (tail.includes(" ")) return null;
	if (verb === "get" || verb === "complete" || verb === "reopen" || verb === "release" || verb === "rotate") {
		return stashIdCompletions(tail, (id, state, title) => ({
			value: `${verb} ${id}`,
			label: id,
			description: `${state} · ${safeLine(title)}`,
		}));
	}
	return null;
}

/** Activate a stash and inject its handover as the next user message. Shared by `get` and the browser. */
async function deliverPickup(
	pi: StashMessageApi,
	ctx: ExtensionContext,
	id: string,
	fail: (message: string) => void,
	note?: string,
): Promise<void> {
	let activated: Awaited<ReturnType<typeof changeLifecycle>>;
	try {
		activated = await changeLifecycle(id, { action: "activate" });
	} catch (error) {
		fail(`Could not activate stash for pickup: ${safeLine(error instanceof Error ? error.message : String(error))}`);
		return;
	}
	try {
		const message = buildPickupMessage(activated.id, activated.content, {
			currentCwd: ctx.cwd,
			note,
			// An idempotent repickup means the artifact was already active: the
			// recorded activation belongs to a predecessor this session supersedes.
			activatedAt: activated.changed ? undefined : activated.meta.activatedAt,
		});
		if (ctx.isIdle()) {
			pi.sendUserMessage(message);
		} else {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
			if (ctx.hasUI) ctx.ui.notify(`Queued stash ${activated.id} for pickup after the current turn.`, "info");
		}
	} catch (error) {
		fail(
			`Stash ${activated.id} is active, but pickup delivery failed: ${safeLine(error instanceof Error ? error.message : String(error))}`,
		);
	}
}

async function selectAndPickup(
	pi: StashMessageApi,
	ctx: ExtensionContext,
	entries: Awaited<ReturnType<typeof listStashes>>,
	hasMore: boolean,
	fail: (message: string) => void,
): Promise<void> {
	const choices = entries.map((entry) => {
		const id = entry.meta.id;
		let length = 17;
		while (
			length < id.length &&
			entries.some((other) => other !== entry && other.meta.id.startsWith(id.slice(0, length)))
		) {
			length++;
		}
		return `${safeLine(entry.meta.title)} · ${safeLine(stateLabel(entry.meta, entry.previewError !== undefined))} · ${id.slice(0, length)}`;
	});
	const selected = await ctx.ui.select(hasMore ? "Stashes (newest 200)" : "Stashes", choices);
	const entry = selected === undefined ? undefined : entries[choices.indexOf(selected)];
	if (entry) await deliverPickup(pi, ctx, entry.meta.id, fail);
}

/**
 * Store operations behind the ordinary browser. Pickup closes the browser first, so the handover
 * arrives in the restored conversation; deliverPickup reports queueing and failures itself.
 */
function ordinaryOperations(
	pi: StashMessageApi,
	ctx: ExtensionContext,
	fail: (message: string) => void,
	copyText?: (text: string) => Promise<void>,
): StashOperations {
	return {
		recent: (signal) => loadRecent(storeDir(), signal),
		archive: (query, cursor, prior, signal) => loadArchive(storeDir(), query, cursor, prior, signal),
		preview: (entry, signal) => loadSelectedPreview(storeDir(), entry, signal),
		pickup: async (id, note, leave) => {
			leave(() => deliverPickup(pi, ctx, id, fail, note));
			return "";
		},
		close: async (id, outcome) => {
			const transitioned = await changeLifecycle(id, { action: "close", outcome });
			if (transitioned.redactions.count) ctx.ui.notify(redactionNotice(transitioned.redactions), "warning");
			return `Closed stash ${transitioned.id}.`;
		},
		release: async (id) => `Released stash ${(await changeLifecycle(id, { action: "release" })).id} back to open.`,
		reopen: async (id) => `Reopened stash ${(await changeLifecycle(id, { action: "reopen" })).id}.`,
		rotate: async (id) => `Rotated stash ${(await rotateLifecycle(id)).id} to the stash archive.`,
		copy: (text) => (copyText ?? copyToClipboard)(text),
	};
}

/** Without the interactive terminal a UI picks from the newest records; without any UI the browser refuses. */
async function pickWithoutTerminal(pi: StashMessageApi, ctx: ExtensionContext, fail: (message: string) => void): Promise<void> {
	if (!ctx.hasUI) {
		throw new Error(
			"The interactive stash browser requires TUI mode. Use stash_list to discover ids, /stash get <id> to pick up, /stash new <hint> to create, /stash complete <id> <outcome> to close, /stash reopen <id>, /stash rotate <id> to archive, or /stash help.",
		);
	}
	try {
		const recent = await listStashes(storeDir(), { limit: 201 });
		await selectAndPickup(pi, ctx, recent.slice(0, 200), recent.length > 200, fail);
	} catch (error) {
		fail(`Could not open stash store: ${safeLine(error instanceof Error ? error.message : String(error))}`);
	}
}

function finishCapacityRound(state: GateState, event: TurnEndEvent, ctx: ExtensionContext, config: ReturnType<typeof capacityConfig>): void {
	if (event.outcome === "aborted" || ctx.signal?.aborted) state.blockedRounds = 0;
	else {
		state.blockedRounds = event.toolResults.length > 0 && event.toolResults.every((result) => state.blockedCalls.has(result.toolCallId)) ? state.blockedRounds + 1 : 0;
		if (band(state.measure ?? { kind: "unknown" }, config) === "decision") state.decisionRoundUsed = true;
	}
	state.blockedCalls.clear();
	state.decisionRoundOpen = false;
}

function reportCapacityFailure(state: GateState, event: TurnEndEvent, ctx: ExtensionContext, config: ReturnType<typeof capacityConfig>, threshold?: number): void {
	if (!config.enabled || event.outcome !== "error" || state.failureReported || !ctx.hasUI) return;
	const measured = measureUsage(() => ctx.getContextUsage());
	if (measured.kind !== "known" || band(measured, config) !== "stop") return;
	state.failureReported = true;
	ctx.ui.notify(`Stash capacity: this turn failed while context use was ${measured.percent.toFixed(1)}% of ${measured.contextWindow} tokens. Pi automatic compaction is ${threshold === undefined ? "disabled or unknown" : `enabled at ${threshold.toFixed(1)}%`}. Remedies: /compact, then continue; or start a fresh session with the latest handover or checkpoint (stash_list with collection checkpoints).`, "error");
}

export default function (pi: StashExtensionApi, overrides?: { copyText?: (text: string) => Promise<void> }) {
	const { registerTool, publish } = toolDisplayPublisher(pi);
	const publicationOptions = {
		agentDir: getAgentDir(),
	};
	const disposeSettings = publishSettings(pi.events, publicationOptions);
	const creationStatus = new CreationStatus();
	const gates = new Map<string, GateState>();
	const budgets = new Map<string, SessionBudget>();
	pi.on("session_shutdown", () => {
		gates.clear();
		budgets.clear();
		creationStatus.close();
		disposeSettings();
	});
	pi.events.emit(
		"durable:contribution",
		stashDurableContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings),
	);
	const stateFor = (ctx: ExtensionContext) => gateState(gates, ctx.sessionManager.getSessionId(), capacityEpisode(ctx));
	let capacityErrorReported = false;
	pi.on("agent_start", (_event, ctx) => { stateFor(ctx).blockedRounds = 0; });
	pi.on("turn_start", (_event, ctx) => {
		const state = stateFor(ctx);
		state.measure = undefined;
		state.decisionRoundOpen = !state.decisionRoundUsed;
		state.blockedCalls.clear();
	});
	pi.on("tool_call", (event, ctx) => {
		try {
			const config = capacityConfig(readSettings({ agentDir: getAgentDir() }).values);
			if (!config.enabled) return;
			const state = stateFor(ctx);
			state.measure ??= measureUsage(() => ctx.getContextUsage());
			state.decisionRoundOpen ??= !state.decisionRoundUsed;
			const decision = gate({ measure: state.measure, toolName: event.toolName, args: event.input, config,
				declared: band(state.measure, config) === "normal" ? new Map() : continuityTools(pi.events),
				released: state.released, decisionRoundOpen: state.decisionRoundOpen, blockedRounds: state.blockedRounds });
			if (decision.kind === "block") {
				state.blockedCalls.add(event.toolCallId);
				return { block: true, reason: decision.reason, terminate: decision.terminate };
			}
		} catch (error) {
			if (capacityErrorReported) return;
			capacityErrorReported = true;
			throw error;
		}
	});
	pi.on("turn_end", (event, ctx) => {
		try {
			const config = capacityConfig(readSettings({ agentDir: getAgentDir() }).values);
			if (!config.enabled) return;
			const state = stateFor(ctx);
			finishCapacityRound(state, event, ctx, config);
			const threshold = piAutoThreshold(pi.getSettings().compaction, ctx.model);
			reportCapacityFailure(state, event, ctx, config, threshold);
			return capacityTurnEnd(event, ctx, config, threshold);
		} catch (error) {
			if (capacityErrorReported) return;
			capacityErrorReported = true;
			throw error;
		}
	});
	pi.on("turn_end", (event, ctx) => {
		const budget = budgets.get(ctx.sessionManager.getSessionId());
		if (!budget || event.entries.some((entry) => entry.type === "custom_message" && entry.customType === "stash-budget")) return;
		const observation = event.entries.some((entry) => entry.type === "compaction")
			? { kind: "unavailable" as const } : budgetContext(() => ctx.getContextUsage());
		return { entries: [...event.entries, { type: "custom_message", customType: "stash-budget", content: budgetNotice(budget, observation, ORDINARY_COST), display: true, details: { turnEntryId: event.messageEntryId } }] };
	});
	registerTool<typeof WriteParams, Record<string, unknown>>({
		name: "stash_write",
		label: "Stash Write",
		description: STASH_WRITE_DESCRIPTION,
		promptSnippet: "Distill the current effort into a durable, discoverable handover artifact",
		promptGuidelines: [STASH_WRITE_GUIDANCE],
		parameters: WriteParams,
		renderCall: renderWriteCall,
		renderResult: renderWriteResult,
		async execute(_toolCallId, params: Static<typeof WriteParams>, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("stash_write cancelled");
			const branch = await currentBranch(pi, ctx.cwd, signal);
			if (signal?.aborted) throw new Error("stash_write cancelled");
			const sessionId = currentSessionId(ctx);
			try {
				// The same deterministic redaction applies to model-supplied stash_write
				// params: an artifact is durable, so no credential-shaped value may be
				// published on the model's discretion on any write path.
				const destination = params.checkpoint ? await checkpointDirectory() : storeDir();
				if (signal?.aborted) throw new Error("stash_write cancelled");
				const { record, path, redactions } = await writeStash(destination, {
					...params,
					project: ctx.cwd,
					branch,
					sessionId,
				});
				if (params.checkpoint) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Saved working checkpoint "${safeLine(record.title)}".\n${safeLine(path)}\nDiscover it with stash_list collection checkpoints, then stash_read with that collection and its checkpoint: identifier. It is provisional working material, not a handover pickup.${noticeSuffix(redactions)}`,
							},
						],
						details: { id: collectionId(record.id, "checkpoints"), path, checkpoint: true, redactions },
					};
				}
				const text =
					[
						`Stashed "${safeLine(record.title)}" as ${record.id}`,
						safeLine(path),
						"",
						"Resume in a new session:",
						`  ${resumeCommand(record.id)}`,
					].join("\n") + noticeSuffix(redactions);
				return {
					content: [{ type: "text" as const, text }],
					details: { id: record.id, path, state: record.state, redactions },
				};
			} catch (error) {
				throw new Error(`stash_write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	registerTool<typeof ListParams, Record<string, unknown>>({
		name: "stash_list",
		label: "Stash List",
		description: STASH_LIST_DESCRIPTION,
		promptSnippet: "List recent stashed handover artifacts",
		promptGuidelines: [STASH_LIST_GUIDANCE],
		parameters: ListParams,
		outputSchema: ListOutputSchema,
		renderCall: renderListCall,
		renderResult: renderListResult,
		async execute(_toolCallId, params: Static<typeof ListParams>, signal): Promise<AgentToolResult<Record<string, unknown>>> {
			const limit = params.limit ?? 10;
			if (signal?.aborted) throw new Error("stash_list cancelled");
			try {
				collectionFilter(params.collection, params.state);
				const directory = await collectionDirectory(getAgentDir(), params.collection);
				if (params.query !== undefined) {
					const page = await searchStashes(directory, { ...params, query: params.query }, signal);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(page) }],
						details: { ...page },
						structuredContent: { ...page, matches: page.matches.map((match) => ({ ...match })) },
					};
				}
				if (params.cursor !== undefined)
					throw new Error("cursor requires query; repeat the original query and filters");
				const entries = await listStashes(directory, {
					limit,
					tag: params.tag,
					state: params.state,
				}, signal);
				return recentListResult(entries, limit, emptyListText(params.tag, params.state), params.collection);
			} catch (error) {
				if (signal?.aborted) throw error;
				const text = boundedOutput(error instanceof Error ? error.message : String(error)).text;
				return {
					content: [{ type: "text" as const, text }],
					details: {},
					isError: true,
					structuredContent: {
						kind: "error",
						error: Array.from(safe(text)).slice(0, 1024).join(""),
						coverage: { complete: false },
						nextCursor: null,
					},
				};
			}
		},
	});

	registerTool<typeof ReadParams, Record<string, unknown>>({
		name: "stash_read",
		label: "Stash Read",
		description: STASH_READ_DESCRIPTION,
		promptSnippet: "Read one stashed handover artifact",
		parameters: ReadParams,
		renderCall: renderReadCall,
		renderResult: renderReadResult,
		async execute(_toolCallId, params: Static<typeof ReadParams>, signal) {
			if (signal?.aborted) throw new Error("stash_read cancelled");
			const id = artifactId(params.id, params.collection);
			const directory = await collectionDirectory(getAgentDir(), params.collection);
			const result = await readStash(directory, id, signal);
			if ("error" in result) throw readFailure(result);
			return readStashResult(result, params.collection);
		},
	});

	registerTool<typeof EditParams, Record<string, unknown>>({
		name: "stash_edit",
		label: "Stash Edit",
		description: STASH_EDIT_DESCRIPTION,
		promptSnippet: "Correct or amend a saved handover without changing its lifecycle",
		promptGuidelines: [STASH_EDIT_GUIDANCE],
		executionMode: "sequential",
		parameters: EditParams,
		renderCall: renderEditCall,
		renderResult: renderEditResult,
		async execute(_toolCallId, params: Static<typeof EditParams>, signal) {
			const result = await withStashTarget(params.id, signal, (dir, targetId) =>
				editStash(dir, targetId, params, signal),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`${result.changed ? "Updated" : "Unchanged"} stash ${result.id}.`,
							`State: ${result.meta.state} (unchanged).`,
							`Digest: ${result.digest}`,
							...(result.redactions.count ? [redactionNotice(result.redactions)] : []),
						].join("\n"),
					},
				],
				details: {
					id: result.id,
					path: result.path,
					state: result.meta.state,
					digest: result.digest,
					changed: result.changed,
					redactions: result.redactions,
				},
			};
		},
	});

	registerTool<typeof CompleteParams, Record<string, unknown>>({
		name: "stash_complete",
		label: "Stash Complete",
		description: STASH_COMPLETE_DESCRIPTION,
		promptSnippet: "Close an open or active stashed effort with its concrete outcome",
		promptGuidelines: [STASH_COMPLETE_GUIDANCE],
		executionMode: "sequential",
		parameters: CompleteParams,
		renderCall: renderCompleteCall,
		renderResult: renderCompleteResult,
		async execute(_toolCallId, params: Static<typeof CompleteParams>, signal) {
			const transitioned = await changeLifecycle(params.id, { action: "close", outcome: params.outcome }, signal);
			return {
				content: [
					{
						type: "text" as const,
						text: `Closed stash ${transitioned.id}.\nOutcome: ${safeLine(transitioned.meta.outcome ?? params.outcome.trim())}${transitioned.redactions.count ? `\n${redactionNotice(transitioned.redactions)}` : ""}`,
					},
				],
				details: {
					id: transitioned.id,
					path: transitioned.path,
					state: transitioned.meta.state,
					closedAt: transitioned.meta.closedAt,
					outcome: transitioned.meta.outcome,
					redactions: transitioned.redactions,
				},
			};
		},
	});

	registerTool<typeof RotateParams, Record<string, unknown>>({
		name: "stash_rotate",
		label: "Stash Rotate",
		description: STASH_ROTATE_DESCRIPTION,
		promptSnippet: "Archive a stale stashed effort so it stops appearing in listings",
		promptGuidelines: [STASH_ROTATE_GUIDANCE],
		executionMode: "sequential",
		parameters: RotateParams,
		renderCall: renderRotateCall,
		renderResult: renderRotateResult,
		async execute(_toolCallId, params: Static<typeof RotateParams>, signal) {
			const rotated = await rotateLifecycle(params.id, signal);
			return {
				content: [{ type: "text" as const, text: `Rotated stash ${rotated.id} to the stash archive.` }],
				details: { id: rotated.id, state: rotated.state, archivePath: rotated.archivePath },
			};
		},
	});

	const failFor = (ctx: ExtensionContext) => (message: string) => {
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else throw new Error(message);
	};
	/** Browsing position per session, kept while the extension instance lives. */
	const viewStates = new Map<string, StashViewState>();
	/** The view module loads when the destination opens, not when this factory runs. */
	const loadView = async (ctx: ExtensionContext, host: ViewHost): Promise<OperatorView> => {
		const module = await import("./operator-view.ts");
		const id = ctx.sessionManager.getSessionId();
		let state = viewStates.get(id);
		if (!state) {
			state = module.createStashViewState();
			viewStates.set(id, state);
		}
		return module.stashView(host, ordinaryOperations(pi, ctx, failFor(ctx), overrides?.copyText), state);
	};
	// Package contract: docs/conventions/operator-panels.md. Opening is a harmless read; pickup and lifecycle changes are labelled actions inside.
	publishOperatorViews(pi, {
		version: 2,
		owner: OWNER,
		views: [{ id: "stash", label: "Stashes", command: { name: "stash" }, order: 10, view: (ctx, host) => new LoadingView("Stashes", host, () => loadView(ctx, host)) }],
	});
	async function openBrowser(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode === "tui") await openOperatorFrame(pi, ctx, { owner: OWNER, id: "stash" });
		else await pickWithoutTerminal(pi, ctx, failFor(ctx));
	}

	pi.registerCommand("stash", {
		description: "Create, browse, get, complete, release, reopen, or rotate stashed efforts",
		getArgumentCompletions: stashArgumentCompletions,
		handler: (args, ctx) => handleStashCommand(pi, args, ctx, openBrowser, creationStatus, gates, budgets),
	});
	pi.registerShortcut("ctrl+alt+s", {
		description: "Open the stash browser",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			await openBrowser(ctx);
		},
	});
	publish();
}

async function handleStashCommand(
	pi: StashExtensionApi,
	args: string,
	ctx: ExtensionCommandContext,
	openBrowser: (ctx: ExtensionContext) => Promise<void>,
	creationStatus: CreationStatus,
	gates: Map<string, GateState>,
	budgets: Map<string, SessionBudget>,
): Promise<void> {
	const raw = args.trim();
	const parts = raw.split(/\s+/).filter(Boolean);
	const verb = parts[0];
	const fail = (message: string): void => {
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else throw new Error(message);
	};

	// Removed verbs — hard-rejected with the replacement syntax, never aliased.
	for (const removed of REMOVED_VERBS) {
		if (verb === removed.verb) {
			fail(removed.replacement);
			return;
		}
	}

	switch (verb) {
		case "new":
			return createCommand(pi, ctx, parts, fail, creationStatus);
		case "help":
			return helpCommand(ctx, parts, fail);
		case "capacity":
			return capacityCommand(pi, ctx, parts, fail, gates);
		case "budget":
			return budgetCommand(pi, ctx, parts, fail, budgets);
		case "get":
			return getCommand(pi, ctx, parts, fail);
		case "complete":
			return completeCommand(pi, ctx, parts, fail);
		case "release":
		case "rotate":
		case "reopen":
			return lifecycleCommand(ctx, verb, parts, fail);
	}
	if (parts.length === 1 && verb && FULL_ID_RE.test(verb)) {
		fail(`Pick up with: /stash get ${verb}`);
		return;
	}
	if (!verb) return openBrowser(ctx);
	fail(`Unknown /stash action "${safeLine(verb)}". Create with /stash new <hint>, or use /stash help.`);
}

type CommandFailure = (message: string) => void;

function budgetCommand(
	pi: StashExtensionApi,
	ctx: ExtensionCommandContext,
	parts: string[],
	fail: CommandFailure,
	budgets: Map<string, SessionBudget>,
): void {
	let action: ReturnType<typeof budgetAction>;
	try { action = budgetAction(parts.slice(1)); }
	catch (error) { fail(error instanceof Error ? error.message : String(error)); return; }
	const id = ctx.sessionManager.getSessionId();
	if (action.kind === "set") budgets.set(id, action.budget);
	else if (action.kind === "off") budgets.delete(id);
	const message = budgetStatus(budgets.get(id));
	pi.sendMessage({ customType: "stash-budget-status", content: message, display: true }, { triggerTurn: false });
	if (!ctx.hasUI) console.error(message);
}

function capacityCommand(
	pi: StashExtensionApi,
	ctx: ExtensionCommandContext,
	parts: string[],
	fail: CommandFailure,
	gates: Map<string, GateState>,
): void {
	if (parts.length > 2 || (parts[1] !== undefined && parts[1] !== "reset" && parts[1] !== "release")) {
		fail("Usage: /stash capacity [reset|release]");
		return;
	}
	let message: string;
	try {
		const config = capacityConfig(readSettings({ agentDir: getAgentDir() }).values);
		if (parts[1] === "reset") pi.appendEntry(CAPACITY_STATE, capacityReset(ctx));
		const state = gateState(gates, ctx.sessionManager.getSessionId(), capacityEpisode(ctx));
		if (parts[1] === "release") state.released = true;
		state.measure = measureUsage(() => ctx.getContextUsage());
		message = [parts[1] === "release" ? "Stash stop and decision round released until the next compaction in this session. Reload restores them." : "", capacityStatus(ctx, config), gateStatus(state, config, continuityTools(pi.events), piAutoThreshold(pi.getSettings().compaction, ctx.model))].filter(Boolean).join("\n");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		return;
	}
	if (ctx.hasUI) ctx.ui.notify(message, "info");
	else throw new Error(message);
}

async function createCommand(
	pi: StashExtensionApi,
	ctx: ExtensionCommandContext,
	parts: string[],
	fail: CommandFailure,
	status: CreationStatus,
): Promise<void> {
	const hint = parts.slice(1).join(" ");
	if (!hint) return fail("Usage: /stash new <hint>");
	await startCreation(pi, ctx, hint, status);
}

function helpCommand(ctx: ExtensionCommandContext, parts: string[], fail: CommandFailure): void {
	if (parts.length !== 1) {
		fail("Usage: /stash help");
		return;
	}
	if (ctx.hasUI) ctx.ui.notify(STASH_USAGE, "info");
	else throw new Error(STASH_USAGE);
}

async function getCommand(
	pi: StashMessageApi,
	ctx: ExtensionCommandContext,
	parts: string[],
	fail: CommandFailure,
): Promise<void> {
	const id = parts[1];
	if (!id) {
		fail("Usage: /stash get <id> [note]");
		return;
	}
	// Every token after the id is the operator note: material the operator
	// recalls after the artifact was written, delivered ahead of it.
	const note = parts.slice(2).join(" ").trim() || undefined;
	await deliverPickup(pi, ctx, id, fail, note);
}

async function completeCommand(
	pi: Pick<ExtensionAPI, "sendMessage">,
	ctx: ExtensionCommandContext,
	parts: string[],
	fail: CommandFailure,
): Promise<void> {
	const id = parts[1];
	const outcome = parts.slice(2).join(" ");
	if (!id || !outcome) {
		fail("Usage: /stash complete <id> <concrete outcome>");
		return;
	}
	try {
		const transitioned = await changeLifecycle(id, { action: "close", outcome });
		if (ctx.hasUI) ctx.ui.notify(`Closed stash ${transitioned.id}.`, "info");
		notifyCommandRedactions(pi, ctx, transitioned.redactions);
	} catch (error) {
		fail(safeLine(error instanceof Error ? error.message : String(error)));
	}
}

async function lifecycleCommand(
	ctx: ExtensionCommandContext,
	verb: "release" | "rotate" | "reopen",
	parts: string[],
	fail: CommandFailure,
): Promise<void> {
	const id = parts[1];
	if (!id || parts.length !== 2) return fail(`Usage: /stash ${verb} <id>`);
	try {
		let message: string;
		if (verb === "rotate") {
			const rotated = await rotateLifecycle(id);
			message = `Rotated stash ${rotated.id} to the stash archive.`;
		} else {
			const transitioned = await changeLifecycle(id, { action: verb });
			message =
				verb === "release" ? `Released stash ${transitioned.id} back to open.` : `Reopened stash ${transitioned.id}.`;
		}
		if (ctx.hasUI) ctx.ui.notify(message, "info");
	} catch (error) {
		fail(safeLine(error instanceof Error ? error.message : String(error)));
	}
}
