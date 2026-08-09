/** Session continuity tools plus the interactive /stash pickup workflow. */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	copyToClipboard,
	getAgentDir,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startDistillJob, type DistillJob, type DistillOutcome, type DistillSessionFactory } from "./distill.ts";
import { resumeCommand, STASH_STATES, type StashState } from "./format.ts";
import { StashPanel } from "./panel.ts";
import { buildPickupMessage } from "./pickup.ts";
import {
	listStashes,
	readStash,
	resolveStoreDir,
	rotateStash,
	transitionStash,
	writeStash,
	type StashLifecycleChange,
} from "./store.ts";
import { boundedOutput, sanitizeTerminalText } from "./text.ts";

const storeDir = () => resolveStoreDir(process.env, getAgentDir());
const safe = (value: string) => sanitizeTerminalText(value).text;
const safeLine = (value: string) => safe(value).replace(/\n/g, "↵");

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
}

let inFlight: InFlightJob | null = null;
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

function startSpinner(ctx: StatusUi): void {
	let frame = 0;
	spinnerTimer = setInterval(() => {
		frame = (frame + 1) % SPINNER_FRAMES.length;
		setStatus(ctx, `stash: running ${SPINNER_FRAMES[frame]}`);
	}, SPINNER_INTERVAL_MS);
	spinnerTimer.unref?.();
}

function settleDistill(slot: InFlightJob, outcome: DistillOutcome, ctx: StatusUi): void {
	if (inFlight !== slot || slot.job === null) {
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
		}
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
	if (outcome.ok === true) {
		hold(`stash: done ${outcome.record.id}`);
		notify(
			ctx,
			`Stashed "${safeLine(outcome.record.title)}" as ${outcome.record.id}\n${safeLine(outcome.path)}\n\nResume in a new session:\n  ${resumeCommand(outcome.record.id)}`,
			"info",
		);
		return;
	}
	if (outcome.reason === "skip") {
		hold("stash: skipped");
		notify(ctx, "Nothing worth stashing: the distiller found no content to preserve.", "info");
		return;
	}
	hold("stash: failed");
	notify(ctx, `Stash distillation failed: ${safeLine(outcome.message ?? outcome.reason)}`, "error");
}

/** Release only this dispatch's slot; stale setup cleanup must not clear a replacement. */
function releaseSlot(slot: InFlightJob): void {
	if (inFlight === slot) inFlight = null;
}

async function startCreation(
	pi: ExtensionAPI,
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
	const model = ctx.model;
	if (!model) {
		surface("No model is available for this session; cannot start a stash distillation.", "error");
		return;
	}
	let entries: ReturnType<typeof ctx.sessionManager.buildContextEntries>;
	try {
		entries = ctx.sessionManager.buildContextEntries();
	} catch (error) {
		surface(`Could not read the session transcript: ${safeLine(error instanceof Error ? error.message : String(error))}`, "error");
		return;
	}
	// Reserve the single-flight slot BEFORE any await so concurrent dispatches serialize,
	// and wire one AbortController to both the setup awaits and the eventual job.
	const controller = new AbortController();
	const slot: InFlightJob = { job: null, controller };
	inFlight = slot;
	try {
		let branch: string | undefined;
		try {
			const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, signal: controller.signal });
			if (result.code === 0) branch = result.stdout.trim() || undefined;
		} catch {
			branch = undefined;
		}
		if (controller.signal.aborted) {
			releaseSlot(slot);
			return;
		}
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? process.env.PI_SESSION_ID;
		} catch {
			sessionId = process.env.PI_SESSION_ID;
		}
		const job = startDistillJob({
			model,
			cwd: ctx.cwd,
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
			setStatus(ctx, `stash: running ${SPINNER_FRAMES[0]}`);
			startSpinner(ctx);
		}
		notify(
			ctx,
			hint.trim() ? `Stash distillation started (hint: ${safeLine(hint.trim())}).` : "Stash distillation started.",
			"info",
		);
		void job.result.then((outcome) => settleDistill(slot, outcome, ctx));
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
	title: shortText("Short human title for the handover"),
	summary: Type.String({
		description: "Distilled state of the effort: what is true now, what was done, what matters. Prose, self-contained.",
		maxLength: 100_000,
	}),
	decisions: itemList("Committed decisions, each with its why"),
	openLoops: itemList("Unresolved questions, blockers, unknowns"),
	nextActions: itemList("Ordered next steps for whoever resumes"),
	files: itemList("Relevant file paths"),
	tags: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { description: "Subject tags (tag by subject, not by consumer)", maxItems: 50 })),
});

