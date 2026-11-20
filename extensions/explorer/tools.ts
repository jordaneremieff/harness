import { arr, bool, int, lit, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import type { LiveBridge } from "./live-bridge.ts";
import { liveArguments } from "./live-launch.ts";
import type { LiveConfig } from "./live-protocol.ts";
import { type Note, NotesError, NotesStore } from "./notes-store.ts";
import { BUILD_COMMAND, type LaunchTarget, paneLaunch } from "./pane-command.ts";
import {
	isRelativePath,
	type Repo,
	type ResolvedScope,
	type ReviewScope,
	resolveReviewTarget,
	resolveScope,
	resolveTarget,
	reviewAnchor,
} from "./repository.ts";
import type { AgentPane } from "./settings.ts";

const pathInput = str({ minLength: 1, maxLength: 4096 });
const noteId = str({ pattern: "^n-[a-f0-9]{20}$" });
const line = int({ minimum: 1, maximum: 2_147_483_647 });
const title = str({ minLength: 1, maxLength: 200 });
const text = str({ minLength: 1, maxLength: 16384 });
const review = obj(
	{
		scope: opt(union([lit("uncommitted"), lit("branch"), lit("since-review")])),
		commit: opt(str({ minLength: 1, maxLength: 512 })),
		range: opt(str({ minLength: 4, maxLength: 1026, description: "Two refs separated by .." })),
	},
	{},
);
const stop = obj({ path: pathInput, start: line, end: line, title, text }, {});
export const ShowParameters = obj(
	{
		path: opt(pathInput),
		line: opt(line),
		endLine: opt(line),
		review: opt(review),
		tour: opt(str({ pattern: "^t-[a-f0-9]{20}$" })),
		note: opt(obj({ title: opt(title), text }, {})),
	},
	{},
);
export const NotesParameters = obj(
	{
		op: union([lit("list"), lit("read"), lit("reply"), lit("resolve"), lit("reopen"), lit("note"), lit("tour")]),
		root: opt(pathInput),
		path: opt(pathInput),
		id: opt(noteId),
		ids: opt(arr(noteId, { minItems: 1, maxItems: 100 })),
		state: opt(union([lit("draft"), lit("open"), lit("sent"), lit("answered"), lit("resolved")])),
		start: opt(line),
		end: opt(line),
		text: opt(text),
		title: opt(title),
		review: opt(review),
		stops: opt(arr(stop, { minItems: 1, maxItems: 32 })),
	},
	{},
);
export type ShowInput = Static<typeof ShowParameters>;
export type NotesInput = Static<typeof NotesParameters>;
// The two callers receive the same bounded JSON receipt. Fields depend on the operation.
export const ToolOutcomeSchema = obj(
	{
		ok: bool(),
		summary: str(),
		op: str(),
	},
	{ open: true },
);
export type Outcome = Static<typeof ToolOutcomeSchema> & Record<string, unknown>;
export const NOTES_DESCRIPTION =
	"List and read a repository's Explorer notes, add an agent note or reply, resolve or reopen notes, or create an ordered walkthrough. root selects the repository; path is relative to its root. note requires path, start, end and text; tour requires title and stops. Pass the returned tour ID to explorer_show. This tool opens no pane.";
export function showGuidance(pane: AgentPane): string {
	const placement = pane === "split" ? "split to the right of your own pane" : "floating pane that stays in place";
	return `If the operator needs to see the code now and you receive show, use its exact argv as the program of a new ${placement}, with no target, without taking focus, and with the pane set to close when its program ends. An agent without its own terminal pane uses a floating pane on the ordinary session's tab. Respect a different placement requested by the operator. Reuse one Explorer pane: moved confirms a live pane navigated, and paneInput is for a pane you already opened. Type into or close only your own pane. The operator can close it at any time. If navigation is unconfirmed, do not open a replacement automatically.`;
}
export const showDescription = (pane: AgentPane) =>
	`Show a file, line range, review or walkthrough in Explorer. For a supplied note, save an open agent note first. If a live pane from this conversation is connected, navigate it instead of creating another. No window opens by itself. ${showGuidance(pane)}`;

export function reviewInput(input: Static<typeof review>): ReviewScope {
	const { scope, commit, range } = input;
	if (Number(scope !== undefined) + Number(commit !== undefined) + Number(range !== undefined) !== 1)
		throw new Error("Choose one review scope, commit or range.");
	if (scope) return { kind: scope };
	if (commit) return { kind: "commit", commit };
	const [base, head, extra] = (range ?? "").split("..");
	if (!base || !head || extra !== undefined || head.startsWith("."))
		throw new Error("A review range must have the form base..head.");
	return { kind: "range", base, head };
}
export async function checkedScope(repo: Repo, store: NotesStore, scope: ReviewScope) {
	const marker =
		scope.kind === "since-review" && repo.branch ? (await store.request("marker", { branch: repo.branch })).head : null;
	return resolveScope(repo, scope, typeof marker === "string" ? marker : null);
}

function outcome(op: string, summary: string, data: Record<string, unknown> = {}): Outcome {
	return { ...data, ok: true, op, summary };
}
function failure(op: string, error: unknown): Outcome {
	const summary = (error instanceof Error ? error.message : "Explorer could not complete the operation.").slice(
		0,
		1024,
	);
	return {
		ok: false,
		op,
		summary,
		error: { code: error instanceof NotesError ? error.code : "invalid", message: summary },
	};
}
function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`${name} is required.`);
	return value;
}
async function agentNote(
	repo: Repo,
	path: string,
	start: number,
	end: number,
	text: string,
	title?: string,
	review?: ResolvedScope,
) {
	if (!isRelativePath(path)) throw new Error("A note requires a path relative to the repository root.");
	return {
		path,
		...(await reviewAnchor(repo, path, start, end, review)),
		text,
		title,
		author: "agent",
		state: "open",
	};
}
interface Context {
	cwd: string;
	dir: string;
	signal?: AbortSignal;
}
interface ShowContext extends Context {
	app: string;
	agentDir: string;
	find?: () => Promise<LiveBridge | undefined>;
	connect?: () => Promise<LiveConfig>;
}
export function pinnedReview(review: Awaited<ReturnType<typeof checkedScope>>): ReviewScope {
	if (review.scope.kind === "commit") return { kind: "commit", commit: review.head };
	if (review.scope.kind === "range" && review.base) return { kind: "range", base: review.base, head: review.head };
	return review.scope;
}
async function launchScope(input: ShowInput, store: NotesStore): Promise<ReviewScope | undefined> {
	const selected = input.review && reviewInput(input.review);
	if (!input.tour) return selected;
	const result = await store.request("list");
	const tour = (result.tours as { id: string; scope?: ReviewScope }[]).find((row) => row.id === input.tour);
	if (!tour) throw new Error("The walkthrough is not in this repository.");
	return selected ?? tour.scope;
}
async function prepareTarget(input: ShowInput, context: ShowContext): Promise<LaunchTarget> {
	const resolve = input.review ? resolveReviewTarget : resolveTarget;
	const { repo, path } = await resolve(input.path, context.cwd);
	const store = new NotesStore(context.dir, repo);
	const target: LaunchTarget = { root: repo.root, path, line: input.line, end: input.endLine, tour: input.tour };
	if (input.endLine !== undefined && (input.line === undefined || input.endLine < input.line))
		throw new Error("endLine requires line and cannot precede it.");
	if (input.line !== undefined && !path) throw new Error("A line requires a file path.");
	const scope = await launchScope(input, store);
	const review = scope ? await checkedScope(repo, store, scope) : undefined;
	if (review) {
		target.review = pinnedReview(review);
		target.view = "changes";
	}
	context.signal?.throwIfAborted();
	if (input.note) {
		const start = input.line ?? 1;
		const { note } = await store.request("create", {
			note: await agentNote(
				repo,
				required(path, "path"),
				start,
				input.endLine ?? start,
				input.note.text,
				input.note.title,
				review,
			),
		});
		target.note = (note as Note).id;
	}
	return target;
}
async function showLaunch(
	context: ShowContext,
	target: LaunchTarget,
	detail: Record<string, unknown>,
): Promise<Outcome> {
	const launch = await paneLaunch(context.app, context.dir, target, context.agentDir);
	if ("showUnavailable" in launch) return outcome("show", launch.showUnavailable, { ...detail, ...launch });
	const { live, ...data } = launch;
	if (context.connect) {
		if (!live)
			return outcome("show", "The installed app does not support live Explorer panes.", {
				...detail,
				showUnavailable: "Run /explorer update for live panes.",
				build: BUILD_COMMAND,
			});
		try {
			const config = await context.connect();
			context.signal?.throwIfAborted();
			const opened = await liveArguments(launch.show, config, context.agentDir);
			if (context.signal?.aborted) {
				await opened.remove();
				context.signal.throwIfAborted();
			}
			data.show = opened.argv;
		} catch {
			return outcome("show", "The exact conversation is unavailable.", {
				...detail,
				showUnavailable: "The live route closed; no replacement conversation was selected.",
			});
		}
	}
	return outcome("show", "Explorer prepared a pane command. No pane was opened.", { ...detail, ...data });
}
export async function runShow(input: ShowInput, context: ShowContext): Promise<Outcome> {
	try {
		context.signal?.throwIfAborted();
		const target = await prepareTarget(input, context);
		const detail = { target, ...(target.note ? { noteId: target.note } : {}) };
		const bridge = await context.find?.();
		const connected = bridge?.list().at(-1);
		if (bridge && connected) {
			const result = await bridge.navigate(connected.handle, target, context.signal);
			if (result.status === "ok")
				return outcome("show", "The connected Explorer pane opened this location.", { ...detail, moved: true });
			return { ...detail, ok: false, op: "show", summary: result.message, navigation: result.status };
		}
		return await showLaunch(context, target, detail);
	} catch (error) {
		return failure("show", error);
	}
}

