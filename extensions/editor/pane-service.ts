import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { browse } from "./browse.ts";
import { authorised, json, jsonBody, listen, type Payload } from "./local.ts";
import { type FileReport, PaneEvents, type RequestState } from "./pane-events.ts";
import { notifyPanes, paneIdPattern, registerPane, type PaneControl, type PaneRecord } from "./pane-registry.ts";
import { invite, isParticipant, members, type Invitation, type Participant } from "./participants.ts";
import { projectReplace } from "./project-search.ts";
import { Workspace } from "./store.ts";
import { fileName, locate, signature } from "./store-files.ts";

export type PaneConfig = {
	root: string;
	agentDir: string;
	paneId: string;
	participant: Participant;
	appPid: number;
};

export function paneConfig(value: unknown): PaneConfig {
	const input = value as Partial<PaneConfig> | undefined;
	const path = (s: unknown): s is string =>
		typeof s === "string" && s.length <= 4096 && !s.includes("\0") && isAbsolute(s);
	if (
		!input ||
		!path(input.root) ||
		!path(input.agentDir) ||
		typeof input.paneId !== "string" ||
		!paneIdPattern.test(input.paneId) ||
		!isParticipant(input.participant) ||
		!Number.isSafeInteger(input.appPid) ||
		(input.appPid as number) < 1
	) {
		throw Error("Invalid Editor service configuration.");
	}
	return input as PaneConfig;
}

const storeOps = new Set([
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
	"rename",
	"remove",
	"mkdir",
	"copy",
]);
const browseOps = new Set(["tree", "files", "search", "git"]);
const WATCH_LIMIT = 2048;
const SCAN_BATCH = 128;
const FIELD_LIMIT = 4096;
const SCAN_MS = 1000;

function field(input: Payload, name: string, limit: number): string {
	const v = input[name];
	if (typeof v !== "string" || !v.trim() || v.length > limit) throw Error(`Invalid ${name}.`);
	return v;
}

