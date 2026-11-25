import { execFile, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";
import { trustedRexExecutable } from "./terminal-origin.ts";

const exec = promisify(execFile);
const feed = "https://blob.superlogical.com/public/changelog/";
const defaultBaseline = new URL("reviewed-rex.json", import.meta.url);
const extensions = new URL("../", import.meta.url);
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/;
const envPattern = /^REX_[A-Z_]+$/;
const installedSuffix = "Rex Server.app/Contents/MacOS/rex";
const stagedSuffix = "Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";

type Row = Record<string, unknown>;
type Platform = "server" | "mac";
type Baseline = Record<Platform, string>;
type Identity = { version: string; api: number };
type Binary = Identity & { path: string; source: "installed" | "staged" };
type Release = { platform: Platform; version: string; date: string };
type Surface = { methods: Map<string, Row>; blocks: Map<string, Row> };
type Probe = Surface & { env: string[]; guide?: string };

function row(value: unknown): Row {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
	return value as Row;
}

function version(value: unknown): string {
	if (typeof value !== "string" || !versionPattern.test(value)) throw new Error("Unrecognised Rex version.");
	return value;
}

export function compareVersions(a: string, b: string): number {
	const parts = (value: string) => versionPattern.exec(version(value))?.slice(1) ?? [];
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < 4; i++) {
		const x = Number(left[i] ?? Infinity);
		const y = Number(right[i] ?? Infinity);
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

function identity(value: unknown): Identity {
	const { rex_version, api_revision } = row(value);
	if (typeof api_revision !== "number" || !Number.isSafeInteger(api_revision)) throw new Error("Invalid API revision.");
	return { version: version(rex_version), api: api_revision };
}

export function releasesAfter(value: unknown, baseline: Baseline): Release[] {
	const { schemaVersion, releases } = row(value);
	if (schemaVersion !== 1 || !Array.isArray(releases)) throw new Error("Invalid changelog index.");
	const entries = releases.flatMap<Release>((value: unknown) => {
		const { platform, version, releasedAt, path } = row(value);
		if (platform !== "server" && platform !== "mac") return [];
		if (
			typeof version !== "string" ||
			!/^\d[0-9a-z.-]*$/.test(version) ||
			typeof releasedAt !== "string" ||
			!Number.isFinite(Date.parse(releasedAt)) ||
			path !== `${platform}/${version}.json`
		)
			throw new Error(`Invalid ${platform} changelog entry.`);
		return [{ platform, version, date: new Date(releasedAt).toISOString() }];
	});
	const cutoff = (platform: Platform) => {
		const [match, duplicate] = entries.filter(
			(entry) => entry.platform === platform && entry.version === baseline[platform],
		);
		if (!match || duplicate)
			throw new Error(`The changelog does not identify one ${platform} release for ${baseline[platform]}.`);
		return match.date;
	};
	const dates = { server: cutoff("server"), mac: cutoff("mac") };
	return entries
		.filter((entry) => entry.date > dates[entry.platform])
		.sort(
			(a, b) =>
				b.date.localeCompare(a.date) || a.platform.localeCompare(b.platform) || a.version.localeCompare(b.version),
		);
}

function keyed(value: unknown, key: string): Map<string, Row> {
	if (!Array.isArray(value)) throw new Error(`Missing help.all list with ${key} fields.`);
	const result = new Map<string, Row>();
	for (const item of value) {
		const entry = row(item);
		const name = entry[key];
		if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(name) || result.has(name))
			throw new Error(`Invalid help.all ${key} field.`);
		result.set(name, entry);
	}
	return result;
}

export function parseSurface(value: unknown): Surface {
	const { methods, block_types } = row(value);
	return { methods: keyed(methods, "name"), blocks: keyed(block_types, "creator") };
}

export function changes(before: ReadonlyMap<string, Row>, after: ReadonlyMap<string, Row>) {
	return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((name) => {
		const old = before.get(name);
		const next = after.get(name);
		if (!old || !next) return [{ name, kind: old ? "Removed" : "Added", fields: [] }];
		const fields = [...new Set([...Object.keys(old), ...Object.keys(next)])]
			.sort()
			.filter((field) => !isDeepStrictEqual(old[field], next[field]));
		return fields.length ? [{ name, kind: "Changed", fields }] : [];
	});
}

export function sourceNames(sources: string[], methods: ReadonlySet<string>) {
	const env = new Set<string>();
	const api = new Set<string>();
	for (const source of sources) {
		for (const match of source.matchAll(/\bREX_[A-Z_]+\b/g)) env.add(match[0]);
		for (const [, , name] of source.matchAll(/(["'`])([a-zA-Z0-9_.-]+)\1/g)) {
			if (name && methods.has(name)) api.add(name);
		}
	}
	return { env: [...env].sort(), api };
}

export function terminalFindings(names: string[], before: string[] | undefined, after: string[]) {
	return names
		.filter((name) => !after.includes(name))
		.map(
			(name) =>
				`- \`${name}\` appears in harness source but is absent from the candidate terminal${before?.includes(name) ? "; the baseline terminal set it" : ""}.`,
		);
}

async function sourceTexts(directory: URL, belowRoot = false): Promise<string[]> {
	const sources: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
			sources.push(...(await sourceTexts(new URL(`${encodeURIComponent(entry.name)}/`, directory), true)));
		} else if (
			belowRoot &&
			entry.isFile() &&
			/(?<!\.test)\.[cm]?tsx?$/.test(entry.name) &&
			entry.name !== "upgrade-review.mts"
		) {
			sources.push(await readFile(new URL(encodeURIComponent(entry.name), directory), "utf8"));
		}
	}
	return sources;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function directories(path: string) {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(path, entry.name))
			.sort();
	} catch (error) {
		if (missing(error)) return [];
		throw error;
	}
}

function rexEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REX_")));
}

