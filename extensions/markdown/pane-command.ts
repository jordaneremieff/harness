import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Version of the native reader's `--pane` mode that this slice runs. */
export const PANE_MODE = 1;

const BUILD_REMEDY = "Build it with node extensions/markdown/native/build.mts.";

/** A command that shows a stored document in the reader over its terminal pane, or why there is none. */
export type PaneCommand = { show: string[] } | { showUnavailable: string };

/**
 * The command that shows a stored document in the native reader over the terminal pane that
 * runs it. The installed app must declare contract 1 and pane mode 1 in its `build.json`;
 * otherwise the result names the reason and the build command instead of a command.
 */
export function paneCommand(app: string | undefined, root: string, documentId: string): PaneCommand {
	if (!app) return { showUnavailable: `No reader app is configured. ${BUILD_REMEDY}` };
	let build: unknown;
	try {
		build = JSON.parse(readFileSync(join(app, "Contents", "Resources", "build.json"), "utf8"));
	} catch {
		return { showUnavailable: `The reader app is not installed at ${app}. ${BUILD_REMEDY}` };
	}
	const manifest = typeof build === "object" && build !== null ? build as Record<string, unknown> : {};
	if (manifest.contract !== 1 || manifest.pane !== PANE_MODE) {
		return { showUnavailable: `The installed reader app cannot show documents in a pane. ${BUILD_REMEDY}` };
	}
	return { show: [join(app, "Contents", "MacOS", "MarkdownReader"), "--pane", "--store", root, documentId] };
}