function prefix(text: string, limit: number): string {
	let end = Math.min(limit, text.length);
	if (/[\ud800-\udbff]/u.test(text[end - 1] ?? "")) end--;
	return text.slice(0, end);
}
function boundedRows<T>(rows: T[], count: number, byteLimit: number): T[] {
	const result: T[] = [];
	let bytes = 2;
	for (const row of rows) {
		bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
		if (bytes > byteLimit || result.length >= count) break;
		result.push(row);
	}
	return result;
}
function preview(note: Note) {
	return {
		id: note.id,
		path: note.path,
		side: note.side,
		start: note.start,
		end: note.end,
		state: note.state,
		author: note.author,
		location: note.location,
		movedFrom: note.movedFrom,
		preview: prefix(note.text, 256),
		title: note.title,
	};
}
function boundedNote(note: Note) {
	const retained = note.thread.slice(-8).map((reply) => ({
		...reply,
		...(reply.text.length > 512 ? { text: prefix(reply.text, 512), truncated: true } : {}),
	}));
	return {
		...note,
		text: prefix(note.text, 4096),
		textTruncated: note.text.length > 4096,
		anchor: { ...note.anchor, quote: prefix(note.anchor.quote, 8192) },
		thread: retained,
		threadOmitted: note.thread.length - retained.length,
		quoteTruncated: note.anchor.quote.length > 8192,
	};
}
async function createTour(input: NotesInput, context: Context, repo: Repo, store: NotesStore) {
	const title = required(input.title, "title");
	const stops = required(input.stops, "stops");
	const review = input.review ? await checkedScope(repo, store, reviewInput(input.review)) : undefined;
	const scope = review ? pinnedReview(review) : undefined;
	const notes = [];
	for (const row of stops) {
		context.signal?.throwIfAborted();
		notes.push(await agentNote(repo, row.path, row.start, row.end, row.text, row.title, review));
	}
	const { tour } = await store.request("tour-create", { title, scope, notes });
	const { id } = tour as { id: string };
	return outcome("tour", `Saved walkthrough ${id}.`, { tourId: id, tour });
}
export async function runNotes(input: NotesInput, context: Context): Promise<Outcome> {
	try {
		context.signal?.throwIfAborted();
		const { repo } = await resolveTarget(input.root, context.cwd);
		const store = new NotesStore(context.dir, repo);
		const { op } = input;
		switch (op) {
			case "list": {
				const listed = await store.request("list", { path: input.path });
				const notes = (listed.notes as Note[]).filter(
					(note) => input.state === undefined || note.state === input.state,
				);
				const tours = listed.tours as Array<{ id: string; title: string; scope?: ReviewScope; stops: string[] }>;
				const rows = boundedRows(notes.slice(0, 64).map(preview), 64, 80 * 1024);
				const walks = boundedRows(
					tours.slice(0, 32).map(({ id, title, scope, stops }) => ({ id, title, scope, stopCount: stops.length })),
					32,
					16 * 1024,
				);
				return outcome(op, `${notes.length} notes match in ${repo.label}.`, {
					notes: rows,
					tours: walks,
					limited: rows.length < notes.length || walks.length < tours.length || listed.truncated === true,
					unreadable: listed.unreadable,
				});
			}
			case "read":
			case "reply": {
				const id = required(input.id, "id");
				const found = await store.request(
					op,
					op === "read" ? { id } : { id, author: "agent", text: required(input.text, "text") },
				);
				return outcome(op, op === "read" ? `Read ${id}.` : `Added a reply to ${id}.`, {
					note: boundedNote(found.note as Note),
				});
			}
			case "resolve":
			case "reopen": {
				const ids = required(input.ids, "ids");
				const { notes } = await store.request("state", { ids, state: op === "resolve" ? "resolved" : "open" });
				return outcome(op, `${op === "resolve" ? "Resolved" : "Reopened"} ${(notes as Note[]).length} notes.`, {
					notes: (notes as Note[]).map(({ id, state, updatedAt }) => ({ id, state, updatedAt })),
				});
			}
			case "note": {
				const { note } = await store.request("create", {
					note: await agentNote(
						repo,
						required(input.path, "path"),
						required(input.start, "start"),
						required(input.end, "end"),
						required(input.text, "text"),
						input.title,
					),
				});
				return outcome(op, `Saved ${(note as Note).id}.`, { note: boundedNote(note as Note) });
			}
			case "tour":
				return await createTour(input, context, repo, store);
		}
	} catch (error) {
		return failure(input.op, error);
	}
}

export function outcomeContent(value: Outcome) {
	return [{ type: "text" as const, text: JSON.stringify(value) }];
}
