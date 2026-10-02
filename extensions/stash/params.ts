/** Shared parameter schemas for the stash tools on both entrypoints. */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { STASH_STATES } from "./format.ts";

const shortText = (description: string) => Type.String({ description, maxLength: 200 });
const itemList = (description: string) =>
	Type.Optional(Type.Array(Type.String({ maxLength: 20_000 }), { description, maxItems: 200 }));

export const WriteParams = Type.Object({
	checkpoint: Type.Optional(
		Type.Boolean({
			description:
				"Save a working checkpoint in the configured checkpoint directory instead of a discoverable handover. Returns a file path, not a pickup id.",
		}),
	),
	title: shortText("Short human title for the handover"),
	summary: Type.String({
		description: "Distilled state of the effort: what is true now, what was done, what matters. Prose, self-contained.",
		maxLength: 100_000,
	}),
	decisions: itemList("Committed decisions, each with its why"),
	openLoops: itemList("Unresolved questions, blockers, unknowns"),
	nextActions: itemList("Ordered next steps for whoever resumes"),
	files: itemList("Relevant file paths"),
	tags: Type.Optional(
		Type.Array(Type.String({ maxLength: 80 }), {
			description: "Subject tags (tag by subject, not by consumer)",
			maxItems: 50,
		}),
	),
});

const stateSchema = StringEnum(STASH_STATES, { description: "Lifecycle state: open, active, or closed" });

export const ListParams = Type.Object({
	limit: Type.Optional(Type.Integer({ description: "Max entries (default 10, max 50)", minimum: 1, maximum: 50 })),
	tag: Type.Optional(Type.String({ description: "Only stashes carrying this tag", maxLength: 80 })),
	state: Type.Optional(stateSchema),
	query: Type.Optional(
		Type.String({
			description:
				"Literal query across metadata and complete supported-size bodies. Nonblank Unicode, at most 256 UTF-16 units; no controls or line separators. Unicode simple case-insensitive matching, no normalization.",
			minLength: 1,
			maxLength: 256,
		}),
	),
	cursor: Type.Optional(
		Type.String({
			description:
				"Opaque search continuation. Repeat query and filters, even after an empty page. Changed inventory requires restart.",
			minLength: 1,
			maxLength: 1024,
		}),
	),
});

export const ReadParams = Type.Object({
	id: Type.String({
		description: "Stash id or unique id prefix (from stash_list)",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
});

export const CompleteParams = Type.Object({
	id: Type.String({
		description: "Open or active stash id or unique id prefix",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
	outcome: Type.String({
		description: "Concrete terminal outcome of the stashed effort",
		minLength: 1,
		maxLength: 20_000,
	}),
});

export const RotateParams = Type.Object({
	id: Type.String({
		description: "Stash id or unique id prefix (from stash_list)",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
});
