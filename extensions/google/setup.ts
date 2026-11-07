import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateDir, replacePrivateFile, sha256 } from "./files.ts";
import { ACCOUNT_FILE, gwsEnvironment, SCOPES } from "./gws.ts";
import { GWS_RELEASE, type Release, releaseUrl } from "./release.ts";
import { GoogleError } from "./result.ts";
import { type Environment, managedExecutable, readSettings } from "./settings.ts";

export const SERVICES = ["gmail", "drive", "sheets", "calendar"] as const;
export type Service = (typeof SERVICES)[number];
export type Access = "read" | "write";

const READ_SCOPES: Record<Service, string[]> = {
	gmail: [SCOPES.gmailRead],
	drive: [SCOPES.driveRead],
	sheets: [SCOPES.sheetsRead],
	calendar: [SCOPES.calendarListRead, SCOPES.calendarEventsRead, SCOPES.calendarAclRead],
};
const WRITE_SCOPES: Record<Service, string[]> = {
	gmail: [SCOPES.gmailModify],
	drive: [SCOPES.drive],
	sheets: [SCOPES.sheets],
	calendar: [SCOPES.calendar],
};
const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60 * 1000;

export type SetupDeps = {
	fetch: typeof fetch;
	platformKey: string;
	release: Release;
	log: (line: string) => void;
};

export function productionDeps(log: (line: string) => void): SetupDeps {
	return { fetch: globalThis.fetch, platformKey: `${platform()}-${arch()}`, release: GWS_RELEASE, log };
}

/** Write scopes include read access, so each service needs only one scope set. */
export function scopesFor(services: readonly Service[], access: Access): string[] {
	const table = access === "write" ? WRITE_SCOPES : READ_SCOPES;
	return [...new Set(services.flatMap((service) => table[service]))];
}

type RunResult = { code: number | null; stdout: string; stderr: string };

function runCommand(
	executable: string,
	args: string[],
	options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; onLine?: (line: string) => void },
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			shell: false,
			env: options.env,
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const forward = (chunk: Buffer, sink: "stdout" | "stderr") => {
			const text = chunk.toString("utf8");
			if (sink === "stdout") stdout = (stdout + text).slice(-65536);
			else stderr = (stderr + text).slice(-65536);
			for (const line of text.split(/\r?\n/)) if (line.trim()) options.onLine?.(line);
		};
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => forward(chunk, "stdout"));
		child.stderr.on("data", (chunk: Buffer) => forward(chunk, "stderr"));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new GoogleError("SPAWN_ERROR", `Could not start ${executable}: ${error.message}`));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

