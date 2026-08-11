#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");
const hookMarker = "# managed by scripts/extension-worktrees.mjs";
const localGitEnvironmentKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

export function cleanGitEnvironment(environment) {
  const clean = { ...environment };
  for (const key of localGitEnvironmentKeys) delete clean[key];
  return clean;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  const accepted = options.accept ?? [0];
  if (!accepted.includes(result.status ?? 1)) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(repoRoot, args, options = {}) {
  return run("git", args, {
    cwd: options.cwd ?? repoRoot,
    env: cleanGitEnvironment(process.env),
    ...options,
  });
}

export function parseWorktreePorcelain(text) {
  const records = [];
  let current;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      records.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current && line === "detached") {
      current.detached = true;
    }
  }
  return records;
}

export function worktreeExtensionName(path, worktreeRoot) {
  const parts = relative(worktreeRoot, path).split(sep);
  if (
    parts.length === 4 &&
    parts[1] === "extensions" &&
    parts[0] === parts[2] &&
    parts[3] === "index.ts"
  ) {
    return parts[0];
  }
  return undefined;
}

function packageSource(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") {
    return entry.source;
  }
  return undefined;
}

function resolveLocalSource(source, settingsDir) {
  if (!source || /^(?:npm:|git:|https?:|ssh:|git@)/.test(source)) return undefined;
  return resolve(settingsDir, source);
}