const stateSchema = StringEnum(STASH_STATES, { description: "Lifecycle state: open, active, or closed" });

const ListParams = Type.Object({
	limit: Type.Optional(Type.Integer({ description: "Max entries (default 10, max 50)", minimum: 1, maximum: 50 })),
	tag: Type.Optional(Type.String({ description: "Only stashes carrying this tag", maxLength: 80 })),
	state: Type.Optional(stateSchema),
});

const ReadParams = Type.Object({
	id: Type.String({ description: "Stash id or unique id prefix (from stash_list)", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._-]+$" }),
});

const CompleteParams = Type.Object({
	id: Type.String({ description: "Active stash id or unique id prefix", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._-]+$" }),
	outcome: Type.String({ description: "Concrete terminal outcome of the resumed effort", minLength: 1, maxLength: 20_000 }),
});

const RotateParams = Type.Object({
	id: Type.String({ description: "Stash id or unique id prefix (from stash_list)", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._-]+$" }),
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
	const target = await readStash(dir, id);
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
	{ value: "get", label: "get", description: "<id> · pick up by full id or unique prefix" },
	{ value: "complete", label: "complete", description: "<id> <outcome> · close an active stash" },
	{ value: "reopen", label: "reopen", description: "<id> · return a closed stash to open" },
	{ value: "rotate", label: "rotate", description: "<id> · archive a stale stash (recoverable)" },
	{ value: "abort", label: "abort", description: "cancel an in-flight stash creation" },
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
	"  /stash get <id>             pick up a stash",
	"  /stash complete <id> <out>  close an active stash with a concrete outcome",
	"  /stash reopen <id>          return a closed stash to open",
	"  /stash rotate <id>          archive a stale stash (recoverable)",
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
		return matches.map((entry) => make(entry.meta.id, entry.meta.state, entry.meta.title));
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
	// (for complete, that token begins the outcome).
	if (tail.includes(" ")) return null;
	if (verb === "get" || verb === "complete" || verb === "reopen" || verb === "rotate") {
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
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	id: string,
	fail: (message: string) => void,
): Promise<void> {
	let activated: Awaited<ReturnType<typeof changeLifecycle>>;
	try {
		activated = await changeLifecycle(id, { action: "activate" });
	} catch (error) {
		fail(`Could not activate stash for pickup: ${safeLine(error instanceof Error ? error.message : String(error))}`);
		return;
	}
	try {
		const message = buildPickupMessage(activated.id, activated.content, { currentCwd: ctx.cwd });
		if (ctx.isIdle()) {
			pi.sendUserMessage(message);
		} else {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
			if (ctx.hasUI) ctx.ui.notify(`Queued stash ${activated.id} for pickup after the current turn.`, "info");
		}
	} catch (error) {
		fail(`Stash ${activated.id} is active, but pickup delivery failed: ${safeLine(error instanceof Error ? error.message : String(error))}`);
	}
}

/** Bare `/stash` (TUI): browse stashes and act on them; a selected entry is picked up. */
async function browseAndPickup(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	fail: (message: string) => void,
	copyText?: (text: string) => Promise<void>,
): Promise<void> {
	let browserFilter: string | undefined;
	let browserSelectedId: string | undefined;
	let browserSelectedIndex: number | undefined;
	let pickupId: string | undefined;

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
		const result = await ctx.ui.custom<{
			selected?: (typeof entries)[number];
			manage?: (typeof entries)[number];
			complete?: (typeof entries)[number];
			filter?: string;
			selectedId?: string;
			selectedIndex?: number;
		}>(
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
		if (result?.selected) {
			pickupId = result.selected.meta.id;
			break;
		}
		if (result?.complete) {
			try {
				const outcome = await ctx.ui.input("Concrete outcome for this stashed effort:");
				if (outcome?.trim()) {
					const transitioned = await changeLifecycle(result.complete.meta.id, { action: "close", outcome });
					ctx.ui.notify(`Closed stash ${transitioned.id}.`, "info");
				}
			} catch (error) {
				fail(safeLine(error instanceof Error ? error.message : String(error)));
				return;
			}
			continue;
		}
		if (!result?.manage) return;

		const state: StashState = result.manage.meta.state;
		const choices =
			state === "active"
				? ["Close with outcome", "Back"]
				: state === "closed"
					? ["Reopen", "Rotate (archive)", "Back"]
					: ["Pick up", "Rotate (archive)", "Back"];
		const action = await ctx.ui.select(`Stash ${result.manage.meta.id}`, choices);
		if (!action || action === "Back") continue;
		try {
			if (action === "Pick up") {
				pickupId = result.manage.meta.id;
			} else if (action === "Close with outcome") {
				const outcome = await ctx.ui.input("Concrete outcome for this stashed effort:");
				if (outcome?.trim()) {
					const transitioned = await changeLifecycle(result.manage.meta.id, { action: "close", outcome });
					ctx.ui.notify(`Closed stash ${transitioned.id}.`, "info");
				}
			} else if (action === "Reopen") {
				const confirmed = await ctx.ui.confirm(
					"Reopen stashed effort?",
					`Clear the closure outcome on ${result.manage.meta.id} and return it to open state?`,
				);
				if (confirmed) {
					const transitioned = await changeLifecycle(result.manage.meta.id, { action: "reopen" });
					ctx.ui.notify(`Reopened stash ${transitioned.id}.`, "info");
				}
			} else if (action === "Rotate (archive)") {
				const confirmed = await ctx.ui.confirm(
					"Rotate stashed effort?",
					`Move ${result.manage.meta.id} into the stash store's .trash directory? It will disappear from listings and pickup; the file remains recoverable.`,
				);
				if (confirmed) {
					const rotated = await rotateLifecycle(result.manage.meta.id);
					ctx.ui.notify(`Rotated stash ${rotated.id} to the stash archive.`, "info");
				}
			}
		} catch (error) {
			fail(safeLine(error instanceof Error ? error.message : String(error)));
			return;
		}
	}

	if (pickupId) await deliverPickup(pi, ctx, pickupId, fail);
}

export default function (
	pi: ExtensionAPI,
	overrides?: { distillSessionFactory?: DistillSessionFactory; copyText?: (text: string) => Promise<void> },
) {
	pi.on("session_shutdown", async (_event, ctx) => {
		if (inFlight) {
			inFlight.controller.abort();
			inFlight = null;
		}
		stopSpinner();
		clearResultStatus();
		setStatus(ctx, undefined);
	});
	pi.registerTool<typeof WriteParams, Record<string, unknown>>({
		name: "stash_write",
		label: "Stash Write",
		description:
			"Distill the current effort into a durable handover artifact (markdown) stored on disk outside the session. Use when handing work to a future session, before major context loss, or when the operator asks to stash.",
		promptSnippet: "Distill the current effort into a durable, discoverable handover artifact",
		promptGuidelines: [
			"Use stash_write when the operator asks to stash, when an effort reaches a resumable state, or before a session ends with open loops. Make the summary self-contained for a fresh session.",
		],
		parameters: WriteParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("stash_write cancelled");
			let branch: string | undefined;
			try {
				const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, signal });
				if (result.code === 0) branch = result.stdout.trim() || undefined;
			} catch {
				branch = undefined;
			}
			if (signal?.aborted) throw new Error("stash_write cancelled");
			let sessionId: string | undefined;
			try {
				sessionId = ctx.sessionManager.getSessionId() ?? process.env.PI_SESSION_ID;
			} catch {
				sessionId = process.env.PI_SESSION_ID;
			}
			try {
				const { record, path } = await writeStash(storeDir(), {
					...params,
					project: ctx.cwd,
					branch,
					sessionId,
				});
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
			const entries = await listStashes(storeDir(), { limit: params.limit ?? 10, tag: params.tag, state: params.state });
			if (entries.length === 0) {
				const scopes = [
					params.tag ? `tag "${safeLine(params.tag)}"` : undefined,
					params.state ? `state ${params.state}` : undefined,
				].filter((value): value is string => Boolean(value));
				const scope = scopes.length > 0 ? ` with ${scopes.join(" and ")}` : "";
				return { content: [{ type: "text" as const, text: `No stashes found${scope}.` }], details: { count: 0 } };
			}
			const text = entries
				.map(({ meta }) => {
					const tags = meta.tags.length > 0 ? ` [${meta.tags.map(safeLine).join(", ")}]` : "";
					return `${meta.id}\n  ${meta.state} · ${safeLine(meta.title)}${tags}`;
				})
				.join("\n");
			const bounded = boundedOutput(text, "Lower limit or filter by tag for a narrower list.");
			return {
				content: [{ type: "text" as const, text: bounded.text }],
				details: {
					count: entries.length,
					ids: entries.map((entry) => entry.meta.id),
					states: entries.map((entry) => entry.meta.state),
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
		description: "Create, browse, get, close, reopen, or rotate stashed efforts",
		getArgumentCompletions: stashArgumentCompletions,
		handler: async (args, ctx) => {
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

			if (verb === "new") {
				const hint = parts.slice(1).join(" ");
				if (!hint) {
					fail("Usage: /stash new <hint>");
					return;
				}
				await startCreation(pi, ctx, hint, overrides?.distillSessionFactory);
				return;
			}

			if (verb === "abort") {
				if (parts.length !== 1) {
					fail("Usage: /stash abort");
					return;
				}
				if (!inFlight) {
					notify(ctx, "No stash creation is in flight.", "info");
					return;
				}
				const current = inFlight;
				inFlight = null;
				stopSpinner();
				clearResultStatus();
				setStatus(ctx, undefined);
				notify(ctx, "Stash creation cancelled.", "info");
				current.controller.abort();
				return;
			}

			if (verb === "help") {
				if (parts.length !== 1) {
					fail("Usage: /stash help");
					return;
				}
				if (ctx.hasUI) ctx.ui.notify(STASH_USAGE, "info");
				else throw new Error(STASH_USAGE);
				return;
			}

			if (verb === "get") {
				const id = parts[1];
				if (!id || parts.length !== 2) {
					fail("Usage: /stash get <id>");
					return;
				}
				await deliverPickup(pi, ctx, id, fail);
				return;
			}

			if (verb === "complete") {
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
				return;
			}

			if (verb === "rotate") {
				const id = parts[1];
				if (!id || parts.length !== 2) {
					fail("Usage: /stash rotate <id>");
					return;
				}
				try {
					const rotated = await rotateLifecycle(id);
					if (ctx.hasUI) ctx.ui.notify(`Rotated stash ${rotated.id} to the stash archive.`, "info");
				} catch (error) {
					fail(safeLine(error instanceof Error ? error.message : String(error)));
				}
				return;
			}

			if (verb === "reopen") {
				const id = parts[1];
				if (!id || parts.length !== 2) {
					fail("Usage: /stash reopen <id>");
					return;
				}
				try {
					const transitioned = await changeLifecycle(id, { action: "reopen" });
					if (ctx.hasUI) ctx.ui.notify(`Reopened stash ${transitioned.id}.`, "info");
				} catch (error) {
					fail(safeLine(error instanceof Error ? error.message : String(error)));
				}
				return;
			}

			// A bare full-id arg is a stale `pi "/stash <id>"` string, not an action.
			if (parts.length === 1 && verb && FULL_ID_RE.test(verb)) {
				fail(`Pick up with: /stash get ${verb}`);
				return;
			}

			if (!verb) {
				await browseAndPickup(pi, ctx, fail, overrides?.copyText);
				return;
			}

			fail(`Unknown /stash action "${safeLine(verb)}". Create with /stash new <hint>, or use /stash help.`);
		},
	});
}
