import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** One command that an extension offers in the Rex palette, as docs/conventions/palette-commands.md defines it. */
export interface PaletteCommand {
	id: string;
	title: string;
	description?: string;
	argv: string[];
}
interface RecordedCommand extends PaletteCommand {
	source: string;
}
/** What the Rex-side runtime reads: every recorded command, and the stacking offer for the panes it opens. */
export interface PaletteRegistry {
	version: 1;
	commands: RecordedCommand[];
	paneStacking?: string[];
}

/** Without underscores, so `pi_<source>_<name>` names exactly one command. */
const SOURCE = /^[a-z][a-z0-9]{0,23}$/;
const NAME = /^[a-z][a-z0-9_]*$/;
const PLAIN = /^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u;

export function paletteRegistryPath(agentDir: string): string {
	return join(agentDir, "rex", "palette.json");
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const text = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && [...value].length <= max && PLAIN.test(value);

function validCommand(source: string, value: unknown): PaletteCommand | undefined {
	const command = object(value);
	const { id, title, description, argv } = command;
	if (
		typeof id !== "string" ||
		id.length > 48 ||
		!id.startsWith(`${source}.`) ||
		!NAME.test(id.slice(source.length + 1))
	)
		return undefined;
	if (!text(title, 64) || (description !== undefined && !text(description, 200))) return undefined;
	if (!Array.isArray(argv) || argv.length < 1 || argv.length > 16) return undefined;
	// Array.from visits every index, so a sparse list fails instead of passing with a hole.
	const words = Array.from(argv as unknown[]);
	if (
		!words.every((word) => typeof word === "string" && word.length <= 4096 && !word.includes("\0")) ||
		!isAbsolute(words[0] as string)
	)
		return undefined;
	return {
		id,
		title: title.trim(),
		...(description === undefined ? {} : { description: description.trim() }),
		argv: words as string[],
	};
}

/** The commands of one publication that meet the contract; a command that does not is left out. */
export function publishedCommands(publication: unknown): { source: string; commands: PaletteCommand[] } | undefined {
	const value = object(publication);
	if (
		value.version !== 1 ||
		typeof value.source !== "string" ||
		!SOURCE.test(value.source) ||
		!Array.isArray(value.commands)
	)
		return undefined;
	const source = value.source;
	const commands = new Map<string, PaletteCommand>();
	for (const item of value.commands) {
		const command = validCommand(source, item);
		if (command && !commands.has(command.id)) commands.set(command.id, command);
	}
	return { source, commands: [...commands.values()] };
}

/** The recorded registry, or nothing when it is absent or not of this shape. */
export function readPaletteRegistry(path: string): PaletteRegistry | undefined {
	let value: Record<string, unknown>;
	try {
		value = object(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
	if (value.version !== 1 || !Array.isArray(value.commands)) return undefined;
	const commands = value.commands.flatMap((item) => {
		const source = object(item).source;
		const command = typeof source === "string" && SOURCE.test(source) ? validCommand(source, item) : undefined;
		return command ? [{ ...command, source: source as string }] : [];
	});
	const stacking = value.paneStacking;
	const paneStacking =
		Array.isArray(stacking) &&
		stacking.length === 2 &&
		stacking.every((word) => typeof word === "string" && isAbsolute(word))
			? (stacking as string[])
			: undefined;
	return { version: 1, commands, ...(paneStacking ? { paneStacking } : {}) };
}

function realPath(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
}

function insidePackage(root: string | undefined, path: string): boolean {
	const target = realPath(path);
	if (root === undefined || target === undefined) return false;
	const local = relative(root, target);
	return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

/**
 * Each heard source replaces its commands. An unheard command stays while its program exists and any absolute
 * first argument resolves to an existing path inside this package.
 */
export function mergePalette(
	existing: PaletteRegistry | undefined,
	heard: ReadonlyMap<string, readonly PaletteCommand[]>,
	paneStacking: string[] | undefined,
	packageRoot: string,
	exists: (path: string) => boolean = existsSync,
): PaletteRegistry {
	const root = realPath(packageRoot);
	const commands = new Map<string, RecordedCommand>();
	for (const command of existing?.commands ?? []) {
		const [program, first] = command.argv;
		if (
			!heard.has(command.source) &&
			exists(program as string) &&
			(first === undefined || !isAbsolute(first) || insidePackage(root, first))
		)
			commands.set(command.id, command);
	}
	for (const [source, list] of heard) for (const command of list) commands.set(command.id, { ...command, source });
	return {
		version: 1,
		commands: [...commands.values()].sort((a, b) => a.id.localeCompare(b.id)),
		...(paneStacking ? { paneStacking } : {}),
	};
}

/** Replace the registry in one rename when its content changes. Returns whether it changed. */
export function writePaletteRegistry(path: string, registry: PaletteRegistry): boolean {
	const content = `${JSON.stringify(registry, null, 2)}\n`;
	try {
		if (readFileSync(path, "utf8") === content) return false;
	} catch {
		/* Absent or unreadable: write it. */
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
	return true;
}

// `open(2)` on macOS takes a flock-style exclusive lock atomically with O_EXLOCK.
const O_EXLOCK = 0x20;

/**
 * Run `update` while this process holds the registry's lock, so a read, merge and replacement never interleave with
 * another writer's. One attempt: a contended lock skips the update, because the writer that holds it records the
 * same publications in an ordinary start.
 */
export function withRegistryLock(path: string, update: () => void): boolean {
	if (process.platform !== "darwin") throw new Error("Recording Pi's palette commands needs macOS file locks.");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lockPath = `${path}.lock`;
	let fd: number;
	try {
		fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EAGAIN") return false;
		throw error;
	}
	try {
		const held = fstatSync(fd);
		let named: ReturnType<typeof statSync>;
		try {
			named = statSync(lockPath);
		} catch {
			return false;
		}
		// A path that names another file belongs to a successor; acting under it would not exclude anybody.
		if (named.dev !== held.dev || named.ino !== held.ino) return false;
		try {
			update();
		} finally {
			rmSync(lockPath, { force: true });
		}
		return true;
	} finally {
		closeSync(fd);
	}
}

/**
 * Whether Pi's global settings load the package at `packageRoot`. A trial that loads a checkout with `-e` is not
 * loaded this way, so it never points the operator's palette at code that can disappear.
 */
export function configuredPackage(agentDir: string, packageRoot: string): boolean {
	let settings: Record<string, unknown>;
	try {
		settings = object(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")));
	} catch {
		return false;
	}
	const root = realPath(packageRoot);
	const sources = Array.isArray(settings.packages) ? settings.packages : [];
	return (
		root !== undefined &&
		sources.some((entry) => {
			const source = typeof entry === "string" ? entry : object(entry).source;
			return (
				typeof source === "string" &&
				(source.startsWith(".") || source.startsWith("/") || source.startsWith("~")) &&
				realPath(resolve(agentDir, source.replace(/^~(?=\/)/, process.env.HOME ?? "~"))) === root
			);
		})
	);
}

export interface PaletteCollector {
	/** Record the heard commands in an interactive terminal session; later publications record again. */
	start(
		ctx: Pick<ExtensionContext, "mode"> & {
			ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
		},
	): void;
	shutdown(): void;
}

/**
 * Collect the publications of `harness:palette:publish` and record them for the Rex-side runtime. Only interactive
 * terminal sessions of a package that Pi's settings load, and that heard a publication, record: RPC, JSON and print
 * sessions and trials leave the operator's palette as it is.
 */
export function createPaletteCollector(options: {
	events: ExtensionAPI["events"];
	agentDir: string;
	packageRoot: string;
	paneStacking: () => string[] | undefined;
	configured?: () => boolean;
}): PaletteCollector {
	const path = paletteRegistryPath(options.agentDir);
	const configured = options.configured ?? (() => configuredPackage(options.agentDir, options.packageRoot));
	const heard = new Map<string, PaletteCommand[]>();
	let active: Parameters<PaletteCollector["start"]>[0] | undefined;
	let warned = false;
	const record = () => {
		// A process that heard no publication, such as a trial of this extension alone, has nothing to record.
		if (!active || heard.size === 0) return;
		try {
			if (!configured()) return;
			withRegistryLock(path, () => {
				writePaletteRegistry(
					path,
					mergePalette(readPaletteRegistry(path), heard, options.paneStacking(), options.packageRoot),
				);
			});
		} catch (error) {
			if (warned) return;
			warned = true;
			const message = `Pi could not record its commands for the Rex palette in ${path}: ${error instanceof Error ? error.message : String(error)}`;
			active.ui.notify(
				stripTerminalSequences(message)
					.replace(/[\p{Cc}\p{Cf}\p{Cs}\s]+/gu, " ")
					.trim(),
				"warning",
			);
		}
	};
	const stop = options.events.on("harness:palette:publish", (payload) => {
		const published = publishedCommands(payload);
		if (!published) return;
		heard.set(published.source, published.commands);
		record();
	});
	options.events.emit("harness:palette:request", { version: 1 });
	return {
		start(ctx) {
			active = ctx?.mode === "tui" ? ctx : undefined;
			record();
		},
		shutdown() {
			active = undefined;
			stop();
		},
	};
}
