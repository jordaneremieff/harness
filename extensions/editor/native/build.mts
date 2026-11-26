import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const native = dirname(fileURLToPath(import.meta.url));
const nativePane = "../../../native-pane";
/** The shared Catppuccin palette (assets/themes), copied into the bundle for the app's own theme code. */
const palette = "../../../assets/themes/catppuccin.css";
export const paletteInApp = "Contents/Resources/catppuccin.css";
const exec = promisify(execFile);

export const executableInApp = "Contents/MacOS/Editor";
export const recordInApp = "Contents/Resources/build.json";

function sourceFiles(root: string, dir: string): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".")) return [];
		const path = join(dir, entry.name);
		return entry.isDirectory() ? sourceFiles(root, path) : entry.isFile() ? [path] : [];
	});
}

export function editorSourceDigest(sources: string): string {
	const hash = createHash("sha256");
	const inputs = [
		"Package.swift",
		"build.mts",
		join(nativePane, "Package.swift"),
		palette,
		...sourceFiles(sources, "Sources"),
		...sourceFiles(sources, join(nativePane, "Sources")),
	];
	for (const file of inputs.sort()) {
		const bytes = readFileSync(join(sources, file));
		hash.update(`${file}\0${bytes.length}\0`).update(bytes);
	}
	return hash.digest("hex");
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.harness.editor</string>
<key>CFBundleName</key><string>Editor</string>
<key>CFBundleDisplayName</key><string>Editor</string>
<key>CFBundleExecutable</key><string>Editor</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;

export interface EditorBuild {
	sources: string;
	app: string;
	scratch: string;
	log: string;
	digest: string;
	/** The machine's shared pane appearance file (docs/conventions/pane-appearance.md), when known. */
	paneAppearance?: string;
}

async function run(log: string, command: string, args: string[], timeout: number): Promise<string> {
	const record = (stdout: unknown, stderr: unknown) => {
		for (const output of [stdout, stderr]) {
			if (typeof output === "string" && output) appendFileSync(log, `${output}\n`);
		}
	};
	try {
		const result = await exec(command, args, { timeout, killSignal: "SIGKILL", maxBuffer: 512 * 1024 });
		record(result.stdout, result.stderr);
		return result.stdout.trim();
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
		record(failure.stdout, failure.stderr);
		const reason = failure.killed ? "time limit exceeded" : (failure.code ?? "failed");
		throw new Error(`${command} (${args[0]}): ${reason}`);
	}
}

/** Builds a bundle at a new, private staging path. The caller publishes it afterwards. */
export async function buildEditorApp({
	sources,
	app,
	scratch,
	log,
	digest,
	paneAppearance,
}: EditorBuild): Promise<void> {
	if (process.platform !== "darwin") throw new Error("Editor requires macOS 26 or later.");
	const flags = ["build", "--package-path", sources, "--scratch-path", scratch, "-c", "release", "--product", "Editor"];
	await run(log, "/usr/bin/swift", flags, 300_000);
	const products = await run(log, "/usr/bin/swift", [...flags, "--show-bin-path"], 15_000);
	if (editorSourceDigest(sources) !== digest) throw new Error("Editor sources changed during the build.");
	mkdirSync(app, { mode: 0o700 });
	mkdirSync(dirname(join(app, executableInApp)), { recursive: true });
	mkdirSync(dirname(join(app, recordInApp)), { recursive: true });
	copyFileSync(join(products, "Editor"), join(app, executableInApp));
	copyFileSync(join(sources, palette), join(app, paletteInApp));
	writeFileSync(join(app, "Contents/Info.plist"), plist);
	const record = paneAppearance ? { sourceDigest: digest, paneAppearance } : { sourceDigest: digest };
	writeFileSync(join(app, recordInApp), `${JSON.stringify(record)}\n`);
	await run(log, "/usr/bin/codesign", ["--force", "--sign", "-", app], 15_000);
}

async function cli(args: string[]): Promise<void> {
	const [action, app] = args;
	if (args.length !== 2 || action !== "build" || !app || !isAbsolute(app) || !app.endsWith(".app")) {
		throw new Error("Usage: node build.mts build <new absolute .app path>");
	}
	const stage = mkdtempSync(join(dirname(app), ".editor-build-"));
	const stagedApp = join(stage, "Editor.app");
	const scratch = join(stage, "swift");
	const log = join(stage, "build.log");
	let built = false;
	try {
		writeFileSync(log, "", { mode: 0o600 });
		await buildEditorApp({ sources: native, app: stagedApp, scratch, log, digest: editorSourceDigest(native) });
		renameSync(stagedApp, app);
		built = true;
		console.log(join(app, executableInApp));
	} catch (error) {
		const reason = (error as Error).message;
		appendFileSync(log, `${reason}\n`);
		throw new Error(`Editor build failed: ${reason}. See ${log}.`, { cause: error });
	} finally {
		for (const path of built ? [stage] : [stagedApp, scratch]) rmSync(path, { force: true, recursive: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	cli(process.argv.slice(2)).catch((error: Error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