function shorten(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\ud800-\udbff]$/u, "")}…`;
}

function lineStart(text: string, index: number): number {
	return index === 0 ? 0 : text.lastIndexOf("\n", index - 1) + 1;
}

function selection(text: string, start: number, end: number): Pick<Invitation, "lines" | "context"> {
	const first = 1 + (text.slice(0, start).match(/\n/g)?.length ?? 0);
	const last = first + (text.slice(start, Math.max(start, end - 1)).match(/\n/g)?.length ?? 0);
	let before = lineStart(text, start);
	let after = end;
	for (let i = 0; i < 3; i++) {
		if (i > 0 && before > 0) before = lineStart(text, before - 1);
		if (after < text.length) {
			const next = text.indexOf("\n", after);
			after = next < 0 ? text.length : next + 1;
		}
	}
	return {
		lines: { start: first, end: last },
		context: shorten(text.slice(before, after), 12288),
	};
}

function draftContext(store: Workspace, thread: Payload, item: Invitation): void {
	const targetFile = item.target?.kind === "file" ? item.target.key : undefined;
	const doc = item.doc || targetFile;
	if (!doc) return;
	item.doc = doc;
	if (
		typeof thread.lineStart === "number" &&
		typeof thread.lineEnd === "number" &&
		typeof thread.context === "string"
	) {
		item.lines = { start: thread.lineStart, end: thread.lineEnd };
		item.context = thread.context;
	}
	let draft: Payload;
	try {
		draft = store.run({ op: "read", doc }, "You", true);
	} catch {
		return;
	}
	item.dirty = draft.dirty === true;
	if (item.lines) return;
	const text = draft.text;
	if (typeof text !== "string") return;
	if (!item.target && typeof thread.start === "number" && typeof thread.end === "number" && thread.rev === draft.rev) {
		Object.assign(item, selection(text, thread.start, thread.end));
	} else if (!item.target && item.quote) {
		const modern = text.indexOf(item.quote);
		if (modern >= 0 && text.lastIndexOf(item.quote) === modern) {
			Object.assign(item, selection(text, modern, modern + item.quote.length));
		}
	}
}

export async function startPaneService(config: PaneConfig) {
	const store = new Workspace(config.root, config.agentDir);
	const token = randomBytes(32).toString("hex");
	const controlToken = randomBytes(32).toString("hex");
	const events = new PaneEvents();
	const watched = new Map<string, string | undefined>();
	let currentSession: Participant | null = config.participant;
	let live: Participant[] = [];
	let membersAt = -Infinity;
	let seq = store.sequence();
	let loaded = false;
	let visible = false;
	let closed = false;
	let refresh: Promise<void> | undefined;
	let scan: ReturnType<typeof setTimeout> | undefined;
	let watchVersion = 0;
	let scanOffset = 0;

	const broadcast = (input: PaneControl) => notifyPanes(store.dir, input, config.paneId).catch(() => 0);

	function workspace() {
		const next = store.sequence();
		if (next !== seq) {
			seq = next;
			events.publish({ type: "workspace", seq });
			return true;
		}
		return false;
	}

	function refreshMembers(): Promise<void> {
		if (refresh) return refresh;
		refresh = (async () => {
			const next = await members(store.dir);
			if (closed) return;
			membersAt = performance.now();
			const previousSession = currentSession;
			currentSession = next.find((p) => p.id === currentSession?.id) ?? null;
			if (JSON.stringify(next) !== JSON.stringify(live) || currentSession?.id !== previousSession?.id) {
				live = next;
				if (currentSession?.id !== previousSession?.id) await publishRecord();
				events.publish({ type: "members", members: live });
			}
		})().finally(() => {
			refresh = undefined;
		});
		return refresh;
	}

	function stamp(path: string): string | undefined {
		try {
			const stat = locate(store.root, path).stat;
			return stat ? signature(stat) : undefined;
		} catch {
			return undefined;
		}
	}

	function diskChange({ path, change, by, thread }: FileReport) {
		if (watched.has(path)) watched.set(path, stamp(path));
		// Invalid or missing disk files still need a file event so open drafts can show the conflict.
		let rev: number | undefined;
		try {
			rev = store.refreshDisk(path);
		} catch {
			/* The read API exposes file errors. */
		}
		workspace();
		events.publish({ type: "file", path, change, by, thread, ...(rev === undefined ? {} : { rev }) });
	}

	function checkDisk() {
		const batch = [...watched].slice(scanOffset, scanOffset + SCAN_BATCH);
		scanOffset = scanOffset + SCAN_BATCH < watched.size ? scanOffset + SCAN_BATCH : 0;
		for (const [path, before] of batch) {
			const after = stamp(path);
			if (before === after) continue;
			watched.set(path, after);
			diskChange({
				type: "file",
				path,
				change: after === undefined ? "deleted" : before === undefined ? "created" : "modified",
			});
		}
	}

	function scheduleScan() {
		if (closed) return;
		scan = setTimeout(async () => {
			try {
				checkDisk();
				workspace();
				await refreshMembers();
			} catch {
				/* A producer can leave during a scan. Check again on the next scan. */
			} finally {
				scheduleScan();
			}
		}, SCAN_MS);
		scan.unref();
	}

	function requestEvent(thread: string, state: RequestState, by: Participant, at: number) {
		workspace();
		events.publish({ type: "request", thread, state, by, at });
	}

	async function publishRequest(thread: string, requestId: string) {
		const status = store.requestStatus(thread, requestId);
		if (!status) return;
		requestEvent(thread, status.state, status.by, status.at);
		await broadcast({ op: "request", thread, ...status });
	}

	function postRequestText(id: string, thread: Payload, message: string): string | undefined {
		const last = Array.isArray(thread.messages) ? thread.messages.at(-1) : undefined;
		if (last?.author === "You" && last.text === message) return;
		try {
			store.run({ op: "reply", id, text: message }, "You");
		} catch {
			return "The conversation accepted the request. Editor could not add the request text to the thread.";
		}
	}

	async function handoff(input: Payload): Promise<Payload> {
		const id = field(input, "id", 128);
		const to = field(input, "to", 256);
		const message = field(input, "message", 8192);
		const thread = store.run({ op: "thread", id }, "You", true);
		const item: Invitation = {
			id: randomUUID(),
			root: store.root,
			thread: id,
			doc: String(thread.doc ?? ""),
			quote: shorten(String(thread.quote ?? ""), 8192),
			message,
		};
		if (thread.target) item.target = thread.target as Invitation["target"];
		draftContext(store, thread, item);
		await refreshMembers();
		const recipient = live.find((p) => p.id === to);
		if (!recipient) throw Error("The selected conversation is no longer connected to this folder.");
		const warning = postRequestText(id, thread, message);
		store.setRequest(id, item.id, "queued", recipient);
		await publishRequest(id, item.id);
		try {
			await invite(store.dir, to, item);
		} catch (error) {
			if (store.finishRequest(id, item.id, recipient, undefined, true)) await publishRequest(id, item.id);
			throw error;
		}
		return { accepted: true, ...(warning ? { warning } : {}) };
	}

	let record: Awaited<ReturnType<typeof registerPane>>;
	function publishRecord() {
		const value: PaneRecord = {
			id: config.paneId,
			port: server.port,
			token: controlToken,
			appPid: config.appPid,
			servicePid: process.pid,
			loaded,
			visible,
			currentSession,
		};
		return record.publish(value);
	}

	function replaceWatchedPaths(docs: Set<string>, version: number) {
		watchVersion = version;
		scanOffset = 0;
		for (const path of watched.keys()) if (!docs.has(path)) watched.delete(path);
		for (const path of docs) if (!watched.has(path)) watched.set(path, stamp(path));
	}

	function watchPaths(input: Payload): Payload {
		if (!Array.isArray(input.docs) || input.docs.length > WATCH_LIMIT) throw Error("Too many open files to watch.");
		const version = input.version;
		if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
			throw Error("Invalid watch version.");
		if (version > watchVersion) {
			const docs = new Set(input.docs.map((doc) => fileName(field({ doc }, "doc", FIELD_LIMIT))));
			replaceWatchedPaths(docs, version);
		}
		return { watched: watched.size };
	}

	async function selectSession(input: Payload): Promise<Payload> {
		await refreshMembers();
		const selected = input.id === null ? null : live.find((p) => p.id === input.id);
		if (selected === undefined) throw Error("The selected conversation is no longer connected to this folder.");
		currentSession = selected;
		await publishRecord();
		events.publish({ type: "members", members: live });
		return { currentSession };
	}

	function projectDoc(value: unknown): value is string {
		return typeof value === "string" && !value.startsWith("scratch:");
	}

	function applySave(input: Payload): Payload {
		const destination = input.path ?? input.doc;
		const before = projectDoc(destination) ? stamp(destination) : undefined;
		const result = store.run(input, "You", true);
		if (!projectDoc(result.doc)) return result;
		const after = stamp(result.doc);
		if (watched.has(result.doc)) watched.set(result.doc, after);
		if (after !== undefined && after !== before) {
			void broadcast({
				op: "file",
				event: { type: "file", path: result.doc, change: before === undefined ? "created" : "modified" },
			});
		}
		return result;
	}

	const paneActions = new Map<string, (input: Payload, signal: AbortSignal) => Payload | Promise<Payload>>([
		[
			"loaded",
			async () => {
				loaded = true;
				await publishRecord();
				return { loaded };
			},
		],
		[
			"visibility",
			async (input) => {
				if (typeof input.visible !== "boolean") throw Error("Invalid pane visibility.");
				visible = input.visible && loaded;
				await publishRecord();
				return { visible };
			},
		],
		[
			"state",
			async (input) => {
				if (performance.now() - membersAt >= SCAN_MS) await refreshMembers();
				return { ...store.run(input, "You", true), currentSession, members: live };
			},
		],
		[
			"members",
			async () => {
				await refreshMembers();
				return { members: live };
			},
		],
		["session", selectSession],
		["watch", watchPaths],
		["send", handoff],
		[
			"events",
			(input, signal) =>
				events.after(input.since as number, signal, () => [
					{ type: "workspace", seq },
					{ type: "members", members: live },
				]),
		],
	]);

	function runStoreAction(op: string, input: Payload, signal: AbortSignal): Payload | Promise<Payload> {
		if (op === "replace") return projectReplace(store, input, signal);
		if (!storeOps.has(op)) throw Error("Unknown Editor action.");
		return op === "save" ? applySave(input) : store.run(input, "You", true);
	}

	function rememberRead(doc: unknown): void {
		if (projectDoc(doc) && watched.size < WATCH_LIMIT && !watched.has(doc)) watched.set(doc, stamp(doc));
	}

	async function api(input: Payload, signal: AbortSignal): Promise<Payload> {
		const op = String(input.op);
		const action = paneActions.get(op);
		if (action) return action(input, signal);
		if (browseOps.has(op)) return browse(store.root, input, signal, store);
		const result = await runStoreAction(op, input, signal);
		if (op === "read") rememberRead(result.doc);
		if (workspace()) void broadcast({ op: "workspace" });
		return result;
	}

	async function control(input: PaneControl): Promise<boolean> {
		switch (input.op) {
			case "attach": {
				if (!visible || !isParticipant(input.participant)) return false;
				await refreshMembers();
				const participant = live.find((p) => p.id === input.participant.id);
				if (!visible || !participant) return false;
				currentSession = participant;
				await publishRecord();
				events.publish({ type: "attach", participant, doc: input.doc, line: input.line });
				return true;
			}
			case "show":
				if (loaded) events.publish(input.event);
				return loaded;
			case "file":
				fileName(input.event.path);
				diskChange(input.event);
				return true;
			case "workspace":
				workspace();
				return true;
			case "members":
				await refreshMembers();
				return true;
			case "request":
				requestEvent(input.thread, input.state, input.by, input.at);
				return true;
		}
		return false;
	}

	const server = await listen(async (req, res) => {
		const isAPI = req.url === "/api";
		const key = isAPI ? token : controlToken;
		const limit = isAPI ? 16 * 1024 * 1024 : 64 * 1024;
		if (req.method !== "POST" || !["/api", "/control"].includes(req.url ?? ""))
			return json(res, 404, { error: "No such Editor request." });
		if (req.headers.origin !== undefined || !authorised(req, key))
			return json(res, 403, { error: "This request requires the pane's private token." });
		const input = await jsonBody(req, limit);
		const controller = new AbortController();
		res.once("close", () => controller.abort());
		const result = isAPI
			? await api(input, controller.signal)
			: { id: config.paneId, accepted: await control(input as PaneControl) };
		if (!res.destroyed) json(res, 200, result);
	}, 25_000).catch((error) => {
		store.close();
		throw error;
	});
	try {
		record = await registerPane(store.dir, config.paneId);
		const previous = await record.previous();
		if (previous?.appPid === config.appPid) currentSession = previous.currentSession;
		await publishRecord();
	} catch (error) {
		await server.close();
		store.close();
		throw error;
	}
	scheduleScan();
	return {
		port: server.port,
		token,
		async close() {
			if (closed) return;
			closed = true;
			clearTimeout(scan);
			await server.close();
			store.close();
			await record.close();
		},
	};
}