async function cli(path: string, args: string[], signal: AbortSignal, env = rexEnv(), socket?: string) {
	const prefix = ["--autostart=false", "--color=never", "--timeout=3s"];
	if (socket) prefix.push("-S", socket);
	try {
		const result = await exec(path, [...prefix, ...args], {
			env,
			signal,
			timeout: 5000,
			killSignal: "SIGKILL",
			maxBuffer: 2 * 1024 * 1024,
		});
		return result.stdout;
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
		const detail =
			failure.stderr?.trim().split("\n")[0] ||
			failure.code ||
			(failure.killed ? "process timed out" : "process failed");
		throw new Error(`rex ${args.slice(0, 2).join(" ")}: ${detail}`);
	}
}

async function binaries(home: string, signal: AbortSignal, attempt: Attempt): Promise<Binary[]> {
	const installed = join(home, "Library/Application Support/com.superlogical.rex/RexServer/Versions");
	const staging = join(home, "Library/Caches/com.superlogical.rex/org.sparkle-project.Sparkle/Installation");
	const installDirs = (await attempt("Installed builds", () => directories(installed))) ?? [];
	const stagedDirs =
		(await attempt("Staged builds", async () =>
			(await Promise.all((await directories(staging)).map(directories))).flat(),
		)) ?? [];
	const paths = [
		trustedRexExecutable(),
		...installDirs.map((path) => join(path, installedSuffix)),
		...stagedDirs.map((path) => join(path, stagedSuffix)),
	];
	const seen = new Set<string>();
	const result: Binary[] = [];
	for (const path of paths) {
		signal.throwIfAborted();
		const canonical = await attempt("Rex binary path", async () => {
			try {
				return await realpath(path);
			} catch (error) {
				if (!missing(error)) throw error;
			}
		});
		if (!canonical || seen.has(canonical)) continue;
		seen.add(canonical);
		const info = await attempt("Rex binary version", async () =>
			identity(JSON.parse(await cli(canonical, ["version", "--json"], signal))),
		);
		if (info)
			result.push({ ...info, path: canonical, source: path.startsWith(`${staging}/`) ? "staged" : "installed" });
	}
	return result.sort((a, b) => compareVersions(b.version, a.version) || b.api - a.api || a.path.localeCompare(b.path));
}

