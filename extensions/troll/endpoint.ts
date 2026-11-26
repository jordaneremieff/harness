import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";

/** Bytes of one protocol line, newline excluded. */
const LINE_LIMIT = 1048576;
/** Bytes of a submitted message or a returned answer. */
export const TEXT_LIMIT = 65536;
const REQUEST_DEADLINE_MS = 5000;
/** How long a target waits for its run to start before it reports the submission as waiting. */
export const START_WAIT_MS = 6000;
// The troll's deadline for the first answer covers the target's start wait.
const STATUS_DEADLINE_MS = START_WAIT_MS + 4000;
const PROBE_DEADLINE_MS = 1000;
// A new process's socket is never older than this; the sweep leaves younger sockets alone.
const SWEEP_MIN_AGE_MS = 60000;
// Unix socket paths hold at most 104 bytes on macOS, including the terminating NUL.
const SOCKET_PATH_BYTES = 103;
const SWEEP_LIMIT = 512;
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const SOCKET_NAME = /^(.+)\.([1-9][0-9]{0,9})\.sock$/u;

export const isSessionId = (value: unknown): value is string => typeof value === "string" && SESSION_ID.test(value);

export interface SubmitRequest {
	version: 1;
	op: "submit";
	target: string;
	from: string;
	round: number;
	text: string;
}
export const STATUS_OUTCOMES = ["submitted", "waiting", "busy", "refused"] as const;
export type StatusOutcome = (typeof STATUS_OUTCOMES)[number];
/** The target's first answer. Only submitted and waiting keep the connection open for the reply. */
export interface Status {
	version: 1;
	type: "status";
	outcome: StatusOutcome;
	detail: string;
}
export const REPLY_OUTCOMES = ["answered", "aborted", "unanswered", "not-run", "not-started", "closed"] as const;
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];
export interface ReplyFields {
	outcome: ReplyOutcome;
	text: string;
	truncated: boolean;
	otherInputs: number;
}
export interface Reply extends ReplyFields {
	version: 1;
	type: "reply";
}

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, max: number): value is string =>
	typeof value === "string" && Buffer.byteLength(value) <= max && !value.includes("\0");
const detailText = (value: unknown): value is string =>
	text(value, 512) && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value);
const count = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const isStatusOutcome = (value: unknown): value is StatusOutcome => STATUS_OUTCOMES.includes(value as StatusOutcome);
const isReplyOutcome = (value: unknown): value is ReplyOutcome => REPLY_OUTCOMES.includes(value as ReplyOutcome);

/** The socket on which one Pi process takes submissions for its session. */
export function endpointPath(dir: string, sessionId: string, pid: number): string {
	if (!isSessionId(sessionId)) throw new Error("The session ID is not valid.");
	const path = join(dir, `${sessionId}.${pid}.sock`);
	if (Buffer.byteLength(path) > SOCKET_PATH_BYTES)
		throw new Error("The troll endpoint path is too long for a local socket.");
	return path;
}

export function parseRequest(line: string): SubmitRequest {
	const value: unknown = JSON.parse(line);
	if (
		!object(value) ||
		!hasOnly(value, ["version", "op", "target", "from", "round", "text"]) ||
		value.version !== 1 ||
		value.op !== "submit" ||
		!isSessionId(value.target) ||
		!isSessionId(value.from) ||
		!count(value.round, 1) ||
		!text(value.text, TEXT_LIMIT) ||
		!value.text.trim()
	)
		throw new Error("Invalid request.");
	return { version: 1, op: "submit", target: value.target, from: value.from, round: value.round, text: value.text };
}

export function parseStatus(line: string): Status {
	const value: unknown = JSON.parse(line);
	if (
		!object(value) ||
		!hasOnly(value, ["version", "type", "outcome", "detail"]) ||
		value.version !== 1 ||
		value.type !== "status" ||
		!isStatusOutcome(value.outcome) ||
		!detailText(value.detail)
	)
		throw new Error("Invalid status.");
	return { version: 1, type: "status", outcome: value.outcome, detail: value.detail };
}

export function parseReply(line: string): Reply {
	const value: unknown = JSON.parse(line);
	if (
		!object(value) ||
		!hasOnly(value, ["version", "type", "outcome", "text", "truncated", "otherInputs"]) ||
		value.version !== 1 ||
		value.type !== "reply" ||
		!isReplyOutcome(value.outcome) ||
		!text(value.text, TEXT_LIMIT) ||
		typeof value.truncated !== "boolean" ||
		!count(value.otherInputs, 0)
	)
		throw new Error("Invalid reply.");
	return {
		version: 1,
		type: "reply",
		outcome: value.outcome,
		text: value.text,
		truncated: value.truncated,
		otherInputs: value.otherInputs,
	};
}

