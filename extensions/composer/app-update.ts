import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_SCRIPT = new URL("./native/build.mts", import.meta.url);
const MANIFEST_LIMIT = 8192;
const ALREADY_BUILDING = "A Composer app build is already in progress.";
const OLD_FAILURE = "The previous Composer app build failed; retry with /composer update.";
export type AppNoticeLevel = "info" | "warning" | "error";
type Notify = (message: string, level: AppNoticeLevel) => void;
export type AppCheck = { state: "started" } | { state: "blocked"; message: string; level: "info" | "warning" };
const blocked = (message: string, level: "info" | "warning" = "warning"): AppCheck => ({
	state: "blocked",
	message,
	level,
});
type Source = { commit: string; modified: boolean };
type BuildInputs = { digest: string; source?: Source };
type InstallOutcome = "installed" | "busy" | "failed";

interface Builder {
	sourceDigest(): string;
	sourceRecord(): Source | undefined;
	INSTALL_BUSY: number;
}
interface AppRuntime {
	load(): Promise<Builder>;
	ancestor(older: string, newer: string): boolean;
	install(app: string, busyCode: number): Promise<InstallOutcome>;
}

function readRecord(path: string): Record<string, unknown> | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MANIFEST_LIMIT) return;
		const bytes = Buffer.alloc(MANIFEST_LIMIT + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		if (length > MANIFEST_LIMIT) return;
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function readBuild(app: string): BuildInputs | undefined {
	const manifest = readRecord(`${app}/Contents/Resources/build.json`);
	if (
		manifest?.contract !== 1 ||
		manifest.composer !== 1 ||
		typeof manifest.sourceDigest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/u.test(manifest.sourceDigest)
	)
		return;
	const source = manifest.source as Partial<Source> | undefined;
	return {
		digest: manifest.sourceDigest,
		...(source &&
		typeof source.commit === "string" &&
		/^[a-f0-9]{40,64}$/u.test(source.commit) &&
		typeof source.modified === "boolean"
			? { source: { commit: source.commit, modified: source.modified } }
			: {}),
	};
}

function needsInstall(
	installed: BuildInputs | undefined,
	loaded: BuildInputs,
	ancestor: AppRuntime["ancestor"],
): boolean {
	if (!installed) return true;
	if (installed.digest === loaded.digest || !loaded.source) return false;
	if (!installed.source) return true;
	return installed.source.commit !== loaded.source.commit && ancestor(installed.source.commit, loaded.source.commit);
}

const runtime: AppRuntime = {
	// Load only on the interactive macOS path, not at extension discovery.
	load: () => import(BUILD_SCRIPT.href),
	ancestor(older, newer) {
		return (
			spawnSync("git", ["-C", dirname(fileURLToPath(import.meta.url)), "merge-base", "--is-ancestor", older, newer], {
				timeout: 3000,
				stdio: "ignore",
			}).status === 0
		);
	},
	async install(app, busyCode) {
		mkdirSync(dirname(app), { recursive: true, mode: 0o700 });
		const log = openSync(
			`${app}.update.log`,
			constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const child = spawn(process.execPath, [fileURLToPath(BUILD_SCRIPT)], {
				cwd: dirname(fileURLToPath(BUILD_SCRIPT)),
				detached: true,
				stdio: ["ignore", log, log],
				env: { ...process.env, PI_COMPOSER_APP: app },
			});
			child.unref();
			return await new Promise((resolve) => {
				child.once("error", () => resolve("failed"));
				child.once("exit", (code) => resolve(code === 0 ? "installed" : code === busyCode ? "busy" : "failed"));
			});
		} finally {
			closeSync(log);
		}
	},
};

export class ComposerApp {
	private readonly attempted = new Map<string, { digest: string; outcome?: InstallOutcome }>();
	private readonly running = new Set<string>();
	private inputs?: Promise<{ loaded: BuildInputs; busyCode: number }>;

	private readonly build: AppRuntime;
	constructor(build: AppRuntime = runtime) {
		this.build = build;
	}

	private loaded(): Promise<{ loaded: BuildInputs; busyCode: number }> {
		this.inputs ??= this.build
			.load()
			.then((builder) => ({
				loaded: { digest: builder.sourceDigest(), source: builder.sourceRecord() },
				busyCode: builder.INSTALL_BUSY,
			}))
			.catch(() => {
				this.inputs = undefined;
				throw new Error("This checkout does not include the app builder.");
			});
		return this.inputs;
	}

	/** No receipt means the installed app is ready. A started build reports its own progress. */
	async check(app: string, notify: Notify, explicit = false): Promise<AppCheck | undefined> {
		const { loaded, busyCode } = await this.loaded();
		if (!explicit && !needsInstall(readBuild(app), loaded, this.build.ancestor)) return undefined;
		if (this.running.has(app)) return blocked(ALREADY_BUILDING, "info");
		const failure = `${app}.update-failure.json`;
		const attempt = this.attempted.get(app);
		if (!explicit) {
			if (
				readRecord(failure)?.digest === loaded.digest ||
				(attempt?.digest === loaded.digest && attempt.outcome === "failed")
			)
				return blocked(OLD_FAILURE);
			if (attempt?.digest === loaded.digest)
				return attempt.outcome === "busy"
					? blocked(ALREADY_BUILDING, "info")
					: blocked("The Composer app is not current; rebuild it with /composer update.");
		}
		const next: { digest: string; outcome?: InstallOutcome } = { digest: loaded.digest };
		this.attempted.set(app, next);
		this.running.add(app);
		notify(`The Composer app build started in the background (log: ${app}.update.log).`, "info");
		void this.build
			.install(app, busyCode)
			.catch((): InstallOutcome => "failed")
			.then((outcome) => {
				next.outcome = outcome;
				this.running.delete(app);
				if (outcome === "busy") {
					notify(ALREADY_BUILDING, "info");
					return;
				}
				if (outcome === "installed" && readBuild(app)) {
					try {
						rmSync(failure, { force: true });
					} catch {
						/* The valid app remains usable. */
					}
					notify("The Composer app build completed.", "info");
					return;
				}
				next.outcome = "failed";
				const temp = `${failure}.${randomUUID()}`;
				try {
					writeFileSync(temp, JSON.stringify({ digest: loaded.digest }), { mode: 0o600, flag: "wx" });
					renameSync(temp, failure);
				} catch {
					/* The in-memory attempt still suppresses automatic retries. */
				} finally {
					try {
						rmSync(temp, { force: true });
					} catch {
						/* Best effort. */
					}
				}
				notify(`The Composer app build failed; see ${app}.update.log and retry with /composer update.`, "error");
			});
		return { state: "started" };
	}
}
