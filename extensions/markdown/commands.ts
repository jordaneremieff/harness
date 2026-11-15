import type { AutocompleteItem } from "@earendil-works/pi-tui";

const notes = {
	recent: { usage: "/markdown recent", description: "Browse recent response previews. Only Read opens the selected response." },
	published: { usage: "/markdown published", description: "Browse published documents. Only Read opens the selected revision." },
	file: { usage: "/markdown file <path>", description: "Capture and read a UTF-8 Markdown file. Resolve relative paths from the session directory; expand a leading ~. Quote a path with spaces." },
	window: { usage: "/markdown window [file <path> | <id or unique prefix>]", description: "Read in a separate Mac window, without a Rex pane. No argument reads the latest retained response. This form is explicit; pane failures never select it." },
	id: { usage: "/markdown <id or unique prefix>", description: "Read a stored document by ID. Copy an ID from Published; a unique prefix needs at least six characters, including md-." },
} as const;
type Topic = keyof typeof notes;
const topics = Object.keys(notes) as Topic[];
export const MARKDOWN_USAGE = "Usage: /markdown recent | published | <id> | file <path> | window [file <path> | <id>] | help [command]";

export function markdownHelp(topic = ""): string {
	if (!topic) return ["/markdown reads the latest retained assistant response on this branch beside this conversation in the same Rex tab.", ...topics.map((key) => `${notes[key].usage}\n  ${notes[key].description}`), "/markdown help <recent|published|file|id|window> shows one command's usage."].join("\n");
	if (!topics.includes(topic as Topic)) throw new Error("Use /markdown help recent | published | file | id | window.");
	const note = notes[topic as Topic];
	return `${note.usage}\n${note.description}`;
}

function windowCompletions(prefix: string): AutocompleteItem[] {
	const argument = prefix.slice(7);
	if (argument.startsWith("file ")) return [{ value: prefix, label: "window file <path>", description: notes.file.description }];
	if (argument.startsWith("md-")) return [{ value: prefix, label: "window <id or unique prefix>", description: notes.id.description }];
	return [{ value: prefix, label: "window [file <path> | <id>]", description: notes.window.description }, ...("file".startsWith(argument) ? [{ value: "window file ", label: "window file <path>", description: notes.file.description }] : [])];
}

/** Values replace the complete argument prefix. Usage labels never become invented paths or IDs. */
export function markdownCompletions(prefix: string): AutocompleteItem[] | null {
	if (prefix.startsWith("help ")) {
		const query = prefix.slice(5);
		const items = topics.filter((topic) => topic.startsWith(query)).map((topic) => ({ value: `help ${topic}`, label: `help ${topic}`, description: notes[topic].description }));
		return items.length ? items : null;
	}
	if (prefix.startsWith("window ")) return windowCompletions(prefix);
	if (prefix.startsWith("file ")) return [{ value: prefix, label: "file <path>", description: notes.file.description }];
	if (prefix.startsWith("md-")) return [{ value: prefix, label: "<id or unique prefix>", description: notes.id.description }];
	const options: AutocompleteItem[] = [
		{ value: "recent", label: "recent", description: notes.recent.description },
		{ value: "published", label: "published", description: notes.published.description },
		{ value: "file ", label: "file <path>", description: notes.file.description },
		{ value: "window ", label: "window [file <path> | <id>]", description: notes.window.description },
		{ value: "help", label: "help [command]", description: "Show usage and individual notes for recent, published, file, ID and window forms." },
	];
	const items = options.filter((item) => item.value.startsWith(prefix));
	return items.length ? items : null;
}
