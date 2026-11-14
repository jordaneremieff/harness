/**
 * Read the Pi version facts that start an evo run without changing any of them:
 * latest publication, the running host, the checkout graph on local main, and
 * committed review coverage. Each fact keeps its own source and failure state.
 */

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";

export const PI_RELEASE_NOTES_CAP_BYTES = 40_000;
export const PI_CHANGELOG_INPUT_CAP_BYTES = 2_000_000;
export const PI_COVERAGE_INPUT_CAP_BYTES = 128_000;
export const PI_LOCKFILE_INPUT_CAP_BYTES = 2_000_000;
export const PI_RELEASE_HEADING_CAP = 512;
export const PI_COVERAGE_PATH = "docs/pi-durable-harness.md";
export const PI_MANIFEST_PATH = "package.json";
export const PI_LOCKFILE_PATH = "package-lock.json";
/** The package whose loaded module reports the running host's version. */
export const PI_HOST_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_REGISTRY = "https://registry.npmjs.org";
export const PI_PUBLICATION_TAG = "latest";
export const PI_PUBLICATION_DEADLINE_MS = 3_000;
export const PI_PUBLICATION_RESPONSE_CAP_BYTES = 16_000;
export const PI_PACKAGE_CAP = 32;
export const PI_NESTED_COPY_CAP = 8;
const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PI_PACKAGE_PATTERN = /^@earendil-works\/[a-z0-9][a-z0-9._-]{0,100}$/;
const REASON_CAP = 300;

export interface PiReleaseIntakeOptions {
	harnessRoot: string;
	installedVersion?: string;
	installedPackageDir?: string;
	/** Registry transport; the global fetch at call time when omitted. */
	fetch?: typeof globalThis.fetch;
	/** Clock for observation times. */
	now?: () => Date;
	/** Caller cancellation; it ends the publication read early. */
	signal?: AbortSignal;
	publicationDeadlineMs?: number;
}

export interface PiReleaseSection {
	version: string;
	date: string;
	/** One-based inclusive source lines, including the heading. */
	startLine: number;
	endLine: number;
	text: string;
	textComplete: boolean;
}

/** One package's version in one fact; `reason` replaces an unavailable version. */
export interface PiPackageVersion {
	name: string;
	version?: string;
	reason?: string;
}

/** The registry's `latest` dist-tag for each package, read once with one deadline. */
export interface PiPublication {
	state: "observed" | "partial" | "unavailable";
	registry: string;
	tag: string;
	observedAt: string;
	packages: PiPackageVersion[];
	reason?: string;
}

export interface PiDeclaredPackage extends PiPackageVersion {
	relation: "dependency" | "peer";
	range: string;
	/** Other resolved copies whose version differs from the top-level one. */
	nested: { path: string; version: string }[];
	nestedOmitted: number;
}

/** The declared Pi packages as the lockfile committed on local main resolves them. */
export interface PiCheckoutGraph {
	state: "observed" | "unavailable";
	commit?: string;
	manifestPath: string;
	lockfilePath: string;
	observedAt: string;
	packages: PiDeclaredPackage[];
	reason?: string;
}

export interface PiReleaseIntake {
	/** Review coverage compared with the running host. */
	state: "aligned" | "behind" | "ahead" | "unavailable";
	installedVersion: string;
	installedPackageDir: string;
	baselineVersion?: string;
	baselineCommit?: string;
	baselinePath: string;
	changelogPath: string;
	releases: PiReleaseSection[];
	notesCut: boolean;
	reason?: string;
	publication: PiPublication;
	graph: PiCheckoutGraph;
}

function versionParts(version: string): number[] {
	if (!VERSION_PATTERN.test(version)) throw new Error(`Unsupported release version: ${version.slice(0, 80)}`);
	const parts = version.split(".").map(Number);
	if (!parts.every(Number.isSafeInteger)) throw new Error("Release version exceeds numeric precision.");
	return parts;
}

/** True for a numeric major.minor.patch version within numeric precision. */
export function isReleaseVersion(version: string): boolean {
	try {
		versionParts(version);
		return true;
	} catch {
		return false;
	}
}

export function compareReleaseVersions(a: string, b: string): number {
	const left = versionParts(a);
	const right = versionParts(b);
	for (let index = 0; index < 3; index++) {
		if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
	}
	return 0;
}