/** Calls onLine for each newline-terminated line, and onEnd once when the stream ends or breaks a limit. */
function readLines(socket: Socket, onLine: (line: string) => void, onEnd: () => void): void {
	let chunks: Buffer[] = [];
	let size = 0;
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		socket.removeListener("data", data);
		onEnd();
	};
	const fail = () => {
		end();
		socket.destroy();
	};
	function data(chunk: Buffer): void {
		let rest = chunk;
		while (!ended) {
			const index = rest.indexOf(0x0a);
			const part = index < 0 ? rest : rest.subarray(0, index);
			size += part.length;
			if (size > LINE_LIMIT) {
				fail();
				return;
			}
			chunks.push(part);
			if (index < 0) return;
			let line: string;
			try {
				line = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
			} catch {
				fail();
				return;
			}
			chunks = [];
			size = 0;
			rest = rest.subarray(index + 1);
			onLine(line);
		}
	}
	socket.on("data", data);
	socket.on("end", end);
	socket.on("close", end);
	socket.on("error", end);
}

/** One submission on the target's side. The connection stays open from an accepted status until the reply. */
export interface Exchange {
	readonly request: SubmitRequest;
	/** Whether the status went out. */
	readonly answered: boolean;
	status(outcome: StatusOutcome, detail: string): void;
	/** Sends the reply and closes the connection; false when the troll no longer holds it. */
	reply(fields: ReplyFields): boolean;
}
export type Handler = (exchange: Exchange) => void | Promise<void>;
export interface Endpoint {
	readonly path: string;
	close(): void;
}

function exchangeFor(socket: Socket, request: SubmitRequest): Exchange {
	let answered = false;
	let done = false;
	return {
		request,
		get answered() {
			return answered;
		},
		status(outcome, detail) {
			if (answered || done) return;
			answered = true;
			const line = `${JSON.stringify({ version: 1, type: "status", outcome, detail } satisfies Status)}\n`;
			if (outcome === "submitted" || outcome === "waiting") {
				socket.setTimeout(0);
				socket.write(line);
			} else {
				done = true;
				socket.end(line);
			}
		},
		reply(fields) {
			if (!answered || done || socket.destroyed) return false;
			done = true;
			socket.end(`${JSON.stringify({ version: 1, type: "reply", ...fields } satisfies Reply)}\n`);
			return true;
		},
	};
}

function serve(socket: Socket, handle: Handler, requestDeadlineMs: number): void {
	socket.setTimeout(requestDeadlineMs, () => socket.destroy());
	let taken = false;
	readLines(
		socket,
		(line) => {
			if (taken) return;
			taken = true;
			// The handler answers within its own start wait; the request deadline covers only the request.
			socket.setTimeout(0);
			let request: SubmitRequest;
			try {
				request = parseRequest(line);
			} catch {
				const refusal: Status = { version: 1, type: "status", outcome: "refused", detail: "The request is not valid." };
				return void socket.end(`${JSON.stringify(refusal)}\n`);
			}
			const exchange = exchangeFor(socket, request);
			Promise.resolve()
				.then(() => handle(exchange))
				.catch(() => exchange.status("refused", "The session could not take the request."));
		},
		() => {
			if (!taken) socket.destroy();
		},
	);
}

/** Whether a process with this ID runs; a process of another account counts as running. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Socket files in the directory, optionally only those of one session. */
function socketFiles(dir: string, sessionId?: string): Array<{ name: string; sessionId: string; pid: number }> {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files = [];
	for (const name of sessionId === undefined ? names : names.filter((name) => name.startsWith(`${sessionId}.`))) {
		const match = SOCKET_NAME.exec(name);
		if (!match?.[1] || !match[2] || !isSessionId(match[1]) || (sessionId !== undefined && match[1] !== sessionId))
			continue;
		files.push({ name, sessionId: match[1], pid: Number(match[2]) });
	}
	return files;
}

/**
 * Removes the sockets of processes that no longer run. A process names its socket by its own ID, and a socket younger
 * than a minute is left alone, so a new process that reuses an ended process's ID keeps its socket.
 */
export function sweepEndpoints(dir: string, alive: (pid: number) => boolean = running, now = Date.now()): void {
	let removed = 0;
	for (const file of socketFiles(dir)) {
		if (removed >= SWEEP_LIMIT) return;
		if (file.pid === process.pid || alive(file.pid)) continue;
		const path = join(dir, file.name);
		try {
			const seen = lstatSync(path);
			if (now - seen.mtimeMs < SWEEP_MIN_AGE_MS || lstatSync(path).ino !== seen.ino) continue;
			unlinkSync(path);
			removed++;
		} catch {
			/* Another process removed or replaced it. */
		}
	}
}

