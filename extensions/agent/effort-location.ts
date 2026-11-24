/**
 * Repository location discovery for effort awareness.
 *
 * Git owns repository discovery. For the common layouts the resolver reads the entries that Git
 * reads during discovery, in Git's order, and answers without starting Git: at each directory from
 * the cwd up, a `.git` directory or `gitdir:` file whose Git directory has a valid HEAD, `objects`
 * and `refs` (through an optional `commondir`) and a config that Git reads without question,
 * owned by the current user, found before Git would stop at a filesystem boundary; or no `.git`
 * and no Git directory up to that boundary. Pointer paths resolve as the filesystem resolves them,
 * a symbolic link before a following `..`. Any other layout, an environment input that changes
 * discovery, a privileged process, or an entry that cannot be inspected asks Git
 * (`git rev-parse --git-common-dir`).
 *
 * A Git answer is cached and reused only while every input that can change it keeps the same
 * identity: the canonical cwd, the discovery environment, the nearest `.git` marker, the entries
 * that could make each directory below it a Git directory, the common-directory pointer, the
 * config, and the markers Git requires before it accepts a directory as a repository. Inputs are captured before and after discovery, so a result is never paired with a
 * stamp from a different repository state. When a marker identity cannot be established, the
 * caller gets a fresh uncached result instead of a guess.
 *
 * One batch canonicalises each directory once, reads each filesystem entry at most once, starts at
 * most LOCATION_BATCH_SPAWNS Git processes, LOCATION_SPAWN_CONCURRENCY at a time, the directories
 * asked longest ago first, and leaves the others unresolved for a later batch. An answer that cannot
 * be cached is kept for UNCACHED_LOCATION_MS, so later batches ask Git for other directories.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PrimaryRepositoryState } from "./primary-channel.ts";

export interface PrimaryLocation {
	readonly cwd: string;
	readonly repositoryState: PrimaryRepositoryState;
	readonly repository?: string;
}

/** Locations of one batch by the caller's cwd strings; `unresolved` directories wait for a later batch. */
export interface PrimaryLocationBatch {
	readonly locations: ReadonlyMap<string, PrimaryLocation>;
	readonly unresolved: number;
}

export interface PrimaryLocationResolver {
	resolve(cwd: string): Promise<PrimaryLocation>;
	/** Locations of many working directories, within one batch's Git bound. */
	resolveMany(cwds: Iterable<string>): Promise<PrimaryLocationBatch>;
	invalidate(cwd?: string): void;
	clear(): void;
}

/** Git answers kept; only layouts that the entry reads cannot settle need one. */
export const LOCATION_CACHE_ENTRIES = 16_384;
/** Git processes one batch starts at most. */
export const LOCATION_BATCH_SPAWNS = 16;
/** Git processes of one batch that run at the same time. */
const LOCATION_SPAWN_CONCURRENCY = 4;
/** Directories one batch reads between turns of the event loop. */
const BATCH_YIELD = 128;
/** How long a batch reuses a Git answer that cannot be cached before it asks Git again. */
export const UNCACHED_LOCATION_MS = 60_000;
/**
 * How long a batch reuses a directory's canonical path while the path still names the same
 * directory. Only a change of letter case in a component keeps the directory and changes the
 * spelling, so that change shows within this time.
 */
const CANONICAL_PATH_MS = 60_000;
const MARKER_BYTES = 4096;
/** A repository config larger than this asks Git. */
const CONFIG_BYTES = 64 * 1024;
/** Extensions that every Git release that knows them accepts in a repository of format version 0. */
const VERSION_0_EXTENSIONS = new Set(["noop", "preciousobjects", "partialclone", "worktreeconfig"]);
const ANCESTOR_LIMIT = 256;

function gitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	])
		delete env[key];
	return env;
}

/** Every sanitised environment input that can change repository discovery. */
function discoveryEnvironment(env: NodeJS.ProcessEnv): string {
	return Object.entries(env)
		.filter(([key, value]) => value !== undefined && (key === "PATH" || key.startsWith("GIT_")))
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join("\n");
}

/** Cached answers of one environment share one string. */
let internedEnvironment = "";
function interned(value: string): string {
	if (value !== internedEnvironment) internedEnvironment = value;
	return internedEnvironment;
}