function settingsSource(path, settingsDir) {
  const value = relative(settingsDir, path).split(sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

export function reconcilePackageEntries(packages, options) {
  const {
    settingsDir,
    repoRoot,
    worktreeRoot,
    mainExtensionNames,
    entrypoints,
    forceActive = [],
    forceInactive = [],
  } = options;

  const mainIndex = packages.findIndex((entry) => {
    const source = packageSource(entry);
    return resolveLocalSource(source, settingsDir) === repoRoot;
  });
  if (mainIndex < 0) {
    throw new Error(`Pi settings do not contain the harness package: ${repoRoot}`);
  }

  const active = new Set(forceActive);
  for (const entry of packages) {
    const source = packageSource(entry);
    const resolved = resolveLocalSource(source, settingsDir);
    const name = resolved ? worktreeExtensionName(resolved, worktreeRoot) : undefined;
    if (name) active.add(name);
  }

  const mainEntry = packages[mainIndex];
  const mainLoadsAll =
    typeof mainEntry === "string" ||
    (mainEntry && typeof mainEntry === "object" && mainEntry.extensions === undefined);
  if (mainLoadsAll) {
    for (const name of mainExtensionNames) active.add(name);
  }
  for (const name of forceInactive) active.delete(name);

  for (const name of active) {
    if (!entrypoints.has(name)) {
      throw new Error(`Active extension has no worktree entrypoint: ${name}`);
    }
  }

  const normalizedMain =
    typeof mainEntry === "string"
      ? { source: mainEntry, extensions: [] }
      : { ...mainEntry, extensions: [] };
  const managed = [...active]
    .sort()
    .map((name) => settingsSource(entrypoints.get(name), settingsDir));

  const next = [];
  for (let index = 0; index < packages.length; index += 1) {
    const entry = packages[index];
    if (index === mainIndex) {
      next.push(normalizedMain, ...managed);
      continue;
    }
    const source = packageSource(entry);
    const resolved = resolveLocalSource(source, settingsDir);
    if (resolved && worktreeExtensionName(resolved, worktreeRoot)) continue;
    next.push(entry);
  }

  return { packages: next, activeNames: [...active].sort() };
}

function repositoryState(repoRoot, worktreeRoot) {
  const branches = git(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/extension/*",
  ]).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  const worktrees = parseWorktreePorcelain(
    git(repoRoot, ["worktree", "list", "--porcelain"]).stdout,
  );
  const byBranch = new Map(worktrees.map((entry) => [entry.branch, entry.path]));
  const records = [];

  mkdirSync(worktreeRoot, { recursive: true });
  for (const branch of branches) {
    const name = branch.slice("extension/".length);
    const ref = `refs/heads/${branch}`;
    let path = byBranch.get(ref);
    if (!path) {
      path = join(worktreeRoot, name);
      if (existsSync(path) && readdirSync(path).length > 0) {
        throw new Error(`Expected worktree path is not empty: ${path}`);
      }
      git(repoRoot, ["-c", "core.hooksPath=/dev/null", "worktree", "add", path, branch], { inherit: true });
    }
    records.push({ name, branch, path, entrypoint: join(path, "extensions", name, "index.ts") });
  }
  return records;
}

function mainExtensionNames(repoRoot) {
  const root = join(repoRoot, "extensions");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "index.ts")))
    .map((entry) => entry.name)
    .sort();
}

function readSettings(settingsPath) {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function writeSettings(settingsPath, settings) {
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  if (readFileSync(settingsPath, "utf8") === content) return false;
  const temporary = `${settingsPath}.extension-worktrees-${process.pid}`;
  const mode = statSync(settingsPath).mode;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, settingsPath);
  return true;
}

function reconcileSettings(context, records, options = {}) {
  const settings = readSettings(context.settingsPath);
  const entrypoints = new Map(
    records.filter((record) => existsSync(record.entrypoint)).map((record) => [record.name, record.entrypoint]),
  );
  const result = reconcilePackageEntries(settings.packages ?? [], {
    settingsDir: dirname(context.settingsPath),
    repoRoot: context.repoRoot,
    worktreeRoot: context.worktreeRoot,
    mainExtensionNames: mainExtensionNames(context.repoRoot),
    entrypoints,
    forceActive: options.forceActive,
    forceInactive: options.forceInactive,
  });
  settings.packages = result.packages;
  return { changed: writeSettings(context.settingsPath, settings), activeNames: result.activeNames };
}

function branchHasBase(repoRoot, branch) {
  return git(repoRoot, ["merge-base", "--is-ancestor", "main", branch], {
    accept: [0, 1],
  }).status === 0;
}

function branchHasCommonHistory(repoRoot, branch) {
  return git(repoRoot, ["merge-base", "main", branch], { accept: [0, 1] }).status === 0;
}

function isDirty(path) {
  return git(path, ["status", "--porcelain"], { cwd: path }).stdout.trim().length > 0;
}

function hasTrackedChanges(path) {
  return (
    git(path, ["status", "--porcelain", "--untracked-files=no"], { cwd: path }).stdout.trim()
      .length > 0
  );
}

function syncBranches(context, records) {
  const changed = [];
  const failures = [];
  for (const record of records) {
    try {
      if (!branchHasCommonHistory(context.repoRoot, record.branch)) {
        throw new Error("branch has no common base with main");
      }
      if (!branchHasBase(context.repoRoot, record.branch)) {
        if (hasTrackedChanges(record.path)) {
          throw new Error("worktree has uncommitted changes and main has advanced");
        }
        git(context.repoRoot, noHooks(["rebase", "main"]), { cwd: record.path, inherit: true });
        changed.push(record.name);
      }
      if (!existsSync(record.entrypoint)) {
        throw new Error(`entrypoint is absent: ${record.entrypoint}`);
      }
    } catch (error) {
      failures.push(`${record.name}: ${error.message}`);
    }
  }
  return { changed, failures };
}

const devRecordPatterns = [
  /^extensions\/[^/]+\/(?:AGENTS|LOG|PLAN|REWRITE-SPEC|SOLUTION)\.md$/,
  /^extensions\/[^/]+\/[A-Z][A-Z0-9-]*FINDINGS\.md$/,
];

export function isDevRecordPath(path) {
  return devRecordPatterns.some((pattern) => pattern.test(path));
}

export function classifyCommitFiles(files) {
  const devRecords = files.filter(isDevRecordPath);
  const shipped = files.filter((file) => !isDevRecordPath(file));
  if (shipped.length === 0) return { kind: "held", devRecords, shipped };
  if (devRecords.length === 0) return { kind: "ship", devRecords, shipped };
  return { kind: "filter", devRecords, shipped };
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function promoteNameFromCwd(cwd, worktreeRoot) {
  const parts = relative(worktreeRoot, cwd).split(sep);
  if (parts.length === 0 || parts[0] === "" || parts[0] === ".." || isAbsolute(parts[0])) {
    return undefined;
  }
  return parts[0];
}

export function parsePromoteArguments(args) {
  const options = { push: true, gates: true, json: false, dryRun: false };
  const flags = new Map([
    ["--no-push", "push"],
    ["--no-gates", "gates"],
    ["--json", "json"],
    ["--dry-run", "dryRun"],
  ]);
  const seen = new Set();
  let name;
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const key = flags.get(arg);
      if (!key) throw new Error(`Unknown promote flag: ${arg}`);
      if (seen.has(arg)) throw new Error(`Repeated promote flag: ${arg}`);
      seen.add(arg);
      options[key] = !(arg === "--no-push" || arg === "--no-gates");
      continue;
    }
    if (name !== undefined) throw new Error(`Unexpected extra argument: ${arg}`);
    name = arg;
  }
  return { name, options };
}

function noHooks(args) {
  return ["-c", "core.hooksPath=/dev/null", ...args];
}

function commitFiles(repoRoot, sha) {
  return git(repoRoot, ["show", "--pretty=format:", "--name-only", "--no-renames", sha])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function runLoadGate(repoRoot, entrypoint) {
  const checker = join(dirname(scriptPath), "extension-load-check.mjs");
  const result = run(process.execPath, [checker, entrypoint], {
    cwd: repoRoot,
    accept: [0, 1],
  });
  if (result.status === 0) return { status: "pass" };
  return { status: "fail", detail: (result.stderr || result.stdout).trim() };
}

function promoteGates(context, entrypoint) {
  const override = process.env.PI_PROMOTE_GATES;
  const commands = override
    ? JSON.parse(override)
    : [
        { name: "test", command: ["npm", "test"] },
        { name: "typecheck", command: ["npm", "run", "typecheck"] },
        { name: "check", command: ["npm", "run", "check"] },
        { name: "lint", command: ["npm", "run", "lint"] },
      ];
  const results = {};
  for (const entry of commands) {
    const [command, ...args] = entry.command;
    const outcome = run(command, args, { cwd: context.repoRoot, accept: [0, 1, 2] });
    results[entry.name] = outcome.status === 0 ? "pass" : "fail";
    if (outcome.status !== 0) {
      return { results, failure: { gate: entry.name, detail: (outcome.stdout + outcome.stderr).trim().slice(-2000) } };
    }
  }
  const load = runLoadGate(context.repoRoot, entrypoint);
  results.load = load.status;
  if (load.status === "fail") {
    return { results, failure: { gate: "load", detail: load.detail } };
  }
  return { results };
}

function remoteMainState(context) {
  const remotes = git(context.repoRoot, ["remote"]).stdout.trim().split("\n").filter(Boolean);
  if (!remotes.includes("origin")) return { present: false };
  git(context.repoRoot, ["fetch", "origin", "main"], { accept: [0, 1, 128] });
  const exists =
    git(context.repoRoot, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], {
      accept: [0, 1],
    }).status === 0;
  if (!exists) return { present: false };
  const behindRemote =
    git(context.repoRoot, ["merge-base", "--is-ancestor", "origin/main", "main"], {
      accept: [0, 1],
    }).status !== 0;
  const ahead =
    git(context.repoRoot, ["rev-list", "--count", "origin/main..main"]).stdout.trim() !== "0";
  return { present: true, behindRemote, ahead };
}

function promote(context, requestedName, options) {
  const name =
    requestedName ??
    promoteNameFromCwd(canonicalPath(process.cwd()), canonicalPath(context.worktreeRoot));
  const fail = (stage, reason, extra = {}) => ({
    ok: false,
    extension: name,
    stage,
    reason,
    promoted: [],
    held: [],
    recover: null,
    ...extra,
  });

  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return fail("preflight", "no extension name given and the working directory is not a worktree");
  }
  const branch = `extension/${name}`;
  const branchExists =
    git(context.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      accept: [0, 1],
    }).status === 0;
  if (!branchExists) return fail("preflight", `branch does not exist: ${branch}`);

  const head = git(context.repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    accept: [0, 1],
  }).stdout.trim();
  if (head !== "main") {
    return fail("preflight", `main must be checked out at ${context.repoRoot} (found: ${head || "detached"})`);
  }
  if (hasTrackedChanges(context.repoRoot)) {
    return fail("preflight", `uncommitted tracked changes in ${context.repoRoot}`);
  }
  if (!branchHasCommonHistory(context.repoRoot, branch)) {
    return fail("preflight", `${branch} shares no history with main`);
  }

  const remote = remoteMainState(context);
  if (remote.present && remote.behindRemote) {
    return fail("preflight", "origin/main has commits that main does not; sync before promoting");
  }

  const merges = git(context.repoRoot, ["rev-list", "--merges", `main..${branch}`]).stdout.trim();
  if (merges) return fail("preflight", `${branch} contains merge commits; promote cannot replay them`);

  const shas = git(context.repoRoot, ["rev-list", "--reverse", "--topo-order", `main..${branch}`])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const plan = shas.map((sha) => {
    const files = commitFiles(context.repoRoot, sha);
    const classified = classifyCommitFiles(files);
    return {
      sha: sha.slice(0, 7),
      full: sha,
      subject: git(context.repoRoot, ["log", "-1", "--format=%s", sha]).stdout.trim(),
      ...classified,
    };
  });
  const shipping = plan.filter((entry) => entry.kind !== "held");
  const held = plan.filter((entry) => entry.kind === "held");
  const mainBefore = git(context.repoRoot, ["rev-parse", "main"]).stdout.trim();

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      extension: name,
      wouldPromote: shipping.map((entry) => ({
        sha: entry.sha,
        subject: entry.subject,
        ships: entry.shipped,
        dropped: entry.devRecords,
      })),
      held: held.map((entry) => ({ sha: entry.sha, subject: entry.subject })),
      wouldRunGates: options.gates,
      wouldPush: options.push,
      mainBefore,
    };
  }

  if (shipping.length === 0) {
    let pushed = false;
    if (options.push && remote.present && remote.ahead) {
      const push = git(context.repoRoot, noHooks(["push", "origin", "main"]), { accept: [0, 1] });
      if (push.status !== 0) {
        return fail("push", (push.stderr || push.stdout).trim(), {
          held: held.map((entry) => entry.sha),
          mainBefore,
          mainAfter: mainBefore,
          recover: `git -C ${context.repoRoot} push origin main`,
        });
      }
      pushed = true;
    }
    return {
      ok: true,
      extension: name,
      promoted: [],
      held: held.map((entry) => entry.sha),
      mainBefore,
      mainAfter: mainBefore,
      gates: {},
      pushed,
    };
  }

  const rollback = () => {
    git(context.repoRoot, ["cherry-pick", "--abort"], { accept: [0, 1, 128] });
    git(context.repoRoot, ["cherry-pick", "--quit"], { accept: [0, 1, 128] });
    const reset = git(context.repoRoot, noHooks(["reset", "--hard", mainBefore]), {
      accept: [0, 1, 128],
    });
    return reset.status === 0;
  };
  const abandon = (stage, reason, extra = {}) => {
    const restored = rollback();
    return {
      ...fail(stage, reason, extra),
      held: held.map((entry) => entry.sha),
      mainBefore,
      mainAfter: restored ? mainBefore : git(context.repoRoot, ["rev-parse", "main"]).stdout.trim(),
      recover: restored ? null : `git -C ${context.repoRoot} reset --hard ${mainBefore}`,
    };
  };

  const promoted = [];
  for (const entry of shipping) {
    const pick = git(context.repoRoot, noHooks(["cherry-pick", "-n", entry.full]), {
      accept: [0, 1, 128],
    });
    if (pick.status !== 0) {
      return abandon("cherry-pick", `${entry.sha} (${entry.subject}): ${(pick.stderr || pick.stdout).trim()}`);
    }
    for (const path of entry.devRecords) {
      const inHead =
        git(context.repoRoot, ["cat-file", "-e", `HEAD:${path}`], { accept: [0, 1, 128] }).status ===
        0;
      if (inHead) git(context.repoRoot, ["checkout", "HEAD", "--", path]);
      else git(context.repoRoot, ["rm", "-f", "--quiet", "--", path], { accept: [0, 1, 128] });
    }
    const staged = git(context.repoRoot, ["diff", "--cached", "--quiet"], { accept: [0, 1] });
    if (staged.status === 0) {
      git(context.repoRoot, ["cherry-pick", "--quit"], { accept: [0, 1, 128] });
      continue;
    }
    const commit = git(context.repoRoot, noHooks(["commit", "--no-verify", "-C", entry.full]), {
      accept: [0, 1],
    });
    if (commit.status !== 0) {
      return abandon("cherry-pick", `${entry.sha}: ${(commit.stderr || commit.stdout).trim()}`);
    }
    promoted.push(entry.sha);
  }

  const records = repositoryState(context.repoRoot, context.worktreeRoot);
  const branchResult = syncBranches(context, records);
  const targetFailure = branchResult.failures.find((failure) => failure.startsWith(`${name}:`));
  if (targetFailure) return abandon("sync", targetFailure);
  reconcileSettings(context, records);

  const boundary = git(context.repoRoot, ["diff", "--name-only", "--no-renames", "main", branch])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const leaked = boundary.filter((path) => !isDevRecordPath(path));
  if (leaked.length > 0) {
    return abandon("verify", `${branch} still differs from main outside dev records: ${leaked.join(", ")}`);
  }

  const record = records.find((candidate) => candidate.name === name);
  let gates = {};
  if (options.gates) {
    const outcome = promoteGates(context, record?.entrypoint ?? join(context.repoRoot, "extensions", name, "index.ts"));
    gates = outcome.results;
    if (outcome.failure) {
      return {
        ...abandon("gates", `${outcome.failure.gate} failed: ${outcome.failure.detail}`),
        gates,
      };
    }
  }

  let pushed = false;
  if (options.push && remote.present) {
    const push = git(context.repoRoot, noHooks(["push", "origin", "main"]), { accept: [0, 1] });
    if (push.status !== 0) {
      return {
        ...fail("push", (push.stderr || push.stdout).trim()),
        promoted,
        held: held.map((entry) => entry.sha),
        mainBefore,
        mainAfter: git(context.repoRoot, ["rev-parse", "main"]).stdout.trim(),
        gates,
        recover: `git -C ${context.repoRoot} push origin main`,
      };
    }
    pushed = true;
  }

  return {
    ok: true,
    extension: name,
    promoted,
    held: held.map((entry) => entry.sha),
    mainBefore,
    mainAfter: git(context.repoRoot, ["rev-parse", "main"]).stdout.trim(),
    gates,
    pushed,
    branchFailures: branchResult.failures,
  };
}

function reportPromotion(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  if (report.dryRun) {
    console.log(`promote ${report.extension} (dry run)`);
    for (const entry of report.wouldPromote) {
      const dropped = entry.dropped.length > 0 ? ` (dropping ${entry.dropped.join(", ")})` : "";
      console.log(`  ship ${entry.sha} ${entry.subject}${dropped}`);
    }
    for (const entry of report.held) console.log(`  hold ${entry.sha} ${entry.subject}`);
    if (report.wouldPromote.length === 0) console.log("  nothing to promote");
    console.log(`  gates: ${report.wouldRunGates ? "yes" : "no"}  push: ${report.wouldPush ? "yes" : "no"}`);
    return 0;
  }
  if (!report.ok) {
    console.error(`promote ${report.extension ?? ""} failed at ${report.stage}: ${report.reason}`);
    if (report.recover) console.error(`recover: ${report.recover}`);
    else console.error(`main is unchanged at ${report.mainAfter ?? report.mainBefore ?? "its original commit"}`);
    return 1;
  }
  if (report.promoted.length === 0) console.log(`Nothing to promote from extension/${report.extension}`);
  else console.log(`Promoted to main: ${report.promoted.join(", ")}`);
  if (report.held.length > 0) console.log(`Held on the branch: ${report.held.join(", ")}`);
  if (report.mainAfter && report.mainAfter !== report.mainBefore) {
    console.log(`main ${report.mainBefore.slice(0, 7)} -> ${report.mainAfter.slice(0, 7)}`);
  }
  console.log(`Pushed: ${report.pushed ? "yes" : "no"}`);
  for (const failure of report.branchFailures ?? []) console.error(failure);
  return 0;
}

function activeNamesFromSettings(context) {
  const settings = readSettings(context.settingsPath);
  const names = [];
  for (const entry of settings.packages ?? []) {
    const source = packageSource(entry);
    const resolved = resolveLocalSource(source, dirname(context.settingsPath));
    const name = resolved ? worktreeExtensionName(resolved, context.worktreeRoot) : undefined;
    if (name) names.push(name);
  }
  return new Set(names);
}

function showStatus(context, records) {
  const active = activeNamesFromSettings(context);
  for (const record of records) {
    const base = branchHasBase(context.repoRoot, record.branch) ? "current" : "behind";
    const tree = isDirty(record.path) ? "dirty" : "clean";
    const load = active.has(record.name) ? "active" : "provisional";
    console.log(`${record.name}\t${base}\t${tree}\t${load}\t${record.path}`);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function installHooks(context) {
  const common = git(context.repoRoot, ["rev-parse", "--git-common-dir"]).stdout.trim();
  const commonDir = isAbsolute(common) ? common : resolve(context.repoRoot, common);
  const hooksDir = join(commonDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const events = ["post-checkout", "post-commit", "post-merge", "post-rewrite"];
  const content = `#!/bin/sh\n${hookMarker}\nbranch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)\ncase "$branch" in\n  main|extension/*) ;;\n  *) exit 0 ;;\nesac\nexec node ${shellQuote(scriptPath)} sync --hook\n`;
  for (const event of events) {
    const path = join(hooksDir, event);
    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (!current.includes(hookMarker) && current !== content) {
        throw new Error(`Refusing to replace an unmanaged hook: ${path}`);
      }
    }
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  console.log(`Installed extension worktree hooks in ${hooksDir}`);
}

function contextFromEnvironment() {
  const repoRoot = resolve(process.env.PI_HARNESS_ROOT ?? defaultRepoRoot);
  const worktreeRoot = resolve(process.env.PI_EXTENSION_WORKTREE_ROOT ?? `${repoRoot}.worktrees`);
  const agentDir = resolve(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  const settingsPath = resolve(process.env.PI_SETTINGS_PATH ?? join(agentDir, "settings.json"));
  return { repoRoot, worktreeRoot, settingsPath };
}

function addExtension(context, name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name ?? "")) {
    throw new Error("Extension name must use lowercase letters, numbers, and hyphens");
  }
  const branch = `extension/${name}`;
  const exists = git(context.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    accept: [0, 1],
  }).status === 0;
  if (!exists) git(context.repoRoot, ["branch", branch, "main"]);
  const records = repositoryState(context.repoRoot, context.worktreeRoot);
  const record = records.find((candidate) => candidate.name === name);
  console.log(record.path);
}

function main() {
  const context = contextFromEnvironment();
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("--")) ?? "sync";
  const commandIndex = args.indexOf(command);
  const name = args.slice(commandIndex + 1).find((arg) => !arg.startsWith("--"));
  const quiet = args.includes("--hook");

  if (command === "add") {
    addExtension(context, name);
    return;
  }
  if (command === "install-hooks") {
    installHooks(context);
    return;
  }
  if (command === "promote") {
    const parsed = parsePromoteArguments(args.slice(commandIndex + 1));
    const report = promote(context, parsed.name, parsed.options);
    process.exitCode = reportPromotion(report, parsed.options.json);
    return;
  }

  const records = repositoryState(context.repoRoot, context.worktreeRoot);
  if (command === "status") {
    showStatus(context, records);
    return;
  }
  if (command === "activate" || command === "deactivate") {
    if (!name) throw new Error(`${command} requires an extension name`);
    const _result = reconcileSettings(context, records, {
      forceActive: command === "activate" ? [name] : [],
      forceInactive: command === "deactivate" ? [name] : [],
    });
    console.log(`${name} is ${command === "activate" ? "active" : "provisional"}`);
    return;
  }
  if (command !== "sync" && command !== "configure") {
    throw new Error(`Unknown command: ${command}`);
  }

  let branchResult = { changed: [], failures: [] };
  if (command === "sync") branchResult = syncBranches(context, records);
  const settingsResult = reconcileSettings(context, records);
  if (!quiet || branchResult.changed.length > 0 || settingsResult.changed || branchResult.failures.length > 0) {
    if (branchResult.changed.length > 0) {
      console.log(`Updated from main: ${branchResult.changed.join(", ")}`);
    }
    if (settingsResult.changed) {
      console.log(`Updated Pi settings: ${context.settingsPath}`);
    }
    console.log(`Active worktree extensions: ${settingsResult.activeNames.join(", ") || "none"}`);
  }
  if (branchResult.failures.length > 0) {
    for (const failure of branchResult.failures) console.error(failure);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