function failure(error: unknown): string {
	if (!(error instanceof Error)) return String(error).slice(0, REASON_CAP);
	const cause = error.cause;
	const code =
		typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
			? ` (${cause.code})`
			: "";
	return `${error.message}${code}`.slice(0, REASON_CAP);
}

function observedAt(now: () => Date): string {
	return now().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function git(root: string, args: string[], maxBuffer = PI_COVERAGE_INPUT_CAP_BYTES): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
		encoding: "utf8",
		timeout: 5_000,
		maxBuffer,
	});
	return stdout;
}

function commitId(output: string): string {
	const hash = output.trim();
	if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("Git did not return one commit identifier.");
	return hash;
}

/** Review coverage and the checkout graph are facts of local main; pushing main is a separate fact. */
async function localMainCommit(root: string): Promise<string> {
	return commitId(await git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]));
}

async function reviewedThrough(root: string, commit: string): Promise<string> {
	const document = await git(root, ["show", `${commit}:${PI_COVERAGE_PATH}`]);
	const markers = document.split(/\r?\n/).filter((line) => line.includes("pi-release-reviewed-through:"));
	if (markers.length !== 1) throw new Error("Expected one reviewed-through marker in the committed coverage document.");
	const match = /^<!-- pi-release-reviewed-through: (\S+) -->$/.exec(markers[0]);
	if (!match || match[1] === "unknown") throw new Error("Pi release review coverage is unknown.");
	versionParts(match[1]);
	return match[1];
}

async function readChangelog(path: string): Promise<string> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(PI_CHANGELOG_INPUT_CAP_BYTES + 1);
		let used = 0;
		while (used < buffer.length) {
			const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
			if (bytesRead === 0) break;
			used += bytesRead;
		}
		if (used > PI_CHANGELOG_INPUT_CAP_BYTES) throw new Error("Installed changelog exceeds the input byte limit.");
		return buffer.subarray(0, used).toString("utf8");
	} finally {
		await file.close();
	}
}

interface Heading {
	version: string;
	date: string;
	line: number;
}

function parseHeadings(lines: string[]): Heading[] {
	const headings: Heading[] = [];
	for (const [index, line] of lines.entries()) {
		if (!/^\s*##(?:\s|$)/.test(line)) continue;
		const match = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(line);
		if (!match) throw new Error(`Unrecognized changelog release heading at line ${index + 1}.`);
		versionParts(match[1]);
		const timestamp = Date.parse(`${match[2]}T00:00:00Z`);
		if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== match[2]) {
			throw new Error(`Invalid changelog date at line ${index + 1}.`);
		}
		headings.push({ version: match[1], date: match[2], line: index + 1 });
		if (headings.length > PI_RELEASE_HEADING_CAP) throw new Error("Changelog exceeds the release heading limit.");
	}
	return headings;
}

function verifyOrder(headings: Heading[]): void {
	for (let index = 1; index < headings.length; index++) {
		if (compareReleaseVersions(headings[index - 1].version, headings[index].version) <= 0) {
			throw new Error(`Duplicate or out-of-order changelog release at line ${headings[index].line}.`);
		}
	}
}

