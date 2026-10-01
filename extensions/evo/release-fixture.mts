import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_COVERAGE_PATH } from "./release.ts";

/** An isolated repository with a local upstream ref; no network or operator settings. */
export function releaseFixture(baseline = "0.99.0", changelog?: string) {
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
	function commit(): void {
		git("add", "docs", "package-lock.json");
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
	writeFileSync(
		join(root, "package-lock.json"),
		JSON.stringify({
			packages: { "node_modules/@earendil-works/pi-coding-agent": { version: "0.99.2" } },
		}),
	);
	commit();
	publish();
	if (changelog !== undefined) writeFileSync(join(installedPackageDir, "CHANGELOG.md"), changelog);
	return {
		root,
		installedPackageDir,
		git,
		marker,
		commit,
		publish,
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}
