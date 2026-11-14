import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { PI_COVERAGE_PATH, PI_REGISTRY } from "./release.ts";

/** Lockfile entries keyed by package path below `node_modules/`, for example `@earendil-works/pi-ai`. */
export type FixtureGraph = Record<string, string>;

export const FIXTURE_MANIFEST = {
	name: "fixture-harness",
	dependencies: { "@earendil-works/pi-durable": "*", "left-pad": "1.0.0" },
	peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
};

/** An isolated repository with a local upstream ref; no network or operator settings. */
export function releaseFixture(
	baseline = "0.99.0",
	changelog?: string,
	graph: FixtureGraph = { "@earendil-works/pi-coding-agent": "0.99.2", "@earendil-works/pi-durable": "0.99.2" },
) {
	const root = mkdtempSync(join(tmpdir(), "evo-release-"));
	const installedPackageDir = join(root, "installed");
	function git(...args: string[]): string {
		return execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 128_000,
		});
	}
	function marker(version: string): void {
		writeFileSync(
			join(root, PI_COVERAGE_PATH),
			`# Pi host contracts\n\n<!-- pi-release-reviewed-through: ${version} -->\n`,
		);
	}
	function manifest(value: unknown = FIXTURE_MANIFEST): void {
		writeFileSync(join(root, "package.json"), `${JSON.stringify(value, null, "\t")}\n`);
	}
	function lockfile(entries: FixtureGraph): void {
		const packages: Record<string, { version: string }> = {};
		for (const [path, version] of Object.entries(entries)) packages[`node_modules/${path}`] = { version };
		writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages }, null, "\t")}\n`);
	}
	function commit(): void {
		git("add", "docs", "package.json", "package-lock.json");
		git("commit", "--quiet", "-m", "Declare release coverage");
	}
	function publish(): void {
		git("update-ref", "refs/remotes/fixture/main", "HEAD");
	}
	mkdirSync(join(root, "docs"));
	mkdirSync(installedPackageDir);
	git("init", "--quiet", "--initial-branch=main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "commit.gpgSign", "false");
	git("config", "core.hooksPath", join(root, "no-hooks"));
	git("config", "remote.fixture.url", "./no-network");
	git("config", "remote.fixture.fetch", "+refs/heads/*:refs/remotes/fixture/*");
	git("config", "branch.main.remote", "fixture");
	git("config", "branch.main.merge", "refs/heads/main");
	marker(baseline);
	manifest();
	lockfile(graph);
	commit();
	publish();
	if (changelog !== undefined) writeFileSync(join(installedPackageDir, "CHANGELOG.md"), changelog);
	return {
		root,
		installedPackageDir,
		git,
		marker,
		manifest,
		lockfile,
		commit,
		publish,
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** What the controlled registry does for one package. */
export type RegistryAnswer =
	| { latest: string }
	| { status: number }
	| { body: string }
	| { error: string; code?: string }
	| "hang";

export interface RegistryRequest {
	url: string;
	method: string;
	redirect: string | undefined;
}

const DIST_TAGS_PREFIX = `${PI_REGISTRY}/-/package/`;

/**
 * A registry transport with no network: each dist-tags request receives the answer
 * for its package, every request is recorded, and any other URL fails the read.
 * A hanging answer never settles and ignores cancellation, so only the reader's own
 * deadline can end it.
 */
function respond(result: RegistryAnswer): Promise<Response> {
	if (result === "hang") return new Promise<Response>(() => {});
	if ("latest" in result) return Promise.resolve(Response.json({ latest: result.latest, next: "0.0.1" }));
	if ("status" in result) return Promise.resolve(new Response("unavailable", { status: result.status }));
	if ("body" in result) {
		return Promise.resolve(new Response(result.body, { headers: { "content-type": "application/json" } }));
	}
	const cause = result.code ? { cause: Object.assign(new Error("cause"), { code: result.code }) } : {};
	return Promise.reject(new TypeError(result.error, cause));
}

export function registryFetch(answer: (name: string) => RegistryAnswer) {
	const requests: RegistryRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		requests.push({ url, method: init?.method ?? "GET", redirect: init?.redirect });
		if (!url.startsWith(DIST_TAGS_PREFIX) || !url.endsWith("/dist-tags")) throw new Error(`Unexpected request: ${url}`);
		return respond(answer(decodeURIComponent(url.slice(DIST_TAGS_PREFIX.length, -"/dist-tags".length))));
	};
	return { fetch, requests };
}

/**
 * Route the global fetch to a controlled registry for one test and leave offline mode
 * off for its duration; both are restored afterwards.
 */
export function controlledRegistry(t: TestContext, answer: (name: string) => RegistryAnswer) {
	const registry = registryFetch(answer);
	const original = globalThis.fetch;
	const offline = process.env.PI_OFFLINE;
	globalThis.fetch = registry.fetch;
	delete process.env.PI_OFFLINE;
	t.after(() => {
		globalThis.fetch = original;
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	});
	return registry;
}

const OBSERVED_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\b/g;

/** Observation times in kickoff text, in order of appearance. */
export function observedTimes(text: string): string[] {
	return text.match(OBSERVED_TIME) ?? [];
}

/** Kickoff text with observation times replaced, for comparing two reads of the same sources. */
export function withoutObservedTimes(text: string): string {
	return text.replace(OBSERVED_TIME, "<observed>");
}

/** The next patch release after `version`, so tests derive versions instead of pinning one. */
export function nextPatch(version: string): string {
	const [major, minor, patch] = version.split(".").map(Number);
	return `${major}.${minor}.${patch + 1}`;
}
