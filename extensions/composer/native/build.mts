import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const shared = "../../../native-pane";
const manifests = ["build.mts", "Package.swift", `${shared}/Package.swift`];
const trees = ["Sources", "web", `${shared}/Sources`];
export const INSTALL_BUSY = 75;

function files(root: string, dir: string): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".")) return [];
		const path = join(dir, entry.name);
		return entry.isDirectory() ? files(root, path) : entry.isFile() ? [path] : [];
	});
}

export function sourceDigest(root = packageDir): string {
	const hash = createHash("sha256");
	for (const path of [...manifests, ...trees.flatMap((dir) => files(root, dir))].sort()) {
		hash
			.update(`${path}\0`)
			.update(readFileSync(join(root, path)))
			.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

export function sourceRecord(root = packageDir): { commit: string; modified: boolean } | undefined {
	function git(...args: string[]): string | undefined {
		const result = spawnSync("git", args, {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return result.status === 0 ? result.stdout.trim() : undefined;
	}
	const commit = git("rev-parse", "--verify", "HEAD");
	if (!commit || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) return undefined;
	const status = git("status", "--porcelain", "--untracked-files=all", "--", ...manifests, ...trees);
	return status === undefined ? undefined : { commit, modified: status.length !== 0 };
}

export function lockHolder(parent: string): { pid: number; startedAt: string } | undefined {
	try {
		const { pid, startedAt } = JSON.parse(readFileSync(join(parent, "install.lock"), "utf8"));
		const started = Date.parse(startedAt);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(started) || Date.now() - started > 3_600_000)
			return undefined;
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
		}
		return { pid, startedAt };
	} catch {
		return undefined;
	}
}

function lock(parent: string, id: string): (() => void) | undefined {
	const path = join(parent, "install.lock");
	const claim = join(parent, `.composer-lock-${id}`);
	const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
	writeFileSync(claim, record, { flag: "wx", mode: 0o600 });
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				linkSync(claim, path);
				return () => {
					try {
						if (readFileSync(path, "utf8") === record) rmSync(path, { force: true });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			if (lockHolder(parent)) return undefined;
			// A stale lock is left in place only until the next install starts.
			rmSync(path, { force: true });
		}
		return undefined;
	} finally {
		rmSync(claim, { force: true });
	}
}

function destination(): string {
	const home = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	if (!isAbsolute(home)) throw new Error("PI_CODING_AGENT_DIR must be absolute");
	let app = process.env.PI_COMPOSER_APP?.trim();
	if (!app) {
		try {
			app = JSON.parse(readFileSync(join(home, "harness.json"), "utf8"))?.composer?.app;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (app === undefined) return join(home, "composer", "Composer.app");
	if (typeof app !== "string" || !isAbsolute(app) || !app.endsWith(".app"))
		throw new Error("composer.app must be an absolute .app path");
	return app;
}

function run(command: string, args: string[], cwd = packageDir, capture = false): string {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status ?? result.signal})`);
	return result.stdout?.trim() ?? "";
}

function test(): void {
	const framework = join(run("xcode-select", ["-p"], packageDir, true), "Library/Developer/Frameworks");
	const args = ["test", "--no-parallel"];
	if (existsSync(join(framework, "Testing.framework")))
		args.push(
			"-Xswiftc",
			"-F",
			"-Xswiftc",
			framework,
			"-Xswiftc",
			"-Xfrontend",
			"-Xswiftc",
			"-disable-cross-import-overlays",
			"-Xlinker",
			"-F",
			"-Xlinker",
			framework,
			"-Xlinker",
			"-rpath",
			"-Xlinker",
			framework,
		);
	run("swift", args, join(packageDir, shared));
	run("swift", args);
}

function stageWeb(resources: string): void {
	for (const path of files(packageDir, "web")) {
		if (path.endsWith(".test.mts")) continue;
		const target = join(resources, path.replace(/\.ts$/u, ".js"));
		mkdirSync(dirname(target), { recursive: true });
		const source = join(packageDir, path);
		if (path.endsWith(".ts"))
			writeFileSync(target, stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" }));
		else copyFileSync(source, target);
	}
}

function install(app: string): number {
	const parent = dirname(app);
	mkdirSync(parent, { recursive: true });
	const id = randomBytes(6).toString("hex");
	const release = lock(parent, id);
	if (!release) return INSTALL_BUSY;
	const staged = join(parent, `.composer-stage-${id}.app`);
	const previous = join(parent, `.composer-previous-${id}.app`);
	try {
		if (existsSync(app)) {
			const identity = run(
				"/usr/libexec/PlistBuddy",
				["-c", "Print CFBundleIdentifier", join(app, "Contents/Info.plist")],
				packageDir,
				true,
			);
			if (identity !== "local.harness.composer") throw new Error(`Refusing to replace another app at ${app}`);
		}
		const digest = sourceDigest();
		const source = sourceRecord();
		const flags = ["-c", "release", "--product", "Composer", "--scratch-path", join(parent, ".composer-build")];
		run("swift", ["build", ...flags]);
		const binary = join(run("swift", ["build", ...flags, "--show-bin-path"], packageDir, true), "Composer");
		const macOS = join(staged, "Contents/MacOS");
		const resources = join(staged, "Contents/Resources");
		mkdirSync(macOS, { recursive: true });
		mkdirSync(resources, { recursive: true });
		copyFileSync(binary, join(macOS, "Composer"));
		stageWeb(resources);
		if (sourceDigest() !== digest) throw new Error("Composer sources changed during the build");
		writeFileSync(
			join(resources, "build.json"),
			`${JSON.stringify({ contract: 1, composer: 1, sourceDigest: digest, source }, null, 2)}\n`,
		);
		writeFileSync(
			join(staged, "Contents/Info.plist"),
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.harness.composer</string>
<key>CFBundleName</key><string>Composer</string>
<key>CFBundleExecutable</key><string>Composer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`,
		);
		run("codesign", ["--force", "--sign", "-", staged]);
		const hadApp = existsSync(app);
		if (hadApp) renameSync(app, previous);
		try {
			renameSync(staged, app);
		} catch (error) {
			if (hadApp) renameSync(previous, app);
			throw error;
		}
		if (hadApp) rmSync(previous, { recursive: true });
		console.log(`Installed ${app}`);
		return 0;
	} finally {
		rmSync(staged, { recursive: true, force: true });
		release();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.platform !== "darwin") throw new Error("Composer builds only on macOS");
		if (process.argv.length === 2) process.exitCode = install(destination());
		else if (process.argv.length === 3 && process.argv[2] === "test") test();
		else {
			console.error("usage: node build.mts [test]");
			process.exitCode = 2;
		}
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
