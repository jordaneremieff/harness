import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { ensureEmptyDotEnv, ensurePrivateDir } from "./files.ts";
import { GWS_VERSION } from "./release.ts";
import { errorResult, GoogleError, ok, type Result } from "./result.ts";
import { type Environment, readSettings, type Snapshot } from "./settings.ts";

export { GWS_VERSION };
export const STDOUT_LIMITS = {
	metadata: 2 * 1024 * 1024,
	message: 16 * 1024 * 1024,
	rawDraft: 24 * 1024 * 1024,
	attachment: 36 * 1024 * 1024,
} as const;
const STDERR_LIMIT = 32 * 1024;

export const SCOPES = {
	gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
	gmailSend: "https://www.googleapis.com/auth/gmail.send",
	gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
	gmailModify: "https://www.googleapis.com/auth/gmail.modify",
	driveRead: "https://www.googleapis.com/auth/drive.readonly",
	driveMetadataRead: "https://www.googleapis.com/auth/drive.metadata.readonly",
	driveFile: "https://www.googleapis.com/auth/drive.file",
	drive: "https://www.googleapis.com/auth/drive",
	sheetsRead: "https://www.googleapis.com/auth/spreadsheets.readonly",
	sheets: "https://www.googleapis.com/auth/spreadsheets",
	calendarListRead: "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	calendarEventsRead: "https://www.googleapis.com/auth/calendar.events.readonly",
	calendarEventsOwned: "https://www.googleapis.com/auth/calendar.events.owned",
	calendarEvents: "https://www.googleapis.com/auth/calendar.events",
	calendarAclRead: "https://www.googleapis.com/auth/calendar.acls.readonly",
	calendarAcls: "https://www.googleapis.com/auth/calendar.acls",
	calendar: "https://www.googleapis.com/auth/calendar",
} as const;

export class BackendError extends GoogleError {
	readonly unknownOutcome: boolean;
	constructor(code: string, message: string, retryable = false, unknownOutcome = false) {
		super(code, message, retryable);
		this.unknownOutcome = unknownOutcome;
	}
}

type ProcessResult = { stdout: string; stderr: string; code: number | null; pid?: number };
export type CallOptions = {
	params?: Record<string, unknown>;
	body?: Record<string, unknown>;
	upload?: string;
	uploadContentType?: string;
	output?: string;
	stdoutLimit?: number;
	timeoutMs?: number;
	allowEmpty?: boolean;
};

export type Auth = { account: string; scopes: string[] };
export type Operation = {
	settings: Snapshot["values"];
	stateDir: string;
	auth: Auth;
	call: <T = Record<string, unknown>>(service: string, path: string[], options?: CallOptions) => Promise<T>;
};
type RunOptions = { scopes?: string[]; profile?: boolean; local?: boolean };

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortError(): BackendError {
	return new BackendError("ABORTED", "The operation was cancelled.", true, true);
}

function boundedCollector(limit: number, onOverflow: () => void) {
	const chunks: Buffer[] = [];
	let bytes = 0;
	return {
		push: (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > limit) onOverflow();
			else chunks.push(chunk);
		},
		text: () => Buffer.concat(chunks).toString("utf8"),
	};
}

type ProcessOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdoutLimit: number;
	signal?: AbortSignal;
	timeoutMs: number;
};

function guard(options: ProcessOptions, stop: (error: BackendError) => void): () => void {
	const timer = setTimeout(
		() => stop(new BackendError("DEADLINE_EXCEEDED", `gws exceeded ${options.timeoutMs} ms.`, true, true)),
		options.timeoutMs,
	);
	const onAbort = () => stop(abortError());
	options.signal?.addEventListener("abort", onAbort, { once: true });
	return () => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	};
}

