/**
 * agent/session-view: a synchronous read projection of one durable
 * AgentHarness session branch onto the coding-agent SessionManager read
 * surface (the ReadonlySessionManager method set).
 *
 * The harness session is the authority. The projection holds a derived cache:
 * an atomic branch snapshot establishes the initial state, and harness events
 * keep committed entry additions and session value updates current. Pending
 * extension writes remain absent until their durable commit. All ids,
 * parents, timestamps, compaction data, labels, and names come from the
 * harness; the projection never invents identifiers or metadata. Returned
 * shapes are the coding-agent session entry types. Custom messages the worker
 * stored under the reserved wrapper custom type are exposed as ordinary
 * custom_message entries; name, label, model, and thinking-level history the
 * worker appends under reserved custom types are exposed as the ordinary
 * typed entries those mutations produce in ordinary Pi (session_info, label,
 * model_change, thinking_level_change), carrying their real harness ids.
 */

import { createBranchSummaryMessage, type Entry } from "@earendil-works/pi-agent-core";
import {
	CURRENT_SESSION_VERSION,
	type BranchSummaryEntry,
	type CompactionEntry,
	type CustomEntry,
	type CustomMessageEntry,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionInfoEntry,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";

/** Reserved wrapper customType under which the worker durably stores ordinary custom messages. */
export const CUSTOM_MESSAGE_WRAPPER_TYPE = "agent.custom_message";

/** Reserved customType carrying one session-name change (data: { name }). */
export const NAME_CHANGE_ENTRY_TYPE = "agent.name_change";

/** Reserved customType carrying one label change (data: { targetId, label? }). */
export const LABEL_CHANGE_ENTRY_TYPE = "agent.label_change";

/** Reserved customType carrying one model change (data: { provider, modelId }). */
export const MODEL_CHANGE_ENTRY_TYPE = "agent.model_change";

/** Reserved customType carrying one thinking-level change (data: { thinkingLevel }). */
export const THINKING_CHANGE_ENTRY_TYPE = "agent.thinking_level_change";

export interface SessionViewIdentity {
	sessionId: string;
	cwd: string;
	createdAtMs: number;
	/** Parent session file path per the ordinary SessionHeader.parentSession contract; absent when unknown. */
	parentSession?: string;
	sessionDir: string;
	sessionFile?: string;
}

/** Authoritative initial state of the durable session branch. */
export interface SessionViewSnapshot {
	/** Branch entries, oldest first. */
	entries: Entry[];
	/** Durable label values, one per labeled entry id. */
	labels: ReadonlyArray<{ targetId: string; label: string }>;
	name: string | undefined;
	tipId: string | null;
	firstKeptEntries?: ReadonlyArray<{ id: string; firstKeptEntryId: string }>;
	entryDetails?: ReadonlyArray<{ id: string; details: unknown }>;
}

/** Durable session value change pushed by the harness. */
export type SessionViewValueUpdate =
	| { kind: "name"; name: string | undefined }
	| { kind: "label"; targetId: string; label: string | undefined };

/** Reads and subscriptions that keep the projection current with the durable session. */
export interface SessionViewFeed {
	/** Authoritative snapshot of the session branch and session values. */
	load(): Promise<SessionViewSnapshot>;
	/** Subscribe to durable entry additions on the session branch. */
	onEntryAdded(listener: (entry: Entry) => void): () => void;
	/** Subscribe to durable session value changes (name, labels). */
	onValueUpdate(listener: (update: SessionViewValueUpdate) => void): () => void;
}

function timestampOf(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * The context message a branch entry contributes to a compaction tail, per the
 * harness compaction preparation: message entries contribute their message,
 * branch summaries contribute their synthesized summary message, and
 * compaction and custom entries contribute nothing.
 */
function tailMessageOf(entry: Entry): unknown {
	if (entry.type === "message") return entry.message;
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

function sameMessage(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

/**
 * Map the worker's reserved mutation-history custom records onto the ordinary
 * typed entries the same mutations produce in ordinary Pi, preserving the
 * real harness id, parent, and timestamp. Malformed payloads fall back to
 * plain custom entries rather than inventing fields.
 */
function historyEntryOf(
	entry: Extract<Entry, { type: "custom" }>,
	base: { id: string; parentId: string | null; timestamp: string },
): SessionEntry | undefined {
	const record = entry.data as Record<string, unknown> | undefined;
	if (record === undefined || typeof record !== "object") return undefined;
	switch (entry.customType) {
		case NAME_CHANGE_ENTRY_TYPE:
			if (record.name !== undefined && typeof record.name !== "string") return undefined;
			return { ...base, type: "session_info", ...(record.name === undefined ? {} : { name: record.name }) } satisfies SessionInfoEntry;
		case LABEL_CHANGE_ENTRY_TYPE:
			if (typeof record.targetId !== "string") return undefined;
			return {
				...base,
				type: "label",
				targetId: record.targetId,
				label: record.label === undefined ? undefined : String(record.label),
			} satisfies SessionEntry;
		case MODEL_CHANGE_ENTRY_TYPE:
			if (typeof record.provider !== "string" || typeof record.modelId !== "string") return undefined;
			return {
				...base,
				type: "model_change",
				provider: record.provider,
				modelId: record.modelId,
			} satisfies ModelChangeEntry;
		case THINKING_CHANGE_ENTRY_TYPE:
			if (typeof record.thinkingLevel !== "string") return undefined;
			return {
				...base,
				type: "thinking_level_change",
				thinkingLevel: record.thinkingLevel,
			} satisfies ThinkingLevelChangeEntry;
		default:
			return undefined;
	}
}

export interface CustomMessagePayload {
	customType: string;
	content: CustomMessageEntry["content"];
	display: boolean;
	details?: unknown;
}

/**
 * The wrapper payload of a durably stored custom message. A wrapper without a
 * payload object, original custom type, or content is malformed and stays a
 * plain custom entry.
 */
export function customMessagePayloadOf(data: unknown): CustomMessagePayload | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.customType !== "string" || record.customType.length === 0) return undefined;
	if (typeof record.content !== "string") {
		if (!Array.isArray(record.content) || !record.content.every((part) => {
			if (part === null || typeof part !== "object" || Array.isArray(part)) return false;
			return part.type === "text" ? typeof part.text === "string" : part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string";
		})) return undefined;
	}
	return {
		customType: record.customType,
		content: record.content as CustomMessageEntry["content"],
		// Ordinary producers always send the flag; an absent flag renders hidden.
		display: record.display === true,
		details: record.details,
	};
}

export class SessionView {
	private readonly byId = new Map<string, SessionEntry>();
	/** Raw harness entries, used for exact compaction tail matching. */
	private readonly rawById = new Map<string, Entry>();
	private readonly firstKeptEntries = new Map<string, string>();
	private readonly entryDetails = new Map<string, unknown>();
	private readonly ordered: SessionEntry[] = [];
	private readonly labels = new Map<string, string>();
	private sessionName: string | undefined;
	private leafId: string | null = null;
	private readonly identity: SessionViewIdentity;
	private readonly feed: SessionViewFeed;
	private readonly pendingEntries: Entry[] = [];
	private readonly pendingValueUpdates: SessionViewValueUpdate[] = [];
	private ready = false;

	constructor(identity: SessionViewIdentity, feed: SessionViewFeed) {
		this.identity = identity;
		this.feed = feed;
		// Subscribe before the asynchronous snapshot loads: entries and value
		// changes committed while the snapshot is in flight are buffered here
		// and replayed after it is ingested, so no durable change is lost.
		feed.onEntryAdded((entry) => {
			if (this.ready) this.ingest(entry);
			else this.pendingEntries.push(entry);
		});
		feed.onValueUpdate((update) => {
			if (this.ready) this.applyValueUpdate(update);
			else this.pendingValueUpdates.push(update);
		});
	}

	/** Load the authoritative snapshot and switch the cache to live event maintenance. */
	async initialize(): Promise<void> {
		if (this.ready) return;
		const snapshot = await this.feed.load();
		for (const pointer of snapshot.firstKeptEntries ?? []) this.firstKeptEntries.set(pointer.id, pointer.firstKeptEntryId);
		for (const override of snapshot.entryDetails ?? []) this.entryDetails.set(override.id, override.details);
		for (const entry of snapshot.entries) this.ingest(entry);
		for (const label of snapshot.labels) this.labels.set(label.targetId, label.label);
		this.sessionName = snapshot.name;
		this.leafId = snapshot.tipId;
		this.ready = true;
		for (const update of this.pendingValueUpdates.splice(0)) this.applyValueUpdate(update);
		for (const entry of this.pendingEntries.splice(0)) this.ingest(entry);
	}

	/** Reflect one durable entry (exact id, parent chain, timestamp). */
	ingest(entry: Entry): void {
		if (this.rawById.has(entry.id)) return;
		this.rawById.set(entry.id, entry);
		const projected = this.project(entry);
		if (projected.type === "branch_summary" && this.entryDetails.has(entry.id)) projected.details = this.entryDetails.get(entry.id);
		this.byId.set(projected.id, projected);
		this.ordered.push(projected);
		// Appends advance the durable branch tip; navigation corrections arrive
		// through setLeafFromHarness.
		this.leafId = projected.id;
	}

	/** Reflect the durable branch tip; null is the ordinary reset-leaf state. */
	setLeafFromHarness(tipId: string | null): void {
		this.leafId = tipId;
	}

	setBranchSummaryDetails(entryId: string, details: unknown): void {
		this.entryDetails.set(entryId, details);
		const projected = this.byId.get(entryId);
		if (projected?.type === "branch_summary") projected.details = details;
	}

	setCompactionPointer(entryId: string, firstKeptEntryId: string): void {
		this.firstKeptEntries.set(entryId, firstKeptEntryId);
		const projected = this.byId.get(entryId);
		if (projected?.type === "compaction") projected.firstKeptEntryId = firstKeptEntryId;
	}

	/** Write-through warmer for a label set through the extension action. */
	markLabel(targetId: string, label: string | undefined): void {
		if (label === undefined || label === "") this.labels.delete(targetId);
		else this.labels.set(targetId, label);
	}

	/** Write-through warmer for a session name set through the extension action. */
	markName(name: string | undefined): void {
		this.sessionName = name;
	}

	// --- coding-agent SessionManager read surface ---

	getCwd(): string {
		return this.identity.cwd;
	}

	getSessionDir(): string {
		return this.identity.sessionDir;
	}

	getSessionId(): string {
		return this.identity.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.identity.sessionFile;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getLabel(id: string): string | undefined {
		return this.labels.get(id);
	}

	/** Ancestors of the given entry (or the leaf), ordered from the root downward. */
	getBranch(fromId?: string): SessionEntry[] {
		const startId = fromId ?? this.leafId;
		return this.ancestryPath(startId ? this.byId.get(startId) : undefined);
	}

	/**
	 * Compaction-aware active entry list, with the coding-agent semantics: the
	 * latest compaction on the leaf path is followed by the kept
	 * pre-compaction entries starting at its firstKeptEntryId, then by every
	 * entry after the compaction.
	 */
	buildContextEntries(): SessionEntry[] {
		// Ordinary leaf resolution: a null tip yields no path; an unknown tip
		// falls back to the last known entry.
		if (this.leafId === null) return [];
		let leaf = this.leafId ? this.byId.get(this.leafId) : undefined;
		leaf ??= this.ordered[this.ordered.length - 1];
		if (!leaf) return [];
		const path = this.ancestryPath(leaf);
		let compaction: CompactionEntry | undefined;
		for (const entry of path) {
			if (entry.type === "compaction") compaction = entry;
		}
		if (!compaction) return path;
		const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
		const contextEntries: SessionEntry[] = [compaction];
		let foundFirstKept = false;
		for (let index = 0; index < compactionIndex; index += 1) {
			if (path[index].id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) contextEntries.push(path[index]);
		}
		contextEntries.push(...path.slice(compactionIndex + 1));
		return contextEntries;
	}

	getHeader(): SessionHeader | null {
		return {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.identity.sessionId,
			timestamp: timestampOf(this.identity.createdAtMs),
			cwd: this.identity.cwd,
			...(this.identity.parentSession ? { parentSession: this.identity.parentSession } : {}),
		};
	}

	/** All entries in durable order (shallow copy). */
	getEntries(): SessionEntry[] {
		return [...this.ordered];
	}

	/** Defensive tree copy; well-formed sessions have one root. */
	getTree(): SessionTreeNode[] {
		const nodesById = new Map<string, SessionTreeNode>();
		for (const entry of this.ordered) {
			const label = this.labels.get(entry.id);
			nodesById.set(entry.id, {
				entry,
				children: [],
				...(label === undefined ? {} : { label }),
			});
		}
		const roots: SessionTreeNode[] = [];
		for (const node of nodesById.values()) {
			const parent = node.entry.parentId !== null ? nodesById.get(node.entry.parentId) : undefined;
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
		return roots;
	}

	getSessionName(): string | undefined {
		return this.sessionName;
	}

	// --- projection internals ---

	private ancestryPath(start: SessionEntry | undefined): SessionEntry[] {
		const path: SessionEntry[] = [];
		let cursor = start;
		while (cursor) {
			path.push(cursor);
			cursor = cursor.parentId ? this.byId.get(cursor.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	private applyValueUpdate(update: SessionViewValueUpdate): void {
		if (update.kind === "name") this.sessionName = update.name;
		else this.markLabel(update.targetId, update.label);
	}

	/**
	 * The stored id of the first pre-compaction entry kept by the compaction,
	 * derived from the retained tail: walking the compaction's ancestry
	 * backward, each tail message must match the contributing entry, and the
	 * entry that consumes the first tail message is the first kept entry.
	 * Compaction and custom entries contribute no tail message and are
	 * skipped. An empty or unmatchable tail yields "" under which the ordinary
	 * context splice keeps only the compaction entry and its successors, the
	 * same reading the harness context builder applies.
	 */
	private deriveFirstKeptEntryId(compaction: Entry & { type: "compaction" }): string {
		const explicit = this.firstKeptEntries.get(compaction.id);
		if (explicit !== undefined) return explicit;
		const tail = compaction.retainedTail;
		if (tail.length === 0) return "";
		let cursorId = compaction.parentId;
		let index = tail.length - 1;
		while (cursorId !== null && index >= 0) {
			const entry = this.rawById.get(cursorId);
			if (!entry) return "";
			if (entry.type !== "compaction" && entry.type !== "custom") {
				if (!sameMessage(tailMessageOf(entry), tail[index])) return "";
				if (index === 0) return entry.id;
				index -= 1;
			}
			cursorId = entry.parentId;
		}
		return "";
	}

	private project(entry: Entry): SessionEntry {
		const base = {
			id: entry.id,
			parentId: entry.parentId,
			timestamp: timestampOf(entry.timestamp),
		};
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "custom") return { ...base, type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details };
				return { ...base, type: "message", message };
			}
			case "compaction":
				return {
					...base,
					type: "compaction",
					summary: entry.summary,
					firstKeptEntryId: this.deriveFirstKeptEntryId(entry),
					tokensBefore: entry.tokensBefore,
					details: entry.details,
					usage: entry.usage,
					fromHook: entry.fromHook,
				} satisfies CompactionEntry;
			case "branch_summary":
				return {
					...base,
					type: "branch_summary",
					// The harness records a null source tip for null-tip
					// navigation; the ordinary writer admits the same null.
					fromId: entry.fromId as BranchSummaryEntry["fromId"],
					summary: entry.summary,
					details: entry.details,
					usage: entry.usage,
					fromHook: entry.fromHook,
				} satisfies BranchSummaryEntry;
			case "custom": {
				if (entry.customType === CUSTOM_MESSAGE_WRAPPER_TYPE) {
					const payload = customMessagePayloadOf(entry.data);
					if (payload) {
						return {
							...base,
							type: "custom_message",
							customType: payload.customType,
							content: payload.content,
							details: payload.details,
							display: payload.display,
						} satisfies CustomMessageEntry;
					}
				}
				const history = historyEntryOf(entry, base);
				if (history) return history;
				return {
					...base,
					type: "custom",
					customType: entry.customType,
					data: entry.data,
				} satisfies CustomEntry;
			}
		}
	}
}
