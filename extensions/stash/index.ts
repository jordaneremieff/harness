/** Session continuity tools plus the interactive /stash pickup workflow. */

import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CAPACITY_STATE, capacityConfig, capacityReset, capacityStatus, capacityTurnEnd } from "./capacity.ts";
import {
	type DistillJob,
	type DistillOutcome,
	type DistillSessionFactory,
	type DistillUsage,
	resolveDistillModel,
	resolveDistillThinking,
	startDistillJob,
} from "./distill.ts";
import { resumeCommand, STASH_STATES, stateLabel } from "./format.ts";
import { StashPanel, type StashPanelResult } from "./panel.ts";
import { buildPickupMessage } from "./pickup.ts";
import { redactPayload } from "./redact.ts";
import {
	listStashes,
	readStash,
	resolveStash,
	resolveStoreDir,
	rotateStash,
	type StashLifecycleChange,
	transitionStash,
	writeStash,
} from "./store.ts";
import { boundedOutput, formatTokenCount, sanitizeTerminalText } from "./text.ts";

type StashExecutionApi = Pick<ExtensionAPI, "exec">;
type StashMessageApi = Pick<ExtensionAPI, "sendUserMessage">;
type StashExtensionApi = Pick<
	ExtensionAPI,
	"exec" | "registerCommand" | "registerTool" | "sendUserMessage" | "on" | "appendEntry"
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

/** Distiller identity in statusline form: model name, thinking bracketed for reasoning models. */
function distillerLabel(model: { id: string; name?: string; reasoning?: boolean }, level: string): string {
	// Configured model names are free-form: keep the surfaced label single-line and
	// control-free like every other string this module interpolates.
	const base = safeLine(model.name || model.id);
	return model.reasoning === true ? `${base} [${level}]` : base;
}

/** Compact in/out/cost summary for a finished distillation, footer style. */
function usageLine(usage: DistillUsage | undefined): string | undefined {
	if (!usage) return undefined;
	const inTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return `${formatTokenCount(inTokens)} in · ${formatTokenCount(usage.outputTokens)} out · ~$${usage.costUsd.toFixed(2)}`;
}

// /stash new <hint> status indicator. The publishing extension owns the animation;
// the footer and the statusline extension render the text generically.
const STATUS_KEY = "stash";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;
const RESULT_STATUS_MS = 3_000;

interface InFlightJob {
	/** Null while setup is in progress (before any await reserves the slot). */
	job: DistillJob | null;
	/** Aborts both the setup awaits and the running job. */
	controller: AbortController;
	/** True once the operator was told synchronously that this job was cancelled. */
	cancelNoticeGiven: boolean;
}

let inFlight: InFlightJob | null = null;
/**
 * Session that owns the in-flight job and its status timers. Pi loads one module
 * instance per path per process, so worker sessions in the same process share
 * these globals: a foreign session_shutdown must not abort another session's
 * work. Null while nothing is owned.
 */
let ownerSessionId: string | null = null;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let resultClearTimer: ReturnType<typeof setTimeout> | null = null;

/** Minimal UI surface needed for status and notifications; both context types satisfy it. */
interface StatusUi {
	hasUI?: boolean;
	ui?: {
		setStatus?: (key: string, text: string | undefined) => void;
		notify?: (message: string, level?: "info" | "warning" | "error") => void;
	};
}

function stopSpinner(): void {
	if (spinnerTimer) {
		clearInterval(spinnerTimer);
		spinnerTimer = null;
	}
}

function clearResultStatus(): void {
	if (resultClearTimer) {
		clearTimeout(resultClearTimer);
		resultClearTimer = null;
	}
}

/** Session identity for ownership checks; empty when the runtime cannot answer. */
function sessionKeyOf(ctx: Pick<ExtensionContext, "sessionManager">): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return process.env.PI_SESSION_ID ?? "";
	}
}

function setStatus(ctx: StatusUi, text: string | undefined): void {
	if (typeof ctx.ui?.setStatus === "function") {
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// A status failure must never disrupt the job or the live session.
		}
	}
}

function notify(ctx: StatusUi, message: string, level: "info" | "warning" | "error"): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui?.notify?.(message, level);
	} catch {
		// A notification failure must never surface as an unhandled rejection
		// from the detached job callbacks.
	}
}

