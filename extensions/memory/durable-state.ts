import type { ConversationId } from "@earendil-works/pi-durable";

export type SavedNotice = {
	occurrence: string;
	text: string;
	root: string;
	slug: string | null;
	digest: string | null;
};
export type RecallState = { watermark: string; notices: SavedNotice[] };
export const WATERMARK_CAP = 1024;
export const NOTICE_BYTES = 2 * 1024 * 1024;

function snapshot(state: RecallState): RecallState {
	return { watermark: state.watermark, notices: state.notices.map((notice) => ({ ...notice })) };
}

/** Watermark-only churn does not evict notice-bearing conversations. */
export class DurableRecallState {
	private readonly empty = new Map<ConversationId, string>();
	private readonly visible = new Map<ConversationId, { state: RecallState; bytes: number }>();
	private bytes = 0;

	get(id: ConversationId): RecallState | undefined {
		const record = this.visible.get(id);
		if (record) {
			this.visible.delete(id);
			this.visible.set(id, record);
			return snapshot(record.state);
		}
		const watermark = this.empty.get(id);
		if (watermark === undefined) return undefined;
		this.empty.delete(id);
		this.empty.set(id, watermark);
		return { watermark, notices: [] };
	}

	delete(id: ConversationId): void {
		const record = this.visible.get(id);
		if (record) this.bytes -= record.bytes;
		this.visible.delete(id);
		this.empty.delete(id);
	}

	set(id: ConversationId, state: RecallState): void {
		this.delete(id);
		if (!state.notices.length) {
			this.empty.set(id, state.watermark);
			if (this.empty.size > WATERMARK_CAP) this.empty.delete(this.empty.keys().next().value as ConversationId);
			return;
		}
		const bytes = Buffer.byteLength(JSON.stringify(state.notices));
		this.visible.set(id, { state: snapshot(state), bytes });
		this.bytes += bytes;
		while (this.bytes > NOTICE_BYTES) this.delete(this.visible.keys().next().value as ConversationId);
	}
}
