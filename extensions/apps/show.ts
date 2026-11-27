import { execFile } from "node:child_process";
import { join } from "node:path";
import { obj, opt, type Static, str } from "@earendil-works/pi-schema";

export const EXECUTABLE = "Contents/MacOS/AppPane";

export type AppEntry = { name: string; path: string; bundleIdentifier?: string; running: boolean; browser: boolean };
export type Resolution = { app?: AppEntry; candidates?: AppEntry[] };

export const ShowParameters = obj(
	{
		app: str({
			minLength: 1,
			maxLength: 1024,
			description:
				'Application name such as "Brave", "Slack" or "Notes", a bundle identifier, or an absolute .app path',
		}),
		url: opt(str({ minLength: 1, maxLength: 2048, description: "http or https address for a new browser window" })),
		window: opt(
			str({
				minLength: 1,
				maxLength: 256,
				description:
					"Text in the title of an existing window to show instead of a new browser window or the main window",
			}),
		),
	},
	{},
);
export type ShowInput = Static<typeof ShowParameters>;

export const SHOW_DESCRIPTION =
	"Prepare a terminal pane that shows a real macOS application window, such as a browser, Slack or an editor, docked to the pane. A browser gets a new window, at url when given. Another application shows its main window, or the window whose title contains window. The result names show, the argv of the pane program. This tool opens no pane.";
export const SHOW_SNIPPET = "Prepare a pane that shows a real macOS app window (browser, Slack, editor)";
export const SHOW_GUIDELINES = [
	"When the operator asks to open, show or put a macOS application in a pane, call apps_show, then use its exact show argv as the program of a new split to the right of your own pane, with no target, without taking focus, and with the pane set to close when its program ends, unless the operator names another placement.",
	"For a new tab in a browser window that apps_show opened, send :tab or :tab <http(s) URL> and Enter to that exact app pane, even when another window has focus. Check the pane's reply; do not use a system URL opener or keyboard shortcut. For page actions, use the browser tools on a tab in the browser window ID shown by the pane.",
];

export type ShowOutcome =
	| { ok: true; app: AppEntry; show: string[]; label: string }
	| { ok: false; error: string; candidates?: AppEntry[] };

export type ShowContext = {
	/** The installed App Pane bundle. */
	app: string;
	installed: () => Promise<boolean>;
	resolve: (executable: string, text: string, signal?: AbortSignal) => Promise<Resolution>;
	/** Starts an install when none is present and returns what the caller tells the agent. */
	install: () => string;
	signal?: AbortSignal;
};

/** An http or https address of at most 2,048 characters without whitespace or control characters. */
export function webAddress(value: string): boolean {
	if (value.length > 2048 || /[\s\p{Cc}]/u.test(value)) return false;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
	} catch {
		return false;
	}
}

/** The pane label: the application's name, at most 32 printable characters. */
export function paneLabel(name: string): string {
	const clean = Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim());
	return (clean.length > 32 ? `${clean.slice(0, 31).join("")}…` : clean.join("")) || "App";
}

/** Why the request cannot reach App Pane, before any application is looked up. */
function requestProblem(input: ShowInput): string | undefined {
	if (process.platform !== "darwin") return "App panes require macOS.";
	if (input.url !== undefined && input.window !== undefined) return "Use url or window, not both.";
	if (input.url !== undefined && !webAddress(input.url)) return "url must be an http or https address without spaces.";
	return undefined;
}

function unmatched(input: ShowInput, resolution: Resolution): ShowOutcome {
	if (resolution.candidates?.length)
		return {
			ok: false,
			error: `"${input.app}" matches several applications; name one of them exactly.`,
			candidates: resolution.candidates,
		};
	return { ok: false, error: `No application on this Mac matches "${input.app}".` };
}

export async function runShow(input: ShowInput, context: ShowContext): Promise<ShowOutcome> {
	const problem = requestProblem(input);
	if (problem) return { ok: false, error: problem };
	if (!(await context.installed())) return { ok: false, error: context.install() };
	const executable = join(context.app, EXECUTABLE);
	let resolution: Resolution;
	try {
		resolution = await context.resolve(executable, input.app.trim(), context.signal);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `App Pane could not look up applications: ${reason}` };
	}
	const found = resolution.app;
	if (!found) return unmatched(input, resolution);
	if (input.url !== undefined && !found.browser)
		return { ok: false, error: `${found.name} is not a browser that a pane can open at an address.` };
	const show = [executable, "--app", found.path];
	if (input.url !== undefined) show.push("--url", input.url);
	if (input.window !== undefined) show.push("--window", input.window.trim());
	return { ok: true, app: found, show, label: paneLabel(found.name) };
}

export function outcomeText(outcome: ShowOutcome): string {
	if (!outcome.ok) {
		const names = outcome.candidates?.map((entry) => `${entry.name} (${entry.path})`).join("; ");
		return names ? `${outcome.error} Candidates: ${names}.` : outcome.error;
	}
	const { app } = outcome;
	const created = app.browser && !outcome.show.includes("--window");
	const window = created ? "a new window of this browser" : "its main window, or the window that you named";
	return [
		`show: ${JSON.stringify(outcome.show)}`,
		`label: ${outcome.label}`,
		`${app.name} (${app.running ? "running" : "not running; the pane starts it"}). The pane shows ${window}. Closing the pane ${created ? "closes that window" : "puts the window back where it was"}; closing the window closes the pane.`,
		"Use show as the program of a new split to the right of your pane, set to close when its program ends, unless the operator asked for another placement.",
		...(created
			? ["Keep the new pane's ID. To open another tab, send :tab <http(s) URL> and Enter to that pane."]
			: []),
	].join("\n");
}

const isEntry = (value: unknown): value is AppEntry =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as AppEntry).name === "string" &&
	typeof (value as AppEntry).path === "string" &&
	(value as AppEntry).path.startsWith("/") &&
	typeof (value as AppEntry).running === "boolean" &&
	typeof (value as AppEntry).browser === "boolean" &&
	((value as AppEntry).bundleIdentifier === undefined || typeof (value as AppEntry).bundleIdentifier === "string");

/** Runs the installed program with arguments that print one JSON value, within five seconds. */
export function runJson(executable: string, args: string[], signal?: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile(
			executable,
			args,
			{ timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) },
			(error, stdout) => {
				if (error) return reject(error);
				try {
					resolve(JSON.parse(stdout));
				} catch {
					reject(new Error("App Pane printed no JSON."));
				}
			},
		);
	});
}

export async function resolveWith(executable: string, text: string, signal?: AbortSignal): Promise<Resolution> {
	const value = await runJson(executable, ["--resolve", text], signal);
	if (typeof value !== "object" || value === null) throw new Error("App Pane printed an invalid answer.");
	const { app, candidates } = value as Resolution;
	return {
		...(isEntry(app) ? { app } : {}),
		...(Array.isArray(candidates) ? { candidates: candidates.filter(isEntry).slice(0, 8) } : {}),
	};
}
