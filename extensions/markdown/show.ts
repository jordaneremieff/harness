import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROGRAM = fileURLToPath(import.meta.url);
export const SHOW_USAGE = [
	"Usage: node extensions/markdown/show.ts [--store <directory>] <document ID or unique prefix>",
	"Shows a stored Markdown document in this terminal and follows its new revisions.",
	"Keys: Up, Down, j and k scroll; Space, b, Page Up and Page Down page; g and G go to the start and end;",
	"o opens the shown revision in Markdown Reader; r reloads; q or Escape closes.",
	"Without --store, the markdown.dir setting selects the store.",
].join("\n");

/** The exact command that shows a stored document in a terminal: this Node runtime, this program, the store root and the document. */
export function showCommand(root: string, documentId: string): string[] {
	return [process.execPath, PROGRAM, "--store", root, documentId];
}

export type ShowArguments = { help: true } | { help: false; store?: string; document: string };
export function parseShowArgs(args: readonly string[]): ShowArguments {
	if (args.includes("--help") || args.includes("-h")) return { help: true };
	const rest = [...args];
	const storeAt = rest.indexOf("--store");
	const directory = storeAt < 0 ? undefined : rest.splice(storeAt, 2)[1];
	if (storeAt >= 0 && !directory) throw new Error("--store requires a directory.");
	const unknown = rest.find((value) => value.startsWith("-"));
	if (unknown) throw new Error(`Unknown option ${unknown}.`);
	if (rest.length > 1) throw new Error("Name one document.");
	const document = rest[0];
	if (!document) throw new Error("Name a document ID or unique prefix.");
	return { help: false, ...(directory === undefined ? {} : { store: resolve(directory) }), document };
}

export async function showMain(args = process.argv.slice(2)): Promise<void> {
	const parsed = parseShowArgs(args);
	if (parsed.help) {
		console.log(SHOW_USAGE);
		return;
	}
	// The terminal screen loads Pi's interface packages only when the program runs, never when a host imports the command.
	const { runShow } = await import("./show-screen.ts");
	await runShow(parsed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	void showMain().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
