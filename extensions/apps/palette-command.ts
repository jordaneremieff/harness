import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { type AppEntry, EXECUTABLE, listWith, paneLabel } from "./show.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const itemId = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 32);

/**
 * One step of the palette command: the first step asks which application to show, and the
 * second opens a pane beside the focused one that shows it.
 */
export async function paletteStep(
	args: string[],
	list: (executable: string) => Promise<AppEntry[]> = (executable) => listWith(executable),
) {
	const [app, json] = args;
	if (args.length !== 2 || !isAbsolute(app) || json.length > 16384)
		return { error: "The app pane request is invalid." };
	let request: unknown;
	try {
		request = JSON.parse(json);
	} catch {
		return { error: "The app pane request is invalid." };
	}
	if (
		!isRecord(request) ||
		request.version !== 1 ||
		request.command !== "apps.open" ||
		!isRecord(request.context) ||
		!Array.isArray(request.answers)
	)
		return { error: "The app pane request is invalid." };
	const executable = join(app, EXECUTABLE);
	let entries: AppEntry[];
	try {
		entries = await list(executable);
	} catch {
		return { error: "App Pane is not installed yet. Open Pi to build it, or run /apps update." };
	}
	const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
	if (request.answers.length === 0) {
		if (!entries.length) return { error: "App Pane found no applications." };
		return {
			ask: {
				kind: "pick",
				prompt: {
					title: "Show an app in a pane",
					items: entries.slice(0, 2000).map((entry) => ({
						id: itemId(entry.path),
						title: clean(entry.name),
						subtitle: clean(entry.running ? `Running · ${entry.path}` : entry.path),
					})),
				},
			},
		};
	}
	const [answer] = request.answers;
	const selected = entries.find((entry) => itemId(entry.path) === answer);
	if (!selected || request.answers.length !== 1) return { error: "That application is no longer available." };
	return { show: { argv: [executable, "--app", selected.path], label: paneLabel(selected.name), placement: "right" } };
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(await paletteStep(process.argv.slice(2)))}\n`);
