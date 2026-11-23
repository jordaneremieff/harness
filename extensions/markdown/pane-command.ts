import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Version of the native reader's `--pane` mode that this slice runs. */
export const PANE_MODE = 1;
/** The reader build still advertises terminal input support to older hosts. */
export const PANE_OPEN = 1;

/** Version of pinned open-request intake in pane mode. */
const PANE_OPEN_REQUEST = 1;
/** Version of the native pane's direct `--revision` and `--digest` inputs. */
export const PANE_REVISION = 1;
/** Version of the explicit native editor launch input. */
export const EDITOR_OPEN = 1;
export type EditorOpenIntent = "scratchpad" | "file" | "edit" | "copy";

const BUILD_REMEDY = "Build it with node extensions/markdown/native/build.mts.";

type PaneCommand = { show: string[] } | { showUnavailable: string };

/**
 * The command that shows a stored document in the native reader over the terminal pane that
 * runs it. The installed app must declare contract 1 and pane mode 1 in its `build.json`;
 * otherwise the result names the reason and the build command instead of a command.
 * A pinned command requires support for the exact revision and digest.
 */
export function paneCommand(
	app: string | undefined,
	root: string,
	documentId: string,
	pin?: { revision: number; digest: string },
): PaneCommand {
	if (!app) return { showUnavailable: `No reader app is configured. ${BUILD_REMEDY}` };
	let build: unknown;
	try {
		build = JSON.parse(readFileSync(join(app, "Contents", "Resources", "build.json"), "utf8"));
	} catch {
		return { showUnavailable: `The reader app is not installed at ${app}. ${BUILD_REMEDY}` };
	}
	const manifest = typeof build === "object" && build !== null ? (build as Record<string, unknown>) : {};
	if (manifest.contract !== 1 || manifest.pane !== PANE_MODE) {
		return { showUnavailable: `The installed reader app cannot show documents in a pane. ${BUILD_REMEDY}` };
	}
	const show = [join(app, "Contents", "MacOS", "MarkdownReader"), "--pane", "--store", root, documentId];
	if (!pin) return { show };
	if (manifest.paneRevision !== PANE_REVISION)
		return { showUnavailable: `The installed reader app cannot open an exact revision in a pane. ${BUILD_REMEDY}` };
	return { show: [...show, "--revision", String(pin.revision), "--digest", pin.digest] };
}

/** Opens a revision selected in an existing pinned request file. */
export function paneRequestCommand(app: string, request: string): PaneCommand {
	let build: unknown;
	try {
		build = JSON.parse(readFileSync(join(app, "Contents", "Resources", "build.json"), "utf8"));
	} catch {
		return { showUnavailable: `The reader app is not installed. ${BUILD_REMEDY}` };
	}
	const manifest = typeof build === "object" && build !== null ? (build as Record<string, unknown>) : {};
	if (manifest.contract !== 1 || manifest.pane !== PANE_MODE || manifest.paneOpenRequest !== PANE_OPEN_REQUEST)
		return { showUnavailable: `The reader app cannot accept a pinned request in a pane. ${BUILD_REMEDY}` };
	return { show: [join(app, "Contents", "MacOS", "MarkdownReader"), "--pane", request] };
}

/** Only a compatible installed app accepts an explicit editor action. Source content never supplies a command. */
export function editorCommand(
	app: string,
	root: string,
	intent: EditorOpenIntent,
	surface: "pane" | "window",
	input?: string,
	origin?: unknown,
): PaneCommand {
	let build: unknown;
	try {
		const path = join(app, "Contents", "Resources", "build.json");
		const info = lstatSync(path);
		if (!info.isFile() || info.size > 16384) throw new Error("Invalid app manifest");
		build = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { showUnavailable: `The editor app is missing or incomplete. ${BUILD_REMEDY}` };
	}
	const manifest = typeof build === "object" && build !== null ? (build as Record<string, unknown>) : {};
	if (
		manifest.contract !== 1 ||
		manifest.editorOpen !== EDITOR_OPEN ||
		(surface === "pane" && manifest.pane !== PANE_MODE)
	)
		return { showUnavailable: `The installed app cannot open an editor on this surface. ${BUILD_REMEDY}` };
	if ((intent === "scratchpad") !== (input === undefined))
		return { showUnavailable: "Scratchpad takes no input; file, edit and copy require an explicit input." };
	const show = [
		join(app, "Contents", "MacOS", "MarkdownReader"),
		"--editor",
		"--surface",
		surface,
		"--store",
		root,
		"--intent",
		intent,
	];
	if (origin !== undefined && origin !== null) {
		const value = JSON.stringify(origin);
		if (Buffer.byteLength(value) > 8192)
			return { showUnavailable: "The terminal return context exceeds the input limit." };
		show.push("--origin", value);
	}
	if (input !== undefined) show.push(input);
	return { show };
}