function waitForPath(
	directory: string,
	path: string,
	matches: (info: Awaited<ReturnType<typeof stat>>) => boolean,
	signal: AbortSignal,
) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		let watcher: FSWatcher | undefined;
		const finish = (error?: unknown) => {
			watcher?.close();
			signal.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		};
		const abort = () => finish(signal.reason);
		const check = () =>
			void stat(path).then(
				(info) => {
					if (matches(info)) finish();
				},
				(error: unknown) => {
					if (!missing(error)) finish(error);
				},
			);
		try {
			watcher = watch(directory, check);
			watcher.once("error", finish);
			signal.addEventListener("abort", abort, { once: true });
			check();
		} catch (error) {
			finish(error);
		}
	});
}

const terminalProbe = `
const fs = require('node:fs');
const target = process.argv[1];
fs.writeFileSync(target + '.pending', JSON.stringify(Object.keys(process.env).filter(k => /^REX_[A-Z_]+$/.test(k)).sort()));
fs.renameSync(target + '.pending', target);
`;

async function probe(binary: Binary, interrupt: AbortSignal, attempt: Attempt): Promise<Probe> {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "rex-review-"));
	try {
		const socketPath = join(dir, "rex.sock");
		const socket = pathToFileURL(socketPath).href.replace(/^file:/, "unix:");
		const config = join(dir, "init.lua");
		await mkdir(join(dir, "home"));
		await writeFile(config, "");
		const env = rexEnv();
		for (const key of Object.keys(env)) if (key.startsWith("XDG_")) delete env[key];
		delete env.NODE_OPTIONS;
		delete env.NODE_V8_COVERAGE;
		env.HOME = join(dir, "home");
		const ended = new AbortController();
		const child = spawn(
			binary.path,
			["server", "run", "--listen", socket, "--state-dir", join(dir, "state"), "--config", config, "--restore=false"],
			{ env, cwd: dir, stdio: "ignore" },
		);
		const exited = new Promise<void>((done) => {
			child.once("error", (error) => {
				ended.abort(error);
				done();
			});
			child.once("exit", (code, signal) => {
				ended.abort(new Error(`Isolated Rex server exited (${signal ?? code}).`));
				done();
			});
		});
		const signal = AbortSignal.any([interrupt, ended.signal, AbortSignal.timeout(20000)]);
		const isolated = (args: string[]) => cli(binary.path, args, signal, env, socket);
		try {
			await waitForPath(dir, socketPath, (info) => info.isSocket(), signal);
			const who = row(JSON.parse(await isolated(["whoami", "--json"])));
			if (who.pid !== child.pid || !isDeepStrictEqual(identity(who), { version: binary.version, api: binary.api }))
				throw new Error("Isolated server identity does not match the process started for this probe.");
			const surface = parseSurface(JSON.parse(await isolated(["api", "call", "help.all"])));
			const path = join(dir, "terminal-env.json");
			await isolated([
				"new",
				"upgrade-review",
				"--cwd",
				dir,
				"--shell",
				"none",
				"--json",
				"--",
				process.execPath,
				"-e",
				terminalProbe,
				path,
			]);
			await waitForPath(dir, path, (info) => info.isFile(), signal);
			const names: unknown = JSON.parse(await readFile(path, "utf8"));
			if (!Array.isArray(names) || !names.every((name: unknown) => typeof name === "string" && envPattern.test(name)))
				throw new Error("Invalid terminal environment sample.");
			const guide = await attempt(`Agent guide for ${binary.version}`, () => isolated(["skill", "show"]));
			return { ...surface, env: names, guide };
		} finally {
			child.kill("SIGTERM");
			const force = setTimeout(() => child.kill("SIGKILL"), 2000);
			try {
				await exited;
			} finally {
				clearTimeout(force);
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function fetchJson(path: string, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(`${feed}${path}`, {
		signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
		redirect: "error",
	});
	if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}.`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
			size += value.byteLength;
			if (size > 1024 * 1024) throw new Error("Changelog file exceeds 1 MiB.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
}

type Attempt = <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;

function plain(value: string): string {
	return value
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[\\`*_{}[\]<>]/g, "\\$&")
		.trim();
}

