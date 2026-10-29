import type { ConversationId } from "@earendil-works/pi-durable";

export type RouteNote = { digest: string; text: string; entryId: number };
export type UserPrefix = { count: number; hash: string };
export type RouteState = { notes: RouteNote[]; prefix: UserPrefix };
export const REQUEST_NOTES_HOST_BYTES = 16 * 1024 * 1024;

/** Whole-conversation eviction bounds host memory without changing a generation task's memo. */
export class RequestRouteState {
	private readonly conversations = new Map<ConversationId, { state: RouteState; bytes: number }>();
	private bytes = 0;
	private readonly maxBytes: number;

	constructor(maxBytes = REQUEST_NOTES_HOST_BYTES) { this.maxBytes = maxBytes; }

	get(id: ConversationId): RouteState | undefined {
		const record = this.conversations.get(id);
		if (!record) return undefined;
		this.conversations.delete(id);
		this.conversations.set(id, record);
		return { notes: record.state.notes.map((note) => ({ ...note })), prefix: { ...record.state.prefix } };
	}

	delete(id: ConversationId): void {
		const record = this.conversations.get(id);
		if (record) this.bytes -= record.bytes;
		this.conversations.delete(id);
	}

	set(id: ConversationId, state: RouteState): void {
		this.delete(id);
		if (!state.notes.length) return;
		const bytes = Buffer.byteLength(JSON.stringify(state));
		this.conversations.set(id, { state: { notes: state.notes.map((note) => ({ ...note })), prefix: { ...state.prefix } }, bytes });
		this.bytes += bytes;
		while (this.bytes > this.maxBytes) this.delete(this.conversations.keys().next().value as ConversationId);
	}
}
