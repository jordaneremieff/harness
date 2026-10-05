import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
	classifyCommitFiles,
	cleanGitEnvironment,
	hookContent,
	hookIsManaged,
	isDevRecordPath,
	parsePromoteArguments,
	parseSliceReference,
	parseWorktreePorcelain,
	promoteNameFromCwd,
	reconcilePackageEntries,
	worktreeExtensionName,
} from "./worktrees.mts";

interface ReconcileOverrides {
	forceActive?: readonly string[];
	forceInactive?: readonly string[];
}

interface SerializedPromotionReport {
	slices: Array<{
		name: string;
		kind: string;
		branch: string;
		promoted: string[];
		held: unknown[];
		gates: Record<string, string>;
		wouldPromote?: Array<{ dropped: string[] }>;
	}>;
	failedSlice?: string;
	name: string;
	kind: string;
	wouldPromote: Array<{ dropped: string[] }>;
	held: unknown[];
	ok: boolean;
	promoted: string[];
	gates: Record<string, string>;
	pushed: boolean;
	syncOk?: boolean;
	mainAfter: string;
	recover: string | null;
	stage: string;
	reason: string;
	branchFailures?: string[];
	deferred?: string[];
}

interface PromoteResult {
	report: SerializedPromotionReport;
	status: number | null;
}

const settingsDir = "/home/operator/.pi/agent";
const repoRoot = "/home/operator/Workspace/harness";
const worktreeRoot = "/home/operator/Workspace/harness.worktrees";
const entrypoints = new Map(
	["brave", "clipboard", "demo", "stash", "statusline", "tune", "workspace"].map((name) => [
		name,
		`${worktreeRoot}/${name}/extensions/${name}/index.ts`,
	]),
);

function reconcile(packages: readonly unknown[], options: ReconcileOverrides = {}) {
	return reconcilePackageEntries(packages, {
		settingsDir,
		repoRoot,
		worktreeRoot,
		mainExtensionNames: ["brave", "clipboard", "stash", "statusline"],
		entrypoints,
		...options,
	});
}

describe("hook ownership", () => {
	it("recognizes the current managed marker", () => {
		assert.equal(hookIsManaged("#!/bin/sh\n# managed by scripts/worktrees.mts\n"), true);
	});

	it("rejects hooks the installer did not write", () => {
		assert.equal(hookIsManaged("#!/bin/sh\n# my own hook\n"), false);
	});

	it("rejects an empty hook file", () => {
		assert.equal(hookIsManaged(""), false);
	});

	it("writes a body that resolves the main checkout at run time", () => {
		const content = hookContent();
		assert.equal(hookIsManaged(content), true);
		assert.match(content, /main\|extension\/\*\|skill\/\*\|prompt\/\*\|feature\/\*/);
		assert.match(content, /git rev-parse --path-format=absolute --git-common-dir/);
		assert.match(content, /exec node "\$script" sync --hook/);
		assert.equal(content.includes(fileURLToPath(new URL("./worktrees.mts", import.meta.url))), false);
	});
});

describe("slice references", () => {
	it("reads the kind and the name from a qualified reference", () => {
		assert.deepEqual(parseSliceReference("extension/stash"), { kind: "extension", name: "stash" });
		assert.deepEqual(parseSliceReference("feature/audit"), { kind: "feature", name: "audit" });
	});

	it("leaves the kind unresolved for a bare name", () => {
		assert.deepEqual(parseSliceReference("stash"), { name: "stash" });
	});

	it("rejects an unknown kind and an invalid name", () => {
		assert.throws(() => parseSliceReference("theme/dark"), /Unknown slice kind/);
		assert.throws(() => parseSliceReference("extension/Stash"), /lowercase/);
		assert.throws(() => parseSliceReference("-stash"), /lowercase/);
	});
});

describe("worktree parsing", () => {
	it("removes repository-local variables inherited from Git hooks", () => {
		const environment = cleanGitEnvironment({
			PATH: "/bin",
			GIT_DIR: ".git",
			GIT_INDEX_FILE: ".git/index",
			GIT_PREFIX: "extensions/stash/",
		});
		assert.deepEqual(environment, { PATH: "/bin" });
	});

	it("maps porcelain branch records to their worktrees", () => {
		const records = parseWorktreePorcelain(`worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo.worktrees/stash
HEAD def
branch refs/heads/extension/stash
`);
		assert.deepEqual(records, [
			{ path: "/repo", branch: "refs/heads/main" },
			{ path: "/repo.worktrees/stash", branch: "refs/heads/extension/stash" },
		]);
	});

	it("recognizes only a matching worktree entrypoint", () => {
		assert.equal(worktreeExtensionName(`${worktreeRoot}/stash/extensions/stash/index.ts`, worktreeRoot), "stash");
		assert.equal(worktreeExtensionName(`${worktreeRoot}/stash/extensions/clipboard/index.ts`, worktreeRoot), undefined);
	});
});

