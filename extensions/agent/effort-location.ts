/**
 * Repository location discovery with a validated short-lived cache.
 *
 * Git owns repository discovery. A completed result is reused only while every
 * input that can change its answer keeps the same identity: the canonical cwd,
 * the discovery environment, the nearest `.git` marker, the common-directory
 * pointer and the markers Git requires before it accepts a directory as a
 * repository. An unknown result is shared only while its resolution is in flight.
 *
 * The cache never answers with a result that a fresh Git invocation could
 * contradict. Inputs are captured before and after discovery, so a result is
 * never paired with a stamp from a different repository state. When a marker
 * identity cannot be established, the caller gets a fresh uncached result
 * instead of a guess.
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
	readonly validity?: string;
}

function identityOf(info: BigIntStats): string {
	return `${info.dev}:${info.ino}`;
}

function stampOfInfo(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** Whether Git accepts a directory's HEAD as a symbolic ref, an object ID, or neither. */
type HeadKind = "absent" | "symbolic" | "object-id" | "invalid";

/** A directory Git requires either exists as a directory or does not satisfy that requirement. */
type MemberKind = "absent" | "directory" | "other";

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

/** Classify one required marker path; an unmodelled or uninspectable entry is uncertain. */
function memberKind(path: string): MemberKind | undefined {
	let info: BigIntStats | undefined;
	try { info = lstatSync(path, { bigint: true, throwIfNoEntry: false }); }
	catch { return undefined; }
	if (info === undefined) return "absent";
	if (info.isDirectory()) return "directory";
	if (info.isFile()) return "other";
	return undefined;
}

/** Classify HEAD as Git's validity check reads it; undefined means its content could not be read. */
function headKind(path: string): HeadKind | undefined {
	let info: BigIntStats | undefined;
	try { info = lstatSync(path, { bigint: true, throwIfNoEntry: false }); }
	catch { return undefined; }
	if (info === undefined) return "absent";
	if (!info.isFile()) return undefined;
	const text = readMarker(path);
	if (text === undefined) return undefined;
	const line = text.split("\n", 1)[0]?.replace(/\r$/u, "") ?? "";
	if (/^ref:[ \t]*\S/u.test(line)) return "symbolic";
	if (/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\s*$/u.test(line)) return "object-id";
	return "invalid";
}

/**
 * Describe the entries Git checks before it accepts one directory as a
 * repository: HEAD at that directory, and `objects` and `refs` either there or,
 * when a `commondir` pointer exists, at the pointer's target. Undefined means a
 * marker cannot be classified, so its discovery result must not be cached.
 */
function directoryMarkers(path: string): { readonly head: HeadKind; readonly stamp: string } | undefined {
	const head = headKind(join(path, "HEAD"));
	if (head === undefined) return undefined;
	const objects = memberKind(join(path, "objects"));
	const refs = memberKind(join(path, "refs"));
	if (objects === undefined || refs === undefined) return undefined;
	const pointer = join(path, "commondir");
	let pointerInfo: BigIntStats | undefined;
	try { pointerInfo = lstatSync(pointer, { bigint: true, throwIfNoEntry: false }); }
	catch { return undefined; }
	let commondir: string | null = null;
	let common: { readonly objects: MemberKind; readonly refs: MemberKind } | undefined;
	if (pointerInfo !== undefined) {
		if (!pointerInfo.isFile()) return undefined;
		const text = readMarker(pointer);
		if (text === undefined) return undefined;
		commondir = text;
		const target = resolve(path, text.replace(/[\r\n]+$/u, ""));
		const commonObjects = memberKind(join(target, "objects"));
		const commonRefs = memberKind(join(target, "refs"));
		if (commonObjects === undefined || commonRefs === undefined) return undefined;
		common = { objects: commonObjects, refs: commonRefs };
	}
	return { head, stamp: JSON.stringify({ head, objects, refs, commondir, ...(common === undefined ? {} : { common }) }) };
}

function markerAt(candidate: string, info: BigIntStats, directory: string): MarkerStamp | undefined {
	if (info.isDirectory()) {
		const markers = directoryMarkers(candidate);
		return markers === undefined ? undefined : { kind: "directory", path: candidate, revision: identityOf(info), validity: markers.stamp };
	}
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
	const markers = directoryMarkers(target);
	if (markers === undefined) return undefined;
	return {
		kind: "file",
		path: candidate,
		revision: stampOfInfo(info),
		target,
		...(targetInfo?.isDirectory() === true ? { targetRevision: identityOf(targetInfo) } : {}),
		...(common === undefined ? {} : { common }),
		validity: markers.stamp,
	};
}

/**
 * Describe the discovery inputs for one canonical cwd. A directory whose own
 * markers Git accepts is reported as a bare repository; otherwise only an
 * absent `.git` along the ancestors is reported as none. Undefined means the
 * marker identity cannot be trusted, so its result must not be cached.
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
	const markers = directoryMarkers(canonical);
	if (markers === undefined) return undefined;
	if (markers.head !== "symbolic" && markers.head !== "object-id") return { kind: "none", path: canonical, revision: "" };
	return { kind: "bare", path: canonical, revision: identityOf(bare), validity: markers.stamp };
}

/** Directory identity that follows the resolved path, not an earlier marker read. */
function repositoryIdentity(path: string): string | undefined {
	const info = statSync(path, { bigint: true, throwIfNoEntry: false });
	return info?.isDirectory() === true ? identityOf(info) : undefined;
}

interface DiscoveryInputs {
	readonly canonical: string;
	readonly environment: string;
	readonly stamp: string;
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

	/** Capture the inputs a discovery result must stay paired with. */
	private async inputs(path: string): Promise<DiscoveryInputs | undefined> {
		let canonical: string;
		try { canonical = await realpath(path); }
		catch { return undefined; }
		const environment = discoveryEnvironment();
		try {
			const stamp = markerStamp(canonical);
			return stamp === undefined ? undefined : { canonical, environment, stamp: JSON.stringify(stamp) };
		} catch { return undefined; }
	}

	private async load(key: string, generation: number): Promise<PrimaryLocation> {
		const before = await this.inputs(key);
		const location = await discoverPrimaryLocation(key);
		if (generation !== this.generation || location.repositoryState === "unknown") return location;
		const after = before === undefined ? undefined : await this.inputs(location.cwd);
		if (before === undefined || after === undefined || after.canonical !== before.canonical || after.environment !== before.environment || after.stamp !== before.stamp) return location;
		try {
			const repositoryRevision = location.repository === undefined ? undefined : repositoryIdentity(location.repository);
			if (location.repositoryState === "git" && repositoryRevision === undefined) return location;
			this.remember(key, { environment: after.environment, stamp: after.stamp, ...(repositoryRevision === undefined ? {} : { repositoryRevision }), location });
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
