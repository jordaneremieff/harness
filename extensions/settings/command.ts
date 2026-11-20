import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SettingsBridge } from "./bridge.ts";
import { isObject } from "./json.ts";

const packageRoot = new URL("../../", import.meta.url);
const adapters = {
	capture: fileURLToPath(new URL("extensions/rex/terminal-origin.ts", packageRoot)),
	split: fileURLToPath(new URL("extensions/rex/terminal-pane.ts", packageRoot)),
};
export const BUILD_COMMAND = "node extensions/settings/native/build.mts install";

const help = {
	open: {
		usage: "/harness-settings [words]",
		description: "Open Settings beside this conversation, searching for the words.",
	},
	update: {
		usage: "/harness-settings update",
		description: "Build and install the Settings app from the loaded checkout.",
	},
	help: { usage: "/harness-settings help", description: "Show these forms." },
} as const;
export function commandHelp(): string {
	return Object.values(help)
		.map(({ usage, description }) => `${usage}  ${description}`)
		.join("\n");
}
export function commandInput(args: string): { mode: "open" | "update" | "help"; query?: string } {
	const text = args.trim().replace(/[\p{Cc}\p{Cf}]/gu, " ");
	if (text === "update" || text === "help") return { mode: text };
	return { mode: "open", ...(text ? { query: text.slice(0, 200) } : {}) };
}
export function completions(prefix: string) {
	const options = [
		["update", help.update.description],
		["help", help.help.description],
	].filter(([value]) => value.startsWith(prefix.trim()));
	return options.length ? options.map(([value, description]) => ({ value, label: value, description })) : null;
}

function adapter(action: keyof typeof adapters, signal: AbortSignal, input?: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			process.execPath,
			[adapters[action], action],
			{
				timeout: action === "capture" ? 4000 : 7000,
				maxBuffer: 32768,
				encoding: "utf8",
				killSignal: "SIGKILL",
				signal,
			},
			(error, stdout) => {
				if (error) reject(error);
				else
					try {
						resolve(JSON.parse(stdout));
					} catch (parseError) {
						reject(parseError);
					}
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
	});
}

export type OpenResult = { outcome: "revealed" | "created"; detail: string };

/**
 * Opens the app in a Rex split beside the invoking conversation. One creation attempt at
 * most: an unconfirmed result is reported, never retried or replaced.
 */
export async function openSettings(options: {
	app: string;
	cwd: string;
	query?: string;
	bridge: SettingsBridge;
	signal: AbortSignal;
}): Promise<OpenResult> {
	if (options.bridge.reveal(options.query))
		return { outcome: "revealed", detail: "Settings is already open for this conversation; it moved to the front." };
	if (process.platform !== "darwin")
		throw new Error("The Settings app needs macOS. The settings_* tools work everywhere.");
	const executable = join(options.app, "Contents", "MacOS", "Settings");
	try {
		await access(executable, constants.X_OK);
	} catch {
		throw new Error(`The Settings app is not installed at ${options.app}. Run /harness-settings update.`);
	}
	const origin = await adapter("capture", options.signal).catch(() => null);
	options.signal.throwIfAborted();
	if (!isObject(origin) || origin.version !== 1 || origin.terminal !== "Rex" || !isObject(origin.exact))
		throw new Error("No exact Rex pane is available for this conversation.");
	const capability = await options.bridge.capability();
	const argv = [executable, "--live", capability.path, ...(options.query ? ["--query", options.query] : [])];
	const receipt = await adapter("split", options.signal, {
		version: 1,
		origin,
		argv,
		cwd: options.cwd,
		label: "Settings",
	}).catch(() => null);
	if (
		!isObject(receipt) ||
		receipt.version !== 1 ||
		!["created", "stale", "unavailable", "uncertain"].includes(String(receipt.outcome))
	)
		throw new Error("Settings pane creation is unconfirmed. Check the Rex tab before another attempt.");
	if (receipt.outcome === "stale" || receipt.outcome === "unavailable") await capability.remove();
	if (receipt.outcome !== "created")
		throw new Error(typeof receipt.detail === "string" ? receipt.detail : "Settings pane creation is unconfirmed.");
	return { outcome: "created", detail: "Settings opened beside this conversation." };
}