/** JSON evidence lines cannot introduce trusted prompt headers or closing delimiters. */
export function releaseEvidenceString(value: string): string {
	return JSON.stringify(value).replace(
		/[<>&\u0085\u2028\u2029]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function capNotes(releases: PiReleaseSection[]): boolean {
	let remaining = PI_RELEASE_NOTES_CAP_BYTES;
	let cut = false;
	for (const release of releases) {
		const lines: string[] = [];
		for (const line of release.text.split("\n")) {
			const size = Buffer.byteLength(releaseEvidenceString(line), "utf8") + 1;
			if (cut || size > remaining) {
				cut = true;
				break;
			}
			lines.push(line);
			remaining -= size;
		}
		release.textComplete = !cut;
		release.text = lines.join("\n");
	}
	return cut;
}

function collectReleases(changelog: string, baseline: string, installed: string): PiReleaseSection[] {
	const lines = changelog.split(/\r?\n/);
	const headings = parseHeadings(lines);
	verifyOrder(headings);
	for (const version of [baseline, installed]) {
		if (!headings.some((heading) => heading.version === version)) {
			throw new Error(`Release boundary ${version} is absent from the installed changelog.`);
		}
	}
	const releases: PiReleaseSection[] = [];
	for (const [index, heading] of headings.entries()) {
		if (compareReleaseVersions(heading.version, baseline) <= 0 || compareReleaseVersions(heading.version, installed) > 0) {
			continue;
		}
		const endLine = (headings[index + 1]?.line ?? lines.length + 1) - 1;
		releases.push({
			version: heading.version,
			date: heading.date,
			startLine: heading.line,
			endLine,
			text: lines.slice(heading.line - 1, endLine).join("\n"),
			textComplete: true,
		});
	}
	releases.reverse();
	return releases;
}

type ReviewCoverage = Omit<PiReleaseIntake, "installedPackageDir" | "publication" | "graph">;

async function readReviewCoverage(
	root: string,
	installedVersion: string,
	changelogPath: string,
	main: { commit?: string; error?: string },
	packageError: string | undefined,
): Promise<ReviewCoverage> {
	const result: ReviewCoverage = {
		state: "unavailable",
		installedVersion,
		baselinePath: PI_COVERAGE_PATH,
		changelogPath,
		releases: [],
		notesCut: false,
	};
	let input = "installed Pi version";
	try {
		versionParts(installedVersion);
		input = "review coverage committed on local main";
		if (main.commit === undefined) throw new Error(main.error ?? "Local main is unavailable.");
		result.baselineCommit = main.commit;
		result.baselineVersion = await reviewedThrough(root, main.commit);
		const order = compareReleaseVersions(installedVersion, result.baselineVersion);
		if (order < 0) return { ...result, state: "ahead" };
		input = "installed Pi changelog";
		if (packageError !== undefined) throw new Error(`The installed package directory is unavailable: ${packageError}`);
		result.releases = collectReleases(await readChangelog(changelogPath), result.baselineVersion, installedVersion);
		result.notesCut = capNotes(result.releases);
		result.state = order === 0 ? "aligned" : "behind";
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		result.reason = `${input}: ${detail.slice(0, 1_000)}`;
	}
	return result;
}

interface DeclaredPackage {
	name: string;
	relation: "dependency" | "peer";
	range: string;
}

function piDeclarations(entries: unknown, field: string, relation: DeclaredPackage["relation"]): DeclaredPackage[] {
	if (entries === undefined) return [];
	if (!isRecord(entries)) throw new Error(`The manifest field ${field} is not an object.`);
	const declared: DeclaredPackage[] = [];
	for (const [name, range] of Object.entries(entries)) {
		if (!name.startsWith("@earendil-works/")) continue;
		if (!PI_PACKAGE_PATTERN.test(name) || typeof range !== "string") {
			throw new Error(`The manifest field ${field} holds an unsupported Pi declaration.`);
		}
		declared.push({ name, relation, range: range.slice(0, 80) });
	}
	return declared;
}

/** The repository's own Pi declarations: its @earendil-works dependencies and peers. */
function declaredPiPackages(manifest: string): DeclaredPackage[] {
	const parsed: unknown = JSON.parse(manifest);
	if (!isRecord(parsed)) throw new Error("The manifest is not a JSON object.");
	const declared = new Map<string, DeclaredPackage>();
	for (const entry of [
		...piDeclarations(parsed.dependencies, "dependencies", "dependency"),
		...piDeclarations(parsed.peerDependencies, "peerDependencies", "peer"),
	]) {
		if (!declared.has(entry.name)) declared.set(entry.name, entry);
	}
	if (declared.size > PI_PACKAGE_CAP) throw new Error(`The manifest declares more than ${PI_PACKAGE_CAP} Pi packages.`);
	return [...declared.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function recordedVersion(record: unknown): string | undefined {
	return isRecord(record) && typeof record.version === "string" ? record.version : undefined;
}

/** Copies installed below other packages whose version differs from the top-level copy. */
function nestedCopies(packages: Record<string, unknown>, top: string, recorded: string | undefined) {
	const nested: PiDeclaredPackage["nested"] = [];
	let nestedOmitted = 0;
	for (const path of Object.keys(packages)) {
		if (path === top || !path.endsWith(`/${top}`)) continue;
		const version = recordedVersion(packages[path])?.slice(0, 80) ?? "unrecorded";
		if (version === recorded) continue;
		if (nested.length < PI_NESTED_COPY_CAP) nested.push({ path: path.slice(0, 300), version });
		else nestedOmitted++;
	}
	return { nested, nestedOmitted };
}

function resolvedPackages(lockfile: string, declared: DeclaredPackage[]): PiDeclaredPackage[] {
	const parsed: unknown = JSON.parse(lockfile);
	if (!isRecord(parsed) || !isRecord(parsed.packages)) throw new Error("The lockfile has no packages map.");
	const packages = parsed.packages;
	return declared.map((entry) => {
		const top = `node_modules/${entry.name}`;
		const recorded = recordedVersion(packages[top]);
		const resolved =
			recorded !== undefined && isReleaseVersion(recorded)
				? { version: recorded }
				: { reason: packages[top] === undefined ? "absent from the lockfile" : "the lockfile records no supported version" };
		return { ...entry, ...resolved, ...nestedCopies(packages, top, recorded) };
	});
}

async function readCheckoutGraph(
	root: string,
	main: { commit?: string; error?: string },
	declared: { packages: DeclaredPackage[]; error?: string },
	now: () => Date,
): Promise<PiCheckoutGraph> {
	const graph = { manifestPath: PI_MANIFEST_PATH, lockfilePath: PI_LOCKFILE_PATH };
	if (main.commit === undefined) {
		return { ...graph, state: "unavailable", observedAt: observedAt(now), packages: [], reason: `local main: ${main.error}` };
	}
	if (declared.error !== undefined) {
		const reason = `${PI_MANIFEST_PATH} at ${main.commit}: ${declared.error}`;
		return { ...graph, state: "unavailable", commit: main.commit, observedAt: observedAt(now), packages: [], reason };
	}
	try {
		const lockfile = await git(root, ["show", `${main.commit}:${PI_LOCKFILE_PATH}`], PI_LOCKFILE_INPUT_CAP_BYTES);
		const packages = resolvedPackages(lockfile, declared.packages);
		return { ...graph, state: "observed", commit: main.commit, observedAt: observedAt(now), packages };
	} catch (error) {
		return {
			...graph,
			state: "unavailable",
			commit: main.commit,
			observedAt: observedAt(now),
			packages: declared.packages.map((entry) => ({ ...entry, reason: "lockfile unavailable", nested: [], nestedOmitted: 0 })),
			reason: `${PI_LOCKFILE_PATH} at ${main.commit}: ${failure(error)}`,
		};
	}
}

/** Pi's CLI enables offline mode for `--offline` and for these PI_OFFLINE values. */
function offlineMode(): boolean {
	const value = process.env.PI_OFFLINE?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export function distTagsUrl(name: string): string {
	return `${PI_REGISTRY}/-/package/${name.replace("/", "%2f")}/dist-tags`;
}

async function boundedBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks).toString("utf8");
			size += value.byteLength;
			if (size > PI_PUBLICATION_RESPONSE_CAP_BYTES) {
				throw new Error(`The registry answer exceeds ${PI_PUBLICATION_RESPONSE_CAP_BYTES} bytes.`);
			}
			chunks.push(value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
	}
}

async function latestPublished(name: string, fetch: typeof globalThis.fetch, signal: AbortSignal): Promise<string> {
	const response = await fetch(distTagsUrl(name), {
		method: "GET",
		headers: { accept: "application/json" },
		redirect: "error",
		signal,
	});
	if (!response.ok) {
		void response.body?.cancel().catch(() => undefined);
		throw new Error(`The registry answered HTTP ${response.status}.`);
	}
	const tags: unknown = JSON.parse(await boundedBody(response));
	const latest = isRecord(tags) ? tags[PI_PUBLICATION_TAG] : undefined;
	if (typeof latest !== "string") throw new Error(`The registry answer names no ${PI_PUBLICATION_TAG} version.`);
	versionParts(latest);
	return latest;
}

/** A fact that covers only the host package when the declared set is unknown says so. */
function limitScope(publication: PiPublication, declaredError: string | undefined): PiPublication {
	if (declaredError === undefined || publication.state === "unavailable") return publication;
	return {
		...publication,
		state: "partial",
		reason: "Only the running host's package was read, because the declared package set on local main is unavailable.",
	};
}

/** One deadline bounds every request; a request that ignores cancellation cannot extend it. */
async function readPublication(
	names: string[],
	options: { fetch: typeof globalThis.fetch; now: () => Date; signal?: AbortSignal; deadlineMs: number },
): Promise<PiPublication> {
	const unavailable = (reason: string): PiPublication => ({
		state: "unavailable",
		registry: PI_REGISTRY,
		tag: PI_PUBLICATION_TAG,
		observedAt: observedAt(options.now),
		packages: names.map((name) => ({ name, reason })),
		reason,
	});
	if (offlineMode()) return unavailable("Pi offline mode (PI_OFFLINE or --offline) disables automatic network reads.");
	if (options.signal?.aborted) return unavailable("The caller cancelled the read.");
	const controller = new AbortController();
	const facts: PiPackageVersion[] = names.map((name) => ({ name }));
	let open = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopCancellation = () => {};
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, options.deadlineMs);
	});
	const cancellation = new Promise<void>((resolve) => {
		const cancel = () => resolve();
		options.signal?.addEventListener("abort", cancel, { once: true });
		stopCancellation = () => options.signal?.removeEventListener("abort", cancel);
	});
	const requests = Promise.all(
		names.map(async (name, index) => {
			try {
				const version = await latestPublished(name, options.fetch, controller.signal);
				if (open) facts[index] = { name, version };
			} catch (error) {
				if (open) facts[index] = { name, reason: failure(error) };
			}
		}),
	);
	try {
		await Promise.race([requests, deadline, cancellation]);
	} finally {
		open = false;
		clearTimeout(timer);
		stopCancellation();
		controller.abort();
	}
	const unanswered = options.signal?.aborted
		? "The caller cancelled the read."
		: `No registry answer within ${options.deadlineMs} ms.`;
	const packages = facts.map((fact) => (fact.version === undefined && fact.reason === undefined ? { ...fact, reason: unanswered } : fact));
	const observed = packages.filter((fact) => fact.version !== undefined).length;
	const publication: PiPublication = {
		state: observed === packages.length ? "observed" : observed === 0 ? "unavailable" : "partial",
		registry: PI_REGISTRY,
		tag: PI_PUBLICATION_TAG,
		observedAt: observedAt(options.now),
		packages,
	};
	if (publication.state === "unavailable") {
		const reasons = [...new Set(packages.map((fact) => fact.reason))];
		publication.reason = reasons.length === 1 ? reasons[0] : "The registry gave no version for any package.";
	}
	return publication;
}

