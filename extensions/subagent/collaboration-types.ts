/** Presentation facts, not a second worker lifecycle or message queue. */
export interface CollaborationParticipant {
	id: string;
	parentId: string | null;
	label: string;
	task: string;
	model: string;
	state: string;
	workerId: string | null;
	continuedFrom: string | null;
}

export interface CollaborationEvent {
	id: string;
	actorId: string;
	recipientId: string | null;
	kind: string;
	text: string;
	timestamp: number;
	source: string;
	sourceSessionId: string;
	entryId: string | null;
	messageId: string | null;
	replyTo: string | null;
	workerId: string | null;
	receipt: string | null;
}

export interface CollaborationSnapshot {
	familyId: string;
	families: { id: string; label: string }[];
	participants: CollaborationParticipant[];
	events: CollaborationEvent[];
	notices: string[];
}

export interface CollaborationQuery {
	familyId?: string;
	/** Explicit selected-family history load, never a background scan. */
	history?: boolean;
}
