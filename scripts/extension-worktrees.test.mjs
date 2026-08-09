import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanGitEnvironment,
  parseWorktreePorcelain,
  reconcilePackageEntries,
  worktreeExtensionName,
} from "./extension-worktrees.mjs";

const settingsDir = "/home/operator/.pi/agent";
const repoRoot = "/home/operator/Workspace/harness";
const worktreeRoot = "/home/operator/Workspace/harness.worktrees";
const entrypoints = new Map(
  ["brave", "clipboard", "stash", "statusline", "subagent", "tune", "workspace"].map((name) => [
    name,
    `${worktreeRoot}/${name}/extensions/${name}/index.ts`,
  ]),
);

function reconcile(packages, options = {}) {
  return reconcilePackageEntries(packages, {
    settingsDir,
    repoRoot,
    worktreeRoot,
    mainExtensionNames: ["brave", "clipboard", "stash", "statusline"],
    entrypoints,
    ...options,
  });
}

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
    assert.equal(
      worktreeExtensionName(
        `${worktreeRoot}/stash/extensions/stash/index.ts`,
        worktreeRoot,
      ),
      "stash",
    );
    assert.equal(
      worktreeExtensionName(
        `${worktreeRoot}/stash/extensions/clipboard/index.ts`,
        worktreeRoot,
      ),
      undefined,
    );
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
    assert.equal(result.packages.some((entry) => String(entry).includes("tune")), false);
    assert.equal(result.packages.some((entry) => String(entry).includes("workspace")), false);
  });

  it("activates and deactivates provisional extensions explicitly", () => {
    const activated = reconcile(
      [{ source: "../../Workspace/harness", extensions: [] }],
      { forceActive: ["tune"] },
    );
    assert.deepEqual(activated.activeNames, ["tune"]);

    const deactivated = reconcile(activated.packages, { forceInactive: ["tune"] });
    assert.deepEqual(deactivated.activeNames, []);
    assert.deepEqual(deactivated.packages, [
      { source: "../../Workspace/harness", extensions: [] },
    ]);
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
