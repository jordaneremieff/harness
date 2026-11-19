import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
		usage: "/explorer changes [uncommitted|branch|since-review|<commit>|<base>..<head>]",
		description:
			"Open a review. The default is uncommitted changes when present; otherwise review since your last review on the default branch, or compare this branch with the default branch.",
	},
	notes: { usage: "/explorer notes", description: "Open the repository's Notes list." },
	update: { usage: "/explorer update", description: "Build and install the native app in the background." },
	help: { usage: "/explorer help [topic]", description: "Show command usage." },
} as const;
export function commandHelp(topic: string): string {
	const valid = Object.hasOwn(help, topic);
	const rows = valid ? [help[topic as keyof typeof help]] : Object.values(help);
	return rows.map(({ usage, description }) => `${usage}  ${description}`).join("\n");
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
	if (process.platform !== "darwin") throw new Error("The native Explorer pane requires macOS.");
	const origin = await adapter("capture", signal).catch(() => null);
	signal.throwIfAborted();
	if (!isRecord(origin) || origin.version !== 1 || origin.terminal !== "Rex" || !isRecord(origin.exact))
		throw new Error("No exact Rex pane is available for this conversation.");
	const target = await commandTarget(input, cwd, dir);
	const launch = await paneLaunch(app, dir, target);
	if ("showUnavailable" in launch) throw new Error(launch.showUnavailable);
	if (!launch.live) throw new Error("The installed app does not support live panes. Run /explorer update.");
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
		throw new Error("Explorer pane creation is unconfirmed. Check the Rex tab before another attempt.");
	}
	if (receipt.outcome === "stale" || receipt.outcome === "unavailable") await capability.remove();
	if (receipt.outcome !== "created" || !receipt.receipt)
		throw new Error(typeof receipt.detail === "string" ? receipt.detail : "Explorer pane creation is unconfirmed.");
}
