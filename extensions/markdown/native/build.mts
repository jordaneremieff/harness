// Builds the Markdown Reader app from this package, signs it ad hoc and installs it at the path
// of the `markdown.app` setting.
//
//   node extensions/markdown/native/build.mts        build, sign and install
//   node extensions/markdown/native/build.mts test   run the core's Swift test suite
//
// The install path is the `markdown.app` setting of the Markdown slice: PI_MARKDOWN_APP, else the
// `markdown.app` field of <agent dir>/harness.json, else
// <agent dir>/markdown-reader/Markdown Reader.app. The agent directory is PI_CODING_AGENT_DIR or
// ~/.pi/agent. The bundle carries build.json, which openers read to tell a
// missing or incompatible build from a usable one. build.json also records the `markdown.dir`
// setting as `store`, the store folder that the app's library shows by default.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PANE_MODE } from "../pane-command.ts";
import { readSettings } from "../settings.ts";

/** Version of the contract between openers and the app: open requests, store format, tool output. */
export const BUILD_CONTRACT = 1;
export const BUNDLE_ID = "local.harness.markdown-reader";
export const APP_NAME = "Markdown Reader.app";

const packageDir = dirname(fileURLToPath(import.meta.url));

/**
 * The slice's settings: `app` is the install path (PI_MARKDOWN_APP, harness.json, default) and
 * `dir` the store folder (PI_MARKDOWN_DIR, harness.json, default).
 */
function settingValues(env: NodeJS.ProcessEnv = process.env): { app: string; dir: string } {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = configured ? resolve(configured.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), ".pi", "agent");
	return readSettings({ agentDir, env }).values;
}

