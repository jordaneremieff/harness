import { execFile } from "node:child_process";
import { opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { readPrimaryEndpointDescriptor } from "./primary-channel.ts";
import type { PrimaryInfo, PrimaryObservedPurpose, PrimaryRepositoryState } from "./primary-channel.ts";
import type { Dirent } from "node:fs";

/** Session-written intent, never a verified host fact or a grant to its reader. */
export interface PrimaryIntentClaim {
	readonly purpose: string;
	readonly integration: string;
	readonly authority: string;
	readonly scope: { readonly paths: string[]; readonly branches: string[]; readonly fullGate?: boolean };
	readonly contactThread?: string;
	readonly updatedAt: string;
}

export type EffortPresenceSelf = Pick<PrimaryInfo, "id" | "cwd" | "repository" | "repositoryState" | "intentClaim" | "observedPurpose">;
export interface RelatedEffort {
	readonly id: string;
	readonly cwd: string;
	readonly name?: string;
	readonly repository?: string;
	readonly repositoryState?: PrimaryRepositoryState;
	readonly startedAt: string;
	readonly lastActivityAt?: string;
	readonly intentClaim?: PrimaryIntentClaim;
	readonly observedPurpose?: PrimaryObservedPurpose;
	readonly liveness: "live" | "unknown" | "incompatible";
	readonly relationship: "repository" | "cwd" | "machine";
	readonly purposeClaim?: string;
	readonly contactThreadClaim?: string;
	readonly intentUpdatedAt?: string;
	readonly sharedSubstrates?: ("repository" | "cwd" | "machine-gates")[];
	readonly overlap?: { readonly basis: "intentClaim"; readonly paths: string[]; readonly branches: string[] };
}
export interface EffortPresenceCoverage {
	visited: number;
	unreadable: number;
	dead: number;
	unrelated: number;
	omitted: number;
	complete: boolean;
	reasons: string[];
}
export interface EffortPresencePage {
	readonly efforts: RelatedEffort[];
	readonly coverage: EffortPresenceCoverage;
	readonly limits: { readonly visits: number; readonly results: number; readonly bytes: number };
}
export const EFFORT_PRESENCE_LIMITS = { visits: 256, results: 20, bytes: 16 * 1024 } as const;

function gitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
	return env;
}

