import type { CollaborationEvent } from "./collaboration-types.ts";

export interface ConversationThread {
	id: string;
	participants: [string, string];
	events: CollaborationEvent[];
}

/** Group recorded exchanges, not management calls or inferred collaboration roles. */
export function conversationThreads(events: readonly CollaborationEvent[]): ConversationThread[] {
	const threads = new Map<string, ConversationThread>();
	for (const event of events) {
		if (!event.exchange) continue;
		const participants = [event.actorId, event.recipientId ?? "unknown recipient"].sort() as [string, string];
		const id = JSON.stringify(participants);
		let thread = threads.get(id);
		if (!thread) {
			thread = { id, participants, events: [] };
			threads.set(id, thread);
		}
		thread.events.push(event);
	}
	return [...threads.values()];
}
