import type { ObligationView } from "./work-references.ts";

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
	/** A communication view, separate from raw tool and source evidence. */
	exchange?: { kind: "peer" | "report" | "steer" | "result" | "pause"; text: string };
}

export interface CollaborationSnapshot {
	familyId: string;
	families: { id: string; label: string }[];
	participants: CollaborationParticipant[];
	events: CollaborationEvent[];
	/** Task/artifact/revision obligations folded from peer references. */
	obligations: ObligationView[];
	/** Required obligations no accepted disposition has closed (including `unavailable`). */
	outstandingRequired: ObligationView[];
	/** Dispositions closed without acceptance (`disagreed`), with their reasons. */
	unaccepted: ObligationView[];
	notices: string[];
}

export interface CollaborationQuery {
	familyId?: string;
	/** Explicit selected-family history load, never a background scan. */
	history?: boolean;
}
