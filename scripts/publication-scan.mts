#!/usr/bin/env node

// Refuses to publish commits that carry a credential, private key, personal
// home path or retained session envelope. Installed as the pre-push hook by
// `npm run hooks`; `node scripts/publication-scan.mts <range>` scans directly.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hookMarker = "# managed by scripts/publication-scan.mts";
const rules: Array<[string, RegExp]> = [
	["personal-path", /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//],
	["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
	["credential", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9_-]{30,})\b/],
	["session-transcript", /^\s*<(?:agent-request-context|agent-efforts|agent-preferences)>\s*$/],
];

export function scanText(text: string): { line: number; rule: string } | undefined {
	for (const [index, line] of text.split("\n").entries()) {
		for (const [rule, pattern] of rules) if (pattern.test(line)) return { line: index + 1, rule };
	}
	return undefined;
}

function git(cwd: string, args: string[], maxBuffer = 4_000_000): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

function changedBlobs(cwd: string, commit: string): Map<string, string> {
	// Compare merge results with every parent. Disabling rename detection treats
	// rename destinations as additions; raw records distinguish blobs from gitlinks.
	const changes = git(cwd, ["diff-tree", "--root", "-m", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "-z", "-r", "--diff-filter=AMT", commit]).split("\0");
	const blobs = new Map<string, string>();
	for (let index = 0; index + 1 < changes.length; index += 2) {
		const [, mode, , oid] = changes[index].split(" ");
		if (mode !== "160000") blobs.set(changes[index + 1], oid);
	}
	return blobs;
}

/** Findings for every commit message and changed text blob selected by `revisions`; matched text is never reported. */
export function scanRange(cwd: string, revisions: string[]): string[] {
	const findings: string[] = [];
	const commits = git(cwd, ["rev-list", ...revisions]).trim().split("\n").filter(Boolean);
	for (const commit of commits) {
		const message = scanText(git(cwd, ["log", "-1", "--format=%B", commit]));
		if (message) findings.push(`${commit.slice(0, 7)} commit message line ${message.line}: ${message.rule}`);
		for (const [path, oid] of changedBlobs(cwd, commit)) {
			const size = Number(git(cwd, ["cat-file", "-s", oid]).trim());
			if (size > 1_000_000) continue;
			const blob = git(cwd, ["cat-file", "blob", oid]);
			if (blob.includes("\0")) continue;
			const finding = scanText(blob);
			if (finding) findings.push(`${commit.slice(0, 7)}:${JSON.stringify(path)}:${finding.line}: ${finding.rule}`);
		}
	}
	return findings;
}

/** Revision selections pushed by this invocation, read from the pre-push stdin lines. */
export function pushRanges(stdin: string): string[][] {
	const zero = /^0+$/;
	return stdin
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(" "))
		.filter(([, local]) => local && !zero.test(local))
		.map(([, local, , remote]) => (remote && !zero.test(remote) ? [`${remote}..${local}`] : [local, "--not", "--remotes"]));
}

export function hookContent(): string {
	return [
		"#!/bin/sh",
		hookMarker,
		'root="$(git rev-parse --show-toplevel)"',
		'script="$root/scripts/publication-scan.mts"',
		'[ -f "$script" ] || exit 0',
		'exec node "$script" --pre-push',
		"",
	].join("\n");
}

export function installHook(repoRoot: string): string {
	const hooks = join(git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(), "hooks");
	mkdirSync(hooks, { recursive: true });
	const path = join(hooks, "pre-push");
	if (existsSync(path) && !readFileSync(path, "utf8").includes(hookMarker)) {
		throw new Error(`Refusing to replace an unmanaged hook: ${path}`);
	}
	writeFileSync(path, hookContent());
	chmodSync(path, 0o755);
	return path;
}

function main(): void {
	const args = process.argv.slice(2);
	const cwd = process.cwd();
	if (args[0] === "--install") {
		console.log(`Installed ${installHook(cwd)}`);
		return;
	}
	const ranges = args[0] === "--pre-push" ? pushRanges(readFileSync(0, "utf8")) : [args];
	if (args.length === 0) throw new Error("Usage: publication-scan.mts <revision-range> | --pre-push | --install");
	const findings = ranges.flatMap((range) => scanRange(cwd, range));
	for (const finding of findings) console.error(finding);
	if (findings.length > 0) {
		console.error("Publication refused: remove the flagged content or rewrite the commit before pushing.");
		process.exitCode = 1;
	}
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