/** Resolve one location without a shell, with bounded Git output and execution time. */
export async function discoverPrimaryLocation(cwd: string): Promise<PrimaryLocation> {
	let canonical: string;
	try {
		canonical = await realpath(cwd);
	} catch {
		return { cwd: resolve(cwd), repositoryState: "unknown" };
	}
	const result = await new Promise<{ common?: string; state: PrimaryRepositoryState }>((done) => {
		execFile(
			"git",
			["rev-parse", "--git-common-dir"],
			{ cwd: canonical, timeout: 1000, maxBuffer: MARKER_BYTES, encoding: "utf8", env: gitEnvironment() },
			(error, stdout, stderr) => {
				if (!error && stdout.trim()) done({ common: stdout.trim(), state: "git" });
				else
					done({
						state: error?.code === 128 && stderr.startsWith("fatal: not a git repository") ? "outside-git" : "unknown",
					});
			},
		);
	});
	if (!result.common) return { cwd: canonical, repositoryState: result.state };
	try {
		return { cwd: canonical, repository: await realpath(resolve(canonical, result.common)), repositoryState: "git" };
	} catch {
		return { cwd: canonical, repositoryState: "unknown" };
	}
}

/** Read one marker file without following a symlink or reading past its bound. */
function readMarker(path: string, limit = MARKER_BYTES): string | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > limit) return undefined;
		const bytes = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > limit) return undefined;
		return bytes.toString("utf8", 0, length);
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * The canonical path that a Git pointer file names, resolved as Git and the filesystem resolve it:
 * a relative path is appended to its base without normalisation, so a symbolic link resolves before
 * a following `..`. Undefined when it does not resolve.
 */
function pointerTarget(base: string, raw: string): string | undefined {
	return nativeRealpath(isAbsolute(raw) ? raw : `${base}/${raw}`);
}

/** A `..` component, which lexical joining would apply before the filesystem resolves a symbolic link. */
function climbs(raw: string): boolean {
	return raw.split("/").includes("..");
}

const CONFIG_ESCAPES: Readonly<Record<string, string>> = { "\\": "\\", '"': '"', n: "\n", t: "\t", b: "\b" };

/**
 * One config value as Git parses it, or undefined for a value this reader does not model: an
 * unterminated quote, an unknown escape, or a line continuation.
 */
function configValue(text: string): string | undefined {
	let value = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] as string;
		if (char === "\\") {
			const escaped = CONFIG_ESCAPES[text[++index] ?? ""];
			if (escaped === undefined) return undefined;
			value += escaped;
			continue;
		}
		if (!quoted && (char === "#" || char === ";")) break;
		if (char === '"') quoted = !quoted;
		else value += char;
	}
	return quoted ? undefined : value.replace(/^[ \t]+|[ \t]+$/gu, "");
}

/** One parsed config line: a section header, an entry, nothing, or undefined for a line this reader does not model. */
type ConfigLine =
	| { readonly section: string; readonly subsection: boolean }
	| { readonly key: string; readonly value: string };

function configLine(raw: string): ConfigLine | null | undefined {
	const line = raw.replace(/\r$/u, "").replace(/^[ \t]+/u, "");
	if (line === "" || line.startsWith("#") || line.startsWith(";")) return null;
	if (line.startsWith("[")) {
		const header = /^\[([A-Za-z0-9.-]+)(?:[ \t]+"(?:[^"\\\n]|\\.)*")?\][ \t]*(?:[#;].*)?$/u.exec(line);
		if (header === null) return undefined;
		const name = (header[1] as string).toLowerCase();
		return { section: name.split(".")[0] as string, subsection: name.includes(".") || line.includes('"') };
	}
	const entry = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*(.*)$/u.exec(line);
	if (entry === null) return undefined;
	const rest = entry[2] as string;
	// A key without `=` is a boolean true; anything else after the key must be `=` and a value.
	const value =
		rest === "" || rest.startsWith("#") || rest.startsWith(";")
			? ""
			: rest.startsWith("=")
				? configValue(rest.slice(1))
				: undefined;
	return value === undefined ? undefined : { key: (entry[1] as string).toLowerCase(), value };
}

/**
 * Whether Git accepts a repository's config without question: it parses, its format version is 0
 * or absent, and it names only extensions that version 0 accepts. Anything else, including a
 * construct this reader does not model, asks Git.
 */
function plainRepositoryFormat(text: string): boolean {
	let header: { readonly section: string; readonly subsection: boolean } | undefined;
	let version: string | undefined;
	for (const raw of text.split("\n")) {
		const line = configLine(raw);
		if (line === null) continue;
		if (line === undefined) return false;
		if ("section" in line) {
			header = line;
			continue;
		}
		if (header === undefined || !acceptedEntry(header, line.key)) return false;
		if (header.section === "core" && !header.subsection && line.key === "repositoryformatversion") version = line.value;
	}
	return version === undefined || version === "0";
}

/** An entry outside `extensions`, or an extension that version 0 accepts. */
function acceptedEntry(header: { readonly section: string; readonly subsection: boolean }, key: string): boolean {
	return header.section !== "extensions" || (!header.subsection && VERSION_0_EXTENSIONS.has(key));
}

function nativeRealpath(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
}

