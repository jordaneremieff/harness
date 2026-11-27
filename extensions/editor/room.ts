import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join as joinPath, relative, resolve, sep } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { browse } from "./browse.ts";
import type { FileEvent, RequestState, ShowEvent } from "./pane-events.ts";
import { attachPane, notifyPanes, type PaneControl, readPane } from "./pane-registry.ts";
import { join, members, type Invitation, type Participant } from "./participants.ts";
import { preparePane, type PreparePane } from "./pane-launch.ts";
import { projectReplace } from "./project-search.ts";
import { statePage, browsePage } from "./results.ts";
import { Workspace } from "./store.ts";
import { fileName, locate, signature } from "./store-files.ts";
export { editorParameters, editorToolDescription } from "./schema.ts";

type Data = Record<string, unknown>;
type RequestRef = Pick<Invitation, "id" | "thread" | "root">;
interface Connection {
	store: Workspace;
	leave: () => Promise<void>;
}
const storageOps = new Set([
	"state",
	"read",
	"new",
	"edit",
	"patch",
	"save",
	"revert",
	"note",
	"thread",
	"reply",
	"compose",
	"view",
]);
const browseOps = new Set(["tree", "files", "search", "git"]);
const field = (input: Data, name: string, limit: number) => {
	const v = input[name];
	if (typeof v !== "string" || !v.trim() || v.length > limit) throw Error(`Invalid ${name}.`);
	return v;
};
function commandPath(value: string): string {
	const s = value.trim();
	return s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s;
}
async function commandTarget(directory: string, args: string) {
	const target = await realpath(resolve(directory, commandPath(args)));
	const info = await stat(target);
	if (!info.isDirectory() && !info.isFile()) throw Error("Choose a file or a folder.");
	const cwd = await realpath(directory);
	const sub = relative(cwd, target);
	const below = sub !== ".." && !sub.startsWith(`..${sep}`) && !isAbsolute(sub);
	const root = info.isDirectory() ? target : below ? cwd : dirname(target);
	return { root, file: info.isFile() ? relative(root, target) : undefined };
}
function point(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw Error("Invalid page boundary.");
	return value;
}
function readPage(result: Data, input: Data): Data {
	if (typeof result.text !== "string") return result;
	if (input.rev !== undefined && input.rev !== result.rev)
		throw Error("The draft changed. Read it again from offset zero.");
	const content = result.text;
	const offset = point(input.offset, 0, 0, content.length);
	if (offset > 0 && input.rev === undefined) throw Error("A later page needs the revision from the first read.");
	const count = point(input.limit, 8000, 1, 16000);
	if (offset !== 0 && /[\uDC00-\uDFFF]/.test(content.charAt(offset))) throw Error("Offset splits a Unicode character.");
	let end = Math.min(content.length, offset + count);
	if (end < content.length && /[\uDC00-\uDFFF]/.test(content.charAt(end))) end = end === offset + 1 ? end + 1 : end - 1;
	return {
		...result,
		text: content.slice(offset, end),
		offset,
		nextOffset: end < content.length ? end : null,
		total: content.length,
	};
}
function notify(store: Workspace, input: PaneControl): Promise<number> {
	return notifyPanes(store.dir, input).catch(() => 0);
}

const program = fileURLToPath(new URL("./pane-program.ts", import.meta.url));
const draftWrites = new Set(["new", "edit", "patch", "revert", "save"]);
const roomOps = new Set(["replace", "join", "members", "show"]);

async function startupProblem(path: string): Promise<string | undefined> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
		() => undefined,
	);
	if (!file) return;
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return;
		const buffer = Buffer.alloc(1025);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead < 2 || bytesRead > 1024 || buffer[bytesRead - 1] !== 10) return;
		return (
			buffer
				.subarray(0, bytesRead - 1)
				.toString("utf8")
				.replace(/[\p{Cc}\p{Cf}]/gu, " ")
				.trim() || undefined
		);
	} finally {
		await file.close();
	}
}

function formatToolResult(op: string, result: Data, input: Data): Data {
	if (op === "read") return readPage(result, input);
	if (op === "revert") return readPage(result, { limit: input.limit });
	if ((op === "new" || op === "save") && typeof result.text === "string") {
		const { text, ...receipt } = result;
		return { ...receipt, total: text.length };
	}
	return result;
}

function recordChangedDrafts(store: Workspace, op: string, result: Data, active: RequestRef): void {
	if (op === "replace" && Array.isArray(result.changed)) {
		for (const { doc } of result.changed) store.recordRequestFile(active.thread, active.id, doc);
	} else if (draftWrites.has(op) && typeof result.doc === "string" && !result.doc.startsWith("scratch:")) {
		store.recordRequestFile(active.thread, active.id, result.doc);
	}
}

