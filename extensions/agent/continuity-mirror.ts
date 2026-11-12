import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId, Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { onStoredCommit } from "./commit-observation.ts";
import { CONTINUITY_ENTRY, nativeContinuityText, validateContinuityState, type ContinuityEvent } from "./continuity-facts.ts";
import { ContinuityDoc } from "./continuity-native.ts";
import { canonicalIdentity } from "./native-identity.ts";

export const CONTINUITY_LOAD_TIMEOUT_MS = 10_000;
interface MirroredConversation {
	events: readonly ContinuityEvent[];
	head?: EntryRecord;
	text?: string;
}
export interface FrozenContinuity { readonly head: EntryRecord; readonly text: string }

/** Synchronous stored-publication mirror. Initialise before any scheduling-enabling act. */
export class ContinuityMirror {
	private readonly conversations = new Map<ConversationId, MirroredConversation>();
	private readonly detach: () => void;
	private readonly harness: Harness;
	private readonly storageId: string;
	constructor(harness: Harness, storageId: string) {
		this.harness = harness;
		this.storageId = storageId;
		this.detach = onStoredCommit(harness, (publication) => this.advance(publication));
	}
	private row(id: ConversationId): MirroredConversation {
		let row = this.conversations.get(id);
		if (row === undefined) { row = { events: [] }; this.conversations.set(id, row); }
		return row;
	}
	advance(publication: CommitPublication): void {
		for (const change of publication.changes) {
			if (change.type === "document" && change.record.kind === CONTINUITY_ENTRY && change.conversationId !== undefined) {
				const row = this.row(change.conversationId);
				if (change.kind === "retire") { row.events = []; row.text = undefined; }
				else { validateContinuityState(change.value); row.events = change.value.events; }
			}
			if (change.type === "entry" && change.value.head !== undefined) {
				const row = this.row(change.value.conversationId);
				if (row.head === undefined || change.value.id > row.head.id) { row.head = change.value; row.text = undefined; }
			}
		}
	}
	async initialize(context: Context): Promise<void> {
		const loading = withAbortSignal(AbortSignal.timeout(CONTINUITY_LOAD_TIMEOUT_MS), context);
		let cursor: Cursor | undefined;
		do {
			const page = await this.harness.commit(async (tx) => {
				const page = await tx.scanConversations({}, 64, cursor);
				for (const conversation of page.items) {
					const state = await tx.doc(ContinuityDoc, conversation.id);
					validateContinuityState(state);
					const head = await tx.latestHeadMarker(conversation.id);
					this.conversations.set(conversation.id, { events: state.events.map((event) => ({ ...event })), ...(head === undefined ? {} : { head }) });
				}
				return page;
			}, loading);
			cursor = page.next;
		} while (cursor !== undefined);
	}
	/** No storage access, clock, liveness read, or asynchronous work at the request boundary. */
	current(conversationId: ConversationId): FrozenContinuity | undefined {
		const row = this.conversations.get(conversationId);
		if (row?.head === undefined) return undefined;
		row.text ??= nativeContinuityText(canonicalIdentity(this.storageId, conversationId), row.head.id, row.events);
		return { head: row.head, text: row.text };
	}
	close(): void { this.detach(); }
}