function showInfo(info: Identity | undefined) {
	return info ? `${info.version} (API ${info.api})` : "unavailable";
}

function macAppVersions(value: unknown): string[] {
	const { clients } = row(value);
	if (!Array.isArray(clients)) throw new Error("Invalid Rex client list.");
	const versions = clients.flatMap((client: unknown) => {
		const { info } = row(client);
		if (info === undefined) return [];
		const app = row(info);
		return app.kind === "app" && app.platform === "macos" ? [version(app.version)] : [];
	});
	return [...new Set(versions)].sort(compareVersions);
}

async function probePair(
	candidate: Binary | undefined,
	previous: Binary | undefined,
	signal: AbortSignal,
	attempt: Attempt,
) {
	const candidateProbe =
		candidate && (await attempt(`Candidate probe (${candidate.version})`, () => probe(candidate, signal, attempt)));
	const previousProbe =
		previous === candidate
			? candidateProbe
			: previous && (await attempt(`Baseline probe (${previous.version})`, () => probe(previous, signal, attempt)));
	return { candidateProbe, previousProbe };
}

async function review(baselinePath: URL | string, signal: AbortSignal) {
	const raw = row(JSON.parse(await readFile(baselinePath, "utf8")));
	const baseline = { server: version(raw.server), mac: version(raw.mac) };
	const issues: string[] = [];
	const attempt: Attempt = async (label, fn) => {
		try {
			return await fn();
		} catch (error) {
			issues.push(`- ${label}: ${plain(errorText(error))}`);
		}
	};
	const readLive = (args: string[]) => cli(trustedRexExecutable(), args, signal);
	const [running, apps, builds, releases, sources] = await Promise.all([
		attempt("Running server", async () => identity(JSON.parse(await readLive(["whoami", "--json"])))),
		attempt("Connected Mac app versions", async () =>
			macAppVersions(JSON.parse(await readLive(["client", "ls", "--json"]))),
		),
		binaries(userInfo().homedir, signal, attempt),
		attempt("Changelog index", async () => releasesAfter(await fetchJson("index.json", signal), baseline)),
		attempt("Harness source scan", () => sourceTexts(extensions)),
	]);
	const installed = builds.find((build) => build.source === "installed");
	const staged = builds.find((build) => build.source === "staged");
	const candidate = builds[0];
	const previous = builds.find((build) => build.version === baseline.server);
	const { candidateProbe, previousProbe } = await probePair(candidate, previous, signal, attempt);
	if (!candidate) issues.push("- No installed or staged Rex binary was available to probe.");
	if (!previous)
		issues.push(
			`- No local Rex binary matched the reviewed server ${baseline.server}. The API and environment comparisons lack a baseline.`,
		);
	const names = sourceNames(
		sources ?? [],
		new Set([...(candidateProbe?.methods.keys() ?? []), ...(previousProbe?.methods.keys() ?? [])]),
	);
	const output = [
		"# Rex upgrade review",
		"",
		"## Versions",
		"",
		`- Reviewed baseline: server ${baseline.server}, Mac app ${baseline.mac}`,
		`- Running server: ${showInfo(running)}`,
		`- Connected Mac app versions: ${apps?.join(", ") || (apps ? "none" : "unavailable")}`,
		`- Newest installed server: ${showInfo(installed)}`,
		`- Newest staged server: ${staged ? showInfo(staged) : "none found"}`,
		`- Candidate: ${showInfo(candidate)}${candidate ? ` (${candidate.source})` : ""}`,
		"",
		"## Terminal environment",
		"",
		...environmentReport(candidateProbe, previousProbe, sources ? names.env : undefined),
		"",
		"## Control API and agent guide",
		"",
	];
	const api = previousProbe && candidateProbe ? changes(previousProbe.methods, candidateProbe.methods) : [];
	output.push(...apiReport(candidateProbe, previousProbe, api, names.api));
	const cues = new Set([...names.env, ...api.map(({ name }) => name)]);
	output.push(
		"",
		"## Changelog since the reviewed baseline",
		"",
		...(await changelogReport(releases, cues, signal, attempt)),
	);
	if (issues.length) output.push("", "## Incomplete evidence", "", ...issues.sort());
	return { report: `${output.join("\n")}\n`, incomplete: issues.length > 0 };
}

