import { arr, bool, int, lit, nullable, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import type { LiveBridge } from "./live-bridge.ts";
import { liveArguments } from "./live-launch.ts";
import type { LiveConfig } from "./live-protocol.ts";
import { type CreateNote, type Note, NotesError, NotesStore } from "./notes-store.ts";
import { BUILD_COMMAND, type LaunchTarget, paneLaunch } from "./pane-command.ts";
import {
	type Anchor,
	isRelativePath,
	pinNoteReview,
	type Repo,
	type ResolvedScope,
	type ReviewScope,
	type ReviewSide,
	readAnchor,
	readReviewAnchor,
	resolveReviewTarget,
	resolveScope,
	resolveTarget,
	reviewAnchor,
	verifyNoteFile,
} from "./repository.ts";
import type { AgentPane } from "./settings.ts";

const pathInput = str({ minLength: 1, maxLength: 4096 });
const noteId = str({ pattern: "^n-[a-f0-9]{20}$" });
const line = int({ minimum: 1, maximum: 2_147_483_647 });
const title = str({ minLength: 1, maxLength: 200 });
const text = str({ minLength: 1, maxLength: 16384 });
const url = str({
	minLength: 1,
	maxLength: 2048,
	description: "HTTP or HTTPS URL",
});
const side = union([lit("head"), lit("base")], {
	description: "head (default) or base",
});
const reply = obj(
	{
		by: title,
		text,
		at: opt(str({ maxLength: 40, description: "ISO 8601 date and time" })),
	},
	{},
);
const review = obj(
	{
		scope: opt(union([lit("uncommitted"), lit("branch"), lit("since-review")])),
		commit: opt(str({ minLength: 1, maxLength: 512 })),
		range: opt(
			str({
				minLength: 4,
				maxLength: 1027,
				description: "Two refs separated by .. or ...",
			}),
		),
	},
	{},
);
const commitId = str({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$", description: "Full Git commit SHA" });
const target = union(
	[
		obj({ kind: lit("file"), path: pathInput, side: opt(side) }, {}),
		obj({ kind: lit("commit"), commit: commitId }, {}),
		obj({ kind: lit("review"), review }, {}),
	],
	{},
);
const comment = obj(
	{
		id: str({
			minLength: 1,
			maxLength: 200,
			description: "Remote comment or discussion ID, unique in the repository",
		}),
		path: opt(
			str({
				minLength: 1,
				maxLength: 4096,
				description: "Path on the comment's side: the new path for head, the old path for base",
			}),
		),
		start: opt(line),
		end: opt(line),
		side: opt(side),
		commit: opt(commitId),
		by: str({
			minLength: 1,
			maxLength: 200,
			description: "Display name of the remote author",
		}),
		text,
		url: opt(url),
		resolved: opt(bool()),
		replies: opt(arr(reply, { maxItems: 64 })),
	},
	{},
);
const noteInput = obj(
	{
		path: opt(pathInput),
		side: opt(side),
		start: opt(line),
		end: opt(line),
		target: opt(target),
		title: opt(title),
		text,
		url: opt(url),
	},
	{},
);
export const ShowParameters = obj(
	{
		path: opt(pathInput),
		line: opt(line),
		endLine: opt(line),
		review: opt(review),
		note: opt(obj({ title: opt(title), text }, {})),
	},
	{},
);
export const NotesParameters = obj(
	{
		op: union([
			lit("list"),
			lit("read"),
			lit("reply"),
			lit("resolve"),
			lit("reopen"),
			lit("note"),
			lit("update"),
			lit("delete"),
			lit("import"),
			lit("export"),
		]),
		root: opt(pathInput),
		path: opt(pathInput),
		id: opt(noteId),
		ids: opt(arr(noteId, { minItems: 1, maxItems: 100 })),
		state: opt(union([lit("draft"), lit("open"), lit("sent"), lit("answered"), lit("resolved")])),
		start: opt(line),
		end: opt(line),
		side: opt(side),
		text: opt(text),
		title: opt(nullable(title)),
		review: opt(review),
		target: opt(target),
		notes: opt(arr(noteInput, { minItems: 1, maxItems: 64 })),
		url: opt(url),
		expectedUpdatedAt: opt(str({ minLength: 1, maxLength: 40 })),
		comments: opt(arr(comment, { minItems: 1, maxItems: 100 })),
	},
	{},
);
export type ShowInput = Static<typeof ShowParameters>;
export type NotesInput = Static<typeof NotesParameters>;
type NoteSpec = {
	path?: string;
	side?: ReviewSide;
	start?: number;
	end?: number;
	target?: NotesInput["target"];
	title?: string | null;
	text: string;
	url?: string;
};
// The two callers receive the same bounded JSON receipt. Fields depend on the operation.
export const ToolOutcomeSchema = obj(
	{
		ok: bool(),
		summary: str(),
		op: str(),
	},
	{ open: true },
);
const diagnosticLength = Symbol("diagnostic length");
export type Outcome = Static<typeof ToolOutcomeSchema> & Record<string, unknown> & { [diagnosticLength]?: number };
export function outcomeDetails(value: Outcome) {
	const retained = value[diagnosticLength];
	return {
		summary: value.summary,
		...(retained === undefined ? {} : { diagnosticLength: retained }),
	};
}
export const NOTES_OUTPUT_BYTES = 128 * 1024;
export const NOTES_DESCRIPTION =
	"List, read, add, reply to, resolve or reopen Explorer notes, import remote comments, export operator notes, update or delete agent notes. Notes may point at lines, a file, a commit or a review. Supply review for import/export and for line anchoring. Paths are relative to root. This tool opens no pane.";
type ShowAudience = AgentPane | "native";
export function showGuidance(pane: ShowAudience): string {
	const placement =
		pane === "native"
			? "split on the right of the inherited pane"
			: pane === "split"
				? "split to the right of your own pane"
				: "floating pane that stays in place";
	const audience =
		pane === "native" ? "Do" : "If you work for another agent or run without an interactive conversation, do";
	const report = `${audience} not call explorer_show unless the operator explicitly asks you to show code. Otherwise, report the file paths and line ranges to the coordinator without opening or navigating a pane.`;
	return `${report} ${pane === "native" ? "For a requested display" : "In the interactive session with the operator, when the operator needs to see the code"}, if you receive show, use its exact argv as the program of a new ${placement}, with no target, without taking focus, and with the pane set to close when its program ends. Respect a different placement requested by the operator. Reuse one Explorer pane: moved confirms a live pane navigated, and paneInput is for a pane you already opened. Type into or close only your own pane. The operator can close it at any time. If navigation is unconfirmed, do not open a replacement automatically.`;
}
export const showDescription = (pane: ShowAudience) =>
	`Show a file, line range or review in Explorer. For a supplied note, save an open agent note first. If a live pane from this conversation is connected, navigate it instead of creating another. No window opens by itself. ${showGuidance(pane)}`;

export function reviewInput(input: Static<typeof review>): ReviewScope {
	const { scope, commit, range } = input;
	if (Number(scope !== undefined) + Number(commit !== undefined) + Number(range !== undefined) !== 1)
		throw new Error("Choose one review scope, commit or range.");
	if (scope) return { kind: scope };
	if (commit) return { kind: "commit", commit };
	const [base, separator, head, extra] = (range ?? "").split(/(\.{2,})/u);
	if (!base || !head || extra !== undefined || (separator !== ".." && separator !== "..."))
		throw new Error("A review range must have the form base..head or base...head.");
	return {
		kind: "range",
		base,
		head,
		...(separator === "..." ? { mergeBase: true } : {}),
	};
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
	const diagnostic = error instanceof Error ? error.message : "Explorer could not complete the operation.";
	const summary = diagnostic.slice(0, 1024);
	return {
		ok: false,
		op,
		summary,
		error: {
			code: error instanceof NotesError ? error.code : "invalid",
			message: summary,
		},
		...(diagnostic.length > summary.length ? { [diagnosticLength]: diagnostic.length } : {}),
	};
}
function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`${name} is required.`);
	return value;
}
async function lineNote(
	repo: Repo,
	path: string,
	start: number,
	end: number,
	body: string,
	heading?: string | null,
	review?: ResolvedScope,
	chosenSide?: ReviewSide,
	link?: string,
): Promise<CreateNote> {
	if (!isRelativePath(path)) throw new Error("A note requires a path relative to the repository root.");
	let anchored: Anchor & { side: ReviewSide };
	if (review) {
		anchored = chosenSide
			? {
					side: chosenSide,
					...(await readReviewAnchor(repo, review, path, chosenSide, start, end)),
				}
			: await reviewAnchor(repo, path, start, end, review);
	} else {
		if (chosenSide === "base") throw new Error("A base-side line note requires a review.");
		anchored = { side: "head", ...(await readAnchor(repo, path, start, end)) };
	}
	return {
		path,
		side: anchored.side,
		start: anchored.start,
		end: anchored.end,
		commit: anchored.commit,
		quote: anchored.quote,
		text: body,
		...(heading === undefined || heading === null ? {} : { title: heading }),
		...(link === undefined ? {} : { url: link }),
		author: "agent",
		state: "open",
		...(review === undefined ? {} : { reviewKey: review.key }),
	};
}
async function noteFromSpec(
	repo: Repo,
	store: NotesStore,
	spec: NoteSpec,
	review?: ResolvedScope,
): Promise<CreateNote> {
	if (spec.target) return targetNoteFromSpec(repo, store, spec, spec.target, review);
	const path = spec.path;
	if (!path) throw new Error("A line note requires a path.");
	if (spec.start === undefined || spec.end === undefined) throw new Error("A line note requires start and end lines.");
	return lineNote(repo, path, spec.start, spec.end, spec.text, spec.title, review, spec.side, spec.url);
}
async function targetNoteFromSpec(
	repo: Repo,
	store: NotesStore,
	spec: NoteSpec,
	target: NonNullable<NoteSpec["target"]>,
	review?: ResolvedScope,
): Promise<CreateNote> {
	if (spec.path !== undefined || spec.start !== undefined || spec.end !== undefined || spec.side !== undefined)
		throw new Error("Place the path and side inside the file target. A target note does not take line fields.");
	const common = {
		text: spec.text,
		title: spec.title ?? undefined,
		url: spec.url,
		author: "agent" as const,
		state: "open" as const,
	};
	switch (target.kind) {
		case "file":
			await verifyNoteFile(repo, target.path, review, target.side);
			return { ...common, target, reviewKey: review?.key };
		case "commit": {
			if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(target.commit))
				throw new Error("A commit note requires a full commit SHA.");
			await resolveScope(repo, target);
			return { ...common, target };
		}
		case "review": {
			const resolved = await checkedScope(repo, store, reviewInput(target.review));
			return { ...common, target: { kind: "review", review: pinNoteReview(resolved) }, reviewKey: resolved.key };
		}
	}
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
async function prepareTarget(input: ShowInput, context: ShowContext): Promise<LaunchTarget> {
	const resolve = input.review ? resolveReviewTarget : resolveTarget;
	const { repo, path } = await resolve(input.path, context.cwd);
	const store = new NotesStore(context.dir, repo);
	const target: LaunchTarget = {
		root: repo.root,
		path,
		line: input.line,
		end: input.endLine,
	};
	if (input.endLine !== undefined && (input.line === undefined || input.endLine < input.line))
		throw new Error("endLine requires line and cannot precede it.");
	if (input.line !== undefined && !path) throw new Error("A line requires a file path.");
	const scope = input.review ? reviewInput(input.review) : undefined;
	const review = scope ? await checkedScope(repo, store, scope) : undefined;
	if (review) {
		target.review = pinnedReview(review);
		target.view = "changes";
	}
	context.signal?.throwIfAborted();
	if (input.note) {
		const start = input.line ?? 1;
		const { note } = await store.request("create", {
			note: await lineNote(
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
			return {
				...detail,
				ok: false,
				op: "show",
				summary: result.message,
				navigation: result.status,
			};
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
	const common = {
		id: note.id,
		state: note.state,
		author: note.author,
		by: note.by,
		url: note.url,
		reviewKey: note.reviewKey,
		updatedAt: note.updatedAt,
		preview: prefix(note.text, 256),
		title: note.title,
	};
	if ("target" in note) return { ...common, target: note.target };
	return {
		...common,
		path: note.path,
		side: note.side,
		start: note.start,
		end: note.end,
		location: note.location,
		movedFrom: note.movedFrom,
	};
}
function boundedNote(note: Note) {
	const retained = note.thread.slice(-8).map((reply) => ({
		...reply,
		...(reply.text.length > 512 ? { text: prefix(reply.text, 512), truncated: true } : {}),
	}));
	const quoted = "anchor" in note ? note.anchor.quote : "";
	return {
		...note,
		text: prefix(note.text, 4096),
		textTruncated: note.text.length > 4096,
		...("anchor" in note
			? {
					anchor: { ...note.anchor, quote: prefix(note.anchor.quote, 8192) },
					quoteTruncated: quoted.length > 8192,
				}
			: {}),
		thread: retained,
		threadOmitted: note.thread.length - retained.length,
	};
}
async function exportNotes(input: NotesInput, context: Context, store: NotesStore) {
	const review = reviewInput(required(input.review, "review"));
	const result = await store.request("export", { review, ids: input.ids }, context.signal);
	const { notes } = result as { notes: unknown[] };
	const receipt = outcome(
		"export",
		`Exported ${notes.length} operator ${notes.length === 1 ? "note" : "notes"}.`,
		result,
	);
	if (Buffer.byteLength(JSON.stringify(receipt)) > NOTES_OUTPUT_BYTES)
		throw new NotesError("conflict", "Select fewer Explorer notes by ID for a complete export.");
	return receipt;
}

async function createNotes(input: NotesInput, context: Context, repo: Repo, store: NotesStore) {
	const op = "note";
	if (
		input.notes &&
		[input.path, input.side, input.start, input.end, input.target, input.title, input.text, input.url].some(
			(field) => field !== undefined,
		)
	)
		throw new Error("Supply either a single note or a notes array.");
	const review = input.review ? await checkedScope(repo, store, reviewInput(input.review)) : undefined;
	const specs: NoteSpec[] =
		input.notes !== undefined
			? input.notes
			: [
					{
						path: input.path,
						side: input.side,
						start: input.start,
						end: input.end,
						target: input.target,
						title: input.title,
						text: required(input.text, "text"),
						url: input.url,
					},
				];
	const notes = [];
	for (const spec of specs) {
		context.signal?.throwIfAborted();
		notes.push(await noteFromSpec(repo, store, spec, review));
	}
	const saved = (await store.request("create", { notes })).notes as Note[];
	const ids = saved.map((note) => note.id);
	const rows = boundedRows(saved.map(preview), 64, 80 * 1024);
	return outcome(op, `Saved ${ids.length} ${ids.length === 1 ? "note" : "notes"}.`, {
		ids,
		notes: rows,
		limited: rows.length < saved.length,
		...(saved.length === 1 ? { note: boundedNote(saved[0]) } : {}),
	});
}
async function updateNote(input: NotesInput, store: NotesStore) {
	const op = "update";
	const id = required(input.id, "id");
	if (input.text === undefined && input.title === undefined) throw new Error("Note text or title is required.");
	const { note } = await store.request("update", {
		id,
		...(input.text === undefined ? {} : { text: input.text }),
		...(input.title === undefined ? {} : { title: input.title }),
		expectedUpdatedAt: required(input.expectedUpdatedAt, "expectedUpdatedAt"),
		agentOnly: true,
	});
	return outcome(op, `Updated ${id}.`, {
		ids: [id],
		note: boundedNote(note as Note),
	});
}
async function listNotes(input: NotesInput, repo: Repo, store: NotesStore) {
	const op = "list";
	const listed = await store.request("list", { path: input.path });
	const notes = (listed.notes as Note[]).filter((note) => input.state === undefined || note.state === input.state);
	const rows = boundedRows(notes.slice(0, 64).map(preview), 64, 80 * 1024);
	return outcome(op, `${notes.length} notes match in ${repo.label}.`, {
		notes: rows,
		limited: rows.length < notes.length || listed.truncated === true,
		unreadable: listed.unreadable,
	});
}

export async function runNotes(input: NotesInput, context: Context): Promise<Outcome> {
	try {
		context.signal?.throwIfAborted();
		const { repo } = await resolveTarget(input.root, context.cwd);
		const store = new NotesStore(context.dir, repo);
		const { op } = input;
		switch (op) {
			case "list":
				return await listNotes(input, repo, store);
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
				const { notes } = await store.request("state", {
					ids,
					state: op === "resolve" ? "resolved" : "open",
				});
				return outcome(op, `${op === "resolve" ? "Resolved" : "Reopened"} ${(notes as Note[]).length} notes.`, {
					notes: (notes as Note[]).map(({ id, state, updatedAt }) => ({
						id,
						state,
						updatedAt,
					})),
				});
			}
			case "note":
				return await createNotes(input, context, repo, store);
			case "update":
				return await updateNote(input, store);
			case "delete": {
				const ids = required(input.ids, "ids");
				const result = await store.request("delete", { ids, agentOnly: true });
				const removed = result.ids as string[];
				return outcome(op, `Deleted ${removed.length} ${removed.length === 1 ? "note" : "notes"}.`, {
					ids: removed,
				});
			}
			case "import": {
				const review = reviewInput(required(input.review, "review"));
				const result = await store.request(
					op,
					{ review, comments: required(input.comments, "comments") },
					context.signal,
				);
				const { created, updated, skipped } = result as {
					created: number;
					updated: number;
					skipped: unknown[];
				};
				return outcome(
					op,
					`Imported comments: ${created} created, ${updated} updated, ${skipped.length} skipped.`,
					result,
				);
			}
			case "export":
				return await exportNotes(input, context, store);
		}
	} catch (error) {
		return failure(input.op, error);
	}
}

export function outcomeContent(value: Outcome) {
	return [{ type: "text" as const, text: JSON.stringify(value) }];
}