/** The first failure wins; the child is killed and the promise settles only after it closes. */
function executeProcess(executable: string, argv: string[], options: ProcessOptions): Promise<ProcessResult> {
	if (options.signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const child = spawn(executable, argv, {
			shell: false,
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let failure: BackendError | undefined;
		const stop = (error: BackendError) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const unguard = guard(options, stop);
		const stdout = boundedCollector(options.stdoutLimit, () =>
			stop(new BackendError("OUTPUT_LIMIT", `gws stdout exceeded ${options.stdoutLimit} bytes.`, true, true)),
		);
		const stderr = boundedCollector(STDERR_LIMIT, () =>
			stop(new BackendError("OUTPUT_LIMIT", `gws stderr exceeded ${STDERR_LIMIT} bytes.`, true, true)),
		);
		child.stdout.on("data", stdout.push);
		child.stderr.on("data", stderr.push);
		child.on("error", (error) => {
			failure ??= new BackendError(
				"SPAWN_ERROR",
				`Could not start gws: ${error.message}`,
				false,
				child.pid !== undefined,
			);
		});
		child.once("close", (code) => {
			unguard();
			if (failure) reject(failure);
			else resolve({ stdout: stdout.text(), stderr: stderr.text(), code, pid: child.pid });
		});
	});
}

export function gwsArgv(service: string, path: string[], options: CallOptions = {}): string[] {
	const argv = [service, ...path, "--params", JSON.stringify(options.params ?? {})];
	if (options.body !== undefined) argv.push("--json", JSON.stringify(options.body));
	if (options.upload !== undefined)
		argv.push(
			"--upload",
			options.upload,
			"--upload-content-type",
			options.uploadContentType ?? "application/octet-stream",
		);
	if (options.output !== undefined) argv.push("--output", options.output);
	argv.push("--format", "json");
	return argv;
}

async function acquireLock(target: string): Promise<() => Promise<void>> {
	try {
		return await lockfile.lock(target, {
			realpath: false,
			stale: 30000,
			update: 5000,
			retries: { retries: 240, minTimeout: 50, maxTimeout: 250, factor: 1.2 },
		});
	} catch (error) {
		throw new GoogleError(
			"LOCK_TIMEOUT",
			`Could not acquire the Google account lock: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
}

const AUTH_STATE_CODES = new Set(["AUTH_REQUIRED", "AUTH_STATUS_UNAVAILABLE", "SCOPE_REQUIRED", "WRONG_ACCOUNT"]);

function parseJson(stdout: string, allowEmpty: boolean): Record<string, unknown> {
	if (!stdout.trim()) {
		if (allowEmpty) return {};
		throw new BackendError("BACKEND_SCHEMA_ERROR", "gws returned empty success output.", false, true);
	}
	try {
		const value: unknown = JSON.parse(stdout);
		if (!object(value)) throw new Error("Expected a JSON object");
		return value;
	} catch (error) {
		throw new BackendError(
			"BACKEND_SCHEMA_ERROR",
			`gws returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			false,
			true,
		);
	}
}

function structuredError(stdout: string): { message?: string; code?: number; reason?: string } {
	try {
		const parsed: unknown = JSON.parse(stdout);
		const error = object(parsed) && object(parsed.error) ? parsed.error : {};
		return {
			message: typeof error.message === "string" ? error.message : undefined,
			code: typeof error.code === "number" ? error.code : undefined,
			reason: typeof error.reason === "string" ? error.reason : undefined,
		};
	} catch {
		return {};
	}
}

const EXIT_ERRORS: Record<number, readonly [string, string]> = {
	2: ["AUTH_REQUIRED", "Google authentication is required."],
	3: ["INVALID_ARGUMENT", "gws rejected the request."],
	4: ["BACKEND_SCHEMA_ERROR", "The gws Discovery schema failed."],
};

/** Maps a nonzero gws exit to an error; only a definite Google rejection marks a send as not dispatched. */
function apiError(result: ProcessResult): BackendError {
	const structured = structuredError(result.stdout);
	const detail = structured.message ?? result.stderr.trim();
	const fixed = result.code === null ? undefined : EXIT_ERRORS[result.code];
	if (fixed) return new BackendError(fixed[0], detail || fixed[1]);
	if (result.code === 1) {
		const serverFailure = structured.code !== undefined && structured.code >= 500;
		const reason = structured.reason ? ` (${structured.reason})` : "";
		return new BackendError(
			serverFailure ? "BACKEND_ERROR" : "API_ERROR",
			`${detail || "Google API error."}${reason}`,
			serverFailure,
			serverFailure,
		);
	}
	return new BackendError("BACKEND_ERROR", detail || `gws failed with exit ${String(result.code)}.`, true, true);
}

function authFields(value: Record<string, unknown>): Auth {
	const storage = value.storage;
	const encrypted = value.encrypted_credentials_exists === true;
	if (storage === "none" || !encrypted)
		throw new GoogleError("AUTH_REQUIRED", "Sign in to the configured personal Google account with gws auth login.");
	if (storage !== "encrypted" || value.keyring_backend !== "keyring")
		throw new GoogleError(
			"AUTH_STATUS_UNAVAILABLE",
			"gws did not confirm encrypted Keychain credential storage.",
			true,
		);
	if (value.encryption_valid !== true || value.has_refresh_token !== true)
		throw new GoogleError("AUTH_STATUS_UNAVAILABLE", "gws did not confirm valid encrypted refresh credentials.", true);
	if (value.token_valid !== true)
		throw new GoogleError(
			"AUTH_STATUS_UNAVAILABLE",
			`gws did not confirm a valid token${typeof value.token_error === "string" ? `: ${value.token_error}` : "."}`,
			true,
		);
	if (
		typeof value.user !== "string" ||
		!Array.isArray(value.scopes) ||
		!value.scopes.every((scope) => typeof scope === "string")
	) {
		throw new GoogleError(
			"AUTH_STATUS_UNAVAILABLE",
			"gws auth status omitted the observed account or granted scopes.",
			true,
		);
	}
	return { account: value.user, scopes: value.scopes };
}

export class GoogleRuntime {
	private versionPromise: Promise<string> | undefined;
	private versionExecutable: string | undefined;
	private authCache: { key: string; expires: number; auth: Auth } | undefined;
	private profileKey: string | undefined;

	readonly agentDir: string;
	readonly env: Environment;
	constructor(agentDir: string, env: Environment = process.env) {
		this.agentDir = agentDir;
		this.env = env;
	}

	private settings(): Snapshot {
		return readSettings({ agentDir: this.agentDir, env: this.env });
	}

	private controlledEnvironment(configDir: string, stateDir: string): NodeJS.ProcessEnv {
		return gwsEnvironment(this.env, configDir, stateDir);
	}

	private async prepare(snapshot: Snapshot) {
		const { executable, configDir } = snapshot.values;
		const configInfo = await lstat(configDir).catch(() => undefined);
		if (!executable || !configInfo?.isDirectory() || configInfo.isSymbolicLink())
			throw new GoogleError("SETUP_REQUIRED", "Google access is not set up. Run /google setup.");
		const stateDir = join(configDir, "pi-extension");
		const expectedAccount = snapshot.values.expectedAccount ?? (await recordedAccount(stateDir));
		if (!expectedAccount) throw new GoogleError("SETUP_REQUIRED", "No Google account is recorded. Run /google setup.");
		const workDir = join(stateDir, "work");
		await ensurePrivateDir(workDir);
		await ensureEmptyDotEnv(workDir);
		const lockTarget = join(stateDir, "lock-target");
		const handle = await open(lockTarget, constants.O_WRONLY | constants.O_CREAT, 0o600);
		await handle.close();
		return { executable, configDir, expectedAccount, stateDir, workDir, lockTarget };
	}

	private async version(
		executable: string,
		workDir: string,
		environment: NodeJS.ProcessEnv,
		signal?: AbortSignal,
	): Promise<string> {
		if (this.versionExecutable !== executable) {
			this.versionExecutable = executable;
			this.versionPromise = undefined;
		}
		this.versionPromise ??= executeProcess(executable, ["--version"], {
			cwd: workDir,
			env: environment,
			stdoutLimit: 4096,
			timeoutMs: 10000,
			signal,
		}).then((result) => {
			if (result.code !== 0) throw apiError(result);
			const match = result.stdout.trim().match(/(?:^|\s)0\.22\.5(?:\s|$)/);
			if (!match)
				throw new GoogleError(
					"BACKEND_VERSION_MISMATCH",
					`gws ${GWS_VERSION} is required; the configured executable reported: ${result.stdout.trim()}`,
				);
			return GWS_VERSION;
		});
		try {
			return await this.versionPromise;
		} catch (error) {
			this.versionPromise = undefined;
			throw error;
		}
	}

	private async checkCredentialFiles(configDir: string): Promise<string> {
		const encryptedPath = join(configDir, "credentials.enc");
		const encrypted = await lstat(encryptedPath).catch(() => undefined);
		if (!encrypted?.isFile() || encrypted.isSymbolicLink())
			throw new GoogleError(
				"AUTH_REQUIRED",
				"Encrypted personal gws credentials are absent. Complete gws auth login in the dedicated config directory.",
			);
		const plaintext = await lstat(join(configDir, "credentials.json")).catch(() => undefined);
		if (plaintext)
			throw new GoogleError(
				"AUTH_CONFIG_ERROR",
				"Remove plaintext credentials.json from the dedicated personal gws config directory.",
			);
		return `${encrypted.mtimeMs}:${encrypted.size}`;
	}

	private async authenticate(prepared: Prepared, signal?: AbortSignal): Promise<Auth> {
		const credentialKey = await this.checkCredentialFiles(prepared.configDir);
		if (this.authCache && this.authCache.key === credentialKey && this.authCache.expires > Date.now())
			return this.authCache.auth;
		const result = await executeProcess(prepared.executable, ["auth", "status"], {
			cwd: prepared.workDir,
			env: this.controlledEnvironment(prepared.configDir, prepared.stateDir),
			stdoutLimit: STDOUT_LIMITS.metadata,
			timeoutMs: 60000,
			signal,
		});
		if (result.code !== 0) {
			this.authCache = undefined;
			throw apiError(result);
		}
		const auth = authFields(parseJson(result.stdout, false));
		if (auth.account.toLowerCase() !== prepared.expectedAccount.toLowerCase()) {
			throw new GoogleError(
				"WRONG_ACCOUNT",
				`Authenticated account ${auth.account} does not match the configured expected account.`,
			);
		}
		this.authCache = { key: credentialKey, expires: Date.now() + 60000, auth };
		return auth;
	}

	private caller(prepared: Prepared, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Operation["call"] {
		return async <T>(service: string, path: string[], callOptions: CallOptions = {}): Promise<T> => {
			const result = await executeProcess(prepared.executable, gwsArgv(service, path, callOptions), {
				cwd: prepared.workDir,
				env: environment,
				stdoutLimit: callOptions.stdoutLimit ?? STDOUT_LIMITS.metadata,
				timeoutMs: callOptions.timeoutMs ?? (callOptions.upload || callOptions.output ? 120000 : 60000),
				signal,
			});
			if (result.code !== 0) throw apiError(result);
			return parseJson(result.stdout, callOptions.allowEmpty ?? false) as T;
		};
	}

	private async checkProfile(auth: Auth, configDir: string, call: Operation["call"]): Promise<void> {
		const profileKey = `${credentialProfileKey(auth)}:${configDir}`;
		if (this.profileKey === profileKey) return;
		await call("gmail", ["users", "getProfile"], { params: { userId: "me" } });
		this.profileKey = profileKey;
	}

	private async connect(
		prepared: Prepared,
		options: RunOptions,
		signal?: AbortSignal,
	): Promise<Pick<Operation, "auth" | "call">> {
		const environment = this.controlledEnvironment(prepared.configDir, prepared.stateDir);
		await this.version(prepared.executable, prepared.workDir, environment, signal);
		const auth = await this.authenticate(prepared, signal);
		if (options.scopes?.length && !options.scopes.some((scope) => auth.scopes.includes(scope))) {
			throw new GoogleError(
				"SCOPE_REQUIRED",
				"The granted Google scopes do not include any scope required by this tool.",
				false,
				options.scopes,
			);
		}
		const call = this.caller(prepared, environment, signal);
		if (options.profile) await this.checkProfile(auth, prepared.configDir, call);
		return { auth, call };
	}

	async run<T>(
		options: RunOptions,
		signal: AbortSignal | undefined,
		handler: (operation: Operation) => Promise<Result<T>>,
	): Promise<Result<T>> {
		const snapshot = this.settings();
		let prepared: Prepared;
		try {
			prepared = await this.prepare(snapshot);
		} catch (error) {
			return errorResult(error);
		}
		const release = await acquireLock(prepared.lockTarget);
		try {
			if (signal?.aborted) throw abortError();
			const connected = options.local
				? { auth: { account: prepared.expectedAccount, scopes: [] }, call: noCall }
				: await this.connect(prepared, options, signal);
			return await handler({ settings: snapshot.values, stateDir: prepared.stateDir, ...connected });
		} catch (error) {
			if (error instanceof GoogleError && AUTH_STATE_CODES.has(error.code)) this.authCache = undefined;
			return errorResult(error);
		} finally {
			await release();
		}
	}

	async status(signal?: AbortSignal): Promise<Result<Record<string, unknown>>> {
		const snapshot = this.settings();
		const base = {
			backend: { name: "gws", requiredVersion: GWS_VERSION },
			expectedAccount: snapshot.values.expectedAccount ?? null,
			configDir: snapshot.values.configDir,
		};
		try {
			const result = await this.run<Record<string, unknown>>({}, signal, async ({ auth }) =>
				ok({
					...base,
					ready: true,
					observedAccount: auth.account,
					grantedScopes: auth.scopes,
					capabilities: {
						gmailRead: auth.scopes.includes(SCOPES.gmailRead) || auth.scopes.includes(SCOPES.gmailModify),
						gmailSend: [SCOPES.gmailSend, SCOPES.gmailCompose, SCOPES.gmailModify].some((scope) =>
							auth.scopes.includes(scope),
						),
						driveRead: [SCOPES.driveRead, SCOPES.drive].some((scope) => auth.scopes.includes(scope)),
						sheetsRead: [SCOPES.sheetsRead, SCOPES.sheets, SCOPES.driveRead, SCOPES.drive].some((scope) =>
							auth.scopes.includes(scope),
						),
						calendarEventsRead: [SCOPES.calendarEventsRead, SCOPES.calendarEvents, SCOPES.calendar].some((scope) =>
							auth.scopes.includes(scope),
						),
					},
				}),
			);
			return result.status === "error" ? ok({ ...base, ready: false, error: result.error }) : result;
		} catch (error) {
			return ok({ ...base, ready: false, error: errorResult(error).error });
		}
	}
}

type Prepared = Awaited<ReturnType<GoogleRuntime["prepare"]>>;

const noCall: Operation["call"] = async () => {
	throw new GoogleError("CONFIG_ERROR", "This local operation has no gws call.");
};

/** The fixed child environment: no inherited credentials, tokens, proxies or .env discovery outside the work directory. */
export function gwsEnvironment(env: Environment, configDir: string, stateDir: string): NodeJS.ProcessEnv {
	if (!env.HOME) throw new GoogleError("CONFIG_ERROR", "HOME is required for the gws Keychain backend.");
	return {
		HOME: env.HOME,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		LANG: "en_US.UTF-8",
		...(env.USER ? { USER: env.USER } : {}),
		...(env.LOGNAME ? { LOGNAME: env.LOGNAME } : {}),
		GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir,
		GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "keyring",
		GOOGLE_APPLICATION_CREDENTIALS: join(stateDir, "no-application-default-credentials.json"),
		NO_COLOR: "1",
	};
}

export const ACCOUNT_FILE = "account.json";

/** The account that /google setup signed in, used when google.expectedAccount is unset. */
export async function recordedAccount(stateDir: string): Promise<string | undefined> {
	const value: unknown = await readFile(join(stateDir, ACCOUNT_FILE), "utf8")
		.then((text) => JSON.parse(text) as unknown)
		.catch(() => undefined);
	return object(value) && typeof value.account === "string" ? value.account : undefined;
}

function credentialProfileKey(auth: Auth): string {
	return `${auth.account}:${auth.scopes.slice().sort().join(",")}`;
}

export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!object(value)) throw new GoogleError("BACKEND_SCHEMA_ERROR", "Expected a JSON object.");
	return value;
}

export async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
}