function environmentReport(candidate: Probe | undefined, baseline: Probe | undefined, names: string[] | undefined) {
	if (!candidate) return ["Candidate terminal evidence is unavailable."];
	const list = (env: string[]) => env.map((name) => `\`${name}\``).join(", ") || "none";
	const lines = [`- Variables set in the candidate terminal: ${list(candidate.env)}.`];
	if (baseline) lines.push(`- Variables set in the baseline terminal: ${list(baseline.env)}.`);
	if (names)
		lines.push(
			...terminalFindings(names, baseline?.env, candidate.env),
			"",
			"Source names include mentions in comments and code that removes variables. A match does not prove a dependency.",
		);
	return lines;
}

function apiReport(
	candidate: Probe | undefined,
	baseline: Probe | undefined,
	methods: ReturnType<typeof changes>,
	source: Set<string>,
) {
	if (!baseline || !candidate) return ["API and guide comparisons are unavailable."];
	const blocks = changes(baseline.blocks, candidate.blocks);
	const describe = ({ name, kind, fields }: ReturnType<typeof changes>[number], label: string, named = false) =>
		`- ${kind} ${label} \`${name}\`${fields.length ? ` (${fields.map(plain).join(", ")})` : ""}${named ? "; harness source names it" : ""}.`;
	const lines = [
		...methods.map((change) => describe(change, "method", source.has(change.name))),
		...blocks.map((change) => describe(change, "block type")),
	];
	const changed = lines.length > 0;
	if (!changed) lines.push("- No changes in `help.all` methods or block types.");
	if (baseline.guide !== undefined && candidate.guide !== undefined)
		lines.push(
			baseline.guide === candidate.guide
				? "- Agent guide unchanged."
				: "- Agent guide changed. Compare `rex skill show` for both versions.",
		);
	if (changed) lines.push("", "Differences in `help.all` do not establish whether calls behave differently.");
	return lines;
}

async function changelogReport(
	releases: Release[] | undefined,
	cues: Set<string>,
	signal: AbortSignal,
	attempt: Attempt,
) {
	if (!releases) return ["Changelog evidence is unavailable."];
	if (!releases.length) return ["No newer Mac or server releases in the changelog."];
	const notes = await Promise.all(
		releases.map(async (release) => {
			const path = `${release.platform}/${release.version}.json`;
			const matches = await attempt(`Notes for ${release.platform} ${release.version}`, async () => {
				const note = row(await fetchJson(path, signal));
				if (note.platform !== release.platform || note.version !== release.version || typeof note.markdown !== "string")
					throw new Error("Changelog file does not match the index entry.");
				return note.markdown
					.split("\n")
					.filter((line) => line.split(/[^a-zA-Z0-9_.]+/).some((word) => cues.has(word.replace(/\.$/, ""))));
			});
			return [
				`- ${release.date.slice(0, 10)} [${release.platform} ${release.version}](${feed}${path})`,
				...(matches ?? []).map((line) => `  - ${plain(line.replace(/^\s*[-*]\s+/, ""))}`),
			];
		}),
	);
	return notes.flat();
}

async function main() {
	const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" }, baseline: { type: "string" } } });
	if (values.help) {
		console.log(
			"Usage: node extensions/rex/upgrade-review.mts [--baseline PATH]\n\nCompare local Rex builds with reviewed-rex.json, or with another baseline file.",
		);
		return;
	}
	const interrupt = new AbortController();
	const stop = () => interrupt.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	process.once("SIGHUP", stop);
	try {
		const signal = AbortSignal.any([interrupt.signal, AbortSignal.timeout(100000)]);
		const { report, incomplete } = await review(values.baseline ?? defaultBaseline, signal);
		process.stdout.write(report);
		process.exitCode = incomplete ? 1 : 0;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGHUP", stop);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await main();
	} catch (error) {
		console.error(`Rex upgrade review: ${plain(errorText(error))}`);
		process.exitCode = 1;
	}
}
