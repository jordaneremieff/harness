/**
 * Repository location discovery with a validated short-lived cache.
 *
 * Git owns repository discovery. A completed result is reused only while every
 * input that can change its answer keeps the same identity: the canonical cwd,
 * the discovery environment, the nearest `.git` marker and the resolved common
 * directory. An unknown result is shared only while its resolution is in flight.
 *
 * The cache never answers with a result that a fresh Git invocation could
 * contradict. When the marker identity cannot be established, the caller gets a
 * fresh uncached result instead of a guess.
 */
import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { PrimaryRepositoryState } from "./primary-channel.ts";

export interface PrimaryLocation {
	readonly cwd: string;
	readonly repositoryState: PrimaryRepositoryState;
	readonly repository?: string;
}

export interface PrimaryLocationResolver {
	resolve(cwd: string): Promise<PrimaryLocation>;
	invalidate(cwd?: string): void;
	clear(): void;
}

const COMPLETED_LIMIT = 32;
const MARKER_BYTES = 4096;
const ANCESTOR_LIMIT = 256;

function gitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
	return env;
}

/** Every sanitised environment input that can change repository discovery. */
function discoveryEnvironment(): string {
	return Object.entries(gitEnvironment())
		.filter(([key, value]) => value !== undefined && (key === "PATH" || key.startsWith("GIT_")))
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join("\n");
}

/** Resolve one location without a shell, with bounded Git output and execution time. */
export async function discoverPrimaryLocation(cwd: string): Promise<PrimaryLocation> {
	let canonical: string;
	try { canonical = await realpath(cwd); }
	catch { return { cwd: resolve(cwd), repositoryState: "unknown" }; }
	const result = await new Promise<{ common?: string; state: PrimaryRepositoryState }>((done) => {
		execFile("git", ["rev-parse", "--git-common-dir"], { cwd: canonical, timeout: 1000, maxBuffer: MARKER_BYTES, encoding: "utf8", env: gitEnvironment() }, (error, stdout, stderr) => {
			if (!error && stdout.trim()) done({ common: stdout.trim(), state: "git" });
			else done({ state: error?.code === 128 && stderr.startsWith("fatal: not a git repository") ? "outside-git" : "unknown" });
		});
	});
	if (!result.common) return { cwd: canonical, repositoryState: result.state };
	try {
		return { cwd: canonical, repository: await realpath(resolve(canonical, result.common)), repositoryState: "git" };
	} catch {
		return { cwd: canonical, repositoryState: "unknown" };
	}
}

interface MarkerStamp {
	readonly kind: "none" | "directory" | "file" | "bare";
	readonly path: string;
	readonly revision: string;
	readonly target?: string;
	readonly targetRevision?: string;
	readonly common?: string;
}

function identityOf(info: BigIntStats): string {
	return `${info.dev}:${info.ino}`;
}

function stampOfInfo(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** Read one marker file without following a symlink or reading past its bound. */
function readMarker(path: string): string | undefined {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch { return undefined; }
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > MARKER_BYTES) return undefined;
		const bytes = Buffer.alloc(MARKER_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > MARKER_BYTES) return undefined;
		return bytes.toString("utf8", 0, length);
	} catch { return undefined; }
	finally { closeSync(fd); }
}

function markerAt(candidate: string, info: BigIntStats, directory: string): MarkerStamp | undefined {
	if (info.isDirectory()) return { kind: "directory", path: candidate, revision: identityOf(info) };
	if (!info.isFile()) return undefined;
	const text = readMarker(candidate);
	if (text === undefined) return undefined;
	const pointer = /^gitdir:[ \t]*(.+?)[\r\n]*$/u.exec(text);
	if (!pointer) return undefined;
	const raw = pointer[1]?.trim();
	if (!raw) return undefined;
	const target = isAbsolute(raw) ? raw : resolve(directory, raw);
	const targetInfo = lstatSync(target, { bigint: true, throwIfNoEntry: false });
	const common = readMarker(join(target, "commondir"));
	return {
		kind: "file",
		path: candidate,
		revision: stampOfInfo(info),
		target,
		...(targetInfo?.isDirectory() === true ? { targetRevision: identityOf(targetInfo) } : {}),
		...(common === undefined ? {} : { common }),
	};
}

/** Git treats a directory with HEAD, objects and refs as a repository marker. */
function bareStamp(canonical: string): MarkerStamp | undefined {
	const head = lstatSync(join(canonical, "HEAD"), { bigint: true, throwIfNoEntry: false });
	const objects = lstatSync(join(canonical, "objects"), { bigint: true, throwIfNoEntry: false });
	const refs = lstatSync(join(canonical, "refs"), { bigint: true, throwIfNoEntry: false });
	if (head?.isFile() !== true || objects?.isDirectory() !== true || refs?.isDirectory() !== true) return undefined;
	const config = lstatSync(join(canonical, "config"), { bigint: true, throwIfNoEntry: false });
	return { kind: "bare", path: canonical, revision: stampOfInfo(head), ...(config?.isFile() === true ? { common: stampOfInfo(config) } : {}) };
}