describe("development record classification", () => {
	it("treats extension development records as unshippable wherever they sit", () => {
		const records = [
			["extensions/demo/LOG.md", "extensions/demo"],
			["extensions/demo/PLAN.md", "extensions/demo"],
			["extensions/stash/AGENTS.md", "extensions/stash"],
			["extensions/stash/SOLUTION.md", "extensions/stash"],
			["extensions/demo/REWRITE-SPEC.md", "extensions/demo"],
			["extensions/demo/RELIABILITY-FINDINGS.md", "extensions/demo"],
		] as const;
		for (const [path, root] of records) {
			assert.equal(isDevRecordPath(path, root), true, path);
		}
	});

	it("treats any *FINDINGS.md basename under an extension as a dev record", () => {
		for (const path of [
			"extensions/demo/FINDINGS.md",
			"extensions/demo/EDGE-FINDINGS.md",
			"extensions/demo/reliability-FINDINGS.md",
		]) {
			assert.equal(isDevRecordPath(path, "extensions/demo"), true, path);
		}
		assert.equal(isDevRecordPath("extensions/demo/RELIABILITY-FINDINGS.md", "extensions/demo"), true);
		for (const path of ["extensions/demo/findings.md", "extensions/demo/FINDINGS.md.bak", "docs/FINDINGS.md"]) {
			assert.equal(isDevRecordPath(path, "extensions/demo"), false, path);
		}
	});

	it("recognizes skill development records under their own root", () => {
		for (const path of [
			"skills/demo/AGENTS.md",
			"skills/demo/LOG.md",
			"skills/demo/PLAN.md",
			"skills/demo/REWRITE-SPEC.md",
			"skills/demo/SOLUTION.md",
			"skills/demo/DEMO-FINDINGS.md",
		]) {
			assert.equal(isDevRecordPath(path, "skills/demo"), true, path);
		}
		for (const path of ["skills/demo/SKILL.md", "skills/demo/README.md", "skills/other/LOG.md"]) {
			assert.equal(isDevRecordPath(path, "skills/demo"), false, path);
		}
	});

	it("recognizes feature development records under the feature root", () => {
		for (const path of ["evals/AGENTS.md", "evals/PLAN.md", "evals/QUALITY-FINDINGS.md"]) {
			assert.equal(isDevRecordPath(path, "evals"), true, path);
		}
		for (const path of ["evals/README.md", "evals/runner.mts", "README.md", "docs/AGENTS.md"]) {
			assert.equal(isDevRecordPath(path, "evals"), false, path);
		}
	});

	it("ships everything from a prompt slice (no dev records)", () => {
		for (const path of ["prompts/drift.md", "prompts/AGENTS.md", "docs/prompts.md"]) {
			assert.equal(isDevRecordPath(path, null), false, path);
		}
	});

	it("ships ordinary extension sources, tests, and READMEs", () => {
		for (const path of [
			"extensions/clipboard/index.ts",
			"extensions/clipboard/panel.test.mts",
			"extensions/clipboard/README.md",
			"docs/conventions/worktrees.md",
			"AGENTS.md",
		]) {
			assert.equal(isDevRecordPath(path, "extensions/clipboard"), false, path);
		}
	});

	it("separates shipping commits, held commits, and commits needing a filter", () => {
		assert.equal(classifyCommitFiles(["extensions/demo/index.ts"], "extensions/demo").kind, "ship");
		assert.equal(classifyCommitFiles(["extensions/demo/LOG.md"], "extensions/demo").kind, "held");
		const mixed = classifyCommitFiles(["extensions/demo/index.ts", "extensions/demo/PLAN.md"], "extensions/demo");
		assert.equal(mixed.kind, "filter");
		assert.deepEqual(mixed.shipped, ["extensions/demo/index.ts"]);
		assert.deepEqual(mixed.devRecords, ["extensions/demo/PLAN.md"]);
	});

	it("classifies feature and skill commits by their own roots", () => {
		const feature = classifyCommitFiles(["evals/runner.mts", "evals/AGENTS.md"], "evals");
		assert.equal(feature.kind, "filter");
		assert.deepEqual(feature.shipped, ["evals/runner.mts"]);
		assert.deepEqual(feature.devRecords, ["evals/AGENTS.md"]);

		const skill = classifyCommitFiles(["skills/demo/SKILL.md"], "skills/demo");
		assert.equal(skill.kind, "ship");
		assert.equal(classifyCommitFiles(["skills/demo/LOG.md"], "skills/demo").kind, "held");

		const prompt = classifyCommitFiles(["prompts/drift.md"], null);
		assert.equal(prompt.kind, "ship");
		assert.deepEqual(prompt.devRecords, []);
	});
});

describe("promotion arguments", () => {
	it("defaults to pushing with gates and human output", () => {
		assert.deepEqual(parsePromoteArguments(["clipboard"]), {
			names: ["clipboard"],
			options: { push: true, gates: true, json: false, dryRun: false },
		});
	});

	it("accepts flags in any order and without a name", () => {
		assert.deepEqual(parsePromoteArguments(["--json", "--no-push"]).options, {
			push: false,
			gates: true,
			json: true,
			dryRun: false,
		});
		assert.deepEqual(parsePromoteArguments(["--dry-run", "stash"]).names, ["stash"]);
		assert.deepEqual(parsePromoteArguments(["a", "--no-push", "feature/b"]).names, ["a", "feature/b"]);
	});

	it("rejects unknown and repeated flags", () => {
		assert.throws(() => parsePromoteArguments(["--force"]), /Unknown promote flag/);
		assert.throws(() => parsePromoteArguments(["--json", "--json"]), /Repeated promote flag/);
	});

	it("reads the slice name from a worktree directory only", () => {
		assert.equal(promoteNameFromCwd(`${worktreeRoot}/stash`, worktreeRoot), "stash");
		assert.equal(promoteNameFromCwd(`${worktreeRoot}/stash/extensions`, worktreeRoot), "stash");
		assert.equal(promoteNameFromCwd(repoRoot, worktreeRoot), undefined);
		assert.equal(promoteNameFromCwd(worktreeRoot, worktreeRoot), undefined);
	});
});

describe("Pi package reconciliation", () => {
	it("routes loaded main extensions and existing worktree extensions through worktrees", () => {
		const result = reconcile([
			"../../Workspace/harness",
			"../../Workspace/harness.worktrees/demo/extensions/demo/index.ts",
			"git:github.com/example/theme",
		]);

		assert.deepEqual(result.activeNames, ["brave", "clipboard", "demo", "stash", "statusline"]);
		assert.deepEqual(result.packages, [
			{ source: "../../Workspace/harness", extensions: [] },
			"../../Workspace/harness.worktrees/brave/extensions/brave/index.ts",
			"../../Workspace/harness.worktrees/clipboard/extensions/clipboard/index.ts",
			"../../Workspace/harness.worktrees/demo/extensions/demo/index.ts",
			"../../Workspace/harness.worktrees/stash/extensions/stash/index.ts",
			"../../Workspace/harness.worktrees/statusline/extensions/statusline/index.ts",
			"git:github.com/example/theme",
		]);
	});

	it("keeps provisional worktrees out of Pi settings", () => {
		const result = reconcile([
			{ source: "../../Workspace/harness", extensions: [] },
			"../../Workspace/harness.worktrees/stash/extensions/stash/index.ts",
		]);

		assert.deepEqual(result.activeNames, ["stash"]);
		assert.equal(
			result.packages.some((entry) => String(entry).includes("tune")),
			false,
		);
		assert.equal(
			result.packages.some((entry) => String(entry).includes("workspace")),
			false,
		);
	});

	it("activates and deactivates provisional extensions explicitly", () => {
		const activated = reconcile([{ source: "../../Workspace/harness", extensions: [] }], { forceActive: ["tune"] });
		assert.deepEqual(activated.activeNames, ["tune"]);

		const deactivated = reconcile(activated.packages, { forceInactive: ["tune"] });
		assert.deepEqual(deactivated.activeNames, []);
		assert.deepEqual(deactivated.packages, [{ source: "../../Workspace/harness", extensions: [] }]);
	});

	it("produces the same package list on repeated reconciliation", () => {
		const first = reconcile([
			"../../Workspace/harness",
			"../../Workspace/harness.worktrees/demo/extensions/demo/index.ts",
		]);
		const second = reconcile(first.packages);
		assert.deepEqual(second, first);
	});
});

