import { randomBytes } from "node:crypto";
import { join, relative } from "node:path";
import { defaultPath, devEditText, type Fixture, openFixtureRoot, validFixturePath } from "./fixture.mts";
import { renderFixtureMarkdown } from "./markdown.mts";
import { createReview, lines, uncommitted } from "./review.mts";

type Packet = {
	[K in keyof ExplorerRequests]: { type: K; v: 1 } & NonNullable<
		ExplorerRequests[K][0] extends undefined ? object : ExplorerRequests[K][0]
	>;
}[keyof ExplorerRequests];
type Event = ExplorerEvent extends infer E ? (E extends ExplorerEvent ? Omit<E, "v"> : never) : never;

const id = (prefix: string) => `${prefix}-${randomBytes(10).toString("hex")}`;
const now = () => new Date().toISOString();
const live = { connected: true, label: "Dev conversation" };
const fail = (code: string, message: string) => ({ ok: false, error: { code, message } });

export function createBridge(
	baseRepo: Fixture,
	emit: (event: Event) => void,
	schedule: (fn: () => void, delay: number) => void,
) {
	const base = { path: baseRepo.root, name: baseRepo.rootInfo().name };
	let repo = baseRepo;
	let root = repo.rootInfo();
	let indexed: ExplorerRequests["files.list"][1] | undefined;
	function rootState(fixture: Fixture, launch: ExplorerLaunch) {
		return {
			launch,
			review: createReview(fixture),
			cardDrafts: new Map<string, ExplorerCardDraft>(),
			editDrafts: new Map<string, ExplorerEditDraft>(),
			notes: new Map<string, ExplorerNote>(),
			tours: new Map<string, ExplorerTour>(),
		};
	}
	const initial = rootState(baseRepo, { path: defaultPath, view: "file" });
	const stores = new Map([[base.path, initial]]);
	let active = initial;
	let settings: ExplorerSettings = {
		textSize: 16,
		wrap: false,
		preview: true,
		diff: "auto",
		sidebar: { open: true, width: 270 },
		tab: "files",
		zoom: 1,
	};
	let clipboard = "";
	const prompts = new Set();
	const assetUrls = new Map<string, string>();
	const assetSources = new Map<string, [string, string?]>();
	const noteStates = ["draft", "open", "sent", "answered", "resolved"];
	const makeNote = ({
		path,
		start,
		end,
		side,
		commit,
		quote,
		author,
		state,
		title,
		text,
	}: ExplorerCreateNote): ExplorerNote => {
		if (
			![start, end].every(Number.isSafeInteger) ||
			start < 1 ||
			end < start ||
			typeof text !== "string" ||
			!text.trim() ||
			!["operator", "agent"].includes(author) ||
			!["head", "base"].includes(side) ||
			!noteStates.slice(0, 3).includes(state) ||
			typeof quote !== "string"
		)
			throw new Error("Invalid note.");
		repo.read(path, commit);
		const note: ExplorerNote = {
			id: id("n"),
			path,
			start,
			end,
			side,
			anchor: { start, end, commit: commit ?? null, quote },
			location: "same",
			author,
			state,
			title,
			text,
			thread: [],
			createdAt: now(),
			updatedAt: now(),
		};
		active.notes.set(note.id, note);
		return note;
	};
	const tourId = "t-route-review";
	const stop = (path: string, start: number, title: string, text: string, order: number) => {
		const note = makeNote({
			path,
			start,
			end: start,
			side: "head",
			commit: repo.head(),
			quote: lines(repo.read(path).text)[start - 1] ?? "",
			author: "agent",
			state: "open",
			title,
			text,
		});
		note.tour = { id: tourId, order };
		return note.id;
	};
	active.tours.set(tourId, {
		id: tourId,
		title: "Retry policy walkthrough",
		scope: uncommitted,
		stops: [
			stop(defaultPath, 9, "Retry delay", "The default wait increased before each retry.", 1),
			stop("config/routes.json", 2, "Attempt limit", "The configuration now allows four attempts.", 2),
		],
		createdAt: now(),
	});
	function uniqueQuote(source: string[], quote: string, span: number) {
		if (!quote) return undefined;
		let line: number | undefined;
		for (let i = 0; i + span <= source.length; i++) {
			if (source.slice(i, i + span).join("\n") !== quote) continue;
			if (line !== undefined) return undefined;
			line = i + 1;
		}
		return line;
	}
	function locate(note: ExplorerNote): ExplorerNote {
		const { start, end, quote, commit } = note.anchor;
		const source = lines(repo.read(note.path, note.side === "base" ? commit : undefined).text);
		const span = end - start + 1;
		if (source.slice(start - 1, end).join("\n") === quote && end <= source.length) return { ...note, location: "same" };
		const line = uniqueQuote(source, quote, span);
		return line === undefined
			? { ...note, location: "outdated" }
			: { ...note, start: line, end: line + span - 1, location: "moved", movedFrom: start };
	}
	function mutateNote(message: ExplorerNoteWrite) {
		const get = (key: string) => {
			const note = active.notes.get(key);
			if (!note) throw new Error("Note not found.");
			return note;
		};
		const editable = (key: string) => {
			const note = get(key);
			if (note.author !== "operator" || !["draft", "open"].includes(note.state))
				throw new Error("This note is not editable.");
			return note;
		};
		let result = {};
		switch (message.op) {
			case "create":
				result = { note: locate(makeNote(message.note)) };
				break;
			case "update": {
				const note = editable(message.id);
				if (typeof message.text !== "string" || !message.text.trim()) throw new Error("Note text is required.");
				Object.assign(note, { text: message.text, updatedAt: now() });
				result = { note: locate(note) };
				break;
			}
			case "reply": {
				const note = get(message.id);
				if (!["operator", "agent"].includes(message.author) || typeof message.text !== "string" || !message.text.trim())
					throw new Error("Invalid reply.");
				note.thread.push({ id: id("r"), author: message.author, text: message.text, at: now() });
				note.updatedAt = now();
				result = { note: locate(note) };
				break;
			}
			case "state":
				result = changeNoteState(message, get);
				break;
			case "delete":
				editable(message.id);
				active.notes.delete(message.id);
				break;
			case "tour-delete":
				removeTour(message.id);
				break;
			default:
				throw new Error("Unknown notes operation.");
		}
		return result;
	}
	function changeNoteState(message: Extract<ExplorerNoteWrite, { op: "state" }>, get: (id: string) => ExplorerNote) {
		if (!Array.isArray(message.ids) || !noteStates.includes(message.state)) throw new Error("Invalid note state.");
		const selected = message.ids.map(get);
		for (const note of selected) {
			note.state = message.state;
			note.updatedAt = now();
			if (message.requestId) note.requestId = message.requestId;
		}
		return { notes: selected.map(locate) };
	}
	function removeTour(key: string) {
		if (!active.tours.delete(key)) throw new Error("Tour not found.");
		for (const note of active.notes.values()) if (note.tour?.id === key) delete note.tour;
	}
	function writeNote(message: ExplorerNoteWrite) {
		const result = mutateNote(message);
		schedule(() => emit({ type: "notes.changed" }), 0);
		return result;
	}
	type SearchArgs = ExplorerRequests["search"][0];
	type SearchMatch = (path: string, line: number, column: number, preview: string) => void;
	function grepArguments({ query, regex, caseSensitive }: SearchArgs) {
		return [
			"grep",
			"--no-color",
			"--no-recurse-submodules",
			"--untracked",
			"-I",
			"-n",
			"-z",
			"--column",
			regex ? "-E" : "-F",
			...(caseSensitive ? [] : ["-i"]),
			"-e",
			query,
			"--",
		];
	}
	function searchRepository(
		source: Fixture,
		args: string[],
		prefix: string,
		keepGoing: () => boolean,
		append: SearchMatch,
	) {
		const matches = source.output(args, [1]);
		for (const [, path, line, column, preview] of matches.matchAll(/([^\0]+)\0(\d+)\0(\d+)\0([^\n]*)\n/g)) {
			if (!keepGoing()) return;
			const first = Buffer.from(preview)
				.subarray(0, Number(column) - 1)
				.toString("utf8");
			append(prefix + path, Number(line), first.length + 1, preview);
		}
	}
	function lineMatcher({ query, regex, caseSensitive }: SearchArgs): (line: string) => number {
		if (regex) {
			const pattern = new RegExp(query, caseSensitive ? "" : "i");
			return (line) => line.search(pattern);
		}
		if (caseSensitive) return (line) => line.indexOf(query);
		const needle = query.toLowerCase();
		return (line) => line.toLowerCase().indexOf(needle);
	}
	function searchPlainFiles(
		index: ExplorerRequests["files.list"][1],
		args: SearchArgs,
		keepGoing: () => boolean,
		append: SearchMatch,
	) {
		const match = lineMatcher(args);
		const repositories = new Set(index.repositories.map((item) => item.path));
		for (const path of index.paths) {
			if (!keepGoing()) return;
			if (insideRepository(path, repositories)) continue;
			searchLines(path, match, keepGoing, append);
		}
	}
	function searchLines(path: string, match: (line: string) => number, keepGoing: () => boolean, append: SearchMatch) {
		for (const [i, line] of lines(repo.read(path).text).entries()) {
			if (!keepGoing()) return;
			const column = match(line);
			if (column >= 0) append(path, i + 1, column + 1, line);
		}
	}
	function validSearch({ query, limit = 100 }: SearchArgs) {
		return typeof query === "string" && query.length <= 1024 && Number.isInteger(limit) && limit > 0;
	}
	function search(args: SearchArgs) {
		if (!validSearch(args)) throw new Error("Invalid search.");
		const index = pathIndex();
		const results: ExplorerSearchResult[] = [];
		if (!args.query) return { results, truncated: false, source: index.source };
		const cap = Math.min(args.limit ?? 100, 2000);
		const deadline = Date.now() + 4000;
		let truncated = index.truncated;
		const keepGoing = () => {
			const more = results.length < cap && Date.now() < deadline;
			if (!more) truncated = true;
			return more;
		};
		const append: SearchMatch = (path, line, column, preview) =>
			results.push({ path, line, column, preview: preview.slice(0, 400) });
		const gitArgs = grepArguments(args);
		if (root.kind === "git") searchRepository(repo, gitArgs, "", keepGoing, append);
		for (const item of index.repositories) {
			if (!keepGoing()) break;
			searchRepository(
				openFixtureRoot(base.path, join(root.path, item.path)),
				gitArgs,
				`${item.path}/`,
				keepGoing,
				append,
			);
		}
		if (root.kind === "folder") searchPlainFiles(index, args, keepGoing, append);
		return { results, truncated, source: index.source };
	}
	function insideRepository(path: string, repositories: Set<string>) {
		for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
			if (repositories.has(path.slice(0, at))) return true;
		}
		return false;
	}
	function file(path: string, at?: string) {
		const { bytes, ...result } = repo.read(path, at);
		if (bytes) {
			const source = JSON.stringify([path, at]);
			if (!assetUrls.has(source)) {
				const url = `/asset/${id("image")}`;
				assetUrls.set(source, url);
				assetSources.set(url, [path, at]);
			}
			result.url = assetUrls.get(source);
		} else if (root.kind === "git" && (result.kind === "text" || result.kind === "binary")) {
			const [commit] = repo.log([at ? repo.rev(at) : "HEAD", "--", path]);
			if (commit) result.lastCommit = { commit: commit.commit, subject: commit.subject, date: commit.date };
		}
		return result;
	}
	function prompt(message: ExplorerPacket) {
		const { requestId, threadId, text } = message;
		if (
			![requestId, threadId, text].every((field) => typeof field === "string" && field.length > 0) ||
			Buffer.byteLength(text) > 160 * 1024
		)
			return fail("rejected", "Invalid prompt.");
		if (!prompts.has(requestId)) {
			prompts.add(requestId);
			for (const [i, status, delay] of [
				[1, "queued", 50],
				[2, "working", 180],
				[3, "answer", 450],
			] as const) {
				schedule(
					() =>
						emit({
							type: "promptState",
							requestId,
							threadId,
							sequence: i,
							status,
							text: status === "answer" ? "This is a simulated reply from the Explorer dev host." : "",
							truncated: false,
						}),
					delay,
				);
			}
		}
		return { ok: true, status: "admitted" };
	}
	function saveState(state: ExplorerRequests["state.save"][0]) {
		const { draft, ...position } = state;
		if (draft !== undefined && position.path) {
			if (draft === null) active.cardDrafts.delete(position.path);
			else active.cardDrafts.set(position.path, draft);
			if (Object.keys(position).length === 1) return;
		}
		active.launch = { ...active.launch, ...position };
	}
	function editDraft({ path, draft }: ExplorerRequests["edit.draft"][0]) {
		if (!validFixturePath(path)) return fail("invalid-path", "An edit draft needs a valid file path.");
		if (draft === undefined) return { ok: true, draft: active.editDrafts.get(path) };
		if (draft === null) active.editDrafts.delete(path);
		else {
			if (
				!devEditText(draft.text) ||
				draft.text.includes("\r") ||
				typeof draft.base !== "string" ||
				!/^[0-9a-f]{64}$/.test(draft.base) ||
				!["lf", "crlf", "cr"].includes(draft.ending)
			)
				return fail("invalid", "The edit draft is invalid or too large.");
			if (!active.editDrafts.has(path) && active.editDrafts.size >= 32)
				return fail("draft-limit", "The fixture already holds 32 edited files.");
			active.editDrafts.set(path, draft);
		}
		return { ok: true };
	}
	function editRequest(message: Extract<Packet, { type: "file.create" | "file.write" | "edit.paths" | "edit.draft" }>) {
		if (message.root !== repo.root) return fail("invalid-root", "The open folder changed.");
		if (message.type === "edit.draft") return editDraft(message);
		if (message.type === "edit.paths") return { ok: true, paths: [...active.editDrafts.keys()] };
		let base: string | undefined;
		if (message.type === "file.create") repo.createFile(message.path);
		else base = repo.writeEdit(message.path, message.text, message.base);
		if (message.type === "file.create") indexed = undefined;
		return { ok: true, base };
	}
	function rejected(error: unknown) {
		return fail(
			error instanceof Error && "bridgeCode" in error ? String(error.bridgeCode) : "invalid",
			error instanceof Error && !("status" in error) ? error.message : "Git rejected this request.",
		);
	}
	function pathIndex() {
		indexed ??= repo.index();
		return indexed;
	}
	function openRoot(path: string) {
		const next = openFixtureRoot(base.path, path);
		if (next.root !== repo.root) {
			root = next.rootInfo();
			repo = next;
			indexed = undefined;
			assetUrls.clear();
			assetSources.clear();
			active = stores.get(root.path) ?? rootState(repo, { view: "file" });
			stores.set(root.path, active);
		}
		emit({ type: "open", ...active.launch, draft: active.cardDrafts.get(active.launch.path ?? ""), root, base });
	}
	function diffHead(next: ExplorerRoot) {
		if (root.head === next.head && root.branch === next.branch) return undefined;
		return { head: next.head, branch: next.branch };
	}
	function changed(paths: string[], structural: Set<string>, unknown: boolean) {
		const valid = (unknown ? [] : paths).flatMap((path) => {
			const current = relative(root.path, join(base.path, path));
			return validFixturePath(current) ? [{ original: path, current }] : [];
		});
		const next = root.kind === "git" ? repo.rootInfo() : root;
		const head = diffHead(next);
		if (!valid.length && !head && !unknown) return;
		root = next;
		const changedPaths = valid.map(({ current }) => current);
		const changes = valid.filter(({ original }) => structural.has(original)).map(({ current }) => current);
		if (changes.length || !changedPaths.length) indexed = undefined;
		emit({
			type: "files.changed",
			paths: changedPaths,
			structural: changedPaths.length ? changes : undefined,
			outside: changedPaths.length ? repo.outside(changedPaths) : undefined,
			head,
		});
	}
	function handle(value: unknown) {
		const message = value as Packet;
		if (message?.v !== 1) return fail("invalid", "Expected bridge version 1.");
		try {
			let result = {};
			switch (message.type) {
				case "hello":
					result = {
						root,
						base,
						launch: { ...active.launch, draft: active.cardDrafts.get(active.launch.path ?? "") },
						settings,
						live,
						build: { version: "dev", commit: null },
					};
					break;
				case "files.list":
					result = pathIndex();
					break;
				case "root.open":
					openRoot(message.path);
					break;
				case "files.folder":
					result = repo.folder(message.path);
					break;
				case "file.read":
					result = file(message.path, message.at);
					break;
				case "markdown.render": {
					const read = file(message.path, message.at);
					result = { file: read, html: read.text === undefined ? undefined : renderFixtureMarkdown(read.text) };
					break;
				}
				case "file.create":
				case "file.write":
				case "edit.paths":
				case "edit.draft":
					return editRequest(message);
				case "review.scopes":
					result = active.review.scopes();
					break;
				case "review.files":
					result = active.review.files(message.scope);
					break;
				case "review.diff":
					result = active.review.diff(message.scope, message.path);
					break;
				case "search":
					result = search(message);
					break;
				case "notes.list":
					result = {
						notes: [...active.notes.values()].filter((note) => !message.path || message.path === note.path).map(locate),
						tours: [...active.tours.values()],
					};
					break;
				case "notes.write":
					result = writeNote(message);
					break;
				case "review.state":
					result = active.review.state(message);
					break;
				case "settings.save":
					settings = message.settings;
					break;
				case "state.save": {
					const { v, type, ...state } = message;
					saveState(state);
					break;
				}
				case "clipboard.write":
					clipboard = String(message.text ?? "");
					break;
				case "clipboard.read":
					result = { text: clipboard };
					break;
				case "link.open":
				case "finder.reveal":
				case "focus.return":
				case "zoom":
					return fail("unavailable", "This action requires the native host.");
				case "prompt":
					return prompt(message);
				default:
					return fail("invalid", "Unknown bridge request.");
			}
			return { ok: true, ...result };
		} catch (error) {
			return rejected(error);
		}
	}
	return {
		handle,
		changed,
		asset(url: string) {
			const source = assetSources.get(url);
			return source ? repo.read(...source) : undefined;
		},
		live,
	};
}
