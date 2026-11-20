import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";

const directory = dirname(fileURLToPath(import.meta.url));
const shared = "../../../native-pane";
const exec = promisify(execFile);
export const INSTALL_BUSY = 75;

function files(root: string, directory: string): string[] {
	return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".")) return [];
		const path = join(directory, entry.name);
		return entry.isDirectory() ? files(root, path) : entry.isFile() ? [path] : [];
	});
}
function webSources(root: string): string[] {
	return files(root, "web").filter((path) => /\.(?:html|css|ts|js|png|woff2)$/u.test(path) && !path.endsWith(".d.ts"));
}
export function sourceDigest(root = directory): string {
	const hash = createHash("sha256");
	const inputs = [
		"build.mts",
		"Package.swift",
		`${shared}/Package.swift`,
		...files(root, "Sources"),
		...webSources(root),
		...files(root, `${shared}/Sources`),
	];
	for (const path of inputs.sort())
		hash
			.update(`${path}\0`)
			.update(readFileSync(join(root, path)))
			.update("\0");
	return `sha256:${hash.digest("hex")}`;
}

async function run(command: string, args: string[], cwd = directory, timeout = 180_000): Promise<string> {
	try {
		const result = await exec(command, args, { cwd, timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
		if (result.stderr) process.stderr.write(result.stderr);
		return result.stdout.trim();
	} catch (error) {
		if (error && typeof error === "object" && "stdout" in error) process.stderr.write(String(error.stdout));
		if (error && typeof error === "object" && "stderr" in error) process.stderr.write(String(error.stderr));
		throw error;
	}
}

async function test(): Promise<void> {
	const framework = join(await run("xcode-select", ["-p"], directory, 5_000), "Library/Developer/Frameworks");
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
	for (const target of [join(directory, shared), directory]) console.log(await run("swift", args, target));
}

function stageWeb(resources: string): void {
	for (const path of webSources(directory)) {
		const target = join(resources, path.replace(/\.ts$/u, ".js"));
		const source = join(directory, path);
		mkdirSync(dirname(target), { recursive: true });
		if (path.endsWith(".ts")) {
			const script = stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" });
			writeFileSync(target, script.replace(/(["'])(\.\.?\/[^"'\s]+)\.ts\1/gu, "$1$2.js$1"));
		} else copyFileSync(source, target);
	}
}

const executable = "Contents/MacOS/Config";
const bundleId = "local.harness.config";
const checkout = resolve(directory, "../../..");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Config</string>
<key>CFBundleExecutable</key><string>Config</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
const plistTool = "/usr/libexec/PlistBuddy";
async function stage(app: string, scratch: string): Promise<void> {
	const digest = sourceDigest();
	const flags = ["build", "-c", "release", "--product", "Config", "--scratch-path", scratch];
	console.log(await run("swift", flags));
	const binary = join(await run("swift", [...flags, "--show-bin-path"], directory, 15_000), "Config");
	const resources = join(app, "Contents/Resources");
	mkdirSync(dirname(join(app, executable)), { recursive: true });
	copyFileSync(binary, join(app, executable));
	stageWeb(resources);
	if (digest !== sourceDigest()) throw new Error("Config sources changed during the build.");
	writeFileSync(
		join(resources, "build.json"),
		`${JSON.stringify({ contract: 1, config: 1, sourceDigest: digest, source: checkout })}\n`,
	);
	writeFileSync(join(app, "Contents/Info.plist"), plist);
	await run("codesign", ["--force", "--sign", "-", app], directory, 20_000);
}
async function verifyDestination(app: string): Promise<void> {
	if (!existsSync(app)) return;
	const identity = await run(
		plistTool,
		["-c", "Print CFBundleIdentifier", join(app, "Contents/Info.plist")],
		directory,
		5_000,
	);
	if (identity !== bundleId) throw new Error(`Refusing to replace another app: ${app}`);
}
function swap(staged: string, app: string): void {
	const previous = `${staged}.previous`;
	const replacing = existsSync(app);
	if (replacing) renameSync(app, previous);
	try {
		renameSync(staged, app);
	} catch (error) {
		if (replacing) renameSync(previous, app);
		throw error;
	}
	if (replacing) rmSync(previous, { recursive: true });
}
async function install(app: string): Promise<number> {
	if (!isAbsolute(app) || !app.endsWith(".app")) throw new Error("Use an absolute path ending in .app.");
	const parent = dirname(app);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(app, { realpath: false, stale: 30_000 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") return INSTALL_BUSY;
		throw error;
	}
	const staged = join(parent, `.config-stage-${randomUUID()}.app`);
	try {
		await verifyDestination(app);
		await stage(staged, join(parent, `.${app.slice(parent.length + 1)}-swift`));
		swap(staged, app);
		console.log(`Built ${app}`);
		return 0;
	} finally {
		try {
			rmSync(staged, { recursive: true, force: true });
		} finally {
			await release();
		}
	}
}

async function main(args: string[]): Promise<number> {
	if (process.platform !== "darwin") throw new Error("Config builds only on macOS.");
	const output = resolve(process.env.CONFIG_BUILD_DIR || join(directory, ".build"));
	const app = join(output, "Config.app");
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	if (args[0] === "test" && args.length === 1) {
		await test();
		return 0;
	}
	if (args[0] === "build" && args.length === 1) return install(app);
	if (args[0] === "install" && args.length <= 2) return install(args[1] ?? join(agentDir, "config-app", "Config.app"));
	if (args[0] === "check" && args.length <= 2) {
		const code = await install(app);
		if (code !== 0) return code;
		console.log(
			await run(join(app, executable), ["--check", resolve(args[1] ?? join(output, "snapshots"))], directory, 45_000),
		);
		return 0;
	}
	throw new Error("usage: node build.mts build | install [absolute app path] | test | check [snapshot directory]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