/** One entry: null when absent, undefined when it cannot be inspected. */
type Entry<T> = T | null | undefined;
/** The facts of one directory entry that Git's walk uses, kept small because a batch keeps many. */
interface Node {
	readonly kind: "directory" | "file" | "symlink" | "other";
	readonly dev: number;
	readonly ino: number;
	readonly uid: number;
}
function nodeOf(info: Stats): Node {
	const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
	return { kind, dev: info.dev, ino: info.ino, uid: info.uid };
}
/** The entry a path names after its symbolic links, or undefined when it cannot be inspected. */
function statNode(path: string): Node | undefined {
	try {
		const info = statSync(path, { throwIfNoEntry: false });
		return info === undefined ? undefined : nodeOf(info);
	} catch {
		return undefined;
	}
}
/** The outcome of Git's discovery walk from one directory upward. */
type Walk =
	| { readonly kind: "outside" }
	| { readonly kind: "git"; readonly repository: string }
	| { readonly kind: "ask" };
const OUTSIDE: Walk = { kind: "outside" };
const ASK: Walk = { kind: "ask" };

/**
 * The filesystem reads of one batch, each made at most once, so directories that share ancestors
 * or a repository share their reads. A later batch reads again.
 */
class Probe {
	readonly environment: string;
	/** No environment input changes Git's walk: no ceiling directories, no discovery across filesystems. */
	readonly plain: boolean;
	/** The effective user that Git's ownership check compares with; undefined for a privileged or unknown user. */
	readonly uid: number | undefined;
	private readonly entries = new Map<string, Entry<Node>>();
	private readonly bigEntries = new Map<string, Entry<BigIntStats>>();
	private readonly canonicals = new Map<string, Entry<string>>();
	private readonly walks = new Map<string, Walk>();
	private readonly repositories = new Map<string, string | undefined>();
	private readonly formats = new Map<string, boolean>();
	private readonly identities = new Map<string, string | undefined>();
	readonly markers = new Map<string, MarkerStamp | undefined>();
	readonly validities = new Map<string, string | undefined>();

	constructor() {
		const env = gitEnvironment();
		this.environment = interned(discoveryEnvironment(env));
		this.plain = env.GIT_CEILING_DIRECTORIES === undefined && env.GIT_DISCOVERY_ACROSS_FILESYSTEM === undefined;
		const uid = process.geteuid?.();
		this.uid = uid === undefined || uid === 0 ? undefined : uid;
	}

	lstat(path: string): Entry<Node> {
		if (this.entries.has(path)) return this.entries.get(path);
		let value: Entry<Node>;
		try {
			const info = lstatSync(path, { throwIfNoEntry: false });
			value = info === undefined ? null : nodeOf(info);
		} catch {
			value = undefined;
		}
		this.entries.set(path, value);
		return value;
	}

	lstatBig(path: string): Entry<BigIntStats> {
		if (this.bigEntries.has(path)) return this.bigEntries.get(path);
		let value: Entry<BigIntStats>;
		try {
			value = lstatSync(path, { bigint: true, throwIfNoEntry: false }) ?? null;
		} catch {
			value = undefined;
		}
		this.bigEntries.set(path, value);
		return value;
	}

	/** Record a canonical path that the caller already resolved. */
	known(path: string, canonical: string): void {
		this.canonicals.set(path, canonical);
	}

	/** Canonical path through the canonical parent: null when absent, undefined when it cannot be resolved. */
	canonical(path: string): Entry<string> {
		if (this.canonicals.has(path)) return this.canonicals.get(path);
		const info = this.lstat(path);
		const parent = dirname(path);
		let value: Entry<string>;
		if (info === null || info === undefined) value = info;
		else if (parent === path || info.kind === "symlink") value = nativeRealpath(path);
		else {
			const above = this.canonical(parent);
			value = typeof above === "string" ? join(above, basename(path)) : above;
		}
		this.canonicals.set(path, value);
		return value;
	}

	/** Directory identity that follows the resolved path, not an earlier marker read. */
	repositoryIdentity(path: string): string | undefined {
		if (this.identities.has(path)) return this.identities.get(path);
		let value: string | undefined;
		try {
			const info = statSync(path, { bigint: true, throwIfNoEntry: false });
			value = info?.isDirectory() === true ? identityOf(info) : undefined;
		} catch {
			value = undefined;
		}
		this.identities.set(path, value);
		return value;
	}

