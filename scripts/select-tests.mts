#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { literalSpecifiers } from "./check-slices.mts";

/** Paths are relative to the repository root; revision selection reads current source. */
export function changedPaths(args: string[], readRange: (range: string) => string[]): string[] {
	if (args.length === 2 && args[0] === "--range") return readRange(args[1]);
	if (!args.length || args.some((arg) => arg.startsWith("--"))) {
		throw new Error("Usage: select-tests.mts <path> [path...] | --range <revision-range>");
	}
	return args;
}

/** Select neighbours and literal consumers, with at most one intermediate module. */
export function selectTests(root: string, files: string[], changed: string[]): string[] {
	const absolute = (path: string) => resolve(root, path);
	const sources = new Set(files.filter((path) => /\.(ts|mts)$/.test(path)).map(absolute));
	const targets = new Set(changed.map(absolute));
	const directories = new Set([...targets].map(dirname));
	const imports = new Map<string, string[]>();
	for (const file of sources) {
		const dependencies = literalSpecifiers(readFileSync(file, "utf8"))
			.filter((specifier) => specifier.startsWith("./") || specifier.startsWith("../"))
			.map((specifier) => resolve(dirname(file), specifier));
		imports.set(file, dependencies);
	}
	const intermediates = new Set(
		[...imports].filter(([, dependencies]) => dependencies.some((path) => targets.has(path))).map(([path]) => path),
	);
	return [...sources]
		.filter((file) => {
			if (!file.endsWith(".test.mts")) return false;
			if (targets.has(file) || directories.has(dirname(file))) return true;
			return imports.get(file)?.some((path) => targets.has(path) || intermediates.has(path));
		})
		.map((file) => relative(root, file).replaceAll("\\", "/"))
		.sort();
}

function git(root: string, args: string[]): string[] {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
		.split("\0")
		.filter(Boolean);
}

function sourceFile(root: string, path: string): boolean {
	if (!/\.(ts|mts)$/.test(path)) return false;
	if (path.split("/").some((part) => part.startsWith(".") || ["node_modules", "dist", "build"].includes(part)))
		return false;
	try {
		return lstatSync(resolve(root, path)).isFile();
	} catch {
		return false;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const changed = changedPaths(process.argv.slice(2), (range) =>
		git(root, ["diff", "--name-only", "--no-renames", "-z", range, "--"]),
	);
	const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).filter((path) =>
		sourceFile(root, path),
	);
	const selected = selectTests(root, files, changed);
	if (selected.length) process.stdout.write(`${selected.join("\n")}\n`);
}
