type ExplorerScope =
	| { kind: "uncommitted" | "since-review" }
	| { kind: "branch"; base?: string }
	| { kind: "commit"; commit: string }
	| { kind: "range"; base: string; head: string };
type ExplorerTab = "files" | "changes" | "notes";
type ExplorerView = "file" | "changes" | "notes";
type ExplorerMode = "auto" | "unified" | "split";
type ExplorerSide = "base" | "head";
type ExplorerCardDraft = {
	mode: "ask" | "comment" | "note";
	text: string;
	range?: ExplorerRange;
	noteId?: string;
	quote?: string;
	commit?: string | null;
};
type ExplorerLaunch = {
	path?: string;
	line?: number;
	end?: number;
	view?: ExplorerView;
	review?: ExplorerScope;
	note?: string;
	draft?: ExplorerCardDraft;
};
type ExplorerSettings = {
	textSize: number;
	wrap: boolean;
	preview: boolean;
	diff: ExplorerMode;
	sidebar: { open: boolean; width: number };
	tab: ExplorerTab;
	/** Page zoom level; the host owns and applies it. */
	zoom: number;
};
type ExplorerLive = { connected: boolean; label?: string; reason?: string };
type ExplorerRoot = {
	path: string;
	name: string;
	kind: "git" | "folder";
	branch: string | null;
	head: string | null;
	defaultBranch: string | null;
	onDefaultBranch: boolean;
};
type ExplorerBase = Pick<ExplorerRoot, "path" | "name">;
type ExplorerRepository = Pick<ExplorerRoot, "branch" | "head">;
type ExplorerFolderEntry = { name: string; kind: "file" | "folder"; ignored?: true; repo?: ExplorerRepository };
type ExplorerTreeEntry = ExplorerFolderEntry & { path: string; lower: string };
type ExplorerTreeRow =
	| { kind: "entry"; entry: ExplorerTreeEntry; depth: number }
	| { kind: "status"; folder: string; message: string; depth: number; retry?: true };
type ExplorerTree = {
	reset(): void;
	load(path: string): Promise<void>;
	isExpanded(path: string): boolean;
	setExpanded(path: string, expand: boolean): Promise<void>;
	reveal(path: string): Promise<void>;
	invalidate(structural: Iterable<string> | null): void;
	entries(): Iterable<ExplorerTreeEntry>;
	rows(): ExplorerTreeRow[];
};
type ExplorerResolved = { scope: ExplorerScope; base: string | null; head: string; label: string; key: string };
type ExplorerChange = {
	path: string;
	oldPath?: string;
	status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
	additions: number;
	deletions: number;
	binary: boolean;
};
type ExplorerCommit = { commit: string; short: string; subject: string; author: string; date: string };
type ExplorerReview = { resolved: ExplorerResolved; commits: ExplorerCommit[]; files: ExplorerChange[] };
type ExplorerScopeOption = { id: string; label: string; scope: ExplorerScope; available: boolean; reason?: string };
type ExplorerLineEnding = "lf" | "crlf" | "cr";
type ExplorerEditDraft = { base: string; text: string; ending: ExplorerLineEnding };
type ExplorerEditPath = { root: string; path: string };
type ExplorerFile = {
	path: string;
	kind: "text" | "image" | "binary" | "missing" | "directory";
	size: number;
	text?: string;
	editBase?: string;
	truncated?: boolean;
	mediaType?: string;
	url?: string;
	lastCommit?: { commit: string; subject: string; date: string };
};
type ExplorerHunk = { baseStart: number; baseCount: number; headStart: number; headCount: number };
type ExplorerDiff = {
	path: string;
	oldPath?: string;
	status: ExplorerChange["status"];
	binary: boolean;
	hunks: ExplorerHunk[];
	base: string | null;
	head: string | null;
	truncated?: boolean;
};
type ExplorerAuthor = "operator" | "agent" | "remote";
type ExplorerNoteState = "draft" | "open" | "sent" | "answered" | "resolved";
type ExplorerNoteTarget =
	| { kind: "file"; path: string; side?: ExplorerSide }
	| { kind: "commit"; commit: string }
	| { kind: "review"; review: ExplorerScope };