/**
 * Listens on this process's socket for its session, in a directory that only this account can enter. The socket
 * of an earlier instance in this process, such as one before a reload, is replaced.
 */
export async function openEndpoint(
	dir: string,
	sessionId: string,
	handle: Handler,
	options: { requestDeadlineMs?: number } = {},
): Promise<Endpoint> {
	const path = endpointPath(dir, sessionId, process.pid);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const server = createServer((socket) => serve(socket, handle, options.requestDeadlineMs ?? REQUEST_DEADLINE_MS));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	});
	chmodSync(path, 0o600);
	const inode = lstatSync(path).ino;
	server.on("error", () => {});
	sweepEndpoints(dir);
	return {
		path,
		close() {
			server.close();
			try {
				if (lstatSync(path).ino === inode) unlinkSync(path);
			} catch {
				/* Another process already removed or replaced the socket. */
			}
		},
	};
}

function connects(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		const settle = (live: boolean) => {
			socket.destroy();
			resolve(live);
		};
		socket.setTimeout(PROBE_DEADLINE_MS, () => settle(false));
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
	});
}

/** The sockets of running processes that take submissions for a session, each with its process ID. */
export async function liveEndpoints(
	dir: string,
	sessionId: string,
	alive: (pid: number) => boolean = running,
): Promise<Array<{ path: string; pid: number }>> {
	const live = [];
	for (const file of socketFiles(dir, sessionId)) {
		if (!alive(file.pid)) continue;
		const path = join(dir, file.name);
		if (await connects(path)) live.push({ path, pid: file.pid });
	}
	return live;
}

/** This process's socket for the session, when the process runs and the socket answers. */
export async function liveEndpoint(
	dir: string,
	sessionId: string,
	pid: number,
	alive: (pid: number) => boolean = running,
): Promise<string | undefined> {
	const path = endpointPath(dir, sessionId, pid);
	return alive(pid) && (await connects(path)) ? path : undefined;
}

export class EndpointError extends Error {
	readonly reason: "absent" | "uncertain";
	constructor(reason: "absent" | "uncertain", message: string) {
		super(message);
		this.reason = reason;
	}
}

/** An accepted submission, from the troll's side. */
export interface Submission {
	status: Status;
	/** Settles with the reply, or with undefined when the connection closes before one arrives. */
	reply: Promise<Reply | undefined>;
	close(): void;
}

const accepts = (status: Status) => status.outcome === "submitted" || status.outcome === "waiting";
const parsedReply = (line: string): Reply | undefined => {
	try {
		return parseReply(line);
	} catch {
		return undefined;
	}
};

/**
 * Sends one submission and reads the target's status. An accepted submission keeps the connection until its reply.
 * An absent endpoint received nothing; an uncertain one may have taken the message.
 */
export function submit(path: string, request: SubmitRequest): Promise<Submission> {
	return new Promise((resolve, reject) => {
		let connected = false;
		let status: Status | undefined;
		let settleReply: (reply: Reply | undefined) => void = () => {};
		const reply = new Promise<Reply | undefined>((done) => {
			settleReply = done;
		});
		const socket = createConnection(path);
		const fail = (error: EndpointError) => {
			clearTimeout(deadline);
			socket.destroy();
			reject(error);
		};
		const deadline = setTimeout(
			() => fail(new EndpointError(connected ? "uncertain" : "absent", "The session did not answer in time.")),
			STATUS_DEADLINE_MS,
		);
		const first = (line: string) => {
			clearTimeout(deadline);
			try {
				status = parseStatus(line);
			} catch {
				fail(new EndpointError("uncertain", "The session sent an invalid answer."));
				return;
			}
			if (!accepts(status)) socket.destroy();
			resolve({ status, reply: accepts(status) ? reply : Promise.resolve(undefined), close: () => socket.destroy() });
		};
		socket.once("connect", () => {
			connected = true;
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (status) return;
			const absent = !connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED");
			fail(
				absent
					? new EndpointError("absent", "No troll endpoint answers for that session.")
					: new EndpointError("uncertain", "The connection to the session failed."),
			);
		});
		readLines(
			socket,
			(line) => {
				if (!status) return first(line);
				settleReply(parsedReply(line));
				socket.destroy();
			},
			() => {
				if (status) settleReply(undefined);
				else fail(new EndpointError("uncertain", "The session closed without an answer."));
			},
		);
	});
}
