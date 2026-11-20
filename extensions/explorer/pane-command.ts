import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./live-protocol.ts";
import type { ReviewScope } from "./repository.ts";
import { readSettings } from "./settings.ts";

export interface LaunchTarget {
	root: string;
	path?: string;
	line?: number;
	end?: number;
	view?: "file" | "changes" | "notes";
	review?: ReviewScope;
	tour?: string;
	note?: string;
}
export const BUILD_COMMAND = "node extensions/explorer/native/build.mts";
export const BUILD_REMEDY = `The Explorer app is missing or incompatible. Run /explorer update, or run ${BUILD_COMMAND}.`;
export type PaneBuild = {
	paneOpen: boolean;
	live: boolean;
	ignoredOption: boolean;
	commit: string | null;
	dirty: boolean;
};
export type PaneLaunch =
	| { show: string[]; paneInput?: string; live: boolean }
	| { showUnavailable: string; build: string };

export async function readBuild(app: string): Promise<PaneBuild | undefined> {
	try {
		const file = await open(
			join(app, "Contents", "Resources", "build.json"),
			constants.O_RDONLY | constants.O_NONBLOCK,
		);
		let value: unknown;
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > 8192) return;
			const data = Buffer.alloc(8193);
			let length = 0;
			while (length < data.length) {
				const { bytesRead } = await file.read(data, length, data.length - length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > 8192) return;
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, length)));
		} finally {
			await file.close();
		}
		if (!isRecord(value) || value.contract !== 1 || value.pane !== 1) return;
		await access(join(app, "Contents", "MacOS", "Explorer"), constants.X_OK);
		const source = isRecord(value.source) ? value.source : {};
		return {
			paneOpen: value.paneOpen === 1,
			live: value.live === 1,
			ignoredOption: value.ignoredOption === 1,
			commit:
				typeof source.commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(source.commit)
					? source.commit
					: null,
			dirty: source.dirty === true,
		};
	} catch {
		return undefined;
	}
}

export function targetArgs(target: LaunchTarget): string[] {
	const args = ["--root", target.root];
	for (const name of ["path", "line", "end", "view", "review", "tour", "note"] as const) {
		const value = target[name];
		if (value !== undefined) args.push(`--${name}`, name === "review" ? JSON.stringify(value) : String(value));
	}
	return args;
}

export async function paneLaunch(
	app: string,
	store: string,
	target: LaunchTarget,
	agentDir: string,
): Promise<PaneLaunch> {
	const build = await readBuild(app);
	if (!build?.ignoredOption) return { showUnavailable: BUILD_REMEDY, build: BUILD_COMMAND };
	const args = targetArgs(target);
	const { showIgnored } = readSettings({ agentDir }).values;
	return {
		show: [
			join(app, "Contents", "MacOS", "Explorer"),
			"--pane",
			"--store",
			store,
			"--ignored",
			showIgnored ? "show" : "hide",
			...args,
		],
		live: build.live,
		...(build.paneOpen
			? {
					paneInput: `:open ${args.map((arg) => (/^[a-zA-Z0-9_./:@+-]+$/u.test(arg) ? arg : JSON.stringify(arg))).join(" ")}\r`,
				}
			: {}),
	};
}