/** Resolve one location without a shell, with bounded Git output and execution time. */
export async function discoverPrimaryLocation(cwd: string): Promise<{ cwd: string; repository?: string; repositoryState: PrimaryRepositoryState }> {
	let canonical: string;
	try { canonical = await realpath(cwd); }
	catch { return { cwd: resolve(cwd), repositoryState: "unknown" }; }
	const result = await new Promise<{ common?: string; state: PrimaryRepositoryState }>((done) => {
		execFile("git", ["rev-parse", "--git-common-dir"], { cwd: canonical, timeout: 1000, maxBuffer: 4096, encoding: "utf8", env: gitEnvironment() }, (error, stdout, stderr) => {
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

/** Exact paths and component-boundary prefixes only; wildcard strings are not interpreted. */
function pathIntersection(a: string, b: string): string | undefined {
	const left = a.replace(/\/+$/u, "") || "/";
	const right = b.replace(/\/+$/u, "") || "/";
	if (left === right) return left;
	if (right.startsWith(left === "/" ? "/" : `${left}/`)) return right;
	if (left.startsWith(right === "/" ? "/" : `${right}/`)) return left;
	return undefined;
}

function claimOverlap(self: PrimaryIntentClaim | undefined, other: PrimaryIntentClaim | undefined): RelatedEffort["overlap"] {
	if (!self || !other) return undefined;
	const paths = new Set<string>();
	for (const a of self.scope.paths) for (const b of other.scope.paths) {
		const match = pathIntersection(a, b);
		if (match && paths.size < 32) paths.add(match);
	}
	const branches = [...new Set(self.scope.branches.filter((branch) => other.scope.branches.includes(branch)))];
	return paths.size || branches.length ? { basis: "intentClaim", paths: [...paths], branches } : undefined;
}

function relation(self: EffortPresenceSelf, other: PrimaryInfo): RelatedEffort["relationship"] | undefined {
	if (self.repository && self.repository === other.repository) return "repository";
	if (self.cwd === other.cwd) return "cwd";
	return other.hostname === hostname() ? "machine" : undefined;
}

function markPartial(page: EffortPresencePage, reason: string): void {
	page.coverage.complete = false;
	if (!page.coverage.reasons.includes(reason)) page.coverage.reasons.push(reason);
}

function projectIntent(claim: PrimaryIntentClaim | undefined, relationship: RelatedEffort["relationship"]): Pick<RelatedEffort, "intentClaim" | "purposeClaim" | "contactThreadClaim" | "intentUpdatedAt"> {
	if (!claim) return {};
	if (relationship !== "machine") return { intentClaim: claim };
	return { purposeClaim: claim.purpose, ...(claim.contactThread === undefined ? {} : { contactThreadClaim: claim.contactThread }), intentUpdatedAt: claim.updatedAt };
}

function sharedSubstrates(self: EffortPresenceSelf, other: Pick<PrimaryInfo, "cwd" | "repository" | "intentClaim" | "hostname">): NonNullable<RelatedEffort["sharedSubstrates"]> {
	const shared: NonNullable<RelatedEffort["sharedSubstrates"]> = [];
	if (self.repository && self.repository === other.repository) shared.push("repository");
	if (self.cwd === other.cwd) shared.push("cwd");
	if (other.hostname === hostname() && (self.intentClaim?.scope.fullGate || other.intentClaim?.scope.fullGate)) shared.push("machine-gates");
	return shared;
}

function effortRow(info: PrimaryInfo, self: EffortPresenceSelf, liveness: RelatedEffort["liveness"], relationship: RelatedEffort["relationship"]): RelatedEffort {
	const { id, cwd, name, repository, repositoryState, startedAt, lastActivityAt, intentClaim, observedPurpose } = info;
	const overlap = relationship === "machine" ? undefined : claimOverlap(self.intentClaim, intentClaim);
	return {
		id, cwd, startedAt, liveness, relationship,
		...(name === undefined ? {} : { name }),
		...(repository === undefined ? {} : { repository }),
		...(repositoryState === undefined ? {} : { repositoryState }),
		...(lastActivityAt === undefined ? {} : { lastActivityAt }),
		...projectIntent(intentClaim, relationship),
		sharedSubstrates: sharedSubstrates(self, info),
		...(observedPurpose === undefined ? {} : { observedPurpose }),
		...(overlap === undefined ? {} : { overlap }),
	};
}

function appendEffort(page: EffortPresencePage, row: RelatedEffort): void {
	const reason = page.efforts.length >= page.limits.results ? "result-limit"
		: Buffer.byteLength(JSON.stringify([...page.efforts, row])) > page.limits.bytes - 1024 ? "byte-limit" : undefined;
	if (reason) {
		page.coverage.omitted += 1;
		markPartial(page, reason);
	} else page.efforts.push(row);
}

function visitEntry(sessionsRoot: string, self: EffortPresenceSelf, page: EffortPresencePage, entry: Dirent): void {
	page.coverage.visited += 1;
	const id = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : undefined;
	if (!entry.isFile() || id === undefined || id === self.id) {
		page.coverage.unrelated += 1;
		return;
	}
	const descriptor = readPrimaryEndpointDescriptor(sessionsRoot, id);
	if (descriptor.unreadable || !descriptor.info || descriptor.state === "absent") {
		page.coverage.unreadable += 1;
		markPartial(page, "unreadable");
		return;
	}
	if (descriptor.state === "dead") {
		page.coverage.dead += 1;
		return;
	}
	if (descriptor.info.repositoryState === "unknown") markPartial(page, "repository-unknown");
	const relationship = relation(self, descriptor.info);
	if (!relationship) { page.coverage.unrelated += 1; return; }
	appendEffort(page, effortRow(descriptor.info, self, descriptor.state, relationship));
}

/** Read-only presence page; no record is removed, even after failed delivery or unknown ownership. */
export async function readRelatedEfforts(sessionsRoot: string, self: EffortPresenceSelf): Promise<EffortPresencePage> {
	const page: EffortPresencePage = {
		efforts: [],
		coverage: { visited: 0, unreadable: 0, dead: 0, unrelated: 0, omitted: 0, complete: true, reasons: [] },
		limits: EFFORT_PRESENCE_LIMITS,
	};
	if (self.repositoryState === "unknown") markPartial(page, "repository-unknown");
	let directory: Awaited<ReturnType<typeof opendir>>;
	try {
		directory = await opendir(join(resolve(sessionsRoot), ".primaries"), { bufferSize: 16 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") markPartial(page, "directory-unreadable");
		return page;
	}
	try {
		for await (const entry of directory) {
			visitEntry(sessionsRoot, self, page, entry);
			if (page.coverage.visited >= page.limits.visits) { markPartial(page, "visit-limit"); break; }
		}
	} catch {
		markPartial(page, "directory-unreadable");
	}
	page.efforts.sort((a, b) => a.id.localeCompare(b.id));
	return page;
}