function diskSignature(root: string, doc: unknown): string | undefined {
	if (typeof doc !== "string" || doc.startsWith("scratch:")) return;
	try {
		const file = locate(root, doc).stat;
		return file && signature(file);
	} catch {
		return;
	}
}

export class EditorRoom {
	private readonly connections = new Map<string, Promise<Connection>>();
	private closed = false;
	private readonly agentDir: string;
	private readonly cwd: string;
	private readonly actor: Participant;
	private readonly onInvite: (request: Invitation) => Promise<void>;
	private readonly prepare: PreparePane;
	private readonly lifetime = new AbortController();
	constructor(
		agentDir: string,
		cwd: string,
		actor: Participant,
		onInvite: (request: Invitation) => Promise<void>,
		prepare: PreparePane = preparePane,
	) {
		this.agentDir = agentDir;
		this.cwd = cwd;
		this.actor = actor;
		this.onInvite = onInvite;
		this.prepare = prepare;
	}

	private async attach(root: string): Promise<Connection> {
		if (this.closed) throw Error("This Editor session closed.");
		const existing = this.connections.get(root);
		if (existing) return existing;
		if (this.connections.size >= 16) throw Error("This session already has 16 Editor folders open.");
		const pending = this.connect(root);
		this.connections.set(root, pending);
		try {
			return await pending;
		} catch (e) {
			this.connections.delete(root);
			throw e;
		}
	}
	private async connect(root: string): Promise<Connection> {
		const store = new Workspace(root, this.agentDir);
		try {
			const leave = await join(store.dir, this.actor, async (request) => {
				if (this.closed || request.root !== root) throw Error("This conversation is not connected to that folder.");
				await this.onInvite(request);
			});
			await notify(store, { op: "members" });
			return { store, leave };
		} catch (e) {
			store.close();
			throw e;
		}
	}
	private async forInput(input: Data) {
		const path = input.root === undefined ? this.cwd : field(input, "root", 4096);
		return this.attach(await realpath(resolve(this.cwd, path)));
	}
	async command(args: string): Promise<string> {
		const { root, file } = await commandTarget(this.cwd, args);
		const { store } = await this.attach(root);
		const signal = this.lifetime.signal;
		const connected = async () => {
			const pane = await attachPane(store.dir, this.actor, file, signal);
			if (pane) return `Connected to Editor for ${root}${pane.visible ? "" : " in another tab"}.`;
		};
		const existing = await connected();
		if (existing) return existing;
		const launch = await this.prepare(this.agentDir, signal);
		// Installation can take long enough for another session to open this workspace.
		const openedDuringInstall = await connected();
		if (openedDuringInstall) return openedDuringInstall;
		const paneId = randomUUID();
		const path = joinPath(store.dir, `open-${paneId}.json`);
		const failure = `${path}.failure`;
		const handle = await open(path, "wx", 0o600);
		try {
			try {
				await handle.writeFile(
					JSON.stringify({
						version: 2,
						node: process.execPath,
						program,
						paneId,
						root,
						file,
						agentDir: this.agentDir,
						participant: this.actor,
						settings: joinPath(dirname(store.dir), "settings.json"),
						layout: joinPath(store.dir, "layout.json"),
					}),
				);
			} finally {
				await handle.close();
			}
			signal.throwIfAborted();
			await launch(root, path);
			const deadline = performance.now() + 55000;
			let loadedAt: number | undefined;
			while (performance.now() < deadline) {
				signal.throwIfAborted();
				const problem = await startupProblem(failure);
				if (problem) throw Error(problem);
				const record = await readPane(store.dir, paneId);
				if (record?.visible) return `Opened Editor for ${root}.`;
				if (record?.loaded) {
					loadedAt ??= performance.now();
					if (performance.now() - loadedAt >= 800) {
						return `Editor loaded ${root} in its split. Show that Rex tab to see it.`;
					}
				}
				await wait(100, undefined, { signal });
			}
			throw Error("Editor did not load this workspace. Check its split for the startup error.");
		} finally {
			await Promise.all([rm(path, { force: true }), rm(failure, { force: true })]);
		}
	}

	private async show(store: Workspace, input: Data): Promise<Data> {
		const doc = field(input, "doc", 4096);
		const event: ShowEvent = { type: "show", by: this.actor, doc };
		if (input.line !== undefined) event.line = point(input.line, 1, 1, Number.MAX_SAFE_INTEGER);
		if (input.message !== undefined) event.message = field(input, "message", 4096);
		const draft = store.run({ op: "read", doc }, this.actor.label);
		if (input.start !== undefined || input.end !== undefined) {
			if (input.start === undefined || input.end === undefined) throw Error("Give both UTF-16 range offsets.");
			const text = draft.text as string;
			event.start = point(input.start, 0, 0, text.length);
			event.end = point(input.end, event.start, event.start, text.length);
			if ([event.start, event.end].some((offset) => /[\udc00-\udfff]/u.test(text.charAt(offset)))) {
				throw Error("The show range splits a Unicode character.");
			}
		}
		const panes = await notify(store, { op: "show", event });
		if (!panes) throw Error("No Editor pane is open for this folder. Open it with /editor.");
		return { panes };
	}