function startSpinner(ctx: StatusUi, distiller: string): void {
	let frame = 0;
	spinnerTimer = setInterval(() => {
		frame = (frame + 1) % SPINNER_FRAMES.length;
		setStatus(ctx, `stash: running ${SPINNER_FRAMES[frame]} · ${distiller}`);
	}, SPINNER_INTERVAL_MS);
	spinnerTimer.unref?.();
}

function settleCancelled(slot: InFlightJob, outcome: DistillOutcome, ctx: StatusUi): void {
	// The slot was released while the artifact was already committing: an abort
	// can land after the distiller's last cancellation check. The file exists on
	// disk, so report it. Silence here would leave an unannounced artifact after
	// the operator was told the creation was cancelled.
	if (outcome.ok === true) {
		notify(
			ctx,
			`The stash artifact was already written when the creation was cancelled: ${outcome.record.id}\n${safeLine(outcome.path)}\n\nRotate it with /stash rotate ${outcome.record.id} if you do not want it.`,
			"warning",
		);
		return;
	}
	// A cancelled job whose slot a session_shutdown already freed is the one
	// cancellation path without a synchronous notice (/stash abort reports
	// itself), so the aborted outcome is the last chance to tell the operator.
	if (outcome.reason === "aborted" && !slot.cancelNoticeGiven) {
		notify(ctx, "Stash creation cancelled by session shutdown.", "info");
	}
	return;
}

function settleDistill(slot: InFlightJob, outcome: DistillOutcome, ctx: StatusUi, distiller: string): void {
	if (inFlight !== slot || slot.job === null) {
		settleCancelled(slot, outcome, ctx);
		return;
	}
	inFlight = null;
	stopSpinner();
	clearResultStatus();
	const hold = (text: string | undefined) => {
		setStatus(ctx, text);
		resultClearTimer = setTimeout(() => setStatus(ctx, undefined), RESULT_STATUS_MS);
		resultClearTimer.unref?.();
	};
	const usage = usageLine(outcome.usage);
	if (outcome.ok === true) {
		hold(usage ? `stash: done ${outcome.record.id} · ${usage}` : `stash: done ${outcome.record.id}`);
		notify(
			ctx,
			[
				`Stashed "${safeLine(outcome.record.title)}" as ${outcome.record.id}`,
				safeLine(outcome.path),
				"",
				`Distilled by ${distiller}${usage ? ` · ${usage}` : ""}`,
				"",
				"Resume in a new session:",
				`  ${resumeCommand(outcome.record.id)}`,
			].join("\n"),
			"info",
		);
		return;
	}
	if (outcome.reason === "skip") {
		hold("stash: skipped");
		notify(
			ctx,
			usage
				? `Nothing worth stashing: the distiller found no content to preserve.\n\nDistiller: ${distiller} · ${usage}`
				: "Nothing worth stashing: the distiller found no content to preserve.",
			"info",
		);
		return;
	}
	hold("stash: failed");
	notify(
		ctx,
		`Stash distillation failed: ${safeLine(outcome.message ?? outcome.reason)}${usage ? `\n\nDistiller: ${distiller} · ${usage}` : ""}`,
		"error",
	);
}