/**
 * Describe the discovery inputs for one canonical cwd. Undefined means the
 * identity cannot be trusted, so its result must not be cached.
 */
function markerStamp(canonical: string): MarkerStamp | undefined {
	let directory = canonical;
	for (let depth = 0; depth < ANCESTOR_LIMIT; depth++) {
		const candidate = join(directory, ".git");
		const info = lstatSync(candidate, { bigint: true, throwIfNoEntry: false });
		if (info !== undefined) return markerAt(candidate, info, directory);
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	const bare = lstatSync(canonical, { bigint: true, throwIfNoEntry: false });
	if (bare === undefined || !bare.isDirectory()) return { kind: "none", path: canonical, revision: "" };
	return bareStamp(canonical) ?? { kind: "none", path: canonical, revision: "" };
}

/** Directory identity that follows the resolved path, not an earlier marker read. */
function repositoryIdentity(path: string): string | undefined {
	const info = statSync(path, { bigint: true, throwIfNoEntry: false });
	return info?.isDirectory() === true ? identityOf(info) : undefined;
}

interface CompletedLocation {
	readonly environment: string;
	readonly stamp: string;
	readonly repositoryRevision?: string;
	readonly location: PrimaryLocation;
}

class RepositoryLocationResolver implements PrimaryLocationResolver {
	private readonly completed = new Map<string, CompletedLocation>();
	private readonly pending = new Map<string, Promise<PrimaryLocation>>();
	private generation = 0;

	async resolve(cwd: string): Promise<PrimaryLocation> {
		const key = resolve(cwd);
		const cached = this.completed.get(key);
		if (cached !== undefined && await this.valid(key, cached)) {
			this.completed.delete(key);
			this.completed.set(key, cached);
			return { ...cached.location };
		}
		if (cached !== undefined) this.completed.delete(key);
		const pending = this.pending.get(key);
		if (pending !== undefined) return { ...(await pending) };
		const generation = this.generation;
		const load = this.load(key, generation);
		this.pending.set(key, load);
		try { return { ...(await load) }; }
		finally { if (this.pending.get(key) === load) this.pending.delete(key); }
	}

	invalidate(cwd?: string): void {
		this.generation++;
		if (cwd === undefined) { this.completed.clear(); return; }
		const key = resolve(cwd);
		let canonical = key;
		try { canonical = realpathSync(cwd); } catch { /* A missing path still invalidates its requested key. */ }
		for (const [candidate, entry] of this.completed) {
			if (candidate === key || candidate === canonical || entry.location.cwd === canonical || entry.location.cwd === key) this.completed.delete(candidate);
		}
	}

	clear(): void {
		this.generation++;
		this.completed.clear();
	}

	private async load(key: string, generation: number): Promise<PrimaryLocation> {
		const location = await discoverPrimaryLocation(key);
		if (generation !== this.generation || location.repositoryState === "unknown") return location;
		try {
			const stamp = markerStamp(location.cwd);
			if (stamp === undefined) return location;
			const repositoryRevision = location.repository === undefined ? undefined : repositoryIdentity(location.repository);
			if (location.repositoryState === "git" && repositoryRevision === undefined) return location;
			this.remember(key, { environment: discoveryEnvironment(), stamp: JSON.stringify(stamp), ...(repositoryRevision === undefined ? {} : { repositoryRevision }), location });
		} catch { /* A result without a trustworthy revision stays uncached. */ }
		return location;
	}

	private async valid(key: string, entry: CompletedLocation): Promise<boolean> {
		if (entry.environment !== discoveryEnvironment()) return false;
		let canonical: string;
		try { canonical = await realpath(key); }
		catch { return false; }
		if (canonical !== entry.location.cwd) return false;
		try {
			const stamp = markerStamp(canonical);
			if (stamp === undefined || JSON.stringify(stamp) !== entry.stamp) return false;
			if (entry.location.repositoryState !== "git") return true;
			return entry.location.repository !== undefined && entry.repositoryRevision !== undefined &&
				repositoryIdentity(entry.location.repository) === entry.repositoryRevision;
		} catch { return false; }
	}

	private remember(key: string, entry: CompletedLocation): void {
		this.completed.delete(key);
		this.completed.set(key, entry);
		while (this.completed.size > COMPLETED_LIMIT) {
			const oldest = this.completed.keys().next().value;
			if (oldest === undefined) break;
			this.completed.delete(oldest);
		}
	}
}

/** One resolver caches completed locations and shares one in-flight resolution per cwd. */
export function createPrimaryLocationResolver(): PrimaryLocationResolver {
	return new RepositoryLocationResolver();
}