/** Digest of the files that define the build: manifest, lockfile, sources, licence notices and the embedded helper. */
export function sourceDigest(root: string = packageDir): string {
	const hash = createHash("sha256");
	const files: string[] = ["Package.swift", "Package.resolved"];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) files.push(path);
		}
	};
	for (const dir of ["Sources", "Licenses"]) walk(dir);
	const helper = join("..", "..", "rex", "terminal-origin.ts");
	if (existsSync(join(root, helper))) files.push(helper);
	for (const file of files.sort()) {
		hash.update(`${file}\0`);
		hash.update(readFileSync(join(root, file)));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

function infoPlist(digest: string): string {
	const entries: [string, string][] = [
		["CFBundleIdentifier", `<string>${BUNDLE_ID}</string>`],
		["CFBundleName", "<string>Markdown Reader</string>"],
		["CFBundleDisplayName", "<string>Markdown Reader</string>"],
		["CFBundleExecutable", "<string>MarkdownReader</string>"],
		["CFBundlePackageType", "<string>APPL</string>"],
		["CFBundleShortVersionString", `<string>${BUILD_CONTRACT}.0</string>`],
		["CFBundleVersion", `<string>${digest.slice(7, 19)}</string>`],
		["LSMinimumSystemVersion", "<string>26.0</string>"],
		["LSApplicationCategoryType", "<string>public.app-category.productivity</string>"],
		["NSHighResolutionCapable", "<true/>"],
		["NSPrincipalClass", "<string>NSApplication</string>"],
		["NSSupportsAutomaticTermination", "<false/>"],
		[
			"CFBundleDocumentTypes",
			`<array>
		<dict>
			<key>CFBundleTypeName</key><string>Markdown document</string>
			<key>CFBundleTypeRole</key><string>Viewer</string>
			<key>LSHandlerRank</key><string>Alternate</string>
			<key>LSItemContentTypes</key><array><string>net.daringfireball.markdown</string></array>
			<key>CFBundleTypeExtensions</key><array><string>md</string><string>markdown</string></array>
		</dict>
		<dict>
			<key>CFBundleTypeName</key><string>Markdown open request</string>
			<key>CFBundleTypeRole</key><string>Viewer</string>
			<key>LSHandlerRank</key><string>None</string>
			<key>LSItemContentTypes</key><array><string>public.json</string></array>
		</dict>
	</array>`,
		],
	];
	const body = entries.map(([key, value]) => `\t<key>${key}</key>\n\t${value}`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

/**
 * Copies the Rex-owned terminal-origin helper of this checkout into the bundle and names the Node
 * executable that runs it. The terminal-origin contract (docs/conventions/terminal-origin.md)
 * permits embedding this single file; each build refreshes the copy. Without the helper the
 * reader offers only the application-level return.
 */
function embedTerminalOrigin(resources: string): { helper: string; node: string } | undefined {
	const source = join(packageDir, "..", "..", "rex", "terminal-origin.ts");
	if (!existsSync(source)) {
		console.log("No terminal-origin helper in this checkout; Return to Rex selects no pane.");
		return undefined;
	}
	cpSync(source, join(resources, "terminal-origin.ts"));
	const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find((path) => existsSync(path)) ?? process.execPath;
	console.log(`Pane return helper embedded; Node: ${node}`);
	return { helper: "terminal-origin.ts", node };
}

function run(command: string, args: string[]): string {
	return execFileSync(command, args, { cwd: packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/**
 * Runs the core's swift-testing suite. Under the Command Line Tools (no Xcode) the Testing
 * framework sits outside the default search paths, so the run names its directory.
 */
function test(): void {
	const developer = run("xcode-select", ["-p"]).trim();
	const frameworks = join(developer, "Library", "Developer", "Frameworks");
	const args = ["test"];
	if (existsSync(join(frameworks, "Testing.framework"))) {
		args.push(
			"-Xswiftc",
			"-F",
			"-Xswiftc",
			frameworks,
			"-Xlinker",
			"-F",
			"-Xlinker",
			frameworks,
			"-Xlinker",
			"-rpath",
			"-Xlinker",
			frameworks,
		);
	}
	const result = spawnSync("swift", args, { cwd: packageDir, stdio: "inherit" });
	process.exit(result.status ?? 1);
}

/** Restores an interrupted replacement before installing, and rolls back a failed final rename. */
export function installBundle(
	bundle: string,
	destination: string,
	rename: (from: string, to: string) => void = renameSync,
): void {
	const parent = dirname(destination);
	if (!existsSync(destination)) {
		const abandoned = readdirSync(parent, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^\.old-[a-f0-9]{12}$/u.test(entry.name))
			.map((entry) => ({ path: join(parent, entry.name), modified: lstatSync(join(parent, entry.name)).mtimeMs }))
			.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))[0];
		if (abandoned) rename(abandoned.path, destination);
	}
	const previous = existsSync(destination) ? join(parent, `.old-${randomBytes(6).toString("hex")}`) : undefined;
	if (previous) rename(destination, previous);
	try {
		rename(bundle, destination);
	} catch (installError) {
		if (previous) {
			try {
				rename(previous, destination);
			} catch (restoreError) {
				throw new AggregateError(
					[installError, restoreError],
					`Install failed: ${String(installError)}; restore failed: ${String(restoreError)}. Previous bundle: ${previous}`,
				);
			}
		}
		throw installError;
	}
	if (previous) rmSync(previous, { recursive: true, force: true });
}

function main(): void {
	if (process.platform !== "darwin") {
		console.error("The Markdown Reader app builds only on macOS.");
		process.exit(1);
	}
	if (process.argv[2] === "test") {
		test();
		return;
	}
	if (process.argv[2] !== undefined) {
		console.error("usage: node build.mts [test]");
		process.exit(2);
	}
	const { app: destination, dir: store } = settingValues();
	const digest = sourceDigest();
	const swiftVersion =
		run("swift", ["--version"])
			.split("\n")
			.find((line) => line.includes("Swift version"))
			?.trim() ?? "unknown";
	console.log(`Building Markdown Reader (${digest.slice(0, 19)}) with ${swiftVersion}`);
	run("swift", ["build", "-c", "release", "--product", "MarkdownReader"]);
	run("swift", ["build", "-c", "release", "--product", "markdown-core"]);
	const binPath = run("swift", ["build", "-c", "release", "--show-bin-path"]).trim();

	const parent = dirname(destination);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const staging = join(parent, `.tmp-${randomBytes(6).toString("hex")}`);
	const bundle = join(staging, APP_NAME);
	const contents = join(bundle, "Contents");
	try {
		mkdirSync(join(contents, "MacOS"), { recursive: true });
		mkdirSync(join(contents, "Resources"), { recursive: true });
		for (const executable of ["MarkdownReader", "markdown-core"]) {
			cpSync(join(binPath, executable), join(contents, "MacOS", executable));
			chmodSync(join(contents, "MacOS", executable), 0o755);
		}
		writeFileSync(join(contents, "Info.plist"), infoPlist(digest));
		writeFileSync(join(contents, "PkgInfo"), "APPL????");
		cpSync(join(packageDir, "Licenses"), join(contents, "Resources", "Licenses"), { recursive: true });
		const terminalOrigin = embedTerminalOrigin(join(contents, "Resources"));
		const build = {
			contract: BUILD_CONTRACT,
			pane: PANE_MODE,
			sourceDigest: digest,
			builtAt: new Date().toISOString(),
			swift: swiftVersion,
			store,
			...(terminalOrigin ? { terminalOrigin } : {}),
		};
		writeFileSync(join(contents, "Resources", "build.json"), `${JSON.stringify(build, null, 2)}\n`);
		run("codesign", ["--force", "--sign", "-", "--timestamp=none", join(contents, "MacOS", "markdown-core")]);
		run("codesign", ["--force", "--sign", "-", "--timestamp=none", bundle]);

		installBundle(bundle, destination);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	console.log(`Installed ${destination}`);
	console.log(`Build contract ${BUILD_CONTRACT}, source ${digest}`);
	const running = spawnSync("/usr/bin/pgrep", ["-f", `${destination}/Contents/MacOS/MarkdownReader`], {
		encoding: "utf8",
	});
	if (running.status === 0) {
		console.log("A Markdown Reader instance is running. It keeps its old code until you quit it.");
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
