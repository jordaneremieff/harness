/** Shared parameter schemas for the stash tools on both entrypoints. */
import { arr, bool, int, obj, opt, str, type Schema } from "@earendil-works/pi-schema";
import { STASH_STATES } from "./format.ts";

/** Plain `{ type: "string", enum: [...] }` so providers without anyOf/const support accept the declaration. */
const StringEnum = <T extends readonly string[]>(values: T, options?: { description?: string }): Schema<T[number]> =>
	({ type: "string", enum: values, ...(options?.description ? { description: options.description } : {}) });

const shortText = (description: string) => str({ description, maxLength: 200 });
const itemList = (description: string) =>
	opt(arr(str({ maxLength: 20_000 }), { description, maxItems: 200 }));

export const WriteParams = obj({
	checkpoint: opt(
		bool({
			description:
				"Save provisional working material in the configured checkpoint directory, discoverable with collection checkpoints. No handover pickup.",
		}),
	),
	title: shortText("Short human title for the handover"),
	summary: str({
		description: "Distilled state of the effort: what is true now, what was done, what matters. Prose, self-contained.",
		maxLength: 100_000,
	}),
	decisions: itemList("Committed decisions, each with its why"),
	openLoops: itemList("Unresolved questions, blockers, unknowns"),
	nextActions: itemList("Ordered next steps for whoever resumes"),
	files: itemList("Relevant file paths"),
	tags: opt(
		arr(str({ maxLength: 80 }), {
			description: "Subject tags (tag by subject, not by consumer)",
			maxItems: 50,
		}),
	),
}, { open: true });

const stateSchema = StringEnum(STASH_STATES, { description: "Lifecycle state: open, active, or closed" });

const collectionSchema = opt(StringEnum(["handovers", "checkpoints"] as const, { description: "Collection to read. Default handovers; checkpoints are provisional working material in the current configured checkpoint directory." }));

export const ListParams = obj({
	collection: collectionSchema,
	limit: opt(int({ description: "Max entries (default 10, max 50)", minimum: 1, maximum: 50 })),
	tag: opt(str({ description: "Only stashes carrying this tag", maxLength: 80 })),
	state: opt(stateSchema),
	query: opt(
		str({
			description:
				"Literal query across metadata and complete supported-size bodies. Nonblank Unicode, at most 256 UTF-16 units; no controls or line separators. Unicode simple case-insensitive matching, no normalization.",
			minLength: 1,
			maxLength: 256,
		}),
	),
	cursor: opt(
		str({
			description:
				"Opaque search continuation. Repeat query and filters, even after an empty page. Changed inventory requires restart.",
			minLength: 1,
			maxLength: 1024,
		}),
	),
}, { open: true });

export const ReadParams = obj({
	collection: collectionSchema,
	id: str({
		description: "Id from stash_list. Checkpoints require their checkpoint: prefix and collection checkpoints; handover ids remain unchanged.",
		minLength: 1,
		maxLength: 211,
		pattern: "^(checkpoint:)?[A-Za-z0-9._-]+$",
	}),
}, { open: true });

export const EditParams = obj({
	id: str({
		description: "Stash id or unique id prefix from stash_read",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
	expectedDigest: str({
		description: "SHA-256 digest from the latest stash_read; binds the complete artifact, including lifecycle state",
		pattern: "^[a-f0-9]{64}$",
	}),
	edits: arr(
		obj({
			oldText: str({
				description: "Exact nonempty text occurring once in the original body, outside its title heading",
				minLength: 1,
				maxLength: 100_000,
			}),
			newText: str({
				description:
					"Replacement text; empty deletes the matched text. Include the anchor plus new text to append an amendment.",
				maxLength: 100_000,
			}),
		}, { open: true }),
		{
			description: "Nonoverlapping body replacements, all matched against the original artifact, not earlier edits",
			minItems: 1,
			maxItems: 32,
		},
	),
	allowActive: opt(
		bool({
			description:
				"Explicitly acknowledge an authorized edit to an active effort. Default refuses active stashes. Closed stashes always refuse.",
		}),
	),
}, { open: true });

export const CompleteParams = obj({
	id: str({
		description: "Open or active stash id or unique id prefix",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
	outcome: str({
		description: "Concrete terminal outcome of the stashed effort",
		minLength: 1,
		maxLength: 20_000,
	}),
}, { open: true });

export const RotateParams = obj({
	id: str({
		description: "Stash id or unique id prefix (from stash_list)",
		minLength: 1,
		maxLength: 200,
		pattern: "^[A-Za-z0-9._-]+$",
	}),
}, { open: true });
