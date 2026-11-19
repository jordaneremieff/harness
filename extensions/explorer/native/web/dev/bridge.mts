import { randomBytes } from "node:crypto";
import { defaultPath, type Fixture } from "./fixture.mts";
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
	repo: Fixture,
	emit: (event: Event) => void,
	schedule: (fn: () => void, delay: number) => void,
) {
	const review = createReview(repo);
	let launch: ExplorerLaunch = { path: defaultPath, view: "changes", review: uncommitted };
	const cardDrafts = new Map<string, ExplorerCardDraft>();
	let settings: ExplorerSettings = {
		textSize: 16,
		wrap: false,
		diff: "auto",
		sidebar: { open: true, width: 270 },
		tab: "changes",
	};
	let clipboard = "";
	const prompts = new Set();
	const notes = new Map<string, ExplorerNote>();
	const tours = new Map<string, ExplorerTour>();
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
		notes.set(note.id, note);
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
	tours.set(tourId, {
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
			const note = notes.get(key);
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
				notes.delete(message.id);
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
		if (!tours.delete(key)) throw new Error("Tour not found.");
		for (const note of notes.values()) if (note.tour?.id === key) delete note.tour;
	}
	function writeNote(message: ExplorerNoteWrite) {
		const result = mutateNote(message);
		schedule(() => emit({ type: "notes.changed" }), 0);
		return result;
	}
	function search({ query, regex, caseSensitive, limit = 100 }: ExplorerRequests["search"][0]) {
		if (typeof query !== "string" || query.length > 1024 || !Number.isInteger(limit) || limit < 1)
			throw new Error("Invalid search.");
		const results: ExplorerSearchResult[] = [];
		const cap = Math.min(limit, 2000);
		if (!query) return { results, truncated: false, source: "git" };
		const args = [
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
		const matches = repo.output(args, [1]);
		for (const [, path, line, column, preview] of matches.matchAll(/([^\0]+)\0(\d+)\0(\d+)\0([^\n]*)\n/g)) {
			if (results.length === cap) return { results, truncated: true, source: "git" };
			const prefix = Buffer.from(preview)
				.subarray(0, Number(column) - 1)
				.toString("utf8");
			results.push({ path, line: Number(line), column: prefix.length + 1, preview: preview.slice(0, 400) });
		}
		return { results, truncated: false, source: "git" };
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
		} else if (result.kind === "text" || result.kind === "binary") {
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
			if (draft === null) cardDrafts.delete(position.path);
			else cardDrafts.set(position.path, draft);
			if (Object.keys(position).length === 1) return;
		}
		launch = { ...launch, ...position };
	}
	function handle(value: unknown) {
		const message = value as Packet;
		if (message?.v !== 1) return fail("invalid", "Expected bridge version 1.");
		try {
			let result = {};
			switch (message.type) {
				case "hello": {
					const branch = repo.branch();
					result = {
						root: {
							path: repo.root,
							name: "Waypoint",
							kind: "git",
							branch,
							head: repo.head(),
							defaultBranch: "main",
							onDefaultBranch: branch === "main",
						},
						launch: { ...launch, draft: cardDrafts.get(launch.path ?? "") },
						settings,
						live,
						build: { version: "dev", commit: null },
					};
					break;
				}
				case "files.list":
					result = { paths: repo.paths(), truncated: false, source: "git" };
					break;
				case "file.read":
					result = file(message.path, message.at);
					break;
				case "review.scopes":
					result = review.scopes();
					break;
				case "review.files":
					result = review.files(message.scope);
					break;
				case "review.diff":
					result = review.diff(message.scope, message.path);
					break;
				case "search":
					result = search(message);
					break;
				case "notes.list":
					result = {
						notes: [...notes.values()].filter((note) => !message.path || message.path === note.path).map(locate),
						tours: [...tours.values()],
					};
					break;
				case "notes.write":
					result = writeNote(message);
					break;
				case "review.state":
					result = review.state(message);
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
				case "finder.reveal":
				case "focus.return":
					return fail("unavailable", "This action requires the native host.");
				case "prompt":
					return prompt(message);
				default:
					return fail("invalid", "Unknown bridge request.");
			}
			return { ok: true, ...result };
		} catch (error) {
			return fail(
				"invalid",
				error instanceof Error && !("status" in error) ? error.message : "Git rejected this request.",
			);
		}
	}
	return {
		handle,
		asset(url: string) {
			const source = assetSources.get(url);
			return source ? repo.read(...source) : undefined;
		},
		live,
	};
}
