import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId, Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { onStoredCommit } from "./commit-observation.ts";
import { CONTINUITY_ENTRY, nativeContinuityText, validateContinuityState, type ContinuityEvent, type ContinuityWork } from "./continuity-facts.ts";
import { ContinuityDoc, freezeContinuityWork } from "./continuity-native.ts";
import { canonicalIdentity } from "./native-identity.ts";

export const CONTINUITY_LOAD_TIMEOUT_MS = 10_000;
interface MirroredConversation {
	events: readonly ContinuityEvent[];
	head?: EntryRecord;
	/** Declared open work as retained; it enters the note only for the head it was read for. */
	work?: ContinuityWork;
	/** Head whose open-work read failed in this process; its note states that and stays unchanged. */
	unread?: number;
	reading?: Promise<void>;
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
				if (change.kind === "retire") { row.events = []; row.work = undefined; row.text = undefined; }
				else { validateContinuityState(change.value); row.events = change.value.events; row.work = change.value.work; }
			}
			if (change.type === "entry" && change.value.head !== undefined) {
				const row = this.row(change.value.conversationId);
				if (row.head === undefined || change.value.id > row.head.id) { row.head = change.value; row.text = undefined; row.unread = undefined; }
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
					this.conversations.set(conversation.id, { events: state.events.map((event) => ({ ...event })), ...(head === undefined ? {} : { head }), ...(state.work === undefined ? {} : { work: JSON.parse(JSON.stringify(state.work)) as ContinuityWork }) });
				}
				return page;
			}, loading);
			cursor = page.next;
		} while (cursor !== undefined);
	}
	/**
	 * Complete the one storage read that a context head needs: the conversation's declared open work,
	 * read and retained in one commit before the first request of that head. Later calls for the head
	 * resolve without storage access. A failed read is not repeated in this process: the note of that
	 * head then states that open work was not read. Only cancellation rejects.
	 */
	async prepare(conversationId: ConversationId, context: Context): Promise<void> {
		const row = this.conversations.get(conversationId);
		const headId = row?.head?.id;
		if (row === undefined || headId === undefined || row.work?.headId === headId || row.unread === headId) return;
		row.reading ??= this.read(row, conversationId, headId, context).finally(() => { row.reading = undefined; });
		await row.reading;
	}
	private async read(row: MirroredConversation, conversationId: ConversationId, headId: number, context: Context): Promise<void> {
		try {
			const work = await this.harness.commit((tx) => freezeContinuityWork(tx, conversationId, headId), context);
			if (work !== undefined && row.head?.id === headId) row.work = work;
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			if (row.head?.id === headId) row.unread = headId;
		}
	}
	/**
	 * No storage access, clock, liveness read, or asynchronous work. The text of a head is kept once
	 * its open-work read is settled; before that it is computed again and names the missing read.
	 */
	current(conversationId: ConversationId): FrozenContinuity | undefined {
		const row = this.conversations.get(conversationId);
		if (row?.head === undefined) return undefined;
		const head = row.head;
		const text = row.text ?? nativeContinuityText(canonicalIdentity(this.storageId, conversationId), head.id, row.events, row.work);
		if (row.work?.headId === head.id || row.unread === head.id) row.text = text;
		return { head, text };
	}
	close(): void { this.detach(); }
}