function hostPackageDir(options: PiReleaseIntakeOptions): { dir: string; error?: string } {
	if (options.installedPackageDir !== undefined) return { dir: options.installedPackageDir };
	try {
		return { dir: getPackageDir() };
	} catch (error) {
		return { dir: "", error: failure(error) };
	}
}

/** Failures remain visible intake data; dispatch never installs packages or advances review coverage. */
export async function readPiReleaseIntake(options: PiReleaseIntakeOptions): Promise<PiReleaseIntake> {
	const now = options.now ?? (() => new Date());
	const installedVersion = options.installedVersion ?? VERSION;
	const host = hostPackageDir(options);
	const changelogPath = host.dir === "" ? "" : join(host.dir, "CHANGELOG.md");
	const main: { commit?: string; error?: string } = {};
	try {
		main.commit = await localMainCommit(options.harnessRoot);
	} catch (error) {
		main.error = failure(error);
	}
	const declared: { packages: DeclaredPackage[]; error?: string } = { packages: [] };
	if (main.commit !== undefined) {
		try {
			declared.packages = declaredPiPackages(await git(options.harnessRoot, ["show", `${main.commit}:${PI_MANIFEST_PATH}`]));
		} catch (error) {
			declared.error = failure(error);
		}
	}
	const names = [...new Set([PI_HOST_PACKAGE, ...declared.packages.map((entry) => entry.name)])].sort();
	const [coverage, graph, publication] = await Promise.all([
		readReviewCoverage(options.harnessRoot, installedVersion, changelogPath, main, host.error),
		readCheckoutGraph(options.harnessRoot, main, declared, now),
		readPublication(names, {
			fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
			now,
			signal: options.signal,
			deadlineMs: options.publicationDeadlineMs ?? PI_PUBLICATION_DEADLINE_MS,
		}),
	]);
	const declaredError = main.commit === undefined ? main.error : declared.error;
	return { ...coverage, installedPackageDir: host.dir, publication: limitScope(publication, declaredError), graph };
}
