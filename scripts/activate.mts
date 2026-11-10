#!/usr/bin/env node

// Switches the snapshot checkout that Pi's settings file lists as the harness
// package. The read, check and write run under Pi's settings lock so two
// sessions cannot overwrite each other's switch, and only the one package
// source is rewritten.

import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

export interface SwitchOptions {
	settingsPath: string;
	expect: string;
	to: string;
	rollback?: boolean;
	isAncestor?: (ancestorDir: string, descendantDir: string) => boolean;
}

const remotePrefixes = ["npm:", "git:", "http://", "https://", "builtin:"];
const lockAttempts = 10;
const lockWaitMs = 20;
// Synchronous waiting without a timer: Atomics.wait blocks the thread briefly between lock attempts.
const lockWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const usage = "Usage: activate.mts [--rollback] --expect <current-snapshot-dir> <new-snapshot-dir>";

type Settings = Record<string, unknown>;
type Match = { index: number; source: string };

function resolvedPath(path: string): string {
	const absolute = resolve(path);
	return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function gitHead(directory: string): string {
	const result = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Could not read the commit of ${directory}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

/** Default ancestry check: the descendant worktree must contain the ancestor commit. */
function gitAncestor(ancestorDir: string, descendantDir: string): boolean {
	const ancestor = gitHead(ancestorDir);
	const descendant = gitHead(descendantDir);
	return spawnSync("git", ["-C", descendantDir, "merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

function assertNewSnapshot(directory: string): void {
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		throw new Error(`The new snapshot is not a directory: ${directory}`);
	}
	if (!existsSync(join(directory, "package.json"))) {
		throw new Error(`The new snapshot has no package.json: ${directory}`);
	}
}

function parseSettings(text: string, settingsPath: string): Settings {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`The settings file is not a JSON object: ${settingsPath}`);
	}
	return value as Settings;
}

function sourceOf(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	if ("source" in entry && typeof entry.source === "string") return entry.source;
	return undefined;
}

function isLocalSource(source: string): boolean {
	return !remotePrefixes.some((prefix) => source.startsWith(prefix));
}

function localSourcePath(source: string, settingsDir: string): string {
	if (isAbsolute(source)) return source;
	if (source.startsWith("~/")) return join(homedir(), source.slice(2));
	return resolve(settingsDir, source);
}

function matchesFor(packages: unknown[], settingsDir: string, expectReal: string): Match[] {
	const matches: Match[] = [];
	for (const [index, entry] of packages.entries()) {
		const source = sourceOf(entry);
		if (source === undefined || !isLocalSource(source)) continue;
		if (resolvedPath(localSourcePath(source, settingsDir)) === expectReal) matches.push({ index, source });
	}
	return matches;
}

/** Keeps the new source in the same form as the one it replaces. */
function replacementSource(oldSource: string, toReal: string, settingsDir: string): string {
	if (isAbsolute(oldSource) || oldSource.startsWith("~/")) return toReal;
	const path = relative(settingsDir, toReal).split(sep).join("/");
	return path.startsWith(".") ? path : `./${path}`;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function acquireSettingsLock(settingsPath: string): () => void {
	for (let attempt = 1; attempt <= lockAttempts; attempt += 1) {
		try {
			return lockfile.lockSync(settingsPath, { realpath: false });
		} catch (error) {
			if (errorCode(error) !== "ELOCKED") throw error;
			if (attempt === lockAttempts) break;
			Atomics.wait(lockWait, 0, 0, lockWaitMs);
		}
	}
	throw new Error(`The settings file is locked: ${settingsPath}`);
}

function withSource(entry: unknown, source: string): unknown {
	if (typeof entry === "string") return source;
	if (typeof entry === "object" && entry !== null) return { ...entry, source };
	return entry;
}

function restoredSettings(settings: Settings, index: number, source: string): Settings {
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const restored = packages.map((entry, position) => (position === index ? withSource(entry, source) : entry));
	return { ...settings, packages: restored };
}

function replaceSourceText(text: string, match: Match, newSource: string, settingsPath: string): string {
	const quoted = JSON.stringify(match.source);
	if (text.split(quoted).length !== 2) {
		throw new Error(`The settings file does not contain exactly one ${quoted} entry: ${settingsPath}`);
	}
	return text.replace(quoted, () => JSON.stringify(newSource));
}

/** Replaces the file through a flushed sibling, so a failed write leaves the original bytes in place. */
function replaceFile(path: string, text: string): void {
	const temporary = `${path}.activate-${process.pid}.tmp`;
	const descriptor = openSync(temporary, "wx");
	let renamed = false;
	try {
		try {
			fchmodSync(descriptor, statSync(path).mode & 0o777);
			writeFileSync(descriptor, text, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
		renamed = true;
	} finally {
		if (!renamed) rmSync(temporary, { force: true });
	}
}

/** A duplicate key or an escaped twin can leave the effective source unchanged after a text replacement. */
function assertSelected(
	updated: Settings,
	index: number,
	settingsDir: string,
	toReal: string,
	settingsPath: string,
): void {
	const selected = Array.isArray(updated.packages) ? sourceOf(updated.packages[index]) : undefined;
	if (selected === undefined || resolvedPath(localSourcePath(selected, settingsDir)) !== toReal) {
		throw new Error(`The replacement would not select the new snapshot; the entry is ambiguous: ${settingsPath}`);
	}
}

function switchLocked(settingsPath: string, expectReal: string, toReal: string): { from: string; to: string } {
	const text = readFileSync(settingsPath, "utf8");
	const settings = parseSettings(text, settingsPath);
	if (!Array.isArray(settings.packages)) throw new Error(`The settings file has no packages array: ${settingsPath}`);
	const settingsDir = realpathSync(dirname(resolve(settingsPath)));
	const matches = matchesFor(settings.packages, settingsDir, expectReal);
	if (matches.length === 0) {
		throw new Error(
			`The harness package entry no longer names the expected snapshot (another activation may have moved it): ${expectReal}`,
		);
	}
	if (matches.length > 1) throw new Error(`More than one package entry names the expected snapshot: ${expectReal}`);
	const match = matches[0];
	const newSource = replacementSource(match.source, toReal, settingsDir);
	const next = replaceSourceText(text, match, newSource, settingsPath);
	const updated = parseSettings(next, settingsPath);
	assertSelected(updated, match.index, settingsDir, toReal, settingsPath);
	if (JSON.stringify(restoredSettings(updated, match.index, match.source)) !== JSON.stringify(settings)) {
		throw new Error(`The settings file could not be updated without changing other entries: ${settingsPath}`);
	}
	replaceFile(settingsPath, next);
	return { from: match.source, to: newSource };
}

/** Replaces the one harness package entry after confirming it still names `expect`; `rollback` skips the ancestry check. */
export function switchHarnessPackage(options: SwitchOptions): { from: string; to: string } {
	const expectReal = resolvedPath(options.expect);
	const toReal = resolvedPath(options.to);
	assertNewSnapshot(toReal);
	const isAncestor = options.isAncestor ?? gitAncestor;
	if (options.rollback !== true && !isAncestor(expectReal, toReal)) {
		throw new Error(
			`The new snapshot's commit does not descend from the current one: ${toReal}; --rollback selects an earlier snapshot.`,
		);
	}
	const release = acquireSettingsLock(options.settingsPath);
	try {
		return switchLocked(options.settingsPath, expectReal, toReal);
	} finally {
		release();
	}
}

function parseArguments(args: string[]): { rollback: boolean; expect: string; to: string } {
	const rollback = args[0] === "--rollback";
	const rest = rollback ? args.slice(1) : args;
	if (rest.length !== 3 || rest[0] !== "--expect") throw new Error(usage);
	return { rollback, expect: rest[1], to: rest[2] };
}

function main(): void {
	const { rollback, expect, to } = parseArguments(process.argv.slice(2));
	const result = switchHarnessPackage({ settingsPath: join(getAgentDir(), "settings.json"), expect, to, rollback });
	console.log(`Switched harness package: ${result.from} -> ${result.to}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