async function reportsVersion(executable: string, version: string): Promise<boolean> {
	const present = await lstat(executable).catch(() => undefined);
	if (!present?.isFile()) return false;
	const result = await runCommand(executable, ["--version"], {
		env: { PATH: "/usr/bin:/bin", HOME: "/" },
		timeoutMs: COMMAND_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 && new RegExp(`(?:^|\\s)${version.replaceAll(".", "\\.")}(?:\\s|$)`).test(result.stdout);
}

/** Install the pinned gws release at `executable` unless it already reports the pinned version. */
export async function installGws(executable: string, deps: SetupDeps): Promise<{ installed: boolean }> {
	const { release } = deps;
	if (await reportsVersion(executable, release.version)) return { installed: false };
	const asset = release.assets[deps.platformKey];
	if (!asset)
		throw new GoogleError(
			"UNSUPPORTED_PLATFORM",
			`No pinned gws ${release.version} archive exists for ${deps.platformKey}.`,
		);
	deps.log(`Downloading gws ${release.version} (${asset.name}).`);
	const response = await deps.fetch(releaseUrl(release.version, asset.name));
	if (!response.ok)
		throw new GoogleError("DOWNLOAD_FAILED", `The gws download returned HTTP ${response.status}.`, true);
	const archive = Buffer.from(await response.arrayBuffer());
	if (archive.length > ARCHIVE_MAX_BYTES)
		throw new GoogleError("DOWNLOAD_FAILED", "The gws archive exceeds the size limit.");
	if (sha256(archive) !== asset.sha256)
		throw new GoogleError("CHECKSUM_MISMATCH", "The gws archive does not match its pinned SHA-256 digest.");
	await mkdir(dirname(executable), { recursive: true, mode: 0o755 });
	const staging = await mkdtemp(join(dirname(executable), ".install-"));
	try {
		const archivePath = join(staging, asset.name);
		await writeFile(archivePath, archive, { mode: 0o600 });
		const extracted = await runCommand("/usr/bin/tar", ["-xzf", archivePath, "-C", staging, "./gws"], {
			env: { PATH: "/usr/bin:/bin" },
			timeoutMs: COMMAND_TIMEOUT_MS,
		});
		if (extracted.code !== 0)
			throw new GoogleError("INSTALL_FAILED", `tar could not extract gws: ${extracted.stderr.trim()}`);
		if (!(await reportsVersion(join(staging, "gws"), release.version)))
			throw new GoogleError("INSTALL_FAILED", `The extracted gws does not report version ${release.version}.`);
		await rename(join(staging, "gws"), executable);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	deps.log(`Installed gws ${release.version}.`);
	return { installed: true };
}

/** Copy a Google Cloud Desktop app OAuth client into the gws configuration directory. */
export async function importClient(configDir: string, source: string): Promise<void> {
	const value: unknown = JSON.parse(await readFile(source, "utf8"));
	const installed = value && typeof value === "object" ? (value as Record<string, unknown>).installed : undefined;
	const client = installed && typeof installed === "object" ? (installed as Record<string, unknown>) : undefined;
	if (typeof client?.client_id !== "string" || typeof client.client_secret !== "string")
		throw new GoogleError("INVALID_ARGUMENT", "The client file must be a Google Cloud Desktop app OAuth client JSON.");
	await ensurePrivateDir(configDir);
	await replacePrivateFile(join(configDir, "client_secret.json"), Buffer.from(`${JSON.stringify(value)}\n`));
}

type Paths = { executable: string; configDir: string; stateDir: string; managed: boolean };

function paths(agentDir: string, env: Environment): Paths {
	const { values } = readSettings({ agentDir, env });
	const managed = managedExecutable(agentDir);
	const executable = values.executable ?? managed;
	return {
		executable,
		configDir: values.configDir,
		stateDir: join(values.configDir, "pi-extension"),
		managed: executable === managed,
	};
}

async function authStatus(executable: string, env: NodeJS.ProcessEnv, stateDir: string) {
	const result = await runCommand(executable, ["auth", "status", "--format", "json"], {
		env,
		cwd: stateDir,
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	const value: unknown = result.code === 0 ? JSON.parse(result.stdout) : undefined;
	const status = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		user: typeof status.user === "string" ? status.user : undefined,
		scopes: Array.isArray(status.scopes)
			? status.scopes.filter((item): item is string => typeof item === "string")
			: [],
	};
}

export type SetupOptions = {
	agentDir: string;
	env: Environment;
	client?: string;
	account?: string;
	services: readonly Service[];
	access: Access;
};

export type SetupReport = { executable: string; installed: boolean; account: string; scopes: string[] };

/**
 * Install gws when the managed copy is used, import the OAuth client, sign in with the scopes for the chosen
 * services, and record the signed-in account. Sign-in opens Google's consent page in the browser.
 */
export async function setup(options: SetupOptions, deps: SetupDeps): Promise<SetupReport> {
	const target = paths(options.agentDir, options.env);
	const { installed } = target.managed ? await installGws(target.executable, deps) : { installed: false };
	if (!target.managed && !(await reportsVersion(target.executable, deps.release.version)))
		throw new GoogleError(
			"BACKEND_VERSION_MISMATCH",
			`The configured gws executable does not report version ${deps.release.version}.`,
		);
	if (options.client) await importClient(target.configDir, options.client);
	const client = await lstat(join(target.configDir, "client_secret.json")).catch(() => undefined);
	if (!client?.isFile())
		throw new GoogleError("SETUP_REQUIRED", "Pass --client with the Desktop app OAuth client JSON file.");
	await ensurePrivateDir(target.stateDir);
	const env = gwsEnvironment(options.env, target.configDir, target.stateDir);
	const scopes = scopesFor(options.services, options.access);
	await runCommand(target.executable, ["auth", "logout"], { env, cwd: target.stateDir, timeoutMs: COMMAND_TIMEOUT_MS });
	deps.log("Opening Google sign-in. Approve access in the browser.");
	const login = await runCommand(target.executable, ["auth", "login", "--scopes", scopes.join(",")], {
		env,
		cwd: target.stateDir,
		timeoutMs: LOGIN_TIMEOUT_MS,
		onLine: deps.log,
	});
	if (login.code !== 0)
		throw new GoogleError(
			"AUTH_REQUIRED",
			`gws sign-in failed: ${login.stderr.trim() || `exit ${String(login.code)}`}`,
		);
	const status = await authStatus(target.executable, env, target.stateDir);
	if (!status.user) throw new GoogleError("AUTH_STATUS_UNAVAILABLE", "gws did not report the signed-in account.");
	if (options.account && status.user.toLowerCase() !== options.account.toLowerCase())
		throw new GoogleError(
			"WRONG_ACCOUNT",
			`Signed in as ${status.user}, not ${options.account}. Run setup again and choose ${options.account}.`,
		);
	await replacePrivateFile(
		join(target.stateDir, ACCOUNT_FILE),
		Buffer.from(`${JSON.stringify({ account: status.user })}\n`),
	);
	return { executable: target.executable, installed, account: status.user, scopes: status.scopes };
}

export type UpdateReport = { executable: string; pinned: string; installed: boolean; latest?: string };

/** Install the pinned gws release if it is missing or damaged, and report the newest upstream release. */
export async function update(options: { agentDir: string; env: Environment }, deps: SetupDeps): Promise<UpdateReport> {
	const target = paths(options.agentDir, options.env);
	if (!target.managed)
		throw new GoogleError(
			"CONFIG_ERROR",
			"google.executable points outside the managed install; update that copy yourself.",
		);
	const { installed } = await installGws(target.executable, deps);
	const latest = await deps
		.fetch("https://api.github.com/repos/googleworkspace/cli/releases/latest", {
			headers: { accept: "application/vnd.github+json" },
		})
		.then(async (response) => (response.ok ? ((await response.json()) as { tag_name?: unknown }).tag_name : undefined))
		.catch(() => undefined);
	return {
		executable: target.executable,
		pinned: deps.release.version,
		installed,
		...(typeof latest === "string" ? { latest: latest.replace(/^v/, "") } : {}),
	};
}

/** Remove the local gws credentials. The grant at Google stays until it is removed in the Google Account. */
export async function logout(options: { agentDir: string; env: Environment }): Promise<void> {
	const target = paths(options.agentDir, options.env);
	await ensurePrivateDir(target.stateDir);
	const env = gwsEnvironment(options.env, target.configDir, target.stateDir);
	const result = await runCommand(target.executable, ["auth", "logout"], {
		env,
		cwd: target.stateDir,
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	if (result.code !== 0) throw new GoogleError("BACKEND_ERROR", `gws auth logout failed: ${result.stderr.trim()}`);
	await rm(join(target.stateDir, ACCOUNT_FILE), { force: true });
}

export function parseSetupArgs(words: string[]): {
	client?: string;
	account?: string;
	services: Service[];
	access: Access;
} {
	const values: Record<string, string> = {};
	for (let index = 0; index < words.length; index += 2) {
		const flag = words[index];
		const value = words[index + 1];
		if (!["--client", "--account", "--services", "--access"].includes(flag) || value === undefined)
			throw new GoogleError(
				"INVALID_ARGUMENT",
				`Unknown or incomplete option ${flag ?? ""}. Use --client, --account, --services and --access.`,
			);
		values[flag.slice(2)] = value;
	}
	const services = (values.services ?? SERVICES.join(",")).split(",").map((item) => item.trim());
	const unknown = services.filter((item) => !(SERVICES as readonly string[]).includes(item));
	if (unknown.length)
		throw new GoogleError("INVALID_ARGUMENT", `Unknown services: ${unknown.join(", ")}. Use ${SERVICES.join(", ")}.`);
	const access = values.access ?? "read";
	if (access !== "read" && access !== "write")
		throw new GoogleError("INVALID_ARGUMENT", "--access takes read or write.");
	return { client: values.client, account: values.account, services: services as Service[], access };
}
