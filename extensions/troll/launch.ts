import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isThinkingLevel, type TrollSettings } from "./settings.ts";

const captureProgram = fileURLToPath(new URL("../rex/terminal-origin.ts", import.meta.url));
const paneProgram = fileURLToPath(new URL("../rex/terminal-pane.ts", import.meta.url));
/** UTF-8 bytes of the opening message, the largest argument that the pane accepts. */
export const OPENING_LIMIT = 8192;
export const TROLL_FLAG = "troll";

export interface Origin {
	id: string;
	pid: number;
	name?: string;
}
/** The origin that the --troll flag carries: the session ID and the process that ran /troll. */
export function parseOriginFlag(value: unknown): { id: string; pid?: number } | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const at = value.lastIndexOf("@");
	const id = at < 0 ? value : value.slice(0, at);
	const pid = at < 0 ? undefined : Number(value.slice(at + 1));
	return { id, ...(pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
}
export type PaneOutcome = "created" | "stale" | "unavailable" | "uncertain";

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** The first executable named pi on PATH, as the operator's own terminals would start it. */
export function findPi(env: Readonly<Record<string, string | undefined>>): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		const candidate = join(dir, "pi");
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* Not an executable file in this directory. */
		}
	}
	return undefined;
}

/** A registered model, then an optional level, can precede the free-form instruction. */
export function parseTrollArgs(
	args: string,
	hasModel: (provider: string, modelId: string) => boolean,
): Pick<TrollSettings, "model" | "thinkingLevel"> & { instruction: string } {
	const text = args.trim();
	const match = /^([^/\s]+)[/](\S+)(?:\s+|$)/u.exec(text);
	if (!match || !hasModel(match[1], match[2])) return { instruction: text };
	const model = `${match[1]}/${match[2]}`;
	const rest = text.slice(match[0].length);
	const level = /^\S+/u.exec(rest)?.[0];
	return isThinkingLevel(level)
		? { model, thinkingLevel: level, instruction: rest.slice(level.length).trimStart() }
		: { model, instruction: rest };
}

/** The troll session's first message: where the operator ran /troll and the operator's own words. */
export function openingMessage(origin: Origin, instruction: string): string {
	const where = origin.name ? `session ${origin.id} ("${origin.name}")` : `session ${origin.id}`;
	return instruction
		? `The operator ran /troll in ${where}.\nInstruction: ${instruction}`
		: `The operator ran /troll in ${where} without an instruction.`;
}

export function trollArgv(program: string, origin: Origin, opening: string, settings: TrollSettings): string[] {
	return [
		program,
		"--unregistered",
		`--${TROLL_FLAG}`,
		`${origin.id}@${origin.pid}`,
		...(settings.model ? ["--model", settings.model] : []),
		...(settings.thinkingLevel ? ["--thinking", settings.thinkingLevel] : []),
		"--name",
		"Troll",
		"--",
		opening,
	];
}

/** Without a configured height, the pane is square; its width fraction stands in where Rex reports no size. */
export function paneBounds(settings: TrollSettings): { bounds: [number, number, number, number]; square: boolean } {
	return {
		bounds: [settings.left, settings.top, settings.width, settings.height ?? settings.width],
		square: settings.height === undefined,
	};
}

export type Helper = (program: string, verb: "capture" | "float", input?: object) => Promise<unknown>;

const runHelper: Helper = (program, verb, input) =>
	new Promise((resolve, reject) => {
		const child = execFile(process.execPath, [program, verb], { timeout: 7500, maxBuffer: 32768 }, (error, stdout) => {
			if (error) return reject(new Error("No terminal acknowledgement."));
			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(new Error("Invalid terminal acknowledgement."));
			}
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
	});

/**
 * Opens the troll session in a floating pane over the tab of the Rex pane that runs this process, through the
 * Rex-owned terminal-origin and terminal-pane helpers. One attempt; an unconfirmed pane is never retried.
 */
export async function openPane(
	request: { argv: string[]; cwd: string; bounds: [number, number, number, number]; square: boolean },
	helper: Helper = runHelper,
): Promise<{ outcome: PaneOutcome; detail: string }> {
	const origin = await helper(captureProgram, "capture").catch(() => null);
	if (!object(origin) || origin.version !== 1 || !object(origin.exact))
		return {
			outcome: "unavailable",
			detail: "Run /troll from a Pi pane in Rex. The troll opens in a floating pane of that tab.",
		};
	const { square, ...rest } = request;
	const result = await helper(paneProgram, "float", {
		version: 1,
		origin,
		...rest,
		...(square ? { square: true } : {}),
		label: "shell",
	}).catch(() => undefined);
	if (
		!object(result) ||
		!["created", "stale", "unavailable", "uncertain"].includes(result.outcome as string) ||
		typeof result.detail !== "string"
	)
		return {
			outcome: "uncertain",
			detail: "Rex did not confirm the troll pane. Look at the tab before you run /troll again.",
		};
	return { outcome: result.outcome as PaneOutcome, detail: result.detail };
}
