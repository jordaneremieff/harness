import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type KeyId,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { liveArguments } from "./live-launch.ts";
import { isRecord, type LiveConfig } from "./live-protocol.ts";
import { NotesStore } from "./notes-store.ts";
import { type LaunchTarget, paneLaunch } from "./pane-command.ts";
import { defaultScope, type ReviewScope, resolveTarget } from "./repository.ts";
import { checkedScope, pinnedReview, reviewInput } from "./tools.ts";

const help = {
	path: {
		usage: "/explorer [path]",
		description:
			"Open your working directory, a repository, a folder or a file. Quote a path to distinguish it from a command name.",
	},
	changes: {
		usage: "/explorer changes [uncommitted|branch|since-review|<commit>|<base>..<head>|<target>...<head>]",
		description:
			"Open a review. The default is uncommitted changes when present; otherwise review since your last review on the default branch, or compare this branch with the default branch. Three dots compare the head with its merge base.",
	},
	notes: { usage: "/explorer notes", description: "Open the repository's Notes list." },
	update: { usage: "/explorer update", description: "Build and install the native app in the background." },
	help: { usage: "/explorer help [topic]", description: "Show command usage." },
} as const;
export class ExplorerRefusal extends Error {}

export function commandHelp(topic: string, compact = false): string {
	if (topic && !Object.hasOwn(help, topic))
		throw new ExplorerRefusal(`Use /explorer help ${Object.keys(help).join(" | ")}.`);
	const rows = topic ? [help[topic as keyof typeof help]] : Object.values(help);
	return rows
		.map(({ usage, description }) => `${usage}${compact ? "  " : "\n"}${description}`)
		.join(compact ? "\n" : "\n\n");
}

function safeReport(text: string) {
	return stripTerminalSequences(text).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : " ",
	);
}

export function noticeText(text: string) {
	return safeReport(text).replace(/\s+/gu, " ").trim();
}

export async function showCommandReport(
	ui: Pick<ExtensionContext["ui"], "custom">,
	title: string,
	text: string,
	signal: AbortSignal,
) {
	if (signal.aborted) return;
	const body = safeReport(text).replaceAll("\t", "   ");
	await ui.custom<void>((tui, theme, _keys, done) => {
		let offset = 0;
		let total = 0;
		let page = 1;
		const close = () => done();
		signal.addEventListener("abort", close, { once: true });
		return {
			capturesViewportInput: true,
			invalidate() {},
			dispose: () => signal.removeEventListener("abort", close),
			render(width: number) {
				const rows = wrapTextWithAnsi(body, Math.max(1, width));
				page = Math.max(1, Math.min(12, tui.terminal.rows - 4));
				total = rows.length;
				offset = Math.min(offset, Math.max(0, total - page));
				const keys =
					total > page
						? `${offset + 1}–${Math.min(total, offset + page)} of ${total} · pgup/pgdn read · esc close`
						: "esc close";
				const clip = (value: string) => stripTerminalSequences(truncateToWidth(value, width, "…"));
				return [
					theme.fg("accent", theme.bold(clip(title))),
					...rows.slice(offset, offset + page),
					theme.fg("muted", clip(keys)),
				];
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) return close();
				const moves: [KeyId, number][] = [
					[Key.pageUp, -page],
					[Key.pageDown, page],
					[Key.up, -1],
					[Key.down, 1],
				];
				const step = moves.find(([key]) => matchesKey(data, key))?.[1];
				if (!step) return;
				offset = Math.max(0, Math.min(Math.max(0, total - page), offset + step));
				tui.requestRender();
			},
		};
	});
}
export function completions(prefix: string) {
	const spaced = prefix.trimStart();
	const mode = spaced.startsWith("help ") ? "help" : spaced.startsWith("changes ") ? "changes" : undefined;
	const options =
		mode === "changes"
			? [
					["uncommitted", "Compare HEAD with the working tree"],
					["branch", "Compare this branch with the default branch"],
					["since-review", "Compare with the last finished review"],
				]
			: Object.entries(help).map(([key, value]) => [key, value.description]);
	const match = mode ? spaced.slice(mode.length + 1) : spaced;
	const choices = options
		.filter(([key]) => key.startsWith(match))
		.map(([key, description]) => ({
			value: mode ? `${mode} ${key}` : key === "path" ? "" : key,
			label: key === "path" && !mode ? "<path>" : key,
			description,
		}));
	return choices.length ? choices : null;
}
export function commandInput(args: string): { mode: "open" | "notes" | "changes" | "update" | "help"; value?: string } {
	const text = args.trim();
	if (text === "notes" || text === "update") return { mode: text };
	const match = /^(help|changes)(?:\s+(.*))?$/su.exec(text);
	if (match) return { mode: match[1] === "help" ? "help" : "changes", value: match[2]?.trim() };
	let value = text;
	if (text.startsWith('"') || text.endsWith('"')) {
		try {
			value = JSON.parse(text);
		} catch {
			throw new Error("An Explorer path has an unclosed quote or invalid escape.");
		}
	}
	if (value === "~" || value.startsWith("~/")) value = `${homedir()}${value.slice(1)}`;
	return { mode: "open", ...(value ? { value } : {}) };
}

