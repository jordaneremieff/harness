import { randomUUID } from "node:crypto";
import { open, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join as joinPath, relative, resolve, sep } from "node:path";
import { browse } from "./browse.ts";
import { invite, join, members, type Invitation, type Participant } from "./participants.ts";
import { servePane } from "./pane-service.ts";
import { preparePane, type PreparePane } from "./pane-launch.ts";
import { projectReplace } from "./project-search.ts";
import { statePage, browsePage } from "./results.ts";
import { Workspace } from "./store.ts";
export { editorParameters, editorToolDescription } from "./schema.ts";

type Data = Record<string, unknown>;
type Pane = Awaited<ReturnType<typeof servePane>> & { receipt?: Data };
interface Connection {
	store: Workspace;
	leave: () => Promise<void>;
	panes: Set<Pane>;
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
const paneFileOps = new Set(["rename", "remove", "mkdir", "copy"]);
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
function shortened(s: string, limit: number) {
	return s.length <= limit ? s : `${s.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
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
			return { store, leave, panes: new Set() };
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
		const launch = await this.prepare(this.agentDir, this.lifetime.signal);
		const c = await this.attach(root);
		const pane: Pane = await servePane((input, signal) => this.paneInput(c, input, signal));
		const path = joinPath(c.store.dir, `open-${randomUUID()}.json`);
		let wrote = false;
		try {
			this.lifetime.signal.throwIfAborted();
			if (c.panes.size >= 16) throw Error("Close an Editor pane for this folder before you open another.");
			c.panes.add(pane);
			void pane.ended.then(() => c.panes.delete(pane));
			const handle = await open(path, "wx", 0o600);
			wrote = true;
			try {
				await handle.writeFile(
					JSON.stringify({
						version: 1,
						port: pane.port,
						token: pane.token,
						root,
						file,
						settings: joinPath(dirname(c.store.dir), "settings.json"),
						layout: joinPath(c.store.dir, "layout.json"),
					}),
				);
			} finally {
				await handle.close();
			}
			this.lifetime.signal.throwIfAborted();
			pane.receipt = await launch(root, path);
			if (!(await pane.waitForLoad(18000))) {
				throw Error(
					pane.problem || "The Editor app did not load this workspace. Open /editor from a connected local Rex pane.",
				);
			}
			const visible = await pane.waitForView(800);
			this.lifetime.signal.throwIfAborted();
			if (pane.closed) throw Error(pane.problem || "The Editor pane closed.");
			return visible
				? `Opened Editor for ${root}.`
				: `Editor loaded ${root} in its split. Show that Rex tab to see it.`;
		} catch (error) {
			await pane.close();
			throw error;
		} finally {
			if (wrote) await rm(path, { force: true });
		}
	}
	private async handoff(c: Connection, input: Data): Promise<Data> {
		const id = field(input, "id", 128),
			to = field(input, "to", 256),
			message = field(input, "message", 8192);
		const thread = c.store.run({ op: "thread", id }, this.actor.label);
		const item: Invitation = {
			id: randomUUID(),
			root: c.store.root,
			thread: id,
			doc: String(thread.doc ?? ""),
			quote: shortened(String(thread.quote ?? ""), 8192),
			message,
		};
		if (thread.target) item.target = thread.target as Invitation["target"];
		const recipient = await invite(c.store.dir, to, item);
		const last = Array.isArray(thread.messages) ? thread.messages.at(-1) : undefined;
		const receipt =
			last?.author === "You" && last.text === message
				? `Sent to ${recipient.label}.`
				: `To ${recipient.label}: ${message}`;
		try {
			c.store.run({ op: "reply", id, text: receipt }, "You");
		} catch {
			return {
				accepted: true,
				warning: "The conversation accepted the request. Editor could not add the delivery note to the thread.",
			};
		}
		return { accepted: true };
	}
	private async paneInput(c: Connection, input: Data, signal: AbortSignal): Promise<Data> {
		if (this.closed) throw Error("This Editor session closed.");
		const op = String(input.op);
		if (op === "members") return { members: await members(c.store.dir) };
		if (op === "send") return this.handoff(c, input);
		if (browseOps.has(op)) return browse(c.store.root, input, signal, c.store);
		if (op === "replace") return projectReplace(c.store, input, signal);
		if (!storageOps.has(op) && !paneFileOps.has(op)) throw Error("Unknown editor action.");
		return c.store.run(input, "You");
	}
	async tool(request: Data, signal?: AbortSignal): Promise<Data> {
		signal?.throwIfAborted();
		const { root, ...input } = request;
		const op = String(input.op);
		if (!storageOps.has(op) && !browseOps.has(op) && op !== "replace" && op !== "join" && op !== "members")
			throw Error("Unknown editor action.");
		const { store } = await this.forInput({ root });
		signal?.throwIfAborted();
		if (this.closed) throw Error("This Editor session closed.");
		if (op === "join") return { root: store.root, folder: basename(store.root), participant: this.actor };
		if (op === "members") return { members: await members(store.dir) };
		if (browseOps.has(op)) return browsePage(await browse(store.root, input, signal, store), input);
		if (op === "replace") return projectReplace(store, input, signal, 32_000);
		if (op === "state") return statePage(store.run({ op }, this.actor.label), input);
		const result = store.run(input, this.actor.label);
		if (op === "read") return readPage(result, input);
		if (op === "revert") return readPage(result, { limit: input.limit });
		if ((op === "new" || op === "save") && typeof result.text === "string") {
			const { text, ...receipt } = result;
			return { ...receipt, total: text.length };
		}
		return result;
	}
	async close(): Promise<void> {
		this.closed = true;
		this.lifetime.abort();
		await Promise.allSettled(
			Array.from(this.connections.values(), async (p) => {
				const c = await p;
				try {
					await Promise.allSettled([c.leave(), ...Array.from(c.panes, (pane) => pane.close())]);
				} finally {
					c.store.close();
				}
			}),
		);
		this.connections.clear();
	}
}