	/**
	 * Git's walk from one canonical directory upward on the cwd's device: `.git` first, then the
	 * directory itself as a Git directory, then the parent unless it lies on another device.
	 */
	walk(directory: string, device: number): Walk {
		const key = `${device}\u0000${directory}`;
		const known = this.walks.get(key);
		if (known !== undefined) return known;
		const git = this.lstat(join(directory, ".git"));
		let value: Walk;
		if (git === undefined) value = ASK;
		else if (git !== null) value = this.discovered(directory, git);
		// A HEAD here may make this directory a Git directory; Git decides that case.
		else if (this.lstat(join(directory, "HEAD")) !== null) value = ASK;
		else value = this.above(directory, device);
		this.walks.set(key, value);
		return value;
	}

	/** The walk from the parent, unless the root ends it or Git stops at a filesystem boundary. */
	private above(directory: string, device: number): Walk {
		const parent = dirname(directory);
		if (parent === directory) return OUTSIDE;
		const info = this.lstat(parent);
		if (!info) return ASK;
		return info.dev !== device ? OUTSIDE : this.walk(parent, device);
	}

	/** The repository that a `.git` entry in `directory` names, when Git would accept it without asking. */
	private discovered(directory: string, git: Node): Walk {
		if (git.uid !== this.uid) return ASK;
		const top = this.lstat(directory);
		if (!top || top.uid !== this.uid) return ASK;
		const gitDirectory =
			git.kind === "directory"
				? join(directory, ".git")
				: git.kind === "file"
					? this.gitfileTarget(directory)
					: undefined;
		const repository = gitDirectory === undefined ? undefined : this.repository(gitDirectory);
		return repository === undefined ? ASK : { kind: "git", repository };
	}

	/** The canonical Git directory that a `gitdir: ` file names, when the current user owns it. */
	private gitfileTarget(directory: string): string | undefined {
		const text = readMarker(join(directory, ".git"));
		if (text === undefined || !text.startsWith("gitdir: ")) return undefined;
		const raw = text.slice(8).replace(/[\r\n]+$/u, "");
		const target = raw ? pointerTarget(directory, raw) : undefined;
		const owner = target === undefined ? undefined : this.lstat(target);
		return owner && owner.uid === this.uid ? target : undefined;
	}

	/**
	 * The canonical common directory of a Git directory that Git accepts: HEAD names a ref under
	 * `refs/` or an object, and `objects` and `refs` are searchable in the common directory, which a
	 * `commondir` file can name. Undefined asks Git.
	 */
	private repository(gitDirectory: string): string | undefined {
		if (this.repositories.has(gitDirectory)) return this.repositories.get(gitDirectory);
		const common = this.validHead(gitDirectory) ? this.commonDirectory(gitDirectory) : undefined;
		let value: string | undefined;
		try {
			if (common !== undefined && this.plainFormat(common)) {
				accessSync(join(common, "objects"), constants.X_OK);
				accessSync(join(common, "refs"), constants.X_OK);
				value = common;
			}
		} catch {
			value = undefined;
		}
		this.repositories.set(gitDirectory, value);
		return value;
	}

	/**
	 * HEAD is a regular file that names a ref under `refs/` or an object, as Git validates it; Git's
	 * whitespace after `ref:` is space, tab, newline and carriage return only.
	 */
	private validHead(gitDirectory: string): boolean {
		const head = this.lstat(join(gitDirectory, "HEAD"));
		const text = head?.kind === "file" ? readMarker(join(gitDirectory, "HEAD")) : undefined;
		return text !== undefined && text.length >= 4 && /^(?:ref:[ \t\n\r]*refs\/|[0-9a-fA-F]{40})/u.test(text);
	}

	/** The canonical Git directory itself, or the canonical directory that its `commondir` file names. */
	private commonDirectory(gitDirectory: string): string | undefined {
		const pointer = this.lstat(join(gitDirectory, "commondir"));
		if (pointer === null) return gitDirectory;
		const named =
			pointer?.kind === "file" ? readMarker(join(gitDirectory, "commondir"))?.replace(/[\r\n]+$/u, "") : undefined;
		return named ? pointerTarget(gitDirectory, named) : undefined;
	}

	/** Whether the common directory's config is one that Git reads without question. */
	private plainFormat(common: string): boolean {
		const known = this.formats.get(common);
		if (known !== undefined) return known;
		const text = readMarker(join(common, "config"), CONFIG_BYTES);
		const value = text !== undefined && plainRepositoryFormat(text);
		this.formats.set(common, value);
		return value;
	}
}

/** The answer of the entries Git reads, or undefined when Git must answer. */
function readLocation(probe: Probe, key: string): PrimaryLocation | undefined {
	const canonical = probe.canonical(key);
	if (canonical === null) return { cwd: key, repositoryState: "unknown" };
	if (canonical === undefined) return undefined;
	const info = probe.lstat(canonical);
	if (!info) return undefined;
	if (info.kind !== "directory") return { cwd: canonical, repositoryState: "unknown" };
	if (!probe.plain || probe.uid === undefined) return undefined;
	const walk = probe.walk(canonical, info.dev);
	if (walk.kind === "outside") return { cwd: canonical, repositoryState: "outside-git" };
	if (walk.kind === "git") return { cwd: canonical, repositoryState: "git", repository: walk.repository };
	return undefined;
}

