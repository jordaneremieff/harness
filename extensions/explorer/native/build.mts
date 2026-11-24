import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { NOTES_HELPER_SOURCES } from "../helper-sources.ts";
import { readSettings } from "../settings.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = dirname(packageDir);
const installedModules = resolve(packageDir, "../../../node_modules");
const bundleId = "local.harness.explorer";
const runFile = promisify(execFile);
export const INSTALL_BUSY = 75;

function regularFiles(dir: string, skip: (name: string) => boolean): string[] {
	const paths: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (skip(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) paths.push(...regularFiles(path, skip));
		else if (entry.isFile()) paths.push(path);
		else throw new Error(`Not a regular build input: ${path}`);
	}
	return paths;
}

function assertRegularFile(path: string): void {
	if (!lstatSync(path).isFile()) throw new Error(`Not a regular build input: ${path}`);
}

function webFiles(root: string): string[] {
	const entry = join(root, "index.html");
	assertRegularFile(entry);
	const files = [entry];
	for (const name of ["styles", "app"]) {
		const tree = join(root, name);
		if (!lstatSync(tree, { throwIfNoEntry: false })) continue;
		if (!lstatSync(tree).isDirectory()) throw new Error(`Not a web directory: ${tree}`);
		files.push(...regularFiles(tree, (name) => name.endsWith(".test.mts") || name.endsWith(".d.ts")));
	}
	return files;
}

function stripped(source: string): string {
	return stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" });
}

export function stageWeb(resources: string, root = join(packageDir, "web")): void {
	const targets = new Set<string>();
	for (const source of webFiles(root)) {
		const path = relative(root, source);
		const target = join(resources, "web", path.replace(/\.ts$/u, ".js"));
		if (targets.has(target)) throw new Error(`Duplicate staged web path: ${target}`);
		targets.add(target);
		mkdirSync(dirname(target), { recursive: true });
		if (path.endsWith(".ts")) writeFileSync(target, stripped(source));
		else copyFileSync(source, target);
	}
}

// Preserve Node's installed dependency layout so each package resolves the same versions in the bundle.
function stageNotesDependencies(notes: string): void {
	const root = realpathSync(installedModules);
	const pending = [createRequire(import.meta.url).resolve("proper-lockfile/package.json")];
	const copied = new Set<string>();
	while (pending.length) {
		const next = pending.pop();
		if (!next) break;
		const manifest = realpathSync(next);
		const source = dirname(manifest);
		if (copied.has(source)) continue;
		const path = relative(root, source);
		if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
			throw new Error(`Notes dependency lies outside node_modules: ${source}`);
		}
		copied.add(source);
		const { dependencies } = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string> };
		const resolver = createRequire(manifest);
		for (const dependency of Object.keys(dependencies ?? {})) {
			pending.push(resolver.resolve(`${dependency}/package.json`));
		}
		for (const file of regularFiles(source, (name) => name === "node_modules")) {
			const target = join(notes, "node_modules", path, relative(source, file));
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(file, target);
		}
	}
}

export function stageNotes(resources: string): void {
	const notes = join(resources, "notes");
	mkdirSync(notes, { recursive: true });
	writeFileSync(join(notes, "package.json"), '{"type":"module"}\n');
	for (const name of NOTES_HELPER_SOURCES) {
		const source = stripped(join(extensionDir, name));
		const rewritten = source.replace(/(["'])(\.\.?\/[\w./-]+)\.ts\1/gu, "$1$2.js$1");
		writeFileSync(join(notes, name.replace(/\.ts$/u, ".js")), rewritten);
	}
	stageNotesDependencies(notes);
}

function git(args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd: packageDir,
			encoding: "utf8",
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		}).trim();
	} catch {
		return undefined;
	}
}

/** The digest of the app's build inputs and the Git commit they come from; `dirty` marks uncommitted input changes. */
export function sourceRecord(): { commit: string | null; dirty: boolean; digest: string } {
	const inputs = [
		"build.mts",
		"Package.swift",
		"Package.resolved",
		"../settings.ts",
		"../helper-sources.ts",
		"../../../package-lock.json",
		...NOTES_HELPER_SOURCES.map((name) => `../${name}`),
	];
	const licenses = regularFiles(join(packageDir, "Licenses"), (name) => name.startsWith("."));
	inputs.push(...licenses.map((file) => relative(packageDir, file)));
	const sources = regularFiles(join(packageDir, "Sources"), (name) => name.startsWith("."));
	const web = webFiles(join(packageDir, "web"));
	const files = [...inputs, ...[...sources, ...web].map((file) => relative(packageDir, file))].sort();
	const hash = createHash("sha256");
	for (const path of files) {
		const bytes = readFileSync(join(packageDir, path));
		hash.update(`${path}\0${bytes.length}\0`).update(bytes);
	}
	const head = git(["rev-parse", "--verify", "HEAD"]);
	const commit = head && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head) ? head : null;
	const status = git(["status", "--porcelain", "--untracked-files=all", "--", ...inputs, "Sources", "web", "Licenses"]);
	return { commit, dirty: status !== "", digest: `sha256:${hash.digest("hex")}` };
}

function stableNode(): string {
	const running = realpathSync(process.execPath);
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		const candidate = join(dir, "node");
		try {
			if (realpathSync(candidate) === running) return candidate;
		} catch {
			// This PATH entry has no usable Node executable.
		}
	}
	return running;
}