type ExplorerNoteFields = {
	id: string;
	reviewKey?: string;
	author: ExplorerAuthor;
	/** Display name of a remote author. */
	by?: string;
	/** Link to the remote discussion. */
	url?: string;
	/** Identifier of the remote discussion that an agent imported. */
	external?: string;
	state: ExplorerNoteState;
	title?: string;
	text: string;
	thread: { id: string; author: ExplorerAuthor; by?: string; text: string; at: string }[];
	requestId?: string;
	createdAt: string;
	updatedAt: string;
};
type ExplorerLineNote = ExplorerNoteFields & {
	target?: never;
	path: string;
	side: ExplorerSide;
	start: number;
	end: number;
	location: "same" | "moved" | "outdated";
	movedFrom?: number;
	anchor: { start: number; end: number; commit: string | null; quote: string };
};
type ExplorerTargetNote = ExplorerNoteFields & { target: ExplorerNoteTarget };
type ExplorerNote = ExplorerLineNote | ExplorerTargetNote;
type ExplorerSearchResult = { path: string; line: number; column: number; preview: string };
type ExplorerPacket = { requestId: string; threadId: string; text: string; noteIds?: string[] };
type ExplorerPromptState = {
	type: "promptState";
	requestId: string;
	threadId: string;
	sequence: number;
	status: "queued" | "working" | "answer" | "error";
	text: string;
	truncated: boolean;
};
type ExplorerEvent = { v: 1 } & (
	| { type: "files.changed"; paths: string[]; structural?: string[]; outside?: string[]; head?: ExplorerRepository }
	| { type: "notes.changed" }
	| { type: "index.changed" }
	| { type: "zoom"; zoom: number }
	| ({ type: "appearance" } & ExplorerAppearance)
	| ({ type: "live" } & ExplorerLive)
	| ({ type: "open" } & ({ root: ExplorerRoot; base: ExplorerBase } | { root?: never; base?: never }) & ExplorerLaunch)
	| ExplorerPromptState
);
type ExplorerCreateNote = Pick<ExplorerLineNote, "path" | "side" | "start" | "end" | "author" | "text" | "title"> & {
	commit: string | null;
	quote: string;
	state: "draft" | "open" | "sent";
};
type ExplorerNoteWrite =
	| { op: "create"; note: ExplorerCreateNote }
	| { op: "update"; id: string; expectedUpdatedAt: string; text?: string; title?: string | null }
	| { op: "reply"; id: string; text: string; author: ExplorerNote["author"]; requestId?: string }
	| { op: "state"; ids: string[]; state: ExplorerNoteState; requestId?: string }
	| { op: "delete"; id: string };
type ExplorerRequests = {
	hello: [
		undefined,
		{
			root: ExplorerRoot;
			base: ExplorerBase;
			launch: ExplorerLaunch;
			settings: ExplorerSettings;
			live: ExplorerLive;
			build: { version: string; commit: string | null };
			appearance: ExplorerAppearance;
		},
	];
	"appearance.save": [Partial<ExplorerAppearance>, ExplorerAppearance];
	"files.list": [
		undefined,
		{
			paths: string[];
			truncated: boolean;
			source: "git" | "scan" | "mixed";
			repositories: ({ path: string } & ExplorerRepository)[];
			repositoriesTruncated?: boolean;
		},
	];
	"files.folder": [{ path: string }, { entries: ExplorerFolderEntry[]; truncated: boolean }];
	"root.open": [{ path: string }, object];
	"file.read": [{ path: string; at?: string }, ExplorerFile];
	"markdown.render": [{ path: string; at?: string }, { file: ExplorerFile; html?: string }];
	"markdown.text": [{ text: string }, { html: string }];
	"link.open": [{ url: string }, object];
	"file.create": [ExplorerEditPath, object];
	"file.write": [ExplorerEditPath & { text: string; base: string }, { base: string }];
	"edit.paths": [{ root: string }, { paths: string[] }];
	"edit.draft": [ExplorerEditPath & { draft?: ExplorerEditDraft | null }, { draft?: ExplorerEditDraft }];
	"review.scopes": [undefined, { scopes: ExplorerScopeOption[]; defaultId: string }];
	"review.files": [{ scope: ExplorerScope }, ExplorerReview];
	"review.diff": [{ scope: ExplorerScope; path: string }, ExplorerDiff];
	search: [
		{ query: string; regex?: boolean; caseSensitive?: boolean; limit?: number },
		{ results: ExplorerSearchResult[]; truncated: boolean; source: string },
	];
	"notes.list": [{ path?: string } | undefined, { notes: ExplorerNote[] }];
	"notes.write": [ExplorerNoteWrite, { note?: ExplorerNote; notes?: ExplorerNote[] }];
	"review.state": [
		{ op: "get" | "set"; key: string; viewed?: string[]; finished?: boolean },
		{ viewed: string[]; finished?: { head: string; at: string } },
	];
	prompt: [ExplorerPacket, { status: "requested" | "admitted" }];
	"clipboard.write": [{ text: string }, object];
	"clipboard.read": [undefined, { text: string }];
	"finder.reveal": [{ path: string }, object];
	"settings.save": [{ settings: ExplorerSettings }, object];
	"state.save": [Omit<ExplorerLaunch, "draft"> & { draft?: ExplorerCardDraft | null }, object];
	"focus.return": [undefined, object];
	zoom: [{ step: "in" | "out" | "reset" }, { zoom: number }];
};
type ExplorerSpan = { start: number; end: number; role: string };
type ExplorerRange = { side: ExplorerSide; start: number; end: number };
type ExplorerExcerpt = {
	path: string;
	start?: number;
	end?: number;
	quote?: string;
	commit: string | null;
	text: string;
	id?: string;
	url?: string;
};
type ExplorerCodeRow =
	| {
			type: "line";
			kind: "context" | "add" | "del" | "pair";
			base?: number;
			head?: number;
			word?: { base: [number, number]; head: [number, number] };
	  }
	| { type: "hunk"; label: string }
	| { type: "fold"; key: string; base: number; head: number; count: number };
