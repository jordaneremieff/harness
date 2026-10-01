/** Read published review coverage and the running Pi installation without changing either. */

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";

export const PI_RELEASE_NOTES_CAP_BYTES = 40_000;
export const PI_CHANGELOG_INPUT_CAP_BYTES = 2_000_000;
export const PI_COVERAGE_INPUT_CAP_BYTES = 128_000;
export const PI_RELEASE_HEADING_CAP = 512;
export const PI_COVERAGE_PATH = "docs/pi-durable-harness.md";
const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface PiReleaseIntakeOptions {
	harnessRoot: string;
	installedVersion?: string;
	installedPackageDir?: string;
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

export interface PiReleaseIntake {
	state: "aligned" | "behind" | "ahead" | "unavailable";
	installedVersion: string;
	baselineVersion?: string;
	baselineCommit?: string;
	baselinePath: string;
	changelogPath: string;
	releases: PiReleaseSection[];
	notesCut: boolean;
	reason?: string;
}

function versionParts(version: string): number[] {
	if (!VERSION_PATTERN.test(version)) throw new Error(`Unsupported release version: ${version.slice(0, 80)}`);
	const parts = version.split(".").map(Number);
	if (!parts.every(Number.isSafeInteger)) throw new Error("Release version exceeds numeric precision.");
	return parts;
}

function compareVersions(a: string, b: string): number {
	const left = versionParts(a);
	const right = versionParts(b);
	for (let index = 0; index < 3; index++) {
		if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
	}
	return 0;
}

async function git(root: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
		encoding: "utf8",
		timeout: 5_000,
		maxBuffer: PI_COVERAGE_INPUT_CAP_BYTES,
	});
	return stdout;
}

function commitId(output: string): string {
	const hash = output.trim();
	if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("Git did not return one commit identifier.");
	return hash;
}

async function publishedCoverageCommit(root: string): Promise<string> {
	const main = commitId(await git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]));
	const upstream = commitId(await git(root, ["rev-parse", "--verify", "main@{upstream}^{commit}"]));
	return commitId(await git(root, ["merge-base", main, upstream]));
}

async function reviewedThrough(root: string, commit: string): Promise<string> {
	const document = await git(root, ["show", `${commit}:${PI_COVERAGE_PATH}`]);
	const markers = document.split(/\r?\n/).filter((line) => line.includes("pi-release-reviewed-through:"));
	if (markers.length !== 1) throw new Error("Expected one reviewed-through marker in the published coverage document.");
	const match = /^<!-- pi-release-reviewed-through: (\S+) -->$/.exec(markers[0]);
	if (!match || match[1] === "unknown") throw new Error("Published Pi release review coverage is unknown.");
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
		if (compareVersions(headings[index - 1].version, headings[index].version) <= 0) {
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
		if (compareVersions(heading.version, baseline) <= 0 || compareVersions(heading.version, installed) > 0) continue;
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

/** Failures remain visible intake data; dispatch never advances review coverage. */
export async function readPiReleaseIntake(options: PiReleaseIntakeOptions): Promise<PiReleaseIntake> {
	const result: PiReleaseIntake = {
		state: "unavailable",
		installedVersion: options.installedVersion ?? VERSION,
		baselinePath: PI_COVERAGE_PATH,
		changelogPath: "",
		releases: [],
		notesCut: false,
	};
	let input = "installed Pi version";
	try {
		versionParts(result.installedVersion);
		result.changelogPath = join(options.installedPackageDir ?? getPackageDir(), "CHANGELOG.md");
		input = "published review coverage (main and its configured upstream)";
		result.baselineCommit = await publishedCoverageCommit(options.harnessRoot);
		result.baselineVersion = await reviewedThrough(options.harnessRoot, result.baselineCommit);
		const order = compareVersions(result.installedVersion, result.baselineVersion);
		if (order < 0) return { ...result, state: "ahead" };
		input = "installed Pi changelog";
		result.releases = collectReleases(
			await readChangelog(result.changelogPath),
			result.baselineVersion,
			result.installedVersion,
		);
		result.notesCut = capNotes(result.releases);
		result.state = order === 0 ? "aligned" : "behind";
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		result.reason = `${input}: ${detail.slice(0, 1_000)}`;
	}
	return result;
}
