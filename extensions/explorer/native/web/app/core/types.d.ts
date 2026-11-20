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
	tour?: string;
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
type ExplorerFile = {
	path: string;
	kind: "text" | "image" | "binary" | "missing" | "directory";
	size: number;
	text?: string;
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
type ExplorerNoteState = "draft" | "open" | "sent" | "answered" | "resolved";
type ExplorerNote = {
	id: string;
	path: string;
	side: ExplorerSide;
	start: number;
	end: number;
	location: "same" | "moved" | "outdated";
	movedFrom?: number;
	anchor: { start: number; end: number; commit: string | null; quote: string };
	author: "operator" | "agent";
	state: ExplorerNoteState;
	title?: string;
	text: string;
	tour?: { id: string; order: number };
	thread: { id: string; author: "operator" | "agent"; text: string; at: string }[];
	requestId?: string;
	createdAt: string;
	updatedAt: string;
};
type ExplorerTour = { id: string; title: string; scope?: ExplorerScope; stops: string[]; createdAt: string };
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
	| { type: "files.changed"; paths: string[]; head?: Pick<ExplorerRoot, "branch" | "head"> }
	| { type: "notes.changed" }
	| ({ type: "live" } & ExplorerLive)
	| ({ type: "open"; root?: ExplorerRoot } & ExplorerLaunch)
	| ExplorerPromptState
);
type ExplorerCreateNote = Pick<ExplorerNote, "path" | "side" | "start" | "end" | "author" | "text" | "title"> & {
	commit: string | null;
	quote: string;
	state: "draft" | "open" | "sent";
};
type ExplorerNoteWrite =
	| { op: "create"; note: ExplorerCreateNote }
	| { op: "update"; id: string; text: string }
	| { op: "reply"; id: string; text: string; author: ExplorerNote["author"]; requestId?: string }
	| { op: "state"; ids: string[]; state: ExplorerNoteState; requestId?: string }
	| { op: "delete" | "tour-delete"; id: string };
type ExplorerRequests = {
	hello: [
		undefined,
		{
			root: ExplorerRoot;
			launch: ExplorerLaunch;
			settings: ExplorerSettings;
			live: ExplorerLive;
			build: { version: string; commit: string | null };
		},
	];
	"files.list": [undefined, { paths: string[]; truncated: boolean; source: string }];
	"file.read": [{ path: string; at?: string }, ExplorerFile];
	"markdown.render": [{ path: string; at?: string }, { file: ExplorerFile; html?: string }];
	"link.open": [{ url: string }, object];
	"review.scopes": [undefined, { scopes: ExplorerScopeOption[]; defaultId: string }];
	"review.files": [{ scope: ExplorerScope }, ExplorerReview];
	"review.diff": [{ scope: ExplorerScope; path: string }, ExplorerDiff];
	search: [
		{ query: string; regex?: boolean; caseSensitive?: boolean; limit?: number },
		{ results: ExplorerSearchResult[]; truncated: boolean; source: string },
	];
	"notes.list": [{ path?: string } | undefined, { notes: ExplorerNote[]; tours: ExplorerTour[] }];
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
type ExplorerLanguage = { id: string; label: string; mark: string };
type ExplorerHit = { path: string; score: number };
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
	language(path: string): ExplorerLanguage;
	fuzzy(paths: string[], query: string, limit?: number): ExplorerHit[];
	find(lines: string[], query: string, side: ExplorerSide, limit?: number): ExplorerMatch[];
	project(base: string[], head: string[], hunks: ExplorerHunk[], split: boolean): ExplorerCodeRow[];
	word(a: string, b: string): { base: [number, number]; head: [number, number] } | undefined;
	excerpt(root: string, scope: string, items: ExplorerExcerpt[]): string;
	source(item: ExplorerExcerpt): string;
	size(bytes: number): string;
}
interface ExplorerApp {
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
		glyph(button: HTMLElement, name: string): void;
	};
	code(body: HTMLElement): ExplorerCodeView;
	preview(body: HTMLElement, follow: (link: ExplorerMarkdownLink) => void): ExplorerPreviewView;
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

type ExplorerReviewContext = {
	root(): ExplorerRoot;
	scope(): string;
	live(): ExplorerLive;
	drafts(): ExplorerNote[];
	notes(): ExplorerNote[];
	excerpt(range: ExplorerRange | null): ExplorerExcerpt | null;
	bounds(range: ExplorerRange | null): DOMRect | null;
	highlight(range: ExplorerRange | null): void;
	go(note: ExplorerNote): Promise<void>;
	refresh(): Promise<void>;
	finish(): () => Promise<void>;
	saveDraft(path: string, draft: ExplorerCardDraft | null): Promise<void>;
	notice(text: string): void;
};

type ExplorerReviewUI = {
	ask(range: ExplorerRange | null, mode?: "ask" | "comment" | "note"): void;
	restore(path: string, draft: ExplorerCardDraft): void;
	thread(notes: ExplorerNote[], position?: ExplorerRange | null): void;
	tour(tour: ExplorerTour): Promise<void>;
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
