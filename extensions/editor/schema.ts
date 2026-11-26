import { arr, int, obj, opt, str, type Schema } from "@earendil-works/pi-schema";

const choice = <T extends string>(values: readonly T[], description?: string): Schema<T> => ({
	type: "string",
	enum: values,
	description,
});
const text = (description: string, maxLength: number) => str({ description, maxLength });
export const editorParameters = obj({
	op: choice([
		"join",
		"members",
		"state",
		"tree",
		"search",
		"git",
		"read",
		"new",
		"edit",
		"patch",
		"save",
		"note",
		"thread",
		"reply",
		"compose",
		"view",
	] as const),
	root: opt(text("Folder shared with the other participants. Defaults to your working directory.", 4096)),
	doc: opt(text("Relative file path or an existing scratch ID.", 4096)),
	path: opt(text("Directory for tree, new file name for new, or an unused destination for Save As.", 4096)),
	rev: opt(
		int({
			minimum: 0,
			description: "Exact revision last read. Required for edits, saves, text notes and view updates.",
		}),
	),
	offset: opt(
		int({
			minimum: 0,
			description: "Read or state: continue with nextOffset and the same rev or seq. Tree: listing offset.",
		}),
	),
	seq: opt(int({ minimum: 0, description: "Workspace sequence to continue a state page." })),
	limit: opt(
		int({
			minimum: 1,
			maximum: 16000,
			description: "Read: maximum UTF-16 units, default 8000. State: maximum rows, default 80.",
		}),
	),
	find: opt(text("Edit: an exact, unique, nonempty passage at rev.", 65536)),
	replace: opt(text("Edit: replacement for that passage. Empty deletes it.", 65536)),
	id: opt(text("Thread or composed view ID.", 128)),
	start: opt(int({ minimum: 0, description: "First UTF-16 unit, inclusive, at rev." })),
	end: opt(int({ minimum: 0, description: "Last UTF-16 boundary, exclusive, at rev." })),
	text: opt(text("Note, reply, or replacement text for a guarded range patch (start=end inserts).", 65536)),
	target: opt(
		obj({
			kind: choice(["file", "folder", "tab", "pane", "setting", "view"] as const),
			key: text("Exact target key. Empty folder key means root.", 4096),
		}),
	),
	query: opt(text("Literal search query.", 256)),
	kind: opt(choice(["paths", "text"] as const)),
	title: opt(text("Name of the composed tab.", 160)),
	blocks: opt(
		arr(
			obj({
				kind: choice(["text", "code", "location"] as const),
				text: text("Text or label; never markup.", 32768),
				doc: opt(text("Location: relative file or scratch ID.", 4096)),
				line: opt(int({ minimum: 1 })),
			}),
			{
				maxItems: 96,
				description: "Ordered parts of a composed view. Location buttons open their document and line.",
			},
		),
	),
});

export const editorToolDescription =
	"Work with people and other agents in one Editor folder. Join makes this conversation available in the editor without opening a pane. State lists shared drafts, threads and composed tabs; members lists connected conversations. Read the current draft (not just disk), then edit a unique passage or patch an exact UTF-16 range at that revision. New creates a draft; save explicitly writes to disk. Note anchors a thread to a UTF-16 range or a named target; thread reads it and reply posts back. Compose creates an interactive tab of text, code and file locations, or updates its exact id and rev. View reads a tab. Tree, search and git inspect the folder. Always use the root supplied with an invitation. No tool opens a pane or wakes another agent.";