	async requestState(request: RequestRef, state: Exclude<RequestState, "queued">, answer?: string): Promise<void> {
		const connection = this.connections.get(request.root);
		if (!connection) return;
		const { store } = await connection;
		const changed =
			state === "working"
				? store.setRequest(request.thread, request.id, state, this.actor)
				: store.finishRequest(request.thread, request.id, this.actor, answer, state === "failed");
		const status = changed && store.requestStatus(request.thread, request.id);
		if (status) await notify(store, { op: "request", thread: request.thread, ...status });
	}

	async reportFile(path: string, change: FileEvent["change"], request?: RequestRef): Promise<void> {
		const pathOnDisk = resolve(this.cwd, path);
		const absolute = await realpath(pathOnDisk).catch(() => pathOnDisk);
		const agentDir = await realpath(this.agentDir);
		const reports: Promise<unknown>[] = [];
		for (let root = dirname(absolute), depth = 0; depth < 64; depth++, root = dirname(root)) {
			const currentRoot = root;
			reports.push(
				(async () => {
					let doc: string;
					let workspace: string;
					try {
						doc = fileName(relative(currentRoot, absolute));
						workspace = Workspace.directory(currentRoot, agentDir);
					} catch {
						return;
					}
					const active = request?.root === currentRoot ? request : undefined;
					const connection = this.connections.get(currentRoot);
					if (connection && active) {
						const { store } = await connection;
						store.recordRequestFile(active.thread, active.id, doc);
					}
					await notifyPanes(workspace, {
						op: "file",
						event: { type: "file", path: doc, change, by: this.actor, thread: active?.thread },
					}).catch(() => 0);
				})(),
			);
			if (root === dirname(root)) break;
		}
		await Promise.all(reports);
	}

	async tool(request: Data, signal?: AbortSignal, invitation?: RequestRef): Promise<Data> {
		signal?.throwIfAborted();
		const { root, ...input } = request;
		const op = String(input.op);
		if (!storageOps.has(op) && !browseOps.has(op) && !roomOps.has(op)) throw Error("Unknown editor action.");
		const { store } = await this.forInput({ root });
		signal?.throwIfAborted();
		if (this.closed) throw Error("This Editor session closed.");
		if (op === "join") return { root: store.root, folder: basename(store.root), participant: this.actor };
		if (op === "members") return { members: await members(store.dir) };
		if (op === "show") return this.show(store, input);
		if (browseOps.has(op)) return browsePage(await browse(store.root, input, signal, store), input);
		if (op === "state") return statePage(store.run({ op }, this.actor.label), input);
		return this.runStoreOp(store, op, input, signal, invitation);
	}

	private async runStoreOp(store: Workspace, op: string, input: Data, signal?: AbortSignal, invitation?: RequestRef) {
		const before = store.sequence();
		const active = invitation?.root === store.root ? invitation : undefined;
		const beforeSave = op === "save" ? diskSignature(store.root, input.path ?? input.doc) : undefined;
		const result: Data =
			op === "replace"
				? await projectReplace(store, input, signal, 32_000, this.actor.label)
				: store.run(input, this.actor.label, false, { participant: this.actor, request: active });
		if (store.sequence() !== before) {
			if (active) recordChangedDrafts(store, op, result, active);
			await this.reportStoreOp(store, op, result.doc, beforeSave, active?.thread);
		}
		return formatToolResult(op, result, input);
	}

	private async reportStoreOp(store: Workspace, op: string, doc: unknown, before: string | undefined, thread?: string) {
		if (op === "save" && typeof doc === "string") {
			const saved = diskSignature(store.root, doc);
			if (saved !== undefined && saved !== before) {
				await notify(store, {
					op: "file",
					event: {
						type: "file",
						path: doc,
						change: before === undefined ? "created" : "modified",
						by: this.actor,
						thread,
					},
				});
				return;
			}
		}
		await notify(store, { op: "workspace" });
	}
	async close(): Promise<void> {
		this.closed = true;
		this.lifetime.abort();
		await Promise.allSettled(
			Array.from(this.connections.values(), async (p) => {
				const c = await p;
				try {
					await c.leave();
					await notify(c.store, { op: "members" });
				} finally {
					c.store.close();
				}
			}),
		);
		this.connections.clear();
	}
}
