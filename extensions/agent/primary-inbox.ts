import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { CustomMessageEntryDraft, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_ROWS = 128;
const MAX_BYTES = 1024 * 1024;

type InboxRow = { sourceId: string; text: string; details: Record<string, unknown> };

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function records(bytes: Buffer, sessionId: string): InboxRow[] {
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	if (
		!object(value) ||
		value.version !== 1 ||
		value.sessionId !== sessionId ||
		!Array.isArray(value.rows) ||
		value.rows.length > MAX_ROWS
	)
		throw new Error("Primary inbox has an invalid header or row count");
	const rows: InboxRow[] = [];
	const seen = new Set<string>();
	for (const row of value.rows as unknown[]) {
		if (
			!object(row) ||
			typeof row.sourceId !== "string" ||
			row.sourceId === "" ||
			seen.has(row.sourceId) ||
			typeof row.text !== "string" ||
			!object(row.details) ||
			row.details.sourceId !== row.sourceId
		)
			throw new Error("Primary inbox has an invalid or duplicate row");
		seen.add(row.sourceId);
		rows.push({ sourceId: row.sourceId, text: row.text, details: row.details });
	}
	return rows;
}
function read(path: string, sessionId: string): InboxRow[] {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Primary inbox is not a regular file");
		const bytes = Buffer.alloc(MAX_BYTES + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (count === 0) return records(bytes.subarray(0, offset), sessionId);
			offset += count;
		}
		throw new Error("Primary inbox exceeds its byte limit");
	} finally {
		closeSync(fd);
	}
}
function draft(row: InboxRow): CustomMessageEntryDraft {
	return { type: "custom_message", customType: "agent.peer", content: row.text, display: true, details: row.details };
}

/** One queue per saved session. Only the registered primary writes it. */
export class PrimaryInbox {
	private readonly session: ExtensionContext["sessionManager"];
	private rows: InboxRow[] | undefined;
	private starting: string | undefined;

	constructor(session: ExtensionContext["sessionManager"]) {
		this.session = session;
	}

	private get path(): string | undefined {
		const sessionFile = this.session.getSessionFile();
		return sessionFile === undefined ? undefined : `${sessionFile}.agent-inbox`;
	}

	private load(): InboxRow[] {
		const path = this.path;
		this.rows ??= path === undefined ? [] : read(path, this.session.getSessionId());
		return this.rows;
	}

	private replace(rows: InboxRow[]): void {
		const path = this.path;
		if (path === undefined) throw new Error("Primary inbox requires a saved session file");
		if (rows.length === 0) {
			unlinkSync(path);
		} else {
			const bytes = JSON.stringify({ version: 1, sessionId: this.session.getSessionId(), rows });
			if (rows.length > MAX_ROWS || Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Primary inbox is full");
			// The endpoint lease excludes another writer. A fixed staging name bounds crash residue.
			const staging = `${path}.new`;
			const fd = openSync(
				staging,
				constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				0o600,
			);
			try {
				if (!fstatSync(fd).isFile()) throw new Error("Primary inbox staging path is not a regular file");
				writeFileSync(fd, bytes);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(staging, path);
		}
		this.rows = rows;
	}

	private retained(): Set<string> {
		// On a flushed Pi session, append is synchronous and a failed write rolls back the entry.
		// Reopen loads the whole file, including notices on other branches.
		return new Set(
			this.session
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom_message" &&
					entry.customType === "agent.peer" &&
					object(entry.details) &&
					typeof entry.details.sourceId === "string"
						? [entry.details.sourceId]
						: [],
				),
		);
	}

	private reconcile(retained: Set<string>): InboxRow[] {
		const rows = this.load();
		const pending = rows.filter((row) => !retained.has(row.sourceId));
		if (rows.length !== pending.length) this.replace(pending);
		if (this.starting !== undefined && retained.has(this.starting)) this.starting = undefined;
		return pending;
	}

	admit(sourceId: string, text: string, details: unknown): void {
		const sessionFile = this.session.getSessionFile();
		if (sessionFile === undefined) throw new Error("Primary inbox requires a saved session file");
		let fd: number;
		try {
			fd = openSync(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			throw new Error("Primary inbox requires a saved session file; start a conversation first");
		}
		try {
			if (!fstatSync(fd).isFile()) throw new Error("Primary inbox requires a regular session file");
		} finally {
			closeSync(fd);
		}
		const retained = this.retained();
		const rows = this.reconcile(retained);
		if (retained.has(sourceId) || rows.some((row) => row.sourceId === sourceId)) return;
		this.replace([
			...rows,
			{
				sourceId,
				text,
				details: { ...(object(details) ? details : details === undefined ? {} : { payload: details }), sourceId },
			},
		]);
	}

	hasRows(): boolean {
		return this.load().length > 0;
	}

	hasPending(sourceId: string): boolean {
		return this.load().some((row) => row.sourceId === sourceId) && !this.retained().has(sourceId);
	}

	private pending(): InboxRow[] {
		return this.load().length === 0 ? [] : this.reconcile(this.retained());
	}

	/** Busy delivery belongs after the assistant and its tool results, never between them. */
	boundary(): { entries: CustomMessageEntryDraft[]; continue: boolean } | undefined {
		const rows = this.pending();
		if (rows.length === 0) return;
		return { entries: rows.map(draft), continue: rows.some((row) => row.details.wake !== false) };
	}

	/** A waking idle message starts a run; that run's boundary places the remainder. */
	flush(send: (row: InboxRow, wake: boolean) => void, wake = true): void {
		for (const row of this.pending()) {
			// Pi can defer the waking send while settlement hooks are still running.
			if (this.starting !== undefined) return;
			const trigger = wake && row.details.wake !== false;
			send(row, trigger);
			if (trigger) {
				this.starting = row.sourceId;
				break;
			}
			if (!this.retained().has(row.sourceId)) break;
		}
		this.pending();
	}
}
