import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	classifyCommitFiles,
	cleanGitEnvironment,
	hookIsManaged,
	isDevRecordPath,
	parsePromoteArguments,
	parseWorktreePorcelain,
	promoteNameFromCwd,
	reconcilePackageEntries,
	worktreeExtensionName,
} from "./extension-worktrees.mts";

interface ReconcileOverrides {
	forceActive?: readonly string[];
	forceInactive?: readonly string[];
}

interface SerializedPromotionReport {
	extension: string;
	wouldPromote: Array<{ dropped: string[] }>;
	held: unknown[];
	ok: boolean;
	promoted: string[];
	gates: Record<string, string>;
	pushed: boolean;
	mainAfter: string;
	recover: string | null;
	stage: string;
	reason: string;
	branchFailures?: string[];
}

interface PromoteResult {
	report: SerializedPromotionReport;
	status: number | null;
}

const settingsDir = "/home/operator/.pi/agent";
const repoRoot = "/home/operator/Workspace/harness";
const worktreeRoot = "/home/operator/Workspace/harness.worktrees";
const entrypoints = new Map(
	["brave", "clipboard", "stash", "statusline", "subagent", "tune", "workspace"].map((name) => [
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
		assert.equal(hookIsManaged("#!/bin/sh\n# managed by scripts/extension-worktrees.mts\n"), true);
	});

	it("recognizes hooks installed by the pre-rename script", () => {
		assert.equal(hookIsManaged("#!/bin/sh\n# managed by scripts/extension-worktrees.mjs\n"), true);
	});

	it("rejects hooks the installer did not write", () => {
		assert.equal(hookIsManaged("#!/bin/sh\n# my own hook\n"), false);
	});

	it("rejects an empty hook file", () => {
		assert.equal(hookIsManaged(""), false);
	});
});

describe("extension worktree parsing", () => {
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

describe("promotion classification", () => {
	it("treats development records as unshippable wherever they sit", () => {
		for (const path of [
			"extensions/subagent/LOG.md",
			"extensions/subagent/PLAN.md",
			"extensions/stash/AGENTS.md",
			"extensions/stash/SOLUTION.md",
			"extensions/subagent/REWRITE-SPEC.md",
			"extensions/subagent/RELIABILITY-FINDINGS.md",
		]) {
			assert.equal(isDevRecordPath(path), true, path);
		}
	});

	it("treats any *FINDINGS.md basename under an extension as a dev record", () => {
		for (const path of [
			"extensions/demo/FINDINGS.md",
			"extensions/demo/EDGE-FINDINGS.md",
			"extensions/demo/reliability-FINDINGS.md",
			"extensions/subagent/RELIABILITY-FINDINGS.md",
		]) {
			assert.equal(isDevRecordPath(path), true, path);
		}
		for (const path of [
			"extensions/demo/findings.md",
			"extensions/demo/FINDINGS.md.bak",
			"docs/FINDINGS.md",
		]) {
			assert.equal(isDevRecordPath(path), false, path);
		}
	});

	it("ships ordinary extension sources, tests, and READMEs", () => {
		for (const path of [
			"extensions/clipboard/index.ts",
			"extensions/clipboard/panel.test.mts",
			"extensions/clipboard/README.md",
			"docs/conventions/extension-worktrees.md",
			"AGENTS.md",
		]) {
			assert.equal(isDevRecordPath(path), false, path);
		}
	});

	it("separates shipping commits, held commits, and commits needing a filter", () => {
		assert.equal(classifyCommitFiles(["extensions/demo/index.ts"]).kind, "ship");
		assert.equal(classifyCommitFiles(["extensions/demo/LOG.md"]).kind, "held");
		const mixed = classifyCommitFiles(["extensions/demo/index.ts", "extensions/demo/PLAN.md"]);
		assert.equal(mixed.kind, "filter");
		assert.deepEqual(mixed.shipped, ["extensions/demo/index.ts"]);
		assert.deepEqual(mixed.devRecords, ["extensions/demo/PLAN.md"]);
	});
});

describe("promotion arguments", () => {
	it("defaults to pushing with gates and human output", () => {
		assert.deepEqual(parsePromoteArguments(["clipboard"]), {
			name: "clipboard",
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
		assert.equal(parsePromoteArguments(["--dry-run", "stash"]).name, "stash");
	});

	it("rejects unknown, repeated, and surplus arguments", () => {
		assert.throws(() => parsePromoteArguments(["--force"]), /Unknown promote flag/);
		assert.throws(() => parsePromoteArguments(["--json", "--json"]), /Repeated promote flag/);
		assert.throws(() => parsePromoteArguments(["a", "b"]), /Unexpected extra argument/);
	});

	it("reads the extension name from a worktree directory only", () => {
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
			"../../Workspace/harness.worktrees/subagent/extensions/subagent/index.ts",
			"git:github.com/example/theme",
		]);

		assert.deepEqual(result.activeNames, ["brave", "clipboard", "stash", "statusline", "subagent"]);
		assert.deepEqual(result.packages, [
			{ source: "../../Workspace/harness", extensions: [] },
			"../../Workspace/harness.worktrees/brave/extensions/brave/index.ts",
			"../../Workspace/harness.worktrees/clipboard/extensions/clipboard/index.ts",
			"../../Workspace/harness.worktrees/stash/extensions/stash/index.ts",
			"../../Workspace/harness.worktrees/statusline/extensions/statusline/index.ts",
			"../../Workspace/harness.worktrees/subagent/extensions/subagent/index.ts",
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
			"../../Workspace/harness.worktrees/subagent/extensions/subagent/index.ts",
		]);
		const second = reconcile(first.packages);
		assert.deepEqual(second, first);
	});
});

describe("promotion against a real repository", () => {
	const script = fileURLToPath(new URL("./extension-worktrees.mts", import.meta.url));
	let root: string;
	let repo: string;
	let worktrees: string;
	let origin: string;
	let demoTree: string;
	let otherTree: string;
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
		env = {
			...process.env,
			PI_HARNESS_ROOT: repo,
			PI_EXTENSION_WORKTREE_ROOT: worktrees,
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
		assert.equal(promote(["--dry-run"], demoTree).report.extension, "demo");
	});

	it("finds main from a linked worktree without root overrides", () => {
		const linkedScript = join(demoTree, "scripts", "extension-worktrees.mts");
		writeIn(demoTree, "scripts/extension-worktrees.mts", readFileSync(script, "utf8"));
		const directEnv = { ...env };
		delete directEnv.PI_HARNESS_ROOT;
		delete directEnv.PI_EXTENSION_WORKTREE_ROOT;
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
		assert.equal(report.extension, "demo");
		assert.equal(git(["rev-parse", "main"]), before);
	});

	it("lands shipped code, holds development records, and pushes", () => {
		const { report } = promote(["demo"]);
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
			remaining.every((path) => isDevRecordPath(path)),
			remaining.join(","),
		);
		assert.ok(report.branchFailures?.some((failure) => failure.startsWith("other:")));
		assert.equal(git(["status", "--porcelain"], otherTree), "");
		assert.equal(existsSync(git(["rev-parse", "--git-path", "rebase-merge"], otherTree)), false);
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

	it("refuses a dirty main checkout and an unknown extension", () => {
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