describe("promotion internal checkout hooks", () => {
	for (const { recordOnMain, json } of [
		{ recordOnMain: false, json: false },
		{ recordOnMain: false, json: true },
		{ recordOnMain: true, json: false },
		{ recordOnMain: true, json: true },
	]) {
		const outputFlags = json ? ["--json"] : [];
		it(`suppresses checkout hooks with a development record ${recordOnMain ? "on" : "absent from"} main (${json ? "JSON" : "text"} output)`, () => {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-checkout-hooks-")));
			try {
				const repo = join(root, "harness");
				const worktrees = join(root, "harness.worktrees");
				const target = join(worktrees, "target");
				const sibling = join(worktrees, "sibling");
				const hooks = join(root, "hooks");
				const marker = join(root, "checkout-hook");
				const gateMarker = join(root, "gate");
				const settings = join(root, "settings.json");
				const env = {
					...cleanGitEnvironment(process.env),
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_AUTHOR_NAME: "Fixture",
					GIT_AUTHOR_EMAIL: "fixture@example.com",
					GIT_COMMITTER_NAME: "Fixture",
					GIT_COMMITTER_EMAIL: "fixture@example.com",
					PI_HARNESS_ROOT: repo,
					PI_WORKTREE_ROOT: worktrees,
					PI_SETTINGS_PATH: settings,
					CHECKOUT_MARKER: marker,
					PI_PROMOTE_GATES: JSON.stringify([
						{
							name: "test",
							command: [
								process.execPath,
								"-e",
								"require('node:fs').writeFileSync(process.argv[1], 'passed')",
								gateMarker,
							],
						},
					]),
				};
				const git = (cwd: string, args: string[]): string =>
					execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
				mkdirSync(join(repo, "target"), { recursive: true });
				mkdirSync(join(repo, "extensions"));
				mkdirSync(hooks);
				git(repo, ["init", "-q", "-b", "main"]);
				git(repo, ["config", "core.hooksPath", hooks]);
				writeFileSync(join(repo, "target/code.txt"), "initial\n");
				if (recordOnMain) writeFileSync(join(repo, "target/LOG.md"), "main record\n");
				git(repo, ["add", "."]);
				git(repo, ["commit", "-q", "-m", "Initial feature"]);
				git(repo, ["worktree", "add", "-q", "-b", "feature/target", target]);
				git(repo, ["worktree", "add", "-q", "-b", "feature/sibling", sibling]);
				writeFileSync(join(target, "target/code.txt"), "shipped\n");
				writeFileSync(join(target, "target/LOG.md"), "branch record\n");
				git(target, ["add", "."]);
				git(target, ["commit", "-q", "-m", "Update feature and development record"]);
				writeFileSync(join(sibling, "target/code.txt"), "uncommitted sibling\n");
				const siblingBefore = git(repo, ["rev-parse", "feature/sibling"]);
				writeFileSync(settings, JSON.stringify({ packages: [{ source: repo, extensions: [] }] }));
				writeFileSync(
					join(hooks, "post-checkout"),
					'#!/bin/sh\nprintf "%s\\n" "$PWD" >> "$CHECKOUT_MARKER"\nexit 1\n',
					{
						mode: 0o755,
					},
				);
				const control = spawnSync("git", ["checkout", "HEAD", "--", "target/code.txt"], { cwd: repo, env });
				assert.equal(control.status, 1);
				assert.equal(readFileSync(marker, "utf8"), `${repo}\n`);
				rmSync(marker);

				const script = fileURLToPath(new URL("./worktrees.mts", import.meta.url));
				const result = spawnSync(process.execPath, [script, "promote", "feature/target", "--no-push", ...outputFlags], {
					cwd: repo,
					env,
					encoding: "utf8",
					timeout: 30_000,
				});
				assert.equal(existsSync(marker), false, result.stderr || result.stdout);
				assert.equal(result.status, 0, result.stderr || result.stdout);
				assert.equal(result.stderr, "");
				assert.equal(readFileSync(gateMarker, "utf8"), "passed");
				if (json) {
					const report: SerializedPromotionReport = JSON.parse(result.stdout);
					assert.equal(report.ok, true);
					assert.equal(report.gates.test, "pass");
					assert.equal(report.pushed, false);
					assert.equal(report.syncOk, true);
					assert.deepEqual(report.branchFailures, []);
					assert.deepEqual(report.deferred, ["sibling"]);
				} else {
					assert.match(result.stdout, /Promoted to main:/);
					assert.doesNotMatch(result.stdout, /sibling|Deferred/);
				}
				assert.equal(git(repo, ["rev-parse", "feature/sibling"]), siblingBefore);
				assert.equal(readFileSync(join(sibling, "target/code.txt"), "utf8"), "uncommitted sibling\n");
				assert.equal(readFileSync(join(repo, "target/code.txt"), "utf8"), "shipped\n");
				assert.equal(readFileSync(join(target, "target/LOG.md"), "utf8"), "branch record\n");
				assert.equal(git(target, ["status", "--porcelain"]), "");
				assert.equal(git(repo, ["diff", "--name-only", "main", "feature/target"]), "target/LOG.md");
				if (recordOnMain) assert.equal(readFileSync(join(repo, "target/LOG.md"), "utf8"), "main record\n");
				else assert.equal(existsSync(join(repo, "target/LOG.md")), false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});

describe("synchronization defers worktrees with uncommitted tracked changes", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-deferred-")));
	const repo = join(root, "harness");
	const worktrees = join(root, "harness.worktrees");
	const target = join(worktrees, "target");
	const sibling = join(worktrees, "sibling");
	const settings = join(root, "settings.json");
	const script = fileURLToPath(new URL("./worktrees.mts", import.meta.url));
	const env = {
		...cleanGitEnvironment(process.env),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
		PI_HARNESS_ROOT: repo,
		PI_WORKTREE_ROOT: worktrees,
		PI_SETTINGS_PATH: settings,
	};
	const git = (cwd: string, args: string[]): string =>
		execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const sync = (cwd: string, extra: string[] = []) =>
		spawnSync(process.execPath, [script, "sync", ...extra], { cwd, env, encoding: "utf8", timeout: 30_000 });

	before(() => {
		mkdirSync(join(repo, "target"), { recursive: true });
		mkdirSync(join(repo, "sibling"));
		mkdirSync(join(repo, "extensions"));
		mkdirSync(join(repo, "scripts"));
		writeFileSync(join(repo, "scripts/worktrees.mts"), readFileSync(script, "utf8"));
		git(repo, ["init", "-q", "-b", "main"]);
		writeFileSync(join(repo, "target/code.txt"), "initial\n");
		writeFileSync(join(repo, "sibling/code.txt"), "initial\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-q", "-m", "Initial features"]);
		git(repo, ["worktree", "add", "-q", "-b", "feature/target", target]);
		git(repo, ["worktree", "add", "-q", "-b", "feature/sibling", sibling]);
		writeFileSync(join(repo, "target/code.txt"), "main advanced\n");
		git(repo, ["commit", "-q", "-am", "Advance main"]);
		writeFileSync(join(target, "target/scratch.txt"), "untracked\n");
		writeFileSync(join(sibling, "sibling/code.txt"), "uncommitted sibling\n");
		writeFileSync(settings, JSON.stringify({ packages: [{ source: repo, extensions: [] }] }));
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	it("rebases an untracked-only worktree without a deferred sibling notice from main", () => {
		const result = sync(repo);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.match(result.stdout, /Updated from main: target/);
		assert.doesNotMatch(result.stdout, /sibling|Deferred/);
		assert.equal(git(repo, ["merge-base", "--is-ancestor", "main", "feature/target"]), "");
		assert.equal(git(repo, ["rev-parse", "feature/sibling"]), git(repo, ["rev-parse", "main~1"]));
		assert.equal(readFileSync(join(target, "target/scratch.txt"), "utf8"), "untracked\n");
		assert.equal(readFileSync(join(sibling, "sibling/code.txt"), "utf8"), "uncommitted sibling\n");
		rmSync(join(target, "target/scratch.txt"));
	});

	it("prints no notice from outside every worktree", () => {
		const result = sync(root);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.doesNotMatch(result.stdout, /sibling|Deferred/);
	});

	it("prints no notice from a current clean worktree", () => {
		assert.equal(git(target, ["status", "--porcelain"]), "");
		const result = sync(target);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.doesNotMatch(result.stdout, /sibling|Deferred/);
	});

	it("keeps hook runs silent about the deferred worktree", () => {
		const result = sync(sibling, ["--hook"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout, "");
	});

	it("tells the owner inside the deferred worktree, without a failure", () => {
		const result = sync(sibling);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.match(
			result.stdout,
			/^Deferred: sibling has uncommitted tracked changes and is behind main; commit them, then sync\.$/m,
		);
		assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("Deferred:")).length, 1);
		assert.equal(readFileSync(join(sibling, "sibling/code.txt"), "utf8"), "uncommitted sibling\n");
	});

	it("tells the owner from a subdirectory of the deferred worktree", () => {
		const result = sync(join(sibling, "sibling"));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.match(result.stdout, /^Deferred: sibling /m);
		assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("Deferred:")).length, 1);
	});

	it("reports the deferred worktree as behind and dirty without changing its branch", () => {
		const before = git(repo, ["rev-parse", "feature/sibling"]);
		const result = spawnSync(process.execPath, [script, "status"], {
			cwd: repo,
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(
			result.stdout.split("\n").find((line) => line.startsWith("feature\tsibling\t")),
			`feature\tsibling\tbehind\tdirty\tbranch\t${sibling}`,
		);
		assert.equal(git(repo, ["rev-parse", "feature/sibling"]), before);
		assert.equal(readFileSync(join(sibling, "sibling/code.txt"), "utf8"), "uncommitted sibling\n");
	});

	it("keeps the owner's partial commit hook silent while tracked changes remain", () => {
		writeFileSync(join(repo, ".git/hooks/post-commit"), hookContent(), { mode: 0o755 });
		writeFileSync(join(sibling, "partial.txt"), "partial commit\n");
		git(sibling, ["add", "partial.txt"]);
		const result = spawnSync("git", ["commit", "-q", "-m", "Commit one file"], {
			cwd: sibling,
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout, "");
		assert.equal(git(repo, ["merge-base", "main", "feature/sibling"]), git(repo, ["rev-parse", "main~1"]));
		assert.equal(readFileSync(join(sibling, "sibling/code.txt"), "utf8"), "uncommitted sibling\n");
	});

	it("reports a missing active entrypoint even when its tracked changes defer the branch", () => {
		const active = join(worktrees, "active");
		const entrypoint = join(active, "extensions/active/index.ts");
		git(repo, ["worktree", "add", "-q", "-b", "extension/active", active, "main~1"]);
		mkdirSync(dirname(entrypoint), { recursive: true });
		writeFileSync(entrypoint, "export default function active() {}\n");
		git(active, ["add", "extensions/active/index.ts"]);
		git(active, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Add active extension"]);
		const beforeHead = git(repo, ["rev-parse", "extension/active"]);
		rmSync(entrypoint);
		writeFileSync(settings, JSON.stringify({ packages: [{ source: repo, extensions: [] }, entrypoint] }));
		const beforeSettings = readFileSync(settings, "utf8");
		const result = sync(root);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Active extension has no worktree entrypoint: active/);
		assert.doesNotMatch(result.stdout, /Deferred/);
		assert.equal(git(repo, ["rev-parse", "extension/active"]), beforeHead);
		assert.equal(existsSync(entrypoint), false);
		assert.equal(readFileSync(settings, "utf8"), beforeSettings);
	});
});

describe("promotion against a real repository", () => {
	const script = fileURLToPath(new URL("./worktrees.mts", import.meta.url));
	let root: string;
	let repo: string;
	let worktrees: string;
	let origin: string;
	let demoTree: string;
	let otherTree: string;
	let featureTree: string;
	let guideTree: string;
	let promptTree: string;
	let env: NodeJS.ProcessEnv;

	const git = (args: readonly string[], cwd: string = repo): string =>
		execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
	const writeIn = (base: string, path: string, content: string): void => {
		mkdirSync(dirname(join(base, path)), { recursive: true });
		writeFileSync(join(base, path), content);
	};
	const commitIn = (base: string, message: string): void => {
		git(["add", "-A"], base);
		git(["commit", "-q", "-m", message], base);
	};
	const promote = (args: readonly string[], cwd: string = repo): PromoteResult => {
		try {
			const stdout = execFileSync(process.execPath, [script, "promote", ...args, "--json"], {
				cwd,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			const report: SerializedPromotionReport = JSON.parse(stdout);
			return { report, status: 0 };
		} catch (error) {
			if (
				error === null ||
				typeof error !== "object" ||
				!("stdout" in error) ||
				typeof error.stdout !== "string" ||
				error.stdout === "" ||
				!("status" in error) ||
				(typeof error.status !== "number" && error.status !== null)
			) {
				throw error;
			}
			const report: SerializedPromotionReport = JSON.parse(error.stdout);
			return { report, status: error.status };
		}
	};

	before(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-promote-")));
		repo = join(root, "harness");
		worktrees = join(root, "harness.worktrees");
		origin = join(root, "origin.git");
		const agent = join(root, "agent");
		demoTree = join(worktrees, "demo");
		otherTree = join(worktrees, "other");
		featureTree = join(worktrees, "reporting");
		guideTree = join(worktrees, "guide");
		promptTree = join(worktrees, "drift");
		env = {
			...process.env,
			PI_HARNESS_ROOT: repo,
			PI_WORKTREE_ROOT: worktrees,
			PI_AGENT_DIR: agent,
			PI_SETTINGS_PATH: join(agent, "settings.json"),
			PI_PROMOTE_GATES: JSON.stringify([{ name: "test", command: ["true"] }]),
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.com",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.com",
		};

		mkdirSync(repo, { recursive: true });
		mkdirSync(agent, { recursive: true });
		git(["init", "-q", "-b", "main"]);
		git(["config", "user.name", "Fixture"]);
		git(["config", "user.email", "fixture@example.com"]);
		writeIn(repo, "extensions/demo/index.ts", "export default function demo() { return {}; }\n");
		writeIn(repo, "package.json", '{"name":"harness","scripts":{}}\n');
		commitIn(repo, "feat(demo): initial");
		execFileSync("git", ["init", "-q", "--bare", origin], { env });
		git(["remote", "add", "origin", origin]);
		git(["push", "-q", "-u", "origin", "main"]);
		writeFileSync(
			join(agent, "settings.json"),
			`${JSON.stringify({ packages: [{ source: repo, extensions: [] }] }, null, 2)}\n`,
		);
		git(["branch", "extension/demo", "main"]);
		git(["worktree", "add", "-q", demoTree, "extension/demo"]);

		writeIn(demoTree, "extensions/demo/index.ts", "export default function demo() { return { ok: true }; }\n");
		commitIn(demoTree, "fix(demo): return a value");
		writeIn(demoTree, "extensions/demo/LOG.md", "# log\n");
		commitIn(demoTree, "docs(demo): log");
		writeIn(demoTree, "extensions/demo/panel.ts", "export const panel = 1;\n");
		writeIn(demoTree, "extensions/demo/LOG.md", "# updated log\n");
		writeIn(demoTree, "extensions/demo/PLAN.md", "# plan\n");
		commitIn(demoTree, "feat(demo): panel with development records");

		git(["branch", "extension/other", "main"]);
		git(["worktree", "add", "-q", otherTree, "extension/other"]);
		writeIn(otherTree, "extensions/other/index.ts", "export default function other() {}\n");
		writeIn(otherTree, "extensions/demo/index.ts", "export default function demo() { return { other: true }; }\n");
		commitIn(otherTree, "feat(other): add conflicting extension worktree");

		git(["branch", "feature/reporting", "main"]);
		git(["worktree", "add", "-q", featureTree, "feature/reporting"]);
		writeIn(featureTree, "reporting/cli.mts", "export const report = 1;\n");
		writeIn(featureTree, "reporting/AGENTS.md", "# plan\n");
		writeIn(featureTree, "package.json", '{"name":"harness","scripts":{"report":"node reporting/cli.mts"}}\n');
		commitIn(featureTree, "feat(reporting): add feature slice and script");

		git(["branch", "skill/guide", "main"]);
		git(["worktree", "add", "-q", guideTree, "skill/guide"]);
		writeIn(
			guideTree,
			"skills/guide/SKILL.md",
			"---\nname: guide\ndescription: Use when a fixture skill is required. Do not use it outside tests.\n---\n\n# guide\n\nFixture skill body.\n",
		);
		writeIn(guideTree, "skills/guide/AGENTS.md", "# development notes\n");
		commitIn(guideTree, "feat(guide): add skill with development records");

		git(["branch", "prompt/drift", "main"]);
		git(["worktree", "add", "-q", promptTree, "prompt/drift"]);
		writeIn(promptTree, "prompts/drift.md", "# drift\n\nFixture prompt body.\n");
		commitIn(promptTree, "feat(drift): add prompt slice");
	});

	after(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("plans without touching the repository and infers the name from the worktree", () => {
		const before = git(["rev-parse", "main"]);
		const { report } = promote(["demo", "--dry-run"]);
		assert.equal(report.wouldPromote.length, 2);
		assert.equal(report.held.length, 1);
		assert.deepEqual(report.wouldPromote[1].dropped, ["extensions/demo/LOG.md", "extensions/demo/PLAN.md"]);
		assert.equal(git(["rev-parse", "main"]), before);
		assert.equal(promote(["--dry-run"], demoTree).report.name, "demo");
	});

	it("finds main from a linked worktree without root overrides", () => {
		const linkedScript = join(demoTree, "scripts", "worktrees.mts");
		writeIn(demoTree, "scripts/worktrees.mts", readFileSync(script, "utf8"));
		writeIn(repo, ".git/info/exclude", "/scripts/\n");
		const directEnv = { ...env };
		delete directEnv.PI_HARNESS_ROOT;
		delete directEnv.PI_WORKTREE_ROOT;
		const before = git(["rev-parse", "main"]);
		let stdout = "";
		try {
			stdout = execFileSync(process.execPath, [linkedScript, "promote", "--dry-run", "--json"], {
				cwd: demoTree,
				env: directEnv,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} finally {
			rmSync(join(demoTree, "scripts"), { recursive: true, force: true });
		}
		const report: SerializedPromotionReport = JSON.parse(stdout);
		assert.equal(report.ok, true);
		assert.equal(report.name, "demo");
		assert.equal(report.kind, "extension");
		assert.equal(git(["rev-parse", "main"]), before);
	});

	it("lands shipped code, holds development records, and pushes", () => {
		const { report, status } = promote(["demo"]);
		assert.equal(status, 1);
		assert.equal(report.ok, true);
		assert.equal(report.promoted.length, 2);
		assert.equal(report.held.length, 1);
		assert.equal(report.gates.test, "pass");
		assert.equal(report.pushed, true);

		const tracked = git(["ls-tree", "-r", "--name-only", "main"]).split("\n");
		assert.ok(tracked.includes("extensions/demo/panel.ts"));
		assert.ok(!tracked.includes("extensions/demo/LOG.md"));
		assert.ok(!tracked.includes("extensions/demo/PLAN.md"));
		assert.equal(git(["rev-parse", "origin/main"]), git(["rev-parse", "main"]));
		assert.equal(readFileSync(join(demoTree, "extensions/demo/LOG.md"), "utf8"), "# updated log\n");
		assert.equal(readFileSync(join(demoTree, "extensions/demo/PLAN.md"), "utf8"), "# plan\n");
		git(["merge-base", "--is-ancestor", "main", "extension/demo"]);

		const remaining = git(["diff", "--name-only", "--no-renames", "main", "extension/demo"])
			.split("\n")
			.filter(Boolean);
		assert.ok(
			remaining.every((path) => isDevRecordPath(path, "extensions/demo")),
			remaining.join(","),
		);
		assert.ok(report.branchFailures?.some((failure) => failure.startsWith("other:")));
		assert.equal(report.syncOk, false);
		assert.equal(git(["status", "--porcelain"], otherTree), "");
		assert.equal(existsSync(git(["rev-parse", "--git-path", "rebase-merge"], otherTree)), false);
	});

	it("promotes a feature slice with its own dev-record root", () => {
		const { report } = promote(["reporting"]);
		assert.equal(report.ok, true);
		assert.equal(report.kind, "feature");
		assert.equal(report.promoted.length, 1);
		assert.equal(report.held.length, 0);

		const tracked = git(["ls-tree", "-r", "--name-only", "main"]).split("\n");
		assert.ok(tracked.includes("reporting/cli.mts"));
		assert.ok(tracked.includes("package.json"));
		assert.ok(!tracked.includes("reporting/AGENTS.md"));
		const remaining = git(["diff", "--name-only", "--no-renames", "main", "feature/reporting"])
			.split("\n")
			.filter(Boolean);
		assert.ok(
			remaining.every((path) => isDevRecordPath(path, "reporting")),
			remaining.join(","),
		);
	});

	it("promotes a skill slice and runs the skill validator gate", () => {
		const { report } = promote(["guide"]);
		assert.equal(report.ok, true);
		assert.equal(report.kind, "skill");
		assert.equal(report.promoted.length, 1);
		assert.equal(report.gates.skill, "pass");

		const tracked = git(["ls-tree", "-r", "--name-only", "main"]).split("\n");
		assert.ok(tracked.includes("skills/guide/SKILL.md"));
		assert.ok(!tracked.includes("skills/guide/AGENTS.md"));
	});

	it("promotes a kind-qualified prompt slice and leaves the branch equal to main", () => {
		const { report } = promote(["prompt/drift"]);
		assert.equal(report.ok, true);
		assert.equal(report.kind, "prompt");
		assert.equal(report.name, "drift");
		assert.equal(report.promoted.length, 1);
		assert.equal(report.held.length, 0);

		const tracked = git(["ls-tree", "-r", "--name-only", "main"]).split("\n");
		assert.ok(tracked.includes("prompts/drift.md"));
		assert.equal(git(["diff", "--name-only", "--no-renames", "main", "prompt/drift"]), "");
	});

	it("refuses to activate a slice that Pi loads from main", () => {
		const result = spawnSync(process.execPath, [script, "activate", "guide"], { cwd: repo, env, encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /applies to extensions only/);
	});

	it("promotes nothing on a second run", () => {
		const { report } = promote(["demo"]);
		assert.equal(report.ok, true);
		assert.deepEqual(report.promoted, []);
	});

	it("restores main exactly when a cherry-pick conflicts", () => {
		writeIn(repo, "extensions/demo/conflict.ts", "export const value = 'main';\n");
		commitIn(repo, "feat(demo): conflicting main change");
		git(["push", "-q", "origin", "main"]);
		writeIn(demoTree, "extensions/demo/conflict.ts", "export const value = 'branch';\n");
		commitIn(demoTree, "feat(demo): conflicting branch change");

		const before = git(["rev-parse", "main"]);
		const { report, status } = promote(["demo"]);
		assert.equal(status, 1);
		assert.equal(report.ok, false);
		assert.equal(report.stage, "cherry-pick");
		assert.equal(git(["rev-parse", "main"]), before);
		assert.equal(report.mainAfter, before);
		assert.equal(report.recover, null);
		assert.equal(git(["status", "--porcelain"]), "");

		git(["reset", "-q", "--hard", "HEAD~1"], demoTree);
		git(["rebase", "-q", "main"], demoTree);
	});

	it("rolls back and never pushes when a gate fails", () => {
		writeIn(demoTree, "extensions/demo/late.ts", "export const late = true;\n");
		commitIn(demoTree, "feat(demo): a late change");
		const beforeMain = git(["rev-parse", "main"]);
		const beforeOrigin = git(["rev-parse", "origin/main"]);

		const beforeBranch = git(["rev-parse", "extension/demo"]);
		const failing = { ...env, PI_PROMOTE_GATES: JSON.stringify([{ name: "test", command: ["false"] }]) };
		const saved = env;
		env = failing;
		const { report, status } = promote(["demo"]);
		env = saved;

		assert.equal(status, 1);
		assert.equal(report.stage, "gates");
		assert.equal(git(["rev-parse", "main"]), beforeMain);
		assert.equal(git(["rev-parse", "origin/main"]), beforeOrigin);
		assert.equal(git(["rev-parse", "extension/demo"]), beforeBranch);
	});

	it("refuses a dirty main checkout and an unknown slice", () => {
		writeIn(repo, "extensions/demo/index.ts", "export default function demo() { return { dirty: true }; }\n");
		const dirty = promote(["demo"]);
		assert.equal(dirty.report.stage, "preflight");
		assert.match(dirty.report.reason, /uncommitted tracked changes/);
		git(["checkout", "-q", "--", "."]);

		const unknown = promote(["nope"]);
		assert.equal(unknown.report.stage, "preflight");
		assert.match(unknown.report.reason, /branch does not exist/);
	});
});

function batchFixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-batch-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "harness"),
		trees = join(root, "harness.worktrees"),
		origin = join(root, "origin.git");
	const settings = join(root, "settings.json"),
		gates = join(root, "gates"),
		trace = join(root, "git-trace");
	const env = {
		...cleanGitEnvironment(process.env),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
		PI_HARNESS_ROOT: repo,
		PI_WORKTREE_ROOT: trees,
		PI_SETTINGS_PATH: settings,
		PI_PROMOTE_GATES: JSON.stringify(
			["test", "typecheck", "check", "lint"].map((name) => ({
				name,
				command: [
					process.execPath,
					"-e",
					"const fs=require('node:fs'); if(process.env.EXPECT_COMPOSED) { for(const file of ['first/file.txt','second/file.txt']) if(!fs.existsSync(file)) process.exit(1); } fs.appendFileSync(process.argv[1], process.argv[2]+'\\n')",
					gates,
					name,
				],
			})),
		),
	};
	const git = (args: string[], cwd = repo) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	const write = (path: string, content: string, cwd = repo) => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), content);
	};
	const commit = (cwd: string, message = "Fixture change") => {
		git(["add", "."], cwd);
		git(["commit", "-qm", message], cwd);
	};
	const add = (branch: string, base = "main") => {
		const tree = join(trees, branch.split("/")[1]);
		git(["worktree", "add", "-qb", branch, tree, base]);
		return tree;
	};
	const promote = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./worktrees.mts", import.meta.url)), "promote", ...args, "--json"],
			{ cwd: repo, env: { ...env, GIT_TRACE: trace, ...overrides }, encoding: "utf8", timeout: 30_000 },
		);
		assert.ok(result.stdout, result.stderr);
		return { ...result, report: JSON.parse(result.stdout) as SerializedPromotionReport };
	};
	mkdirSync(repo);
	git(["init", "-qb", "main"]);
	write("extensions/.keep", "");
	write("extensions/existing/index.ts", "export default function existing() {}\n");
	write("shared.txt", "top\n\na\nb\nc\nd\ne\n\nbottom\n");
	commit(repo, "Initial tree");
	git(["init", "-q", "--bare", origin]);
	git(["remote", "add", "origin", origin]);
	git(["push", "-q", "origin", "main"]);
	writeFileSync(settings, JSON.stringify({ packages: [{ source: repo, extensions: [] }] }));
	const first = add("feature/first"),
		second = add("feature/second");
	write("shared.txt", "FIRST\n\na\nb\nc\nd\ne\n\nbottom\n", first);
	write("first/LOG.md", "first held bytes\n", first);
	write("first/file.txt", "first shipped\n", first);
	commit(first, "First slice");
	write("shared.txt", "top\n\na\nb\nc\nd\ne\n\nSECOND\n", second);
	write("second/PLAN.md", "second held bytes\n", second);
	write("second/file.txt", "second shipped\n", second);
	commit(second, "Second slice");
	const snapshot = () => ({
		main: git(["rev-parse", "main"]),
		first: git(["rev-parse", "feature/first"]),
		second: git(["rev-parse", "feature/second"]),
		remote: git(["rev-parse", "refs/heads/main"], origin),
		settings: readFileSync(settings, "utf8"),
	});
	return {
		root,
		repo,
		trees,
		origin,
		settings,
		gates,
		trace,
		env,
		git,
		write,
		commit,
		add,
		promote,
		first,
		second,
		snapshot,
	};
}

function invalidBatchSelection(f: ReturnType<typeof batchFixture>, problem: string): string[] {
	if (problem === "unknown") return ["first", "nope"];
	if (problem === "duplicate") return ["first", "feature/first"];
	if (problem === "dirty") f.write("shared.txt", "dirty\n", f.second);
	if (problem === "untracked") f.write("first/file.txt", "do not overwrite\n", f.second);
	if (problem === "missing") f.git(["worktree", "remove", f.second]);
	if (problem === "paused") f.write(".git/CHERRY_PICK_HEAD", `${f.git(["rev-parse", "main"])}\n`);
	return ["first", "second"];
}

describe("batch promotion", () => {
	it("composes shared-file edits and halves shared gate, push, and sync calls", (t) => {
		const batch = batchFixture(t),
			serial = batchFixture(t);
		const unselected = batch.add("feature/unselected");
		batch.write("unselected/private.txt", "not selected\n", unselected);
		batch.commit(unselected);
		const before = batch.snapshot();
		const plan = batch.promote(["first", "feature/second", "--dry-run"]);
		assert.equal(plan.status, 0, plan.stdout);
		assert.deepEqual(batch.snapshot(), before);
		assert.deepEqual(
			plan.report.slices.map((s) => s.branch),
			["feature/first", "feature/second"],
		);
		assert.deepEqual(
			plan.report.slices.map((s) => s.wouldPromote?.[0].dropped),
			[["first/LOG.md"], ["second/PLAN.md"]],
		);
		rmSync(batch.trace);
		const result = batch.promote(["first", "feature/second"], { EXPECT_COMPOSED: "1" });
		assert.equal(result.status, 0, result.stdout);
		assert.equal(result.report.pushed, true);
		assert.equal(result.report.syncOk, true);
		assert.deepEqual(result.report.gates, { test: "pass", typecheck: "pass", check: "pass", lint: "pass" });
		assert.equal(batch.git(["rev-parse", "main"]), batch.git(["rev-parse", "refs/heads/main"], batch.origin));
		assert.equal(readFileSync(join(batch.repo, "shared.txt"), "utf8"), "FIRST\n\na\nb\nc\nd\ne\n\nSECOND\n");
		assert.equal(existsSync(join(batch.repo, "unselected/private.txt")), false);
		for (const tree of [batch.first, batch.second]) {
			assert.equal(readFileSync(join(tree, "first/file.txt"), "utf8"), "first shipped\n");
			assert.equal(readFileSync(join(tree, "second/file.txt"), "utf8"), "second shipped\n");
			assert.equal(batch.git(["status", "--porcelain"], tree), "");
		}
		assert.equal(readFileSync(join(batch.first, "first/LOG.md"), "utf8"), "first held bytes\n");
		assert.equal(readFileSync(join(batch.second, "second/PLAN.md"), "utf8"), "second held bytes\n");
		assert.equal(existsSync(join(batch.first, "second/PLAN.md")), false);
		assert.equal(existsSync(join(batch.second, "first/LOG.md")), false);
		assert.equal(existsSync(join(batch.repo, "first/LOG.md")), false);
		assert.equal(existsSync(join(batch.repo, "second/PLAN.md")), false);
		assert.equal(serial.promote(["first"]).status, 0);
		assert.equal(serial.promote(["second"]).status, 0);
		for (const [f, expected] of [
			[batch, 1],
			[serial, 2],
		] as const) {
			assert.equal(readFileSync(f.gates, "utf8").trim().split("\n").length, expected * 4);
			const commands = readFileSync(f.trace, "utf8").split("\n");
			assert.equal(
				commands.filter((line) => line.includes("built-in: git") && line.includes(" push origin main")).length,
				expected,
			);
			assert.equal(
				commands.filter(
					(line) =>
						line.includes("built-in: git for-each-ref") &&
						/refs\/heads\/(extension|skill|prompt|feature)\/\*/.test(line),
				).length,
				expected * 4,
				commands.filter((line) => line.includes("built-in: git for-each-ref")).join("\n"),
			);
		}
	});
	for (const problem of ["unknown", "duplicate", "dirty", "untracked", "missing", "paused"] as const) {
		it(`refuses ${problem} selections before mutations`, (t) => {
			const f = batchFixture(t);
			const args = invalidBatchSelection(f, problem);
			const before = f.snapshot(),
				result = f.promote(args);
			assert.equal(result.status, 1, result.stdout);
			assert.equal(result.report.stage, "preflight");
			assert.deepEqual(f.snapshot(), before);
			assert.equal(existsSync(f.gates), false);
			if (problem === "untracked")
				assert.equal(readFileSync(join(f.second, "first/file.txt"), "utf8"), "do not overwrite\n");
			if (problem === "missing") assert.equal(existsSync(f.second), false);
		});
	}
	it("restores all selected tips and main after a later rebase conflict", (t) => {
		const f = batchFixture(t);
		f.write("shared.txt", "CONFLICT\n", f.second);
		f.commit(f.second);
		const before = f.snapshot(),
			result = f.promote(["first", "second"]);
		assert.equal(result.status, 1, result.stdout);
		assert.equal(result.report.stage, "rebase");
		assert.equal(result.report.failedSlice, "feature/second");
		assert.equal(result.report.recover, null);
		assert.deepEqual(f.snapshot(), before);
		assert.equal(f.git(["status", "--porcelain"], f.second), "");
		assert.equal(existsSync(f.gates), false);
	});
	it("rolls back thrown gate failures after both slices compose", (t) => {
		const f = batchFixture(t),
			before = f.snapshot();
		const result = f.promote(["first", "second"], {
			PI_PROMOTE_GATES: JSON.stringify([{ name: "test", command: [process.execPath, "-e", "process.exit(42)"] }]),
		});
		assert.equal(result.status, 1, result.stdout);
		assert.equal(result.report.stage, "gates");
		assert.deepEqual(f.snapshot(), before);
	});
	it("filters combined development roots across shared selected history", (t) => {
		const f = batchFixture(t);
		f.git(["rebase", "feature/first"], f.second);
		const result = f.promote(["first", "second"]);
		assert.equal(result.status, 0, result.stdout);
		assert.equal(readFileSync(join(f.first, "first/LOG.md"), "utf8"), "first held bytes\n");
		assert.equal(readFileSync(join(f.second, "second/PLAN.md"), "utf8"), "second held bytes\n");
		assert.equal(existsSync(join(f.repo, "first/LOG.md")), false);
		assert.equal(existsSync(join(f.repo, "second/PLAN.md")), false);
		assert.equal(f.git(["diff", "--name-only", "main", "feature/first"]), "first/LOG.md");
		assert.equal(f.git(["diff", "--name-only", "main", "feature/second"]), "second/PLAN.md");
	});

	it("checks every selected resource including an unchanged extension on the final tree", (t) => {
		const f = batchFixture(t);
		f.add("extension/existing");
		const widget = f.add("extension/widget");
		f.write("extensions/widget/index.ts", "export default function widget() {}\n", widget);
		f.commit(widget);
		const guide = f.add("skill/guide");
		f.write(
			"skills/guide/SKILL.md",
			"---\nname: guide\ndescription: Use when a fixture guide is required. Do not use outside tests.\n---\n\n# Guide\n\nFixture instructions.\n",
			guide,
		);
		f.commit(guide);
		const result = f.promote(["existing", "widget", "guide", "first", "second"], { EXPECT_COMPOSED: "1" });
		assert.equal(result.status, 0, result.stdout);
		assert.deepEqual(
			result.report.slices.map((slice) => slice.gates),
			[{ load: "pass" }, { load: "pass" }, { skill: "pass" }, {}, {}],
		);
		assert.deepEqual(result.report.slices[0].promoted, []);
		assert.equal(readFileSync(f.gates, "utf8").trim().split("\n").length, 4);
	});

	for (const fault of ["rebuild", "abort", "probe"] as const) {
		it(`keeps rollback honest after a failed ${fault}`, (t) => {
			const f = batchFixture(t);
			if (fault !== "rebuild") {
				f.write("shared.txt", "CONFLICT\n", f.second);
				f.commit(f.second);
			}
			const before = f.snapshot();
			const bin = join(f.root, "bin");
			mkdirSync(bin);
			const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
			const marker = join(f.root, "failed-rebase");
			writeFileSync(
				join(bin, "git"),
				`#!${process.execPath}
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const second = process.cwd() === ${JSON.stringify(f.second)};
const fault = ${JSON.stringify(fault)};
const marker = ${JSON.stringify(marker)};
if (second && fault === "rebuild" && args.slice(-3).join(" ") === "reset --hard main") process.exit(42);
if (second && fault === "abort" && args.slice(-2).join(" ") === "rebase --abort") process.exit(42);
if (second && fault === "probe" && existsSync(marker) && args.at(-1) === "rebase-merge") process.exit(42);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (second && args.slice(-2).join(" ") === "rebase main" && result.status !== 0) writeFileSync(marker, "failed");
process.exitCode = result.status ?? 1;
`,
				{ mode: 0o755 },
			);
			const result = f.promote(["first", "second"], { PATH: `${bin}${delimiter}${process.env.PATH}` });
			assert.equal(result.status, 1, result.stdout);
			const after = f.snapshot();
			assert.equal(after.main, before.main);
			assert.equal(after.first, before.first);
			assert.equal(after.remote, before.remote);
			assert.equal(after.settings, before.settings);
			if (fault === "rebuild") {
				assert.deepEqual(after, before);
				assert.equal(result.report.recover, null);
			} else {
				assert.match(result.report.recover ?? "", /rebase --abort/);
				assert.match(result.report.recover ?? "", /switch feature\/second/);
				assert.equal(
					existsSync(f.git(["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"], f.second)),
					true,
				);
			}
		});
	}

	it("rolls back a later resource gate failure and keeps no-gates explicit", (t) => {
		const f = batchFixture(t);
		const broken = f.add("skill/broken");
		f.write("skills/broken/SKILL.md", "# Missing skill metadata\n", broken);
		f.commit(broken);
		const before = f.snapshot();
		const brokenBefore = f.git(["rev-parse", "skill/broken"]);
		const result = f.promote(["first", "broken"]);
		assert.equal(result.status, 1, result.stdout);
		assert.equal(result.report.stage, "gates");
		assert.equal(result.report.failedSlice, "skill/broken");
		assert.deepEqual(result.report.slices[1].gates, { skill: "fail" });
		assert.deepEqual(f.snapshot(), before);
		assert.equal(f.git(["rev-parse", "skill/broken"]), brokenBefore);
		const skipped = f.promote(["first", "broken", "--no-gates", "--no-push"]);
		assert.equal(skipped.status, 0, skipped.stdout);
		assert.deepEqual(skipped.report.gates, {});
		assert.equal(skipped.report.pushed, false);
		assert.equal(skipped.report.syncOk, true);
	});

	it("keeps accepted local changes after a rejected push and refuses an implicit retry", (t) => {
		const f = batchFixture(t);
		writeFileSync(join(f.origin, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const before = f.snapshot();
		const result = f.promote(["first", "second"]);
		assert.equal(result.status, 1, result.stdout);
		assert.equal(result.report.stage, "push");
		assert.match(result.report.recover ?? "", /diff origin\/main/);
		assert.equal(f.snapshot().remote, before.remote);
		assert.notEqual(f.snapshot().main, before.main);
		assert.equal(f.promote(["first", "second"]).report.stage, "preflight");
	});

	it("refuses unpublished main history for one or many selections", (t) => {
		const f = batchFixture(t);
		f.write("unrelated.txt", "unpublished\n");
		f.commit(f.repo);
		const before = f.snapshot();
		for (const args of [["first"], ["first", "second"]]) {
			const result = f.promote(args);
			assert.equal(result.status, 1, result.stdout);
			assert.match(result.report.reason, /unpublished commits/);
			assert.deepEqual(f.snapshot(), before);
		}
	});
});