export function commandScope(value: string): ReviewScope {
	if (value === "uncommitted" || value === "branch" || value === "since-review") return { kind: value };
	return reviewInput(value.includes("..") ? { range: value } : { commit: value });
}
const packageRoot = new URL("../../", import.meta.url);
const adapters = {
	capture: fileURLToPath(new URL("extensions/rex/terminal-origin.ts", packageRoot)),
	split: fileURLToPath(new URL("extensions/rex/terminal-pane.ts", packageRoot)),
};
function adapter(action: keyof typeof adapters, signal: AbortSignal, input?: unknown) {
	return new Promise<unknown>((resolve, reject) => {
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
				else {
					try {
						resolve(JSON.parse(stdout));
					} catch (error) {
						reject(error);
					}
				}
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
	});
}
export function ordinaryLifecycle(pi: Pick<ExtensionAPI, "on">): () => AbortSignal {
	let controller = new AbortController();
	const withdraw = () => {
		controller.abort();
		controller = new AbortController();
	};
	pi.on("session_before_switch", withdraw);
	pi.on("session_before_fork", withdraw);
	pi.on("session_before_tree", withdraw);
	pi.on("session_shutdown", withdraw);
	return () => controller.signal;
}
async function commandTarget(input: ReturnType<typeof commandInput>, cwd: string, dir: string): Promise<LaunchTarget> {
	const { repo, path } = await resolveTarget(input.mode === "open" ? input.value : undefined, cwd);
	const store = new NotesStore(dir, repo);
	const target: LaunchTarget = { root: repo.root, path };
	if (input.mode === "notes") target.view = "notes";
	if (input.mode === "changes") {
		const scope = input.value ? commandScope(input.value) : await defaultScope(repo);
		target.review = pinnedReview(await checkedScope(repo, store, scope));
		target.view = "changes";
		delete target.path;
	}
	return target;
}
export async function openExplorer(
	input: ReturnType<typeof commandInput>,
	options: {
		cwd: string;
		app: string;
		dir: string;
		agentDir: string;
		signal: AbortSignal;
		connect: () => Promise<LiveConfig>;
	},
) {
	const { app, dir, agentDir, cwd, signal } = options;
	if (process.platform !== "darwin") throw new ExplorerRefusal("The native Explorer pane requires macOS.");
	const origin = await adapter("capture", signal).catch(() => null);
	signal.throwIfAborted();
	if (!isRecord(origin) || origin.version !== 1 || origin.terminal !== "Rex" || !isRecord(origin.exact))
		throw new ExplorerRefusal("Explorer found no exact Rex pane for this conversation.");
	const target = await commandTarget(input, cwd, dir);
	const launch = await paneLaunch(app, dir, target, agentDir);
	if ("showUnavailable" in launch) throw new ExplorerRefusal(launch.showUnavailable);
	if (!launch.live)
		throw new ExplorerRefusal("The installed Explorer app does not support live panes; use /explorer update.");
	signal.throwIfAborted();
	const capability = await liveArguments(launch.show, await options.connect(), agentDir);
	const receipt = await adapter("split", signal, {
		version: 1,
		origin,
		argv: capability.argv,
		cwd,
		label: "Explorer",
	}).catch(() => null);
	if (
		!isRecord(receipt) ||
		receipt.version !== 1 ||
		!["created", "stale", "unavailable", "uncertain"].includes(String(receipt.outcome))
	) {
		throw new ExplorerRefusal("Explorer pane creation is unconfirmed; check the Rex tab before another attempt.");
	}
	if (receipt.outcome === "stale" || receipt.outcome === "unavailable") await capability.remove();
	if (receipt.outcome !== "created" || !receipt.receipt)
		throw new ExplorerRefusal(
			typeof receipt.detail === "string" ? receipt.detail : "Explorer pane creation is unconfirmed.",
		);
}