type ExplorerReference =
	| { kind: "lines"; path?: string; start: number; end: number }
	| { kind: "file"; path: string }
	| { kind: "commit"; commit: string }
	| { kind: "range"; base: string; head: string };
type ExplorerReferenceSpan = { start: number; end: number; ref: ExplorerReference };
type ExplorerRichTarget =
	| { kind: "lines"; path: string; start: number; end: number }
	| Exclude<ExplorerReference, { kind: "lines" }>
	| { kind: "url"; url: string };
type ExplorerRichOptions = {
	/** File that relative links and bare line references name. */
	path?: string;
	open(target: ExplorerRichTarget): void;
	/** Runs after rendered Markdown replaces the plain text. */
	changed?: () => void;
};
type ExplorerLanguage = { id: string; label: string; mark: string };
type ExplorerHit = { path: string; score: number };
type ExplorerIndexedPath = string | { path: string; lower: string };
type ExplorerMatch = { side: ExplorerSide; line: number; start: number; end: number };
type ExplorerCodeOptions = {
	path: string;
	base: string[];
	head: string[];
	diff: ExplorerDiff | null;
	split: boolean;
	wrap: boolean;
	size: number;
	notes: ExplorerNote[];
	onNote: (notes: ExplorerNote[]) => void;
	onRange: (range: ExplorerRange | null) => void;
	onScroll: (line: number) => void;
};
type ExplorerMarkdownLink =
	| { kind: "external"; url: string }
	| { kind: "file"; path: string; fragment: string }
	| { kind: "fragment"; fragment: string };
