import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { hasPaneRevision, paneCommand } from "./pane-command.ts";
import { type DocumentRecord, MarkdownStore, StoreError } from "./store.ts";

type PaletteCommand = {
	id: string;
	title: string;
	description?: string;
	argv: string[];
};
export type PalettePublication = { version: 1; source: string; commands: PaletteCommand[] };
export type PaletteRequestEvent = { version: 1 };

type PaletteRequest = {
	version: 1;
	command: string;
	context: { session?: string; block?: string; client?: string; origin?: string };
	answers: unknown[];
};
type PaletteReply =
	| { ask: { kind: "input" | "pick"; prompt: Record<string, unknown> } }
	| { show: { argv: string[]; label: string; cwd?: string; placement?: "right" | "below" | "float" } }
	| { done: { notice?: string } }
	| { error: string };

const PICK_LIMIT = 200;
const READER_ERROR = "The reader app is missing or cannot open a pinned revision. Run /markdown update in Pi.";

function title(document: DocumentRecord): string {
	return document.title.trim() || `Document ${document.id}`;
}

function age(updatedAt: string, now: number): string {
	const minutes = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
	return `${Math.floor(minutes / 1440)} d ago`;
}

function isRequest(value: unknown): value is PaletteRequest {
	return typeof value === "object" && value !== null
		&& "version" in value && value.version === 1
		&& "command" in value && value.command === "markdown.read"
		&& "context" in value && typeof value.context === "object" && value.context !== null && !Array.isArray(value.context)
		&& "answers" in value && Array.isArray(value.answers);
}

async function step(root: string, app: string, request: PaletteRequest): Promise<PaletteReply> {
	const store = new MarkdownStore(root);
	if (request.answers.length === 0) {
		const [published, responses] = await Promise.all([
			store.list({ kind: "published", limit: PICK_LIMIT }),
			store.list({ kind: "response", limit: PICK_LIMIT }),
		]);
		const documents = [...published.documents, ...responses.documents]
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
			.slice(0, PICK_LIMIT);
		if (!documents.length) return { error: "There are no published documents or saved responses to read." };
		const now = Date.now();
		const items = documents.map((document) => ({
			id: document.id,
			title: title(document),
			subtitle: `${document.kind === "published" ? "Published" : "Response"} · ${age(document.updatedAt, now)}`,
			icon: "document",
			...(document.kind === "published" ? { detail: `Revision ${document.revision}` } : {}),
		}));
		return { ask: { kind: "pick", prompt: { title: "Read a document", items } } };
	}

	const [id] = request.answers;
	if (request.answers.length !== 1 || typeof id !== "string" || !/^md-[a-f0-9]{20}$/.test(id)) {
		return { error: "Select one stored document." };
	}
	const { document, revision } = await store.get(id);
	const pane = paneCommand(app, root, document.id, revision);
	if (!("show" in pane) || !hasPaneRevision(pane.show)) return { error: READER_ERROR };
	try { await access(pane.show[0], constants.X_OK); }
	catch { return { error: READER_ERROR }; }
	return { show: { argv: pane.show, label: [...title(document)].slice(0, 32).join(""), placement: "right" } };
}

async function run(args: string[]): Promise<PaletteReply> {
	const [root, app, json] = args;
	if (args.length !== 3 || !isAbsolute(root) || !isAbsolute(app)) {
		return { error: "The Markdown store and reader app require absolute paths." };
	}
	let request: unknown;
	try { request = JSON.parse(json); }
	catch { return { error: "The Markdown palette request is not valid JSON." }; }
	if (!isRequest(request)) return { error: "The Markdown palette request is invalid." };
	try { return await step(root, app, request); }
	catch (error) { return { error: error instanceof StoreError ? error.message : "The Markdown store is unavailable." }; }
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(await run(process.argv.slice(2)))}\n`);
