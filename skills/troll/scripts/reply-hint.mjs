#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const help = `Observe one previously identified local ordinary Pi session. The result is a hint for a person or one read-only review, never attribution, proof of the live branch, or permission for another message.

node reply-hint.mjs [--timeout-ms 900000] < observation.json

Pass one JSON object on stdin, at most 8192 bytes. Use the facts from the named session's pre-offer history observation and a separately verified local Rex pane. Do not discover targets by scanning files. Supply these fields:
  sessionId        exact Pi session UUID
  file             absolute path from source.path
  head             {id,offset}; source.head.id and source.head.byteOffset
  pin              {dev,ino,size}; source.pin at the same pre-offer snapshot
  rex              {server,host,instance,session,block,pid}; explicit local unix:// endpoint, Rex host and instance IDs, full Rex session and block IDs, foreground Pi PID from the named session
Use the installed rex executable (or its absolute path in PI_REX_EXECUTABLE). No default server, network target, terminal input, file write, or model call. One invocation only. Deadline: 1500 to 3600000 ms. Supply no draft text, digest or credentials. No transcript text appears in the result.

hint: a first fresh user entry, a later assistant entry with readable text and a normal stop, and a fresh done report from this Pi process. The input was NOT compared with a draft. Verify the first user entry against the actual offered text before judging any answer. An edit or unrelated message is not the offered round. These observations are not a reply-to or settlement receipt. A custom event or silent branch choice can change the interpretation.
ambiguous: a second user, non-text input, a discontinuity or another ambiguity needs a person. incomplete: an interrupted, failed or truncated assistant entry and a resting report. timeout: no qualifying signal by the deadline, not proof that no answer exists. unavailable: a source, identity, format or observation bound prevented the check.\n`;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const entry = (s) => typeof s === "string" && (/^[0-9a-f]{8}$/i.test(s) || uuid.test(s));
const validUuid = (s) => typeof s === "string" && uuid.test(s);
const int = (n, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;
const dex = (s) => typeof s === "string" && /^\d{1,32}$/.test(s);
const keys = (value, allowed) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).every((k) => allowed.includes(k));
const fail = (reason) => {
	throw new Fault(reason);
};
class Fault extends Error {}
const checked = (truth, reason) => {
	if (!truth) fail(reason);
};
const MAX_LINE = 2 * 1024 * 1024,
	MAX_NEW = 8 * 1024 * 1024;
const run = promisify(execFile);
const text = new TextDecoder("utf-8", { fatal: true });
const json = (buf) => {
	try {
		return JSON.parse(typeof buf === "string" ? buf : text.decode(buf));
	} catch {
		fail("invalid-record");
	}
};
function validSpec(s) {
	const r = s?.rex;
	checked(
		keys(s, ["sessionId", "file", "head", "pin", "rex"]) &&
			keys(s.head, ["id", "offset"]) &&
			keys(s.pin, ["dev", "ino", "size"]) &&
			keys(r, ["server", "host", "instance", "session", "block", "pid"]),
		"unexpected-input-fields",
	);
	checked(
		validUuid(s?.sessionId) &&
			typeof s.file === "string" &&
			isAbsolute(s.file) &&
			s.file.endsWith(".jsonl") &&
			!s.file.includes("\0"),
		"invalid-file-reference",
	);
	checked(
		entry(s.head?.id) &&
			int(s.head.offset, 1) &&
			dex(s.pin?.dev) &&
			dex(s.pin?.ino) &&
			int(s.pin?.size, s.head.offset + 1) &&
			s.pin.size - s.head.offset <= MAX_LINE,
		"invalid-baseline",
	);
	checked(
		typeof r?.server === "string" &&
			/^unix:\/\/\/[^\x00-\x1f]+$/u.test(r.server) &&
			r.server.length <= 1024 &&
			validUuid(r.host) &&
			validUuid(r.instance) &&
			r.session?.startsWith("session:") &&
			validUuid(r.session.slice(8)) &&
			r.block?.startsWith("block:") &&
			validUuid(r.block.slice(6)) &&
			int(r.pid, 2, 2 ** 31 - 1),
		"invalid-pane-reference",
	);
}
async function input(end) {
	let total = 0,
		timer;
	const chunks = [];
	try {
		return await Promise.race([
			(async () => {
				for await (const b of process.stdin) {
					total += b.length;
					checked(total <= 8192, "input-limit");
					chunks.push(b);
				}
				return json(Buffer.concat(chunks));
			})(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Fault("input-deadline")), Math.max(1, end - performance.now()));
			}),
		]);
	} finally {
		clearTimeout(timer);
		process.stdin.destroy();
	}
}
function read(fd, start, bytes) {
	const b = Buffer.allocUnsafe(bytes);
	let pos = 0;
	while (pos < bytes) {
		const n = fs.readSync(fd, b, pos, bytes - pos, start + pos);
		checked(n, "source-changed");
		pos += n;
	}
	return b;
}
function newTrace(s, fd) {
	const verify = () => {
		const a = fs.fstatSync(fd, { bigint: true }),
			b = fs.lstatSync(s.file, { bigint: true });
		checked(
			a.isFile() &&
				b.isFile() &&
				a.ino === b.ino &&
				a.dev === b.dev &&
				String(a.dev) === s.pin.dev &&
				String(a.ino) === s.pin.ino &&
				a.size >= BigInt(s.pin.size) &&
				a.size <= BigInt(Number.MAX_SAFE_INTEGER),
			"source-changed",
		);
		return Number(a.size);
	};
	verify();
	const h = read(fd, 0, Math.min(16384, s.head.offset)),
		nl = h.indexOf(10);
	checked(nl >= 0, "header-limit");
	const header = json(h.subarray(0, nl));
	checked(header?.type === "session" && header.version === 3 && header.id === s.sessionId, "session-header-mismatch");
	checked(read(fd, s.head.offset - 1, 1)[0] === 10, "not-entry-start");
	const base = read(fd, s.head.offset, s.pin.size - s.head.offset);
	checked(base.indexOf(10) === base.length - 1 && json(base).id === s.head.id, "head-mismatch");
	const seen = new Set([s.head.id]);
	let offset = s.pin.size,
		pending = Buffer.alloc(0),
		last = s.head.id,
		changedContext = false;
	let user, answer, final;
	const fields = () => ({
		...(user && { userId: user.id }),
		...(answer && { assistantId: answer.id }),
		...(changedContext && { contextChanged: true }),
	});
	function accept(row) {
		checked(row && entry(row.id) && !seen.has(row.id) && seen.size < 2048, "entry-limit-or-invalid-id");
		if (row.parentId !== last) {
			final = { state: "ambiguous", reason: "diverged-ancestry" };
			return;
		}
		seen.add(row.id);
		last = row.id;
		if (["compaction", "context_edit", "branch_summary"].includes(row.type)) {
			final = { state: "ambiguous", reason: "context-or-branch-changed" };
			return;
		}
		if (["custom_message", "custom"].includes(row.type)) changedContext = true;
		if (row.type !== "message") return;
		const m = row.message;
		checked(
			m &&
				typeof m.role === "string" &&
				typeof row.timestamp === "string" &&
				Number.isFinite(Date.parse(row.timestamp)),
			"invalid-message",
		);
		if (m.role === "user") {
			if (user) {
				final = { state: "ambiguous", reason: "another-user-entry", otherUserId: row.id };
				return;
			}
			const content =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content) && m.content.length === 1 && m.content[0]?.type === "text"
						? m.content[0].text
						: undefined;
			user = { id: row.id, at: Date.parse(row.timestamp) };
			if (typeof content !== "string") final = { state: "ambiguous", reason: "nontext-or-multipart-user" };
			return;
		}
		if (!user || m.role !== "assistant") return;
		if (
			m.stopReason === "stop" &&
			Array.isArray(m.content) &&
			m.content.some((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim().length)
		) {
			if (answer?.normal) {
				final = { state: "ambiguous", reason: "multiple-candidate-answers", otherAssistantId: row.id };
				return;
			}
			answer = { id: row.id, at: Date.parse(row.timestamp), normal: true };
		} else if (["error", "aborted", "length"].includes(m.stopReason))
			answer = { id: row.id, at: Date.parse(row.timestamp), normal: false, stop: m.stopReason };
		else if (answer) {
			final = { state: "ambiguous", reason: "generation-continued" };
		}
	}
	function scan() {
		const size = verify();
		checked(size >= offset && size - s.pin.size <= MAX_NEW, "append-limit-or-truncation");
		while (!final && offset < size) {
			const n = Math.min(256 * 1024, size - offset),
				chunk = read(fd, offset, n);
			offset += n;
			const b = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			let start = 0,
				stop;
			while (!final && (stop = b.indexOf(10, start)) !== -1) {
				checked(stop - start <= MAX_LINE, "line-limit");
				accept(json(b.subarray(start, stop)));
				start = stop + 1;
			}
			pending = b.subarray(start);
			if (!final) checked(pending.length <= MAX_LINE, "line-limit");
		}
		return { user, answer, final, partial: pending.length > 0, last };
	}
	return { scan, fields };
}
async function observe(s, end) {
	const r = s.rex,
		exe = process.env.PI_REX_EXECUTABLE || "rex";
	checked(exe === "rex" || isAbsolute(exe), "invalid-rex-path");
	const prefix = ["-S", r.server, "--autostart=false", "--timeout", "2s"];
	const fd = fs.openSync(s.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	let watcher,
		events,
		finalRead,
		timer,
		wake,
		seq = 0,
		eventFault,
		ended = false,
		scans = 0,
		trace;
	const pulse = () => {
		++seq;
		if (wake) {
			const f = wake;
			wake = undefined;
			f();
		}
	};
	const signal = (why) => {
		eventFault = why;
		pulse();
	};
	const cli = async (args) => {
		const left = Math.floor(end - performance.now());
		checked(left > 0, "deadline");
		const { stdout } = await run(exe, [...prefix, ...args], {
			encoding: "utf8",
			maxBuffer: 65536,
			timeout: Math.min(2200, left),
			killSignal: "SIGKILL",
		});
		return json(stdout);
	};
	const block = (name) =>
		cli([
			"api",
			"call",
			`com.superlogical.terminal.${name}`,
			JSON.stringify({ session_id: r.session, block_id: r.block, args: {} }),
		]);
	const identity = async () => {
		const [who, proc] = await Promise.all([cli(["whoami", "--json"]), block("process")]);
		checked(
			who?.host_id === r.host && who?.instance_id === r.instance && proc?.foreground?.pid === r.pid,
			"pane-identity-changed",
		);
	};
	try {
		trace = newTrace(s, fd);
		await identity();
		watcher = fs.watch(s.file, pulse);
		watcher.on("error", () => signal("file-observer-ended"));
		events = spawn(exe, [...prefix, "events", "-s", r.session, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
		let buf = "",
			traffic = 0;
		events.stdout.setEncoding("utf8");
		events.stdout.on("data", (chunk) => {
			if (eventFault) return;
			traffic += Buffer.byteLength(chunk);
			if (traffic > MAX_NEW) return signal("event-limit");
			buf += chunk;
			let i;
			while ((i = buf.indexOf("\n")) !== -1) {
				if (i > 131072) return signal("event-line-limit");
				let row;
				try {
					row = JSON.parse(buf.slice(0, i));
				} catch {
					return signal("invalid-rex-event");
				}
				buf = buf.slice(i + 1);
				const e = row?.payload?.event,
					p = e?.payload;
				if (
					e?.type === "block_event" &&
					p?.block_id === r.block &&
					p?.creator_name === "com.superlogical.terminal" &&
					["program_status_changed", "program_status_removed", "child_exited"].includes(p?.name)
				)
					pulse();
			}
			if (buf.length > 131072) signal("event-line-limit");
		});
		events.on("error", () => signal("event-stream-unavailable"));
		events.on("exit", () => signal("event-stream-ended"));
		// Both notification channels can race their subscription. Read immediately and reconcile once before expiry.
		const left = end - performance.now(),
			reserve = Math.min(1200, Math.max(180, left / 6));
		finalRead = setTimeout(pulse, Math.max(1, left - reserve));
		timer = setTimeout(
			() => {
				ended = true;
				pulse();
			},
			Math.max(1, left),
		);
		while (true) {
			const before = seq;
			checked(!eventFault, eventFault);
			checked(++scans <= 1024, "snapshot-limit");
			const state = trace.scan();
			if (state.final) return { ...state.final, ...trace.fields() };
			if (ended || performance.now() >= end)
				return { state: "timeout", reason: "no-qualifying-hint", ...trace.fields() };
			if (state.user && state.answer && !state.partial) {
				const report = await block("program_status");
				const matches = Array.isArray(report?.records)
					? report.records.filter((x) => x?.owner?.pid === r.pid && (x?.effective_app ?? x.app) === "pi")
					: [];
				if (matches.length === 1) {
					const status = matches[0];
					if (
						["done", "idle", "error"].includes(status.state) &&
						Date.parse(status.updated_at) > state.user.at &&
						Date.parse(status.updated_at) >= state.answer.at
					) {
						await identity();
						const now = trace.scan();
						if (now.final) return { ...now.final, ...trace.fields() };
						if (!now.partial && state.last === now.last && !eventFault) {
							const normal = state.answer.normal && status.state === "done";
							return {
								state: normal ? "hint" : "incomplete",
								...trace.fields(),
								reported: status.state,
								...(state.answer.stop && { stop: state.answer.stop }),
							};
						}
					}
				}
			}
			if (eventFault) fail(eventFault);
			if (ended || performance.now() >= end)
				return { state: "timeout", reason: "no-qualifying-hint", ...trace.fields() };
			if (before === seq)
				await new Promise((resolve) => {
					wake = resolve;
				});
		}
	} catch (e) {
		return { state: "unavailable", reason: e instanceof Fault ? e.message : "observation-failed", ...trace?.fields() };
	} finally {
		clearTimeout(finalRead);
		clearTimeout(timer);
		watcher?.close();
		events?.stdout.destroy();
		if (events && events.exitCode === null && events.signalCode === null) events.kill("SIGKILL");
		fs.closeSync(fd);
	}
}
async function main(args) {
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(help);
		return;
	}
	const ms = !args.length
		? 900000
		: args.length === 2 && args[0] === "--timeout-ms" && /^\d+$/.test(args[1])
			? Number(args[1])
			: NaN;
	checked(int(ms, 1500, 3600000), "invalid-arguments");
	const end = performance.now() + ms;
	const spec = await input(end);
	validSpec(spec);
	const result = await observe(spec, end);
	console.log(
		JSON.stringify({ ...result, sessionId: spec.sessionId, headId: spec.head.id, attribution: "not-established" }),
	);
}
try {
	await main(process.argv.slice(2));
} catch (e) {
	console.log(
		JSON.stringify({
			state: "unavailable",
			reason: e instanceof Fault ? e.message : "source-unavailable",
			attribution: "not-established",
		}),
	);
	process.exitCode = 1;
}