/** Release only this dispatch's slot; stale setup cleanup must not clear a replacement. */
function releaseSlot(slot: InFlightJob): void {
	if (inFlight === slot) inFlight = null;
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

async function startCreation(
	pi: StashExecutionApi,
	ctx: ExtensionCommandContext,
	hint: string,
	sessionFactory: DistillSessionFactory | undefined,
): Promise<void> {
	// Synchronous failures must be visible in every mode: notify in TUI/RPC, throw in JSON/print.
	const surface = (message: string, level: "info" | "warning" | "error"): void => {
		if (!ctx.hasUI) throw new Error(message);
		notify(ctx, message, level);
	};
	if (inFlight) {
		surface("A stash creation is already in flight. Use /stash abort to cancel.", "warning");
		return;
	}
	// Resolve model and thinking before reserving the single-flight slot so a bad
	// PI_STASH_* value fails cleanly without wedging creation or starting a spinner.
	const modelResult = resolveDistillModel({
		envModel: process.env.PI_STASH_MODEL,
		parentModel: ctx.model,
		registry: ctx.modelRegistry,
	});
	if (!modelResult.ok) {
		surface(modelResult.error, "error");
		return;
	}
	const thinkingResult = resolveDistillThinking({
		envThinking: process.env.PI_STASH_THINKING,
		parentThinking: ctx.thinkingLevel,
		model: modelResult.model,
	});
	if (!thinkingResult.ok) {
		surface(thinkingResult.error, "error");
		return;
	}
	const model = modelResult.model;
	const thinkingLevel = thinkingResult.level;
	const distiller = distillerLabel(model, thinkingLevel);
	let entries: ReturnType<typeof ctx.sessionManager.buildContextEntries>;
	try {
		entries = ctx.sessionManager.buildContextEntries();
	} catch (error) {
		surface(
			`Could not read the session transcript: ${safeLine(error instanceof Error ? error.message : String(error))}`,
			"error",
		);
		return;
	}
	// Reserve the single-flight slot BEFORE any await so concurrent dispatches serialize,
	// and wire one AbortController to both the setup awaits and the eventual job.
	const controller = new AbortController();
	const slot: InFlightJob = { job: null, controller, cancelNoticeGiven: false };
	inFlight = slot;
	// The reserving session owns the job and its status UI; only its own shutdown
	// may abort the work, even with worker sessions sharing this module instance.
	ownerSessionId = sessionKeyOf(ctx);
	try {
		const branch = await currentBranch(pi, ctx.cwd, controller.signal);
		if (controller.signal.aborted) {
			releaseSlot(slot);
			return;
		}
		const sessionId = currentSessionId(ctx);
		const job = startDistillJob({
			model,
			cwd: ctx.cwd,
			thinkingLevel,
			hint,
			entries,
			project: ctx.cwd,
			branch,
			sessionId,
			storeDir: storeDir(),
			sessionFactory,
		});
		slot.job = job;
		controller.signal.addEventListener("abort", () => job.abort(), { once: true });
		// A pre-existing abort (shutdown/abort during setup) won't re-fire the listener.
		if (controller.signal.aborted) {
			job.abort();
			releaseSlot(slot);
			return;
		}
		// A stale result timer from a previous settle must not wipe the new status.
		stopSpinner();
		clearResultStatus();
		if (ctx.mode === "tui") {
			setStatus(ctx, `stash: running ${SPINNER_FRAMES[0]} · ${distiller}`);
			startSpinner(ctx, distiller);
		}
		notify(
			ctx,
			hint.trim()
				? `Stash distillation started (${distiller}; hint: ${safeLine(hint.trim())}).`
				: `Stash distillation started (${distiller}).`,
			"info",
		);
		void job.result.then((outcome) => settleDistill(slot, outcome, ctx, distiller));
	} catch (error) {
		controller.abort();
		releaseSlot(slot);
		stopSpinner();
		clearResultStatus();
		setStatus(ctx, undefined);
		surface(
			`Could not start stash distillation: ${safeLine(error instanceof Error ? error.message : String(error))}`,
			"error",
		);
	}
}

const shortText = (description: string) => Type.String({ description, maxLength: 200 });
const itemList = (description: string) =>
	Type.Optional(Type.Array(Type.String({ maxLength: 20_000 }), { description, maxItems: 200 }));

const WriteParams = Type.Object({
	checkpoint: Type.Optional(
		Type.Boolean({
			description:
				"Save a working checkpoint in the configured checkpoint directory instead of a discoverable handover. Returns a file path, not a pickup id.",
		}),
	),
	title: shortText("Short human title for the handover"),
	summary: Type.String({
		description: "Distilled state of the effort: what is true now, what was done, what matters. Prose, self-contained.",
		maxLength: 100_000,
	}),
	decisions: itemList("Committed decisions, each with its why"),
	openLoops: itemList("Unresolved questions, blockers, unknowns"),
	nextActions: itemList("Ordered next steps for whoever resumes"),
	files: itemList("Relevant file paths"),
	tags: Type.Optional(
		Type.Array(Type.String({ maxLength: 80 }), {
			description: "Subject tags (tag by subject, not by consumer)",
			maxItems: 50,
		}),
	),
});

const stateSchema = StringEnum(STASH_STATES, { description: "Lifecycle state: open, active, or closed" });

const ListParams = Type.Object({
	limit: Type.Optional(Type.Integer({ description: "Max entries (default 10, max 50)", minimum: 1, maximum: 50 })),
	tag: Type.Optional(Type.String({ description: "Only stashes carrying this tag", maxLength: 80 })),
	state: Type.Optional(stateSchema),
});

const ReadParams = Type.Object({
	id: Type.String({
		description: "Stash id or unique id prefix (from stash_list)",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
});

const CompleteParams = Type.Object({
	id: Type.String({
		description: "Active stash id or unique id prefix",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
	outcome: Type.String({
		description: "Concrete terminal outcome of the resumed effort",
		minLength: 1,
		maxLength: 20_000,
	}),
});

const RotateParams = Type.Object({
	id: Type.String({
		description: "Stash id or unique id prefix (from stash_list)",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
});

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
	{ value: "complete", label: "complete", description: "<id> <outcome> · close an active stash" },
	{ value: "release", label: "release", description: "<id> · return an active stash to open" },
	{ value: "reopen", label: "reopen", description: "<id> · return a closed stash to open" },
	{ value: "rotate", label: "rotate", description: "<id> · archive a stale stash (recoverable)" },
	{ value: "abort", label: "abort", description: "cancel an in-flight stash creation" },
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
	"  /stash abort                cancel an in-flight creation",
	"",
	"Retrieve & manage:",
	"  /stash                      browse & pick up (TUI overlay)",
	"  /stash get <id> [note]      pick up a stash; the note amends it at pickup time",
	"  /stash complete <id> <out>  close an active stash with a concrete outcome",
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
	ctx: ExtensionCommandContext,
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

/** Bare `/stash` (TUI): browse stashes and act on them; a selected entry is picked up. */
async function browseAndPickup(
	pi: StashMessageApi,
	ctx: ExtensionCommandContext,
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

async function closeFromBrowser(ctx: ExtensionCommandContext, id: string): Promise<void> {
	const outcome = await ctx.ui.input("Concrete outcome for this stashed effort:");
	if (outcome?.trim()) {
		const transitioned = await changeLifecycle(id, { action: "close", outcome });
		ctx.ui.notify(`Closed stash ${transitioned.id}.`, "info");
	}
}

async function browserAction(
	ctx: ExtensionCommandContext,
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
	ctx: ExtensionCommandContext,
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

async function applyBrowserAction(ctx: ExtensionCommandContext, id: string, action: string): Promise<BrowserAction> {
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

export default function (
	pi: StashExtensionApi,
	overrides?: { distillSessionFactory?: DistillSessionFactory; copyText?: (text: string) => Promise<void> },
) {
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
	pi.on("session_shutdown", async (_event, ctx) => {
		// Each session's shutdown fires this handler with that session's context,
		// and worker sessions share this module instance: only the session that
		// owns the in-flight work may abort it or clear its status UI.
		if (ownerSessionId !== null && sessionKeyOf(ctx) !== ownerSessionId) return;
		if (inFlight) {
			inFlight.controller.abort();
			inFlight = null;
		}
		stopSpinner();
		clearResultStatus();
		setStatus(ctx, undefined);
		ownerSessionId = null;
	});
	pi.registerTool<typeof WriteParams, Record<string, unknown>>({
		name: "stash_write",
		label: "Stash Write",
		description:
			"Distill the current effort into a durable handover artifact (markdown) stored on disk outside the session. Use when handing work to a future session, before major context loss, or when the operator asks to stash. Set checkpoint: true for a working synthesis instead of a discoverable handover.",
		promptSnippet: "Distill the current effort into a durable, discoverable handover artifact",
		promptGuidelines: [
			"Use stash_write when the operator asks to stash, when an effort reaches a resumable state, or before a session ends with open loops. Make the summary self-contained for a fresh session.",
		],
		parameters: WriteParams,
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
				const { record, path } = await writeStash(destination, {
					...redactPayload(params),
					project: ctx.cwd,
					branch,
					sessionId,
				});
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
				return { content: [{ type: "text" as const, text }], details: { id: record.id, path, state: record.state } };
			} catch (error) {
				throw new Error(`stash_write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	pi.registerTool<typeof ListParams, Record<string, unknown>>({
		name: "stash_list",
		label: "Stash List",
		description:
			"List recent stashed handover artifacts (newest first): id, lifecycle state, title, and tags. Optionally filter by tag or state. Output is capped at 50 KiB or 2000 lines.",
		promptSnippet: "List recent stashed handover artifacts",
		promptGuidelines: [
			"Use stash_list when the operator references earlier or stashed work, then use stash_read on the matching id to load the artifact.",
		],
		parameters: ListParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("stash_list cancelled");
			const entries = await listStashes(storeDir(), {
				limit: params.limit ?? 10,
				tag: params.tag,
				state: params.state,
			});
			if (entries.length === 0) {
				const scopes = [
					params.tag ? `tag "${safeLine(params.tag)}"` : undefined,
					params.state ? `state ${params.state}` : undefined,
				].filter((value): value is string => Boolean(value));
				const scope = scopes.length > 0 ? ` with ${scopes.join(" and ")}` : "";
				return { content: [{ type: "text" as const, text: `No stashes found${scope}.` }], details: { count: 0 } };
			}
			const text = entries
				.map((entry) => {
					const tags = entry.meta.tags.length > 0 ? ` [${entry.meta.tags.map(safeLine).join(", ")}]` : "";
					return `${entry.meta.id}\n  ${safeLine(stateLabel(entry.meta, entry.previewError !== undefined))} · ${safeLine(entry.meta.title)}${tags}`;
				})
				.join("\n");
			const bounded = boundedOutput(text, "Lower limit or filter by tag for a narrower list.");
			return {
				content: [{ type: "text" as const, text: bounded.text }],
				details: {
					count: entries.length,
					ids: entries.map((entry) => entry.meta.id),
					states: entries.map((entry) => safeLine(stateLabel(entry.meta, entry.previewError !== undefined))),
					truncated: bounded.truncated,
				},
			};
		},
	});

	pi.registerTool<typeof ReadParams, Record<string, unknown>>({
		name: "stash_read",
		label: "Stash Read",
		description:
			"Read one stashed handover artifact by id or unique id prefix. Output is capped at 50 KiB or 2000 lines; a truncated result includes the artifact path for continued reading.",
		promptSnippet: "Read one stashed handover artifact",
		parameters: ReadParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("stash_read cancelled");
			const result = await readStash(storeDir(), params.id);
			if ("error" in result) throw readFailure(result);
			const sanitized = sanitizeTerminalText(result.content);
			const bounded = boundedOutput(sanitized.text, `Full artifact: ${result.path}`);
			return {
				content: [{ type: "text" as const, text: bounded.text }],
				details: {
					path: result.path,
					truncated: bounded.truncated,
					controlsEscaped: sanitized.changed,
					totalBytes: bounded.totalBytes,
					totalLines: bounded.totalLines,
				},
			};
		},
	});

	pi.registerTool<typeof CompleteParams, Record<string, unknown>>({
		name: "stash_complete",
		label: "Stash Complete",
		description:
			"Close an active stashed effort with a concrete terminal outcome. Use the id named in the pickup instruction after the resumed work is complete. The artifact is retained and can be deliberately reopened later.",
		promptSnippet: "Close an active stashed effort with its concrete outcome",
		promptGuidelines: [
			"Use stash_complete with the picked-up stash id when the resumed effort reaches a terminal outcome; state what completed, failed, or was deliberately abandoned.",
		],
		executionMode: "sequential",
		parameters: CompleteParams,
		async execute(_toolCallId, params, signal) {
			const transitioned = await changeLifecycle(params.id, { action: "close", outcome: params.outcome }, signal);
			return {
				content: [
					{
						type: "text" as const,
						text: `Closed stash ${transitioned.id}.\nOutcome: ${safeLine(transitioned.meta.outcome ?? params.outcome.trim())}`,
					},
				],
				details: {
					id: transitioned.id,
					path: transitioned.path,
					state: transitioned.meta.state,
					closedAt: transitioned.meta.closedAt,
					outcome: transitioned.meta.outcome,
				},
			};
		},
	});

	pi.registerTool<typeof RotateParams, Record<string, unknown>>({
		name: "stash_rotate",
		label: "Stash Rotate",
		description:
			"Archive a stale stashed effort (open or closed) so it no longer appears in listings or pickup. The artifact moves to the stash store's dot-hidden .trash directory and remains recoverable; active stashes cannot be rotated. Use when a handover is superseded or no longer needed.",
		promptSnippet: "Archive a stale stashed effort so it stops appearing in listings",
		promptGuidelines: [
			"Use stash_rotate for superseded or obsolete handovers. Rotation is operator-initiated and recoverable (the file moves to .trash); do not rotate without an explicit reason.",
		],
		executionMode: "sequential",
		parameters: RotateParams,
		async execute(_toolCallId, params, signal) {
			const rotated = await rotateLifecycle(params.id, signal);
			return {
				content: [{ type: "text" as const, text: `Rotated stash ${rotated.id} to the stash archive.` }],
				details: { id: rotated.id, state: rotated.state, archivePath: rotated.archivePath },
			};
		},
	});

	pi.registerCommand("stash", {
		description: "Create, browse, get, complete, release, reopen, or rotate stashed efforts",
		getArgumentCompletions: stashArgumentCompletions,
		handler: (args, ctx) => handleStashCommand(pi, args, ctx, overrides),
	});
}

async function handleStashCommand(
	pi: StashExtensionApi,
	args: string,
	ctx: ExtensionCommandContext,
	overrides?: { distillSessionFactory?: DistillSessionFactory; copyText?: (text: string) => Promise<void> },
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
			return createCommand(pi, ctx, parts, fail, overrides?.distillSessionFactory);
		case "abort":
			return abortCommand(ctx, parts, fail);
		case "help":
			return helpCommand(ctx, parts, fail);
		case "capacity":
			return capacityCommand(pi, ctx, parts, fail);
		case "get":
			return getCommand(pi, ctx, parts, fail);
		case "complete":
			return completeCommand(ctx, parts, fail);
		case "release":
		case "rotate":
		case "reopen":
			return lifecycleCommand(ctx, verb, parts, fail);
	}
	if (parts.length === 1 && verb && FULL_ID_RE.test(verb)) {
		fail(`Pick up with: /stash get ${verb}`);
		return;
	}
	if (!verb) return browseAndPickup(pi, ctx, fail, overrides?.copyText);
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
	pi: StashExecutionApi,
	ctx: ExtensionCommandContext,
	parts: string[],
	fail: CommandFailure,
	factory?: DistillSessionFactory,
): Promise<void> {
	const hint = parts.slice(1).join(" ");
	if (!hint) return fail("Usage: /stash new <hint>");
	await startCreation(pi, ctx, hint, factory);
}

function abortCommand(ctx: ExtensionCommandContext, parts: string[], fail: CommandFailure): void {
	if (parts.length !== 1) {
		fail("Usage: /stash abort");
		return;
	}
	if (!inFlight) {
		notify(ctx, "No stash creation is in flight.", "info");
		return;
	}
	if (ownerSessionId !== sessionKeyOf(ctx)) {
		fail("The in-flight stash creation belongs to another session. Abort it from that session.");
		return;
	}
	const current = inFlight;
	inFlight = null;
	stopSpinner();
	clearResultStatus();
	setStatus(ctx, undefined);
	notify(ctx, "Stash creation cancelled.", "info");
	// The synchronous notice above covers the eventual aborted outcome; the
	// stale-slot branch must not repeat it when the job settles.
	current.cancelNoticeGiven = true;
	current.controller.abort();
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

async function completeCommand(ctx: ExtensionCommandContext, parts: string[], fail: CommandFailure): Promise<void> {
	const id = parts[1];
	const outcome = parts.slice(2).join(" ");
	if (!id || !outcome) {
		fail("Usage: /stash complete <id> <concrete outcome>");
		return;
	}
	try {
		const transitioned = await changeLifecycle(id, { action: "close", outcome });
		if (ctx.hasUI) ctx.ui.notify(`Closed stash ${transitioned.id}.`, "info");
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
