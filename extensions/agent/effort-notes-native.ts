import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { EffortPrompt } from "./effort-awareness.ts";
import {
	applyChanges,
	EFFORT_UPDATE_BUDGET,
	effortDelta,
	formatEffortUpdate,
	seenInSection,
	seenOf,
	type EffortChange,
	type EffortPromptRow,
	type EffortSeen,
} from "./effort-update.ts";

/**
 * Durable form of stable effort awareness. Durable renders sections before every request and stores
 * a changed section as a positional system entry, so the `agent-efforts` section keeps its bytes
 * between baseline points. At the first request of each run the section function reads awareness;
 * the change since the model's view becomes one frozen update note, which a request hook inserts
 * after the message that started the run, on that request and on every later one. Notes live in
 * host memory: a host restart or eviction keeps the section, which Durable restores from the
 * transcript, and drops the notes, so the next change is computed against the section alone.
 */

/** A note follows one message of the request, found by role, timestamp and content digest. */
interface Anchor {
	readonly role: Message["role"];
	readonly timestamp: number;
	readonly digest: string;
}
interface Note {
	readonly anchor: Anchor;
	readonly text: string;
	readonly change: EffortChange;
	readonly bytes: number;
}
interface Conversation {
	baseline: string;
	baseSeen: EffortSeen;
	notes: Note[];
	/** The run whose first request already decided this conversation's section. */
	decided?: string;
	/** Rows read at that first request, for the next request hook to turn into a note. */
	pending?: readonly EffortPromptRow[];
	/** The change did not fit: the next run replaces the section. */
	rebaseline?: boolean;
}

export const NATIVE_EFFORT_CONVERSATIONS = 256;
const SECTION = "agent-efforts";

function messageDigest(message: Message): string {
	return createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 16);
}

/** The tagged section text Durable shows, without its tags. */
function shownText(shown: Readonly<Record<string, string>>): string | undefined {
	const value = shown[SECTION];
	if (value === undefined) return undefined;
	const open = `<${SECTION}>\n`;
	const close = `\n</${SECTION}>`;
	return value.startsWith(open) && value.endsWith(close) ? value.slice(open.length, -close.length) : value;
}

/** Index of each note's anchor in this request, or -1 when the anchor left the context. */
function anchorIndexes(messages: readonly Message[], notes: readonly Note[]): number[] {
	const stamps = new Set(notes.map((note) => note.anchor.timestamp));
	const candidates = new Map<string, number[]>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "system" || !stamps.has(message.timestamp)) continue;
		const key = `${message.role}\u0000${message.timestamp}`;
		const list = candidates.get(key) ?? [];
		list.push(index);
		candidates.set(key, list);
	}
	const digests = new Map<number, string>();
	return notes.map(({ anchor }) => {
		for (const index of candidates.get(`${anchor.role}\u0000${anchor.timestamp}`) ?? []) {
			let digest = digests.get(index);
			if (digest === undefined) {
				digest = messageDigest(messages[index]);
				digests.set(index, digest);
			}
			if (digest === anchor.digest) return index;
		}
		return -1;
	});
}

/**
 * A new host or an evicted conversation keeps the section the transcript already holds, unless it
 * is the text of a failed read, which the first working read replaces.
 */
function adoptShown(shown: Readonly<Record<string, string>>, unavailable: string): Conversation | undefined {
	const text = shownText(shown);
	return text === undefined || text === unavailable
		? undefined
		: { baseline: text, baseSeen: seenInSection(text), notes: [] };
}

function noteMessage(note: Note): Message {
	return { role: "user", content: [{ type: "text", text: note.text }], timestamp: note.anchor.timestamp };
}

export class NativeEffortNotes {
	private readonly conversations = new Map<ConversationId, Conversation>();
	private readonly limit: number;
	constructor(limit = NATIVE_EFFORT_CONVERSATIONS) {
		this.limit = limit;
	}

	private keep(id: ConversationId, state: Conversation): Conversation {
		this.conversations.delete(id);
		this.conversations.set(id, state);
		while (this.conversations.size > this.limit) {
			const oldest = this.conversations.keys().next().value;
			if (oldest === undefined) break;
			this.conversations.delete(oldest);
		}
		return state;
	}

	private seen(state: Conversation): EffortSeen {
		return applyChanges(
			state.baseSeen,
			state.notes.map((note) => note.change),
		);
	}

	/**
	 * The section text of one request. `run` names the current run; within a decided run the text is
	 * returned without a read. `read` resolves undefined when awareness is unavailable.
	 */
	async section(
		input: { conversationId: ConversationId; shown: Readonly<Record<string, string>>; run: string | undefined },
		read: () => Promise<EffortPrompt | undefined>,
		unavailable: string,
	): Promise<string> {
		const id = input.conversationId;
		let state = this.conversations.get(id);
		if (state !== undefined && (input.run === undefined || state.decided === input.run)) {
			this.keep(id, state);
			return state.baseline;
		}
		state ??= adoptShown(input.shown, unavailable);
		const prompt = await read();
		if (prompt === undefined) {
			if (state === undefined) return unavailable;
			state.decided = input.run;
			this.keep(id, state);
			return state.baseline;
		}
		const replace = (): string => {
			this.keep(id, { baseline: prompt.text, baseSeen: seenOf(prompt.rows), notes: [], decided: input.run });
			return prompt.text;
		};
		if (state === undefined || state.rebaseline) return replace();
		state.decided = input.run;
		state.pending = undefined;
		const delta = effortDelta(this.seen(state), prompt.rows);
		if (delta !== undefined) {
			const update = formatEffortUpdate(delta);
			const bytes = state.notes.reduce((total, note) => total + note.bytes, 0);
			if (update === undefined || bytes + update.bytes > EFFORT_UPDATE_BUDGET) return replace();
			state.pending = prompt.rows;
		}
		this.keep(id, state);
		return state.baseline;
	}

	/**
	 * The request with every retained note after its anchor. A note whose anchor left the context
	 * (compaction, rewind, reset) is no longer seen. Sections render before the hooks of each request,
	 * so the request after a section read turns its rows into a note after the request's last message.
	 */
	request(conversationId: ConversationId, messages: readonly Message[]): readonly Message[] | undefined {
		const state = this.conversations.get(conversationId);
		if (state === undefined) return undefined;
		let indexes = anchorIndexes(messages, state.notes);
		if (indexes.includes(-1)) {
			state.notes = state.notes.filter((_, index) => indexes[index] >= 0);
			indexes = indexes.filter((index) => index >= 0);
		}
		const pending = state.pending;
		if (pending !== undefined) {
			state.pending = undefined;
			const delta = effortDelta(this.seen(state), pending);
			const update = delta === undefined ? undefined : formatEffortUpdate(delta);
			const last = messages.findLastIndex((message) => message.role !== "system");
			if (update !== undefined && last >= 0) {
				const anchor = messages[last];
				state.notes.push({
					anchor: { role: anchor.role, timestamp: anchor.timestamp, digest: messageDigest(anchor) },
					text: update.text,
					change: update.change,
					bytes: update.bytes,
				});
				indexes.push(last);
			} else if (delta !== undefined) state.rebaseline = true;
		}
		if (state.notes.length === 0) return undefined;
		const after = new Map<number, Message[]>();
		state.notes.forEach((note, index) => {
			const list = after.get(indexes[index]) ?? [];
			list.push(noteMessage(note));
			after.set(indexes[index], list);
		});
		const result: Message[] = [];
		messages.forEach((message, index) => {
			result.push(message);
			for (const note of after.get(index) ?? []) result.push(note);
		});
		return result;
	}
}
