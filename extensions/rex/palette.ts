import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One command that an extension offers in the Rex palette, as docs/conventions/palette-commands.md defines it. */
export interface PaletteCommand { id: string; title: string; description?: string; argv: string[] }
interface RecordedCommand extends PaletteCommand { source: string }
/** What the Rex-side runtime reads: every recorded command, and the stacking offer for the panes it opens. */
export interface PaletteRegistry { version: 1; commands: RecordedCommand[]; paneStacking?: string[] }

const SOURCE = /^[a-z][a-z0-9_]{0,23}$/;
const NAME = /^[a-z][a-z0-9_]*$/;
const PLAIN = /^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u;

export function paletteRegistryPath(agentDir: string): string {
	return join(agentDir, "rex", "palette.json");
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && [...value].length <= max && PLAIN.test(value);

function validCommand(source: string, value: unknown): PaletteCommand | undefined {
	const command = object(value);
	const { id, title, description, argv } = command;
	if (typeof id !== "string" || id.length > 48 || !id.startsWith(`${source}.`) || !NAME.test(id.slice(source.length + 1))) return undefined;
	if (!text(title, 64) || (description !== undefined && !text(description, 200))) return undefined;
	if (!Array.isArray(argv) || argv.length < 1 || argv.length > 16) return undefined;
	if (!argv.every((word) => typeof word === "string" && word.length <= 4096 && !word.includes("\0")) || !isAbsolute(argv[0] as string)) return undefined;
	return { id, title: title.trim(), ...(description === undefined ? {} : { description: description.trim() }), argv: [...argv as string[]] };
}

/** The commands of one publication that meet the contract; a command that does not is left out. */
export function publishedCommands(publication: unknown): { source: string; commands: PaletteCommand[] } | undefined {
	const value = object(publication);
	if (value.version !== 1 || typeof value.source !== "string" || !SOURCE.test(value.source) || !Array.isArray(value.commands)) return undefined;
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
	try { value = object(JSON.parse(readFileSync(path, "utf8"))); } catch { return undefined; }
	if (value.version !== 1 || !Array.isArray(value.commands)) return undefined;
	const commands = value.commands.flatMap((item) => {
		const source = object(item).source;
		const command = typeof source === "string" && SOURCE.test(source) ? validCommand(source, item) : undefined;
		return command ? [{ ...command, source: source as string }] : [];
	});
	const stacking = value.paneStacking;
	const paneStacking = Array.isArray(stacking) && stacking.length === 2 && stacking.every((word) => typeof word === "string" && isAbsolute(word)) ? stacking as string[] : undefined;
	return { version: 1, commands, ...(paneStacking ? { paneStacking } : {}) };
}

/**
 * The registry after the publications that this process heard: each heard source replaces its commands, and every
 * other source keeps its commands while their program exists, so a process that loads only some extensions removes
 * nothing.
 */
export function mergePalette(existing: PaletteRegistry | undefined, heard: ReadonlyMap<string, readonly PaletteCommand[]>, paneStacking: string[] | undefined, exists: (path: string) => boolean = existsSync): PaletteRegistry {
	const commands = new Map<string, RecordedCommand>();
	for (const command of existing?.commands ?? []) {
		if (!heard.has(command.source) && exists(command.argv[0] as string)) commands.set(command.id, command);
	}
	for (const [source, list] of heard) for (const command of list) commands.set(command.id, { ...command, source });
	return { version: 1, commands: [...commands.values()].sort((a, b) => a.id.localeCompare(b.id)), ...(paneStacking ? { paneStacking } : {}) };
}

/** Replace the registry in one rename when its content changes. Returns whether it changed. */
export function writePaletteRegistry(path: string, registry: PaletteRegistry): boolean {
	const content = `${JSON.stringify(registry, null, 2)}\n`;
	try { if (readFileSync(path, "utf8") === content) return false; } catch { /* Absent or unreadable: write it. */ }
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally { rmSync(temporary, { force: true }); }
	return true;
}

export interface PaletteCollector {
	/** Record the heard commands when this session is interactive; later publications record again. */
	start(ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): void;
	shutdown(): void;
}

/**
 * Collect the publications of `harness:palette:publish` and record them for the Rex-side runtime. Only interactive
 * sessions that heard a publication record, so print runs and trials of this extension alone leave the operator's
 * palette as it is.
 */
export function createPaletteCollector(options: { events: ExtensionAPI["events"]; agentDir: string; paneStacking: () => string[] | undefined }): PaletteCollector {
	const path = paletteRegistryPath(options.agentDir);
	const heard = new Map<string, PaletteCommand[]>();
	let active: Parameters<PaletteCollector["start"]>[0] | undefined;
	let warned = false;
	const record = () => {
		// A process that heard no publication, such as a trial of this extension alone, has nothing to record.
		if (!active || heard.size === 0) return;
		try { writePaletteRegistry(path, mergePalette(readPaletteRegistry(path), heard, options.paneStacking())); }
		catch (error) {
			if (warned) return;
			warned = true;
			active.ui.notify(`Pi could not record its commands for the Rex palette in ${path}: ${error instanceof Error ? error.message : String(error)}`, "warning");
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
			active = ctx?.hasUI ? ctx : undefined;
			record();
		},
		shutdown() {
			active = undefined;
			stop();
		},
	};
}
