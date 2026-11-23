import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionContext, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ConfigBridge } from "./bridge.ts";
import { isObject } from "./json.ts";

const packageRoot = new URL("../../", import.meta.url);
const adapters = {
	capture: fileURLToPath(new URL("extensions/rex/terminal-origin.ts", packageRoot)),
	split: fileURLToPath(new URL("extensions/rex/terminal-pane.ts", packageRoot)),
};
export const BUILD_COMMAND = "node extensions/config/native/build.mts install";

const help = {
	open: {
		usage: "/config [words]",
		description: "Open Config beside this conversation, searching for the words.",
	},
	update: {
		usage: "/config update",
		description: "Build and install the Config app from the loaded checkout.",
	},
	help: { usage: "/config help", description: "Show these forms." },
} as const;
export function commandHelp(): string {
	return Object.values(help)
		.map(({ usage, description }) => `${usage}  ${description}`)
		.join("\n");
}
export async function showCommandHelp(ctx: Pick<ExtensionContext, "mode" | "ui">): Promise<void> {
	if (ctx.mode !== "tui") return ctx.ui.notify(commandHelp(), "info");
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const text = Object.values(help)
			.map(({ usage, description }) => `${usage}\n  ${description}`)
			.join("\n");
		let offset = 0;
		let lastOffset = 0;
		return {
			invalidate() {},
			render(width) {
				const rows = truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines;
				const height = Math.max(1, Math.min(8, tui.terminal.rows - 3));
				lastOffset = Math.max(0, rows.length - height);
				offset = Math.min(offset, lastOffset);
				return [
					theme.bold(truncateToWidth("Config help", width)),
					...rows.slice(offset, offset + height),
					theme.fg("muted", truncateToWidth(lastOffset ? "↑/↓ scroll · esc close" : "esc close", width)),
				];
			},
			handleInput(data) {
				if (matchesKey(data, "escape")) done();
				else if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
				else if (matchesKey(data, "down")) offset = Math.min(lastOffset, offset + 1);
				else return;
				tui.requestRender();
			},
		};
	});
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
export async function openConfig(options: {
	app: string;
	cwd: string;
	query?: string;
	bridge: ConfigBridge;
	signal: AbortSignal;
}): Promise<OpenResult> {
	if (options.bridge.reveal(options.query))
		return { outcome: "revealed", detail: "Config is already open for this conversation; it moved to the front." };
	if (process.platform !== "darwin") throw new Error("The Config app needs macOS. The config_* tools work everywhere.");
	const executable = join(options.app, "Contents", "MacOS", "Config");
	try {
		await access(executable, constants.X_OK);
	} catch {
		throw new Error(`The Config app is not installed at ${options.app}. Run /config update.`);
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
		label: "Config",
	}).catch(() => null);
	if (
		!isObject(receipt) ||
		receipt.version !== 1 ||
		!["created", "stale", "unavailable", "uncertain"].includes(String(receipt.outcome))
	)
		throw new Error("Config pane creation is unconfirmed. Check the Rex tab before another attempt.");
	if (receipt.outcome === "stale" || receipt.outcome === "unavailable") await capability.remove();
	if (receipt.outcome !== "created")
		throw new Error(typeof receipt.detail === "string" ? receipt.detail : "Config pane creation is unconfirmed.");
	return { outcome: "created", detail: "Config opened beside this conversation." };
}