interface MarkerStamp {
	readonly kind: "none" | "directory" | "file" | "bare";
	readonly path: string;
	readonly revision: string;
	readonly target?: string;
	readonly targetRevision?: string;
	readonly common?: string;
	readonly validity?: string;
	/** Markers of the directories below the nearest `.git`, which Git also checks. */
	readonly passed?: readonly string[];
}

function identityOf(info: BigIntStats): string {
	return `${info.dev}:${info.ino}`;
}

function stampOfInfo(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** A directory Git requires either exists as a directory or does not satisfy that requirement. */
type MemberKind = "absent" | "directory" | "other";

/** Classify one required marker path; an unmodelled or uninspectable entry is uncertain. */
function memberKind(probe: Probe, path: string): MemberKind | undefined {
	const info = probe.lstatBig(path);
	if (info === undefined) return undefined;
	if (info === null) return "absent";
	if (info.isDirectory()) return "directory";
	if (info.isFile()) return "other";
	return undefined;
}

/** Read HEAD exactly as stored; null means absent and undefined means its content could not be read. */
function headContents(probe: Probe, path: string): string | null | undefined {
	const info = probe.lstatBig(path);
	if (info === undefined || info === null) return info;
	if (!info.isFile()) return undefined;
	return readMarker(path);
}

interface CommonMarkers {
	readonly resolved: string;
	readonly identity: string;
	readonly objects: MemberKind;
	readonly refs: MemberKind;
}

/** Resolve a commondir pointer target and describe its identity and required markers. */
function commonMarkers(probe: Probe, path: string, text: string): CommonMarkers | undefined {
	const resolved = pointerTarget(path, text.replace(/[\r\n]+$/u, ""));
	if (resolved === undefined) return undefined;
	const identity = probe.repositoryIdentity(resolved);
	if (identity === undefined) return undefined;
	const objects = memberKind(probe, join(resolved, "objects"));
	const refs = memberKind(probe, join(resolved, "refs"));
	if (objects === undefined || refs === undefined) return undefined;
	return { resolved, identity, objects, refs };
}

/**
 * Describe the entries Git checks before it accepts one directory as a repository: the exact
 * bounded HEAD contents at that directory, and `objects` and `refs` either there or, when a
 * `commondir` pointer exists, at the pointer's resolved target with its canonical path and
 * directory identity. Without HEAD no other entry can make the directory a repository. Undefined
 * means a marker cannot be classified or resolved, so its discovery result must not be cached.
 */
function directoryMarkers(probe: Probe, path: string): string | undefined {
	if (probe.validities.has(path)) return probe.validities.get(path);
	const value = describeDirectory(probe, path);
	probe.validities.set(path, value);
	return value;
}

/** Git reads the repository format from the common directory's config; null when it is absent. */
function configRevision(probe: Probe, common: string): string | null | undefined {
	const info = probe.lstatBig(join(common, "config"));
	return info === undefined || info === null ? info : stampOfInfo(info);
}

function describeDirectory(probe: Probe, path: string): string | undefined {
	const head = headContents(probe, join(path, "HEAD"));
	if (head === undefined) return undefined;
	if (head === null) return JSON.stringify({ head });
	const objects = memberKind(probe, join(path, "objects"));
	const refs = memberKind(probe, join(path, "refs"));
	if (objects === undefined || refs === undefined) return undefined;
	const pointer = join(path, "commondir");
	const pointerInfo = probe.lstatBig(pointer);
	if (pointerInfo === undefined) return undefined;
	let commondir: string | null = null;
	let common: CommonMarkers | undefined;
	if (pointerInfo !== null) {
		if (!pointerInfo.isFile()) return undefined;
		const text = readMarker(pointer);
		if (text === undefined) return undefined;
		commondir = text;
		common = commonMarkers(probe, path, text);
		if (common === undefined) return undefined;
	}
	const config = configRevision(probe, common?.resolved ?? path);
	if (config === undefined) return undefined;
	return JSON.stringify({ head, objects, refs, commondir, config, ...(common === undefined ? {} : { common }) });
}

function markerAt(probe: Probe, candidate: string, info: BigIntStats, directory: string): MarkerStamp | undefined {
	if (info.isDirectory()) {
		const markers = directoryMarkers(probe, candidate);
		return markers === undefined
			? undefined
			: { kind: "directory", path: candidate, revision: identityOf(info), validity: markers };
	}
	if (!info.isFile()) return undefined;
	const text = readMarker(candidate);
	if (text === undefined || !text.startsWith("gitdir: ")) return undefined;
	const raw = text.slice(8).replace(/[\r\n]+$/u, "");
	if (!raw) return undefined;
	// A target that does not resolve yet is watched at its lexical path, which names the same entry
	// as the filesystem's resolution only without a `..` component.
	const target = pointerTarget(directory, raw) ?? (climbs(raw) ? undefined : resolve(directory, raw));
	if (target === undefined) return undefined;
	const targetInfo = probe.lstatBig(target);
	const common = readMarker(join(target, "commondir"));
	const markers = directoryMarkers(probe, target);
	if (markers === undefined) return undefined;
	return {
		kind: "file",
		path: candidate,
		revision: stampOfInfo(info),
		target,
		...(targetInfo?.isDirectory() === true ? { targetRevision: identityOf(targetInfo) } : {}),
		...(common === undefined ? {} : { common }),
		validity: markers,
	};
}

/**
 * Describe the discovery inputs for one canonical cwd: the nearest `.git` marker, and the entries
 * that could make each directory below it a Git directory, which Git checks at every directory of
 * its walk. A directory whose own markers are present is reported as a bare repository; otherwise
 * only an absent `.git` along the ancestors is reported as none. Undefined means the marker identity
 * cannot be trusted, so its result must not be cached.
 */
function markerStamp(probe: Probe, canonical: string): MarkerStamp | undefined {
	const passed: string[] = [];
	let directory = canonical;
	for (let depth = 0; depth < ANCESTOR_LIMIT; depth++) {
		const candidate = join(directory, ".git");
		const info = probe.lstatBig(candidate);
		if (info === undefined) return undefined;
		if (info !== null) return nearestMarker(probe, candidate, info, directory, passed);
		const markers = directoryMarkers(probe, directory);
		if (markers === undefined) return undefined;
		passed.push(markers);
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	const bare = probe.lstatBig(canonical);
	if (bare === undefined) return undefined;
	if (bare === null || !bare.isDirectory()) return { kind: "none", path: canonical, revision: "", passed };
	const markers = directoryMarkers(probe, canonical);
	if (markers === undefined) return undefined;
	return { kind: "bare", path: canonical, revision: identityOf(bare), validity: markers, passed };
}

/** The stamp of a `.git` entry, shared by every cwd of a batch below it, with the directories one cwd passed. */
function nearestMarker(
	probe: Probe,
	candidate: string,
	info: BigIntStats,
	directory: string,
	passed: readonly string[],
): MarkerStamp | undefined {
	if (!probe.markers.has(candidate)) probe.markers.set(candidate, markerAt(probe, candidate, info, directory));
	const marker = probe.markers.get(candidate);
	return marker === undefined ? undefined : { ...marker, passed };
}

function stampDigest(stamp: MarkerStamp): string {
	return createHash("sha256").update(JSON.stringify(stamp)).digest("base64");
}

interface DiscoveryInputs {
	readonly canonical: string;
	readonly environment: string;
	readonly stamp: string;
}

/** A directory's canonical path and the identity of the directory it named. */
interface CanonicalPath {
	readonly canonical: string;
	readonly dev: number;
	readonly ino: number;
	readonly at: number;
}

/** A Git answer that cannot be cached: its inputs could not be stamped, or Git did not answer. */
interface UncachedLocation {
	readonly environment: string;
	readonly at: number;
	readonly location: PrimaryLocation;
}

interface CompletedLocation {
	readonly environment: string;
	/** Digest of the discovery inputs' marker stamp. */
	readonly stamp: string;
	readonly repositoryRevision?: string;
	readonly location: PrimaryLocation;
}

/** Capture the inputs a discovery result must stay paired with, from fresh reads. */
function inputs(path: string): DiscoveryInputs | undefined {
	const probe = new Probe();
	const canonical = probe.canonical(path);
	if (typeof canonical !== "string") return undefined;
	try {
		const stamp = markerStamp(probe, canonical);
		return stamp === undefined ? undefined : { canonical, environment: probe.environment, stamp: stampDigest(stamp) };
	} catch {
		return undefined;
	}
}

class RepositoryLocationResolver implements PrimaryLocationResolver {
	private readonly completed = new Map<string, CompletedLocation>();
	private readonly uncached = new Map<string, UncachedLocation>();
	private readonly canonicalPaths = new Map<string, CanonicalPath>();
	private readonly pending = new Map<string, Promise<PrimaryLocation>>();
	private readonly entries: number;
	private readonly now: () => number;
	private generation = 0;

	constructor(entries: number, now: () => number) {
		this.entries = entries;
		this.now = now;
	}

	/**
	 * One location. The cwd is canonicalised through the filesystem's asynchronous path first, as discovery
	 * always has been, so a caller resumes after pending I/O events whether or not Git runs.
	 */
	async resolve(cwd: string): Promise<PrimaryLocation> {
		const key = resolve(cwd);
		let canonical: string;
		try {
			canonical = await realpath(key);
		} catch {
			return { cwd: key, repositoryState: "unknown" };
		}
		const probe = new Probe();
		probe.known(key, canonical);
		return this.known(probe, key) ?? this.ask(key);
	}

	/**
	 * Locations of many directories. Each is canonicalised through the same filesystem call as
	 * `resolve`, so both name one directory the same way; a later batch reuses that path while it
	 * names the same directory, for CANONICAL_PATH_MS. Directories that need Git are asked longest ago
	 * first, never-asked ones before all others, so no batch repeats an earlier batch's window while
	 * other directories wait.
	 */
	async resolveMany(cwds: Iterable<string>): Promise<PrimaryLocationBatch> {
		const probe = new Probe();
		const now = this.now();
		const locations = new Map<string, PrimaryLocation>();
		const needGit: string[] = [];
		const keys = [...new Set(cwds)];
		for (let start = 0; start < keys.length; start += BATCH_YIELD) {
			const chunk = keys.slice(start, start + BATCH_YIELD);
			const canonicals = await this.canonicalise(probe, chunk, now);
			for (const cwd of chunk) {
				const key = resolve(cwd);
				const canonical = canonicals.get(cwd);
				// A directory that does not resolve is unknown, as Git discovery reports it.
				if (canonical === undefined) {
					locations.set(cwd, { cwd: key, repositoryState: "unknown" });
					continue;
				}
				probe.known(key, canonical);
				const known = this.known(probe, key) ?? this.held(key, probe.environment, now);
				this.rememberCanonical(probe, key, canonical, now);
				if (known === undefined) needGit.push(cwd);
				else locations.set(cwd, known);
			}
		}
		const askedAt = (cwd: string) => this.uncached.get(resolve(cwd))?.at ?? 0;
		const asked = needGit.sort((a, b) => askedAt(a) - askedAt(b)).slice(0, LOCATION_BATCH_SPAWNS);
		let next = 0;
		const worker = async () => {
			while (next < asked.length) {
				const cwd = asked[next++] as string;
				const key = resolve(cwd);
				const location = await this.ask(key);
				locations.set(cwd, location);
				if (this.completed.has(key)) this.uncached.delete(key);
				else this.hold(key, { environment: probe.environment, at: this.now(), location });
			}
		};
		await Promise.all(Array.from({ length: Math.min(LOCATION_SPAWN_CONCURRENCY, asked.length) }, worker));
		return { locations, unresolved: needGit.length - asked.length };
	}

	invalidate(cwd?: string): void {
		this.generation++;
		if (cwd === undefined) {
			this.completed.clear();
			this.uncached.clear();
			this.canonicalPaths.clear();
			return;
		}
		const key = resolve(cwd);
		let canonical = key;
		try {
			canonical = realpathSync(cwd);
		} catch {
			/* A missing path still invalidates its requested key. */
		}
		for (const [candidate, entry] of this.canonicalPaths)
			if (candidate === key || entry.canonical === canonical || entry.canonical === key)
				this.canonicalPaths.delete(candidate);
		for (const entries of [this.completed, this.uncached])
			for (const [candidate, entry] of entries) {
				if (
					candidate === key ||
					candidate === canonical ||
					entry.location.cwd === canonical ||
					entry.location.cwd === key
				)
					entries.delete(candidate);
			}
	}

	clear(): void {
		this.generation++;
		this.completed.clear();
		this.uncached.clear();
		this.canonicalPaths.clear();
	}

	/** Canonical paths of one chunk: remembered ones that still name their directory, the rest resolved now. */
	private async canonicalise(probe: Probe, chunk: readonly string[], now: number): Promise<Map<string, string>> {
		const canonicals = new Map<string, string>();
		const fresh: string[] = [];
		for (const cwd of chunk) {
			const remembered = this.rememberedCanonical(probe, resolve(cwd), now);
			if (remembered === undefined) fresh.push(cwd);
			else canonicals.set(cwd, remembered);
		}
		if (fresh.length === 0) {
			await new Promise<void>((done) => setImmediate(done));
			return canonicals;
		}
		const resolved = await Promise.all(fresh.map((cwd) => realpath(resolve(cwd)).catch(() => undefined)));
		for (const [index, cwd] of fresh.entries()) {
			const canonical = resolved[index];
			if (canonical !== undefined) canonicals.set(cwd, canonical);
		}
		return canonicals;
	}

	private rememberedCanonical(probe: Probe, key: string, now: number): string | undefined {
		const entry = this.canonicalPaths.get(key);
		if (entry === undefined || now - entry.at >= CANONICAL_PATH_MS) return undefined;
		const info = entry.canonical === key ? probe.lstat(key) : statNode(key);
		return info && info.dev === entry.dev && info.ino === entry.ino ? entry.canonical : undefined;
	}

	private rememberCanonical(probe: Probe, key: string, canonical: string, now: number): void {
		if (this.canonicalPaths.get(key)?.canonical === canonical) return;
		const info = probe.lstat(canonical);
		if (!info) return;
		this.canonicalPaths.delete(key);
		this.canonicalPaths.set(key, {
			canonical: canonical === key ? key : canonical,
			dev: info.dev,
			ino: info.ino,
			at: now,
		});
		while (this.canonicalPaths.size > this.entries) {
			const oldest = this.canonicalPaths.keys().next().value;
			if (oldest === undefined) break;
			this.canonicalPaths.delete(oldest);
		}
	}

	/** An answer that could not be cached, while it is recent and the environment is unchanged. */
	private held(key: string, environment: string, now: number): PrimaryLocation | undefined {
		const entry = this.uncached.get(key);
		if (entry === undefined || entry.environment !== environment || now - entry.at >= UNCACHED_LOCATION_MS)
			return undefined;
		return { ...entry.location };
	}

	private hold(key: string, entry: UncachedLocation): void {
		this.uncached.delete(key);
		this.uncached.set(key, entry);
		while (this.uncached.size > this.entries) {
			const oldest = this.uncached.keys().next().value;
			if (oldest === undefined) break;
			this.uncached.delete(oldest);
		}
	}

	/** The answer of the entries Git reads, or a cached Git answer whose inputs are unchanged; undefined asks Git. */
	private known(probe: Probe, key: string): PrimaryLocation | undefined {
		const read = readLocation(probe, key);
		if (read !== undefined) return read;
		const cached = this.completed.get(key);
		if (cached === undefined) return undefined;
		this.completed.delete(key);
		if (!this.valid(probe, key, cached)) return undefined;
		this.completed.set(key, cached);
		return { ...cached.location };
	}

	private async ask(key: string): Promise<PrimaryLocation> {
		const pending = this.pending.get(key);
		if (pending !== undefined) return { ...(await pending) };
		const load = this.load(key, this.generation);
		this.pending.set(key, load);
		try {
			return { ...(await load) };
		} finally {
			if (this.pending.get(key) === load) this.pending.delete(key);
		}
	}

	private async load(key: string, generation: number): Promise<PrimaryLocation> {
		const before = inputs(key);
		const location = await discoverPrimaryLocation(key);
		if (generation !== this.generation || location.repositoryState === "unknown") return location;
		const after = before === undefined ? undefined : inputs(location.cwd);
		if (
			before === undefined ||
			after === undefined ||
			after.canonical !== before.canonical ||
			after.environment !== before.environment ||
			after.stamp !== before.stamp
		)
			return location;
		const repositoryRevision =
			location.repository === undefined ? undefined : new Probe().repositoryIdentity(location.repository);
		// A result without a trustworthy revision stays uncached.
		if (location.repositoryState === "git" && repositoryRevision === undefined) return location;
		this.remember(key, {
			environment: after.environment,
			stamp: after.stamp,
			...(repositoryRevision === undefined ? {} : { repositoryRevision }),
			location,
		});
		return location;
	}

	private valid(probe: Probe, key: string, entry: CompletedLocation): boolean {
		if (entry.environment !== probe.environment) return false;
		if (probe.canonical(key) !== entry.location.cwd) return false;
		try {
			const stamp = markerStamp(probe, entry.location.cwd);
			if (stamp === undefined || stampDigest(stamp) !== entry.stamp) return false;
			if (entry.location.repositoryState !== "git") return true;
			return (
				entry.location.repository !== undefined &&
				entry.repositoryRevision !== undefined &&
				probe.repositoryIdentity(entry.location.repository) === entry.repositoryRevision
			);
		} catch {
			return false;
		}
	}

	private remember(key: string, entry: CompletedLocation): void {
		this.completed.delete(key);
		this.completed.set(key, entry);
		while (this.completed.size > this.entries) {
			const oldest = this.completed.keys().next().value;
			if (oldest === undefined) break;
			this.completed.delete(oldest);
		}
	}
}

/** One resolver caches Git answers and shares one in-flight Git resolution per cwd. */
export function createPrimaryLocationResolver(
	options: { cacheEntries?: number; now?: () => number } = {},
): PrimaryLocationResolver {
	return new RepositoryLocationResolver(options.cacheEntries ?? LOCATION_CACHE_ENTRIES, options.now ?? Date.now);
}
