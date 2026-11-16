import type { AutocompleteItem } from "@earendil-works/pi-tui";

const notes = {
	new: { usage: "/markdown new", description: "Open a blank private scratchpad beside this conversation. No title, file destination or model turn is required." },
	recent: { usage: "/markdown recent", description: "Browse recent response previews. Read preserves the response; Edit a Copy creates a private editing session." },
	published: { usage: "/markdown published", description: "Browse published documents. Read opens the selected revision; Edit prepares an explicit revision save." },
	edit: { usage: "/markdown edit <id or unique prefix> | edit file <path>", description: "Edit a published document, or explicitly edit a local Markdown file. Save is separate from opening. Captured responses and snapshots require copy." },
	copy: { usage: "/markdown copy <id or unique prefix>", description: "Edit a separate copy of the selected stored source. The original captured record stays unchanged." },
	file: { usage: "/markdown file <path>", description: "Capture and read a UTF-8 Markdown file without editing it. Resolve relative paths from the session directory; expand a leading ~. Quote a path with spaces." },
	window: { usage: "/markdown window [new | edit <id> | edit file <path> | copy <id> | file <path> | <id>]", description: "Use a separate Mac window, without a Rex pane. No argument reads the latest retained response. This form is explicit; pane failures never select it." },
	id: { usage: "/markdown <id or unique prefix>", description: "Read a stored document by ID. Copy an ID from Published; a unique prefix needs at least six characters, including md-." },
} as const;
type Topic = keyof typeof notes;
const topics = Object.keys(notes) as Topic[];
export const MARKDOWN_USAGE = "Usage: /markdown new | recent | published | edit <id> | edit file <path> | copy <id> | <id> | file <path> | window [new|edit|copy|file|<id>] | help [command]";

export function markdownHelp(topic = ""): string {
	if (!topic) return ["/markdown reads the latest retained assistant response on this branch beside this conversation in the same Rex tab.", ...topics.map((key) => `${notes[key].usage}\n  ${notes[key].description}`), `/markdown help <${topics.join("|")}> shows one command's usage.`].join("\n");
	if (!topics.includes(topic as Topic)) throw new Error(`Use /markdown help ${topics.join(" | ")}.`);
	const note = notes[topic as Topic];
	return `${note.usage}\n${note.description}`;
}
function inputCompletions(prefix: string): AutocompleteItem[] | undefined {
	if (prefix.startsWith("file ")) return [{ value: prefix, label: "file <path>", description: notes.file.description }];
	if (prefix.startsWith("edit file ")) return [{ value: prefix, label: "edit file <path>", description: notes.edit.description }];
	if (prefix.startsWith("edit ")) return [{ value: prefix, label: "edit <id or unique prefix>", description: notes.edit.description }, ...("file".startsWith(prefix.slice(5)) ? [{ value: "edit file ", label: "edit file <path>", description: notes.edit.description }] : [])];
	if (prefix.startsWith("copy ")) return [{ value: prefix, label: "copy <id or unique prefix>", description: notes.copy.description }];
	if (prefix.startsWith("md-")) return [{ value: prefix, label: "<id or unique prefix>", description: notes.id.description }];
	return undefined;
}
function windowCompletions(prefix: string): AutocompleteItem[] {
	const argument = prefix.slice(7);
	const inputs = inputCompletions(argument);
	if (inputs) return inputs.map((item) => ({ ...item, value: `window ${item.value}`, label: `window ${item.label}` }));
	return [{ value: prefix, label: "window [new | edit <id> | copy <id> | file <path> | <id>]", description: notes.window.description }, ...["new", "edit", "copy", "file"].filter((name) => name.startsWith(argument)).map((name) => ({ value: `window ${name}${name === "new" ? "" : " "}`, label: `window ${name}${name === "edit" || name === "copy" ? " <id>" : name === "file" ? " <path>" : ""}`, description: notes[name as Topic].description }))];
}

/** Values replace the complete argument prefix. Usage labels never become invented paths or IDs. */
export function markdownCompletions(prefix: string): AutocompleteItem[] | null {
	if (prefix.startsWith("help ")) {
		const query = prefix.slice(5);
		const items = topics.filter((topic) => topic.startsWith(query)).map((topic) => ({ value: `help ${topic}`, label: `help ${topic}`, description: notes[topic].description }));
		return items.length ? items : null;
	}
	if (prefix.startsWith("window ")) return windowCompletions(prefix);
	const inputs = inputCompletions(prefix);
	if (inputs) return inputs;
	const options: AutocompleteItem[] = [
		...(["new", "recent", "published", "edit", "copy", "file", "window"] as const).map((name) => ({ value: `${name}${["edit", "copy", "file", "window"].includes(name) ? " " : ""}`, label: name === "edit" || name === "copy" ? `${name} <id>` : name === "file" ? "file <path>" : name === "window" ? "window [command]" : name, description: notes[name].description })),
		{ value: "help", label: "help [command]", description: "Show complete usage or one command's notes." },
	];
	const items = options.filter((item) => item.value.startsWith(prefix));
	return items.length ? items : null;
}