type ExplorerPreviewView = ExplorerCodeView & {
	show(opts: ExplorerCodeOptions & { html?: string }): void;
	find(query: string): ExplorerMatch[];
	focusMatch(match: ExplorerMatch): void;
	fragment(name: string): void;
};
type ExplorerCodeView = {
	show: (opts: ExplorerCodeOptions) => void;
	clear: () => void;
	jump: (line: number, side?: ExplorerSide, nearTop?: boolean) => void;
	place: () => { line: number; side: ExplorerSide; offset: number; left: number };
	restore: (place: { line: number; side: ExplorerSide; offset: number; left: number }) => void;
	highlight: (range: ExplorerRange | null) => void;
	marks: (matches: ExplorerMatch[], current: ExplorerMatch | undefined) => void;
	updateNotes: (notes: ExplorerNote[]) => void;
	anchor: (range: ExplorerRange | null) => DOMRect | null;
	rowAt: (node: Node | null) => ExplorerRange | null;
	selection: () => { range: ExplorerRange; text: string; rect: DOMRect } | null;
};
interface ExplorerModel {
	lines(text: string | null | undefined): string[];
	language(path: string, firstLine?: string): ExplorerLanguage;
	fuzzy(paths: Iterable<ExplorerIndexedPath>, query: string, limit?: number): ExplorerHit[];
	find(lines: string[], query: string, side: ExplorerSide, limit?: number): ExplorerMatch[];
	project(base: string[], head: string[], hunks: ExplorerHunk[], split: boolean): ExplorerCodeRow[];
	word(a: string, b: string): { base: [number, number]; head: [number, number] } | undefined;
	excerpt(root: string, scope: string, items: ExplorerExcerpt[]): string;
	source(item: ExplorerExcerpt): string;
	size(bytes: number): string;
}
interface ExplorerEditing {
	limit: number;
	byteLength(value: string): number;
	normalise(value: string): string;
	lineEnding(value: string): ExplorerLineEnding;
	restore(value: string, ending: ExplorerLineEnding): string;
	indentUnit(value: string): string;
	indentLines(
		text: string,
		start: number,
		end: number,
		unit: string,
		outdent: boolean,
	): {
		from: number;
		to: number;
		value: string;
		start: number;
		end: number;
	};
	nextIndent(text: string, offset: number): string;
	validNewPath(path: string): boolean;
}
type ExplorerEditorContext = {
	notice(text: string): void;
	change(identity: ExplorerEditPath, dirty: boolean): void;
	saved(identity: ExplorerEditPath, text: string, base: string): void;
	closed(identity: ExplorerEditPath): void;
};
type ExplorerEditor = {
	active(): boolean;
	open(identity: ExplorerEditPath, file: ExplorerFile | null, draft?: ExplorerEditDraft): void;
	mount(settings: ExplorerSettings, line?: number): void;
	checkDisk(): Promise<void>;
	toggle(): void;
	save(): Promise<void>;
	flush(): Promise<void>;
	detach(): void;
	focus(): void;
};
interface ExplorerApp {
	fileTree(list: (path: string) => Promise<ExplorerRequests["files.folder"][1]>, changed: () => void): ExplorerTree;
	editing: ExplorerEditing;
	editor(body: HTMLElement, toolbar: HTMLElement, context: ExplorerEditorContext): ExplorerEditor;
	request<K extends keyof ExplorerRequests>(
		type: K,
		...args: undefined extends ExplorerRequests[K][0]
			? [fields?: ExplorerRequests[K][0]]
			: [fields: ExplorerRequests[K][0]]
	): Promise<ExplorerRequests[K][1]>;
	receive(value: unknown): void;
	listen(cb: (event: ExplorerEvent) => void): void;
	model: ExplorerModel;
	syntax(text: string, language: string): ExplorerSpan[];
	syntaxFile(lines: string[], language: string): (zeroBasedLine: number) => ExplorerSpan[];
	flushDraft(): Promise<void>;
	dom: {
		el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K];
		get<T extends HTMLElement = HTMLElement>(id: string): T;
		icon(name: string): HTMLElement;
		button(text: string, action: () => void, cls?: string): HTMLButtonElement;
		iconButton(name: string, label: string, action: () => void): HTMLButtonElement;
		noteMarker(notes: ExplorerNote[], label: string, action: () => void): HTMLButtonElement;
		glyph(button: HTMLElement, name: string): void;
	};
	code(body: HTMLElement): ExplorerCodeView;
	preview(body: HTMLElement, follow: (link: ExplorerMarkdownLink) => void): ExplorerPreviewView;
	rich: { render(text: string, options: ExplorerRichOptions): HTMLElement };
	references: {
		find(text: string): ExplorerReferenceSpan[];
		lineLabel(start: number, end: number): string;
	};
	markdown: {
		isMarkdown(path: string): boolean;
		sourceSpan(sourcepos: string): ExplorerRange | null;
		cover(ranges: Iterable<ExplorerRange>): ExplorerRange | null;
		slugs(): (text: string) => string;
		link(destination: string, path: string): ExplorerMarkdownLink | null;
	};
}
interface Window {
	explorer: ExplorerApp;
}

/** The machine's shared pane appearance (docs/conventions/pane-appearance.md). */
type ExplorerAppearance = { appearance: "system" | "light" | "dark"; darkTheme: "frappe" | "macchiato" | "mocha" };
type ExplorerAppearanceView = {
	apply(value: ExplorerAppearance): void;
};
interface ExplorerApp {
	appearance(save: (patch: Partial<ExplorerAppearance>) => void): ExplorerAppearanceView;
}

type ExplorerReviewContext = {
	root(): ExplorerRoot;
	scope(): string;
	live(): ExplorerLive;
	drafts(): ExplorerLineNote[];
	notes(): ExplorerNote[];
	sequence(): ExplorerNote[];
	shows(note: ExplorerNote): boolean;
	inReview(): boolean;
	excerpt(range: ExplorerRange | null): ExplorerExcerpt | null;
	bounds(range: ExplorerRange | null): DOMRect | null;
	highlight(range: ExplorerRange | null): void;
	/** Shows the note's target and returns its visible line range, if any. */
	go(note: ExplorerNote): Promise<ExplorerRange | null>;
	/** Opens a location, commit, range or link named in card text while the card stays open. */
	follow(target: ExplorerRichTarget, side: ExplorerSide | null): Promise<void>;
	refresh(): Promise<void>;
	finish(): () => Promise<void>;
	saveDraft(path: string, draft: ExplorerCardDraft | null): Promise<void>;
	notice(text: string): void;
};

type ExplorerReviewUI = {
	ask(range: ExplorerRange | null, mode?: "ask" | "comment" | "note"): void;
	restore(path: string, draft: ExplorerCardDraft): void;
	thread(notes: ExplorerNote[], position?: ExplorerRange | null): void;
	step(direction: number): boolean;
	refresh(): void;
	prompt(event: ExplorerPromptState): void;
	reposition(): void;
	escape(): boolean;
	range(): ExplorerRange | null;
};

interface ExplorerApp {
	review(context: ExplorerReviewContext): ExplorerReviewUI;
}