function destination(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = configured ? resolve(configured.replace(/^~(?=$|\/)/u, homedir())) : join(homedir(), ".pi", "agent");
	const app = readSettings({ agentDir }).values.app;
	if (!basename(app).endsWith(".app")) throw new Error("explorer.app must name an .app bundle.");
	return app;
}

async function run(command: string, args: string[], capture = false): Promise<string> {
	const child = runFile(command, args, {
		cwd: packageDir,
		encoding: "utf8",
		timeout: 20 * 60_000,
		killSignal: "SIGKILL",
	});
	child.child.stderr?.pipe(process.stderr, { end: false });
	if (!capture) child.child.stdout?.pipe(process.stdout, { end: false });
	return (await child).stdout.trim();
}

async function test(): Promise<void> {
	const framework = join(await run("xcode-select", ["-p"], true), "Library/Developer/Frameworks");
	const args = ["test", "--no-parallel"];
	if (existsSync(join(framework, "Testing.framework"))) {
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
	}
	await run("swift", args);
}

function infoPlist(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Explorer</string>
<key>CFBundleExecutable</key><string>Explorer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`;
}

function existingBundle(app: string): boolean {
	const stat = lstatSync(app, { throwIfNoEntry: false });
	if (!stat) return false;
	if (stat.isDirectory()) {
		try {
			const id = execFileSync(
				"/usr/libexec/PlistBuddy",
				["-c", "Print CFBundleIdentifier", join(app, "Contents/Info.plist")],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 10_000,
				},
			).trim();
			if (id === bundleId) return true;
		} catch {
			// An unidentifiable bundle is not ours to replace.
		}
	}
	throw new Error(
		`Refusing to replace an unrecognised app at ${app}. Choose another explorer.app path or move it yourself.`,
	);
}

function replaceBundle(staged: string, app: string): void {
	const previous = existingBundle(app)
		? join(dirname(app), `.explorer-previous-${randomBytes(6).toString("hex")}.app`)
		: undefined;
	if (previous) renameSync(app, previous);
	try {
		renameSync(staged, app);
	} catch (error) {
		if (previous) {
			try {
				renameSync(previous, app);
			} catch (restoreError) {
				throw new AggregateError([error, restoreError], `Install and restore failed. Previous bundle: ${previous}`);
			}
		}
		throw error;
	}
	if (previous) rmSync(previous, { recursive: true, force: true });
}

/** The lock that an install holds beside the app for its whole run. */
function installLock(parent: string): string {
	return join(parent, ".explorer-install.lock");
}

/** True while another process holds the install lock beside the app. */
export async function installRunning(app: string): Promise<boolean> {
	const parent = dirname(app);
	return lockfile.check(parent, { lockfilePath: installLock(parent), stale: 120_000 }).catch(() => false);
}

async function install(app: string): Promise<number> {
	const parent = dirname(app);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	let release: () => Promise<void>;
	let compromised: Error | undefined;
	try {
		release = await lockfile.lock(parent, {
			lockfilePath: installLock(parent),
			stale: 120_000,
			onCompromised: (error) => {
				compromised = error;
			},
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
		console.error("Another Explorer install is in progress. The installed app is unchanged.");
		return INSTALL_BUSY;
	}
	try {
		existingBundle(app);
		const source = sourceRecord();
		const checkout = createHash("sha256").update(realpathSync(packageDir)).digest("hex").slice(0, 16);
		const flags = [
			"-c",
			"release",
			"--product",
			"Explorer",
			"--scratch-path",
			join(parent, `.explorer-build-${checkout}`),
		];
		await run("swift", ["build", ...flags]);
		const bin = await run("swift", ["build", ...flags, "--show-bin-path"], true);
		const stage = mkdtempSync(join(parent, ".explorer-stage-"));
		try {
			const bundle = join(stage, "Explorer.app");
			const contents = join(bundle, "Contents");
			const resources = join(contents, "Resources");
			const executable = join(contents, "MacOS", "Explorer");
			mkdirSync(dirname(executable), { recursive: true });
			copyFileSync(join(bin, "Explorer"), executable);
			chmodSync(executable, 0o755);
			stageWeb(resources);
			stageNotes(resources);
			const licenses = join(packageDir, "Licenses");
			for (const source of regularFiles(licenses, (name) => name.startsWith("."))) {
				const target = join(resources, "Licenses", relative(licenses, source));
				mkdirSync(dirname(target), { recursive: true });
				copyFileSync(source, target);
			}
			writeFileSync(join(contents, "Info.plist"), infoPlist());
			const build = {
				contract: 1,
				pane: 1,
				paneOpen: 1,
				ignoredOption: 1,
				live: 1,
				notes: 1,
				node: stableNode(),
				source,
				builtAt: new Date().toISOString(),
			};
			writeFileSync(join(resources, "build.json"), `${JSON.stringify(build, null, 2)}\n`);
			await run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", bundle]);
			const current = sourceRecord();
			if (source.digest !== current.digest || source.commit !== current.commit || source.dirty !== current.dirty) {
				throw new Error("Explorer sources changed during the build. Run the build again.");
			}
			if (compromised) throw compromised;
			replaceBundle(bundle, app);
			console.log(`Installed ${app}`);
			return 0;
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	} finally {
		if (!compromised) await release();
	}
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	if (args.length && !(args.length === 1 && args[0] === "test")) {
		console.error("usage: node build.mts [test]");
		return 2;
	}
	if (process.platform !== "darwin") throw new Error("Explorer builds only on macOS.");
	if (!args.length) return await install(destination());
	await test();
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main();
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
