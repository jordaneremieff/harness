import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink, writeFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { authorised, json, jsonBody, listen } from "./local.ts";

export interface Participant {
	id: string;
	label: string;
	kind: "ordinary" | "durable";
}
export interface Invitation {
	id: string;
	root: string;
	thread: string;
	doc: string;
	quote: string;
	message: string;
	target?: { kind: string; key: string };
}
interface Endpoint extends Participant {
	port: number;
	pid: number;
	key: string;
}

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const clean = (s: unknown, limit: number): s is string =>
	typeof s === "string" && s.length > 0 && s.length <= limit && !/[\x00-\x1f\x7f]/u.test(s);
function identity(p: Participant): boolean {
	return clean(p.id, 256) && clean(p.label, 256) && (p.kind === "ordinary" || p.kind === "durable");
}
function invitation(p: Record<string, unknown>): Invitation {
	if (
		typeof p.id !== "string" ||
		!uuid.test(p.id) ||
		!clean(p.root, 4096) ||
		!clean(p.thread, 128) ||
		(p.doc !== "" && !clean(p.doc, 4096))
	)
		throw Error("Invalid thread address.");
	if (
		typeof p.quote !== "string" ||
		p.quote.length > 8192 ||
		typeof p.message !== "string" ||
		!p.message.trim() ||
		p.message.length > 8192
	)
		throw Error("A message or selection exceeds the invitation limit.");
	const result: Invitation = {
		id: p.id,
		root: p.root,
		thread: p.thread,
		doc: p.doc,
		quote: p.quote,
		message: p.message,
	};
	if (p.target !== undefined) {
		const t = p.target as Record<string, unknown> | null;
		if (!t || !clean(t.kind, 32) || typeof t.key !== "string" || t.key.length > 4096)
			throw Error("Invalid editor target.");
		result.target = { kind: t.kind, key: t.key };
	}
	if (!result.doc && !result.target) throw Error("Invitation has no target.");
	return result;
}
async function directory(dir: string): Promise<string> {
	const peers = pathJoin(dir, "peers");
	await mkdir(peers, { recursive: true, mode: 0o700 });
	const info = await lstat(peers);
	if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
		throw Error("Editor participant directory is not private.");
	return peers;
}
function accepts(onInvite: (request: Invitation) => Promise<void>) {
	const recent = new Map<string, { body: string; result: Promise<void> }>();
	return (request: Invitation): Promise<void> => {
		const body = JSON.stringify(request);
		const previous = recent.get(request.id);
		if (previous) {
			if (previous.body !== body) throw Error("That invitation ID already identifies another request.");
			return previous.result;
		}
		if (recent.size >= 256) recent.delete(recent.keys().next().value as string);
		const result = Promise.resolve().then(() => onInvite(request));
		recent.set(request.id, { body, result });
		return result;
	};
}

export async function join(
	dir: string,
	actor: Participant,
	onInvite: (request: Invitation) => Promise<void>,
): Promise<() => Promise<void>> {
	if (!identity(actor)) throw Error("Invalid session identity.");
	const peers = await directory(dir);
	const key = randomBytes(32).toString("hex");
	const accept = accepts(onInvite);
	const server = await listen(async (req, res) => {
		if (req.headers.origin || !authorised(req, key))
			return json(res, 403, { error: "This participant requires a private invitation." });
		if (req.method === "GET" && req.url === "/present") return json(res, 200, { id: actor.id });
		if (req.method !== "POST" || req.url !== "/invite") return json(res, 404, { error: "Unknown request." });
		await accept(invitation(await jsonBody(req, 128 * 1024)));
		json(res, 200, { accepted: true });
	});
	const file = pathJoin(peers, `${randomUUID()}.json`);
	try {
		const record: Endpoint = { ...actor, pid: process.pid, port: server.port, key };
		await writeFile(`${file}.new`, JSON.stringify(record), { mode: 0o600, flag: "wx" });
		await rename(`${file}.new`, file);
	} catch (error) {
		await server.close();
		await unlink(`${file}.new`).catch(() => {});
		throw error;
	}
	return async () => {
		await server.close();
		await unlink(file).catch(() => {});
	};
}

function isEndpoint(e: Endpoint): boolean {
	return (
		identity(e) &&
		Number.isSafeInteger(e.port) &&
		e.port > 0 &&
		e.port < 65536 &&
		Number.isSafeInteger(e.pid) &&
		e.pid > 0 &&
		/^[\da-f]{64}$/.test(e.key)
	);
}
async function endpoint(file: string): Promise<Endpoint | undefined> {
	let opened: Awaited<ReturnType<typeof open>> | undefined;
	try {
		opened = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = await opened.stat();
		if (
			!stat.isFile() ||
			stat.size > 4096 ||
			(stat.mode & 0o077) !== 0 ||
			(process.getuid && stat.uid !== process.getuid())
		)
			return;
		const candidate: Endpoint = JSON.parse(await opened.readFile("utf8"));
		if (!candidate || !isEndpoint(candidate)) return;
		try {
			process.kill(candidate.pid, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") await unlink(file).catch(() => {});
			return;
		}
		return candidate;
	} catch {
		return;
	} finally {
		await opened?.close();
	}
}
async function endpoints(dir: string): Promise<Endpoint[]> {
	const peers = await directory(dir);
	const files: string[] = [];
	for await (const entry of await opendir(peers)) {
		if (!entry.isFile() || !entry.name.endsWith(".json") || !uuid.test(entry.name.slice(0, -5))) continue;
		files.push(pathJoin(peers, entry.name));
		if (files.length > 256) throw Error("Too many participant records in this folder.");
	}
	const values = await Promise.all(files.map(endpoint));
	return values.filter((e): e is Endpoint => !!e);
}
async function present(e: Endpoint): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${e.port}/present`, {
			headers: { Authorization: `Bearer ${e.key}` },
			redirect: "error",
			signal: AbortSignal.timeout(700),
		});
		return response.ok && (await response.json()).id === e.id;
	} catch {
		return false;
	}
}
export async function members(dir: string): Promise<Participant[]> {
	const values = await endpoints(dir);
	const live = await Promise.all(values.map(present));
	return values
		.filter((_, i) => live[i])
		.map(({ id, label, kind }) => ({ id, label, kind }))
		.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
export async function invite(dir: string, target: string, request: Invitation): Promise<Participant> {
	const candidates = (await endpoints(dir)).filter((e) => e.id === target);
	const live = (await Promise.all(candidates.map(present)))
		.map((ok, i) => (ok ? candidates[i] : undefined))
		.filter((e): e is Endpoint => !!e);
	if (live.length !== 1)
		throw Error(
			live.length
				? "Two connections claim that conversation. Choose a distinct session."
				: "The selected conversation is no longer connected to this folder.",
		);
	const e = live[0];
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${e.port}/invite`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.key}` },
			body: JSON.stringify(request),
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
	} catch {
		throw Error("No receipt from the selected conversation. Check the thread before you send again.");
	}
	const result = await response.json();
	if (!response.ok || result.accepted !== true)
		throw Error(typeof result.error === "string" ? result.error : "Conversation did not confirm the invitation.");
	return { id: e.id, label: e.label, kind: e.kind };
}
