import type { ConversationId } from "@earendil-works/pi-durable";

export type RouteNote = { digest: string; text: string; entryId: number };
export const REQUEST_NOTES_HOST_BYTES = 16 * 1024 * 1024;

/** Whole-conversation eviction bounds host memory without changing a generation task's memo. */
export class RequestRouteState {
	private readonly conversations = new Map<ConversationId, { notes: RouteNote[]; bytes: number }>();
	private bytes = 0;
	private readonly maxBytes: number;

	constructor(maxBytes = REQUEST_NOTES_HOST_BYTES) { this.maxBytes = maxBytes; }

	get(id: ConversationId): RouteNote[] | undefined {
		const record = this.conversations.get(id);
		if (!record) return undefined;
		this.conversations.delete(id);
		this.conversations.set(id, record);
		return record.notes.map((note) => ({ ...note }));
	}

	delete(id: ConversationId): void {
		const record = this.conversations.get(id);
		if (record) this.bytes -= record.bytes;
		this.conversations.delete(id);
	}

	set(id: ConversationId, notes: RouteNote[]): void {
		this.delete(id);
		if (!notes.length) return;
		const bytes = Buffer.byteLength(JSON.stringify(notes));
		this.conversations.set(id, { notes: notes.map((note) => ({ ...note })), bytes });
		this.bytes += bytes;
		while (this.bytes > this.maxBytes) this.delete(this.conversations.keys().next().value as ConversationId);
	}
}
