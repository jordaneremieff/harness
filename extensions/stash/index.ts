/** Session continuity tools plus the interactive /stash pickup workflow. */

import { toolDisplayPublisher } from "./tool-display.ts";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentToolResult,
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { CAPACITY_STATE, capacityConfig, capacityReset, capacityStatus, capacityTurnEnd } from "./capacity.ts";
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
import { StashPanel, type StashPanelResult } from "./panel.ts";
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

async function checkpointDirectory(cwd: string): Promise<string> {
	const handovers = resolve(storeDir());
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

async function startCreation(pi: StashExtensionApi, ctx: ExtensionCommandContext, hint: string): Promise<void> {
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
		const scanned = redactSecretsWithReport(error instanceof Error ? error.message : String(error));
		notifyCommandRedactions(pi, ctx, scanned.report);
		const message = `Could not start stash creation: ${safeLine(scanned.text)}`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else throw new Error(message);
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
	withStashTarget(id, signal, (dir, targetId) => transitionStash(dir, targetId, change));

const rotateLifecycle = (id: string, signal?: AbortSignal) =>
	withStashTarget(id, signal, (dir, targetId) => rotateStash(dir, targetId));

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
	"  /stash                      browse & pick up (TUI overlay)",
	"  /stash get <id> [note]      pick up a stash; the note amends it at pickup time",
	"  /stash complete <id> <out>  close an open or active stash with a concrete outcome",
	"  /stash release <id>         return an active stash to open (dead-session cleanup)",
	"  /stash reopen <id>          return a closed stash to open",
	"  /stash rotate <id>          archive a stale stash (recoverable)",
	"  /stash capacity [reset]     inspect capacity requests or start a new episode",
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

/** Browse stashes and act on them; a selected entry is picked up. */
async function browseAndPickup(
	pi: StashMessageApi,
	ctx: ExtensionContext,
	fail: (message: string) => void,
	copyText?: (text: string) => Promise<void>,
): Promise<void> {
	let browserFilter: string | undefined;
	let browserSelectedId: string | undefined;
	let browserSelectedIndex: number | undefined;
	let pickupId: string | undefined;
	let pickupNote: string | undefined;

	while (!pickupId) {
		if (ctx.mode !== "tui") {
			const message =
				"The interactive stash browser requires TUI mode. Use stash_list to discover ids, /stash get <id> to pick up, /stash new <hint> to create, /stash complete <id> <outcome> to close, /stash reopen <id>, /stash rotate <id> to archive, or /stash help.";
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else throw new Error(message);
			return;
		}
		let entries: Awaited<ReturnType<typeof listStashes>>;
		let hasMore = false;
		try {
			const loaded = await listStashes(storeDir(), { limit: 201, previewBytes: 32 * 1024 });
			hasMore = loaded.length > 200;
			entries = loaded.slice(0, 200);
		} catch (error) {
			fail(`Could not open stash store: ${safeLine(error instanceof Error ? error.message : String(error))}`);
			return;
		}
		const result = await ctx.ui.custom<StashPanelResult>(
			(tui, theme, _keybindings, done) =>
				new StashPanel({
					entries,
					title: "Stashes",
					theme,
					tui,
					getMaxRows: () => Math.max(1, tui.terminal.rows - 6),
					hasMore,
					initialFilter: browserFilter,
					initialSelectedId: browserSelectedId,
					initialSelectedIndex: browserSelectedIndex,
					copyResume: (entry) => (copyText ?? copyToClipboard)(resumeCommand(entry.meta.id)),
					done,
				}),
			{
				overlay: true,
				overlayOptions: { width: "90%", minWidth: 104, maxHeight: "92%", anchor: "center", margin: 1 },
			},
		);
		browserFilter = result?.filter ?? "";
		browserSelectedId = result?.selectedId;
		browserSelectedIndex = result?.selectedIndex;
		const action = await browserAction(ctx, result, fail);
		if (action.kind === "stop") return;
		if (action.kind === "pickup") {
			pickupId = action.id;
			pickupNote = action.note;
		}
	}
	if (pickupId) await deliverPickup(pi, ctx, pickupId, fail, pickupNote);
}

type BrowserAction = { kind: "stop" | "continue" } | { kind: "pickup"; id: string; note?: string };

async function closeFromBrowser(ctx: ExtensionContext, id: string): Promise<void> {
	const outcome = await ctx.ui.input("Concrete outcome for this stashed effort:");
	if (outcome?.trim()) {
		const transitioned = await changeLifecycle(id, { action: "close", outcome });
		ctx.ui.notify(`Closed stash ${transitioned.id}.`, "info");
		if (transitioned.redactions.count) ctx.ui.notify(redactionNotice(transitioned.redactions), "warning");
	}
}

async function browserAction(
	ctx: ExtensionContext,
	result: StashPanelResult | undefined,
	fail: (message: string) => void,
): Promise<BrowserAction> {
	if (result?.selected) return { kind: "pickup", id: result.selected.meta.id };
	if (result?.note) {
		// The `a` path: collect the amendment in the host, then pick up with it.
		// An empty answer degrades to a plain pickup, never a dead end.
		try {
			const answer = await ctx.ui.input("Operator note for this pickup (empty for none):");
			return { kind: "pickup", id: result.note.meta.id, note: answer?.trim() || undefined };
		} catch (error) {
			fail(safeLine(error instanceof Error ? error.message : String(error)));
			return { kind: "stop" };
		}
	}
	if (result?.complete) {
		try {
			await closeFromBrowser(ctx, result.complete.meta.id);
		} catch (error) {
			fail(safeLine(error instanceof Error ? error.message : String(error)));
			return { kind: "stop" };
		}
		return { kind: "continue" };
	}
	if (!result?.manage) return { kind: "stop" };
	return manageBrowserEntry(ctx, result.manage, fail);
}

async function manageBrowserEntry(
	ctx: ExtensionContext,
	managed: NonNullable<StashPanelResult["manage"]>,
	fail: (message: string) => void,
): Promise<BrowserAction> {
	if (managed.meta.invalidState !== undefined || managed.previewError !== undefined) {
		const reason =
			managed.meta.invalidState !== undefined
				? `state "${safeLine(managed.meta.invalidState)}" is not a recognized lifecycle state`
				: "its header could not be read, so its state is unknown";
		ctx.ui.notify(`Stash ${managed.meta.id} cannot be acted on: ${reason}.`, "warning");
		return { kind: "continue" };
	}

	const state = managed.meta.state;
	const choices =
		state === "active"
			? ["Close with outcome", "Release (return to open)", "Back"]
			: state === "closed"
				? ["Reopen", "Rotate (archive)", "Back"]
				: ["Pick up", "Rotate (archive)", "Back"];
	const action = await ctx.ui.select(`Stash ${managed.meta.id}`, choices);
	if (!action || action === "Back") return { kind: "continue" };
	try {
		return await applyBrowserAction(ctx, managed.meta.id, action);
	} catch (error) {
		fail(safeLine(error instanceof Error ? error.message : String(error)));
		return { kind: "stop" };
	}
}

async function applyBrowserAction(ctx: ExtensionContext, id: string, action: string): Promise<BrowserAction> {
	if (action === "Pick up") {
		return { kind: "pickup", id };
	} else if (action === "Close with outcome") {
		await closeFromBrowser(ctx, id);
	} else if (action === "Release (return to open)") {
		// Deliberate dialog position, no further confirm: release keeps every
		// durable byte and pickup remains one action away.
		const transitioned = await changeLifecycle(id, { action: "release" });
		ctx.ui.notify(`Released stash ${transitioned.id} back to open.`, "info");
	} else if (action === "Reopen") {
		const confirmed = await ctx.ui.confirm(
			"Reopen stashed effort?",
			`Clear the closure outcome on ${id} and return it to open state?`,
		);
		if (confirmed) {
			const transitioned = await changeLifecycle(id, { action: "reopen" });
			ctx.ui.notify(`Reopened stash ${transitioned.id}.`, "info");
		}
	} else if (action === "Rotate (archive)") {
		const confirmed = await ctx.ui.confirm(
			"Rotate stashed effort?",
			`Move ${id} into the stash store's .trash directory? It will disappear from listings and pickup; the file remains recoverable.`,
		);
		if (confirmed) {
			const rotated = await rotateLifecycle(id);
			ctx.ui.notify(`Rotated stash ${rotated.id} to the stash archive.`, "info");
		}
	}
	return { kind: "continue" };
}

export default function (pi: StashExtensionApi, overrides?: { copyText?: (text: string) => Promise<void> }) {
	const { registerTool, publish } = toolDisplayPublisher(pi);
	pi.events.emit("durable:contribution", stashDurableContribution(fileURLToPath(import.meta.url)));
	let capacityErrorReported = false;
	pi.on("turn_end", (event, ctx) => {
		try {
			return capacityTurnEnd(event, ctx, capacityConfig(process.env));
		} catch (error) {
			if (capacityErrorReported) return;
			capacityErrorReported = true;
			throw error;
		}
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("stash_write cancelled");
			const branch = await currentBranch(pi, ctx.cwd, signal);
			if (signal?.aborted) throw new Error("stash_write cancelled");
			const sessionId = currentSessionId(ctx);
			try {
				// The same deterministic redaction applies to model-supplied stash_write
				// params: an artifact is durable, so no credential-shaped value may be
				// published on the model's discretion on any write path.
				const destination = params.checkpoint ? await checkpointDirectory(ctx.cwd) : storeDir();
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
								text: `Saved working checkpoint "${safeLine(record.title)}".\n${safeLine(path)}\nRead this file to recover the synthesis. It is not listed by stash_list and has no /stash pickup shortcut.${noticeSuffix(redactions)}`,
							},
						],
						details: { path, checkpoint: true, redactions },
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
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
			const limit = params.limit ?? 10;
			if (signal?.aborted) throw new Error("stash_list cancelled");
			try {
				if (params.query !== undefined) {
					const page = await searchStashes(storeDir(), { ...params, query: params.query }, signal);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(page) }],
						details: { ...page },
						structuredContent: { ...page, matches: page.matches.map((match) => ({ ...match })) },
					};
				}
				if (params.cursor !== undefined)
					throw new Error("cursor requires query; repeat the original query and filters");
				const entries = await listStashes(storeDir(), {
					limit,
					tag: params.tag,
					state: params.state,
				});
				return recentListResult(entries, limit, emptyListText(params.tag, params.state));
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
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("stash_read cancelled");
			const result = await readStash(storeDir(), params.id);
			if ("error" in result) throw readFailure(result);
			return readStashResult(result);
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
		async execute(_toolCallId, params, signal) {
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
		async execute(_toolCallId, params, signal) {
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
		async execute(_toolCallId, params, signal) {
			const rotated = await rotateLifecycle(params.id, signal);
			return {
				content: [{ type: "text" as const, text: `Rotated stash ${rotated.id} to the stash archive.` }],
				details: { id: rotated.id, state: rotated.state, archivePath: rotated.archivePath },
			};
		},
	});

	let browserOpen = false;
	async function openBrowser(ctx: ExtensionContext): Promise<void> {
		if (browserOpen) return;
		browserOpen = true;
		try {
			await browseAndPickup(
				pi,
				ctx,
				(message) => {
					if (ctx.hasUI) ctx.ui.notify(message, "error");
					else throw new Error(message);
				},
				overrides?.copyText,
			);
		} finally {
			browserOpen = false;
		}
	}

	pi.registerCommand("stash", {
		description: "Create, browse, get, complete, release, reopen, or rotate stashed efforts",
		getArgumentCompletions: stashArgumentCompletions,
		handler: (args, ctx) => handleStashCommand(pi, args, ctx, openBrowser),
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
			return createCommand(pi, ctx, parts, fail);
		case "help":
			return helpCommand(ctx, parts, fail);
		case "capacity":
			return capacityCommand(pi, ctx, parts, fail);
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

function capacityCommand(
	pi: StashExtensionApi,
	ctx: ExtensionCommandContext,
	parts: string[],
	fail: CommandFailure,
): void {
	if (parts.length > 2 || (parts[1] !== undefined && parts[1] !== "reset")) {
		fail("Usage: /stash capacity [reset]");
		return;
	}
	let message: string;
	try {
		const config = capacityConfig(process.env);
		if (parts[1] === "reset") pi.appendEntry(CAPACITY_STATE, capacityReset(ctx));
		message = capacityStatus(ctx, config);
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
): Promise<void> {
	const hint = parts.slice(1).join(" ");
	if (!hint) return fail("Usage: /stash new <hint>");
	await startCreation(pi, ctx, hint);
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
