/**
 * Writer work on a storage whose host is not running, each under the storage's writer lease in a runner process
 * of its own: delivery of one recipient's rows without the scheduler, and publication of the storage's recipient
 * hints from its retained rows. Neither resumes the scheduler, calls a model or submits input to the storage. The
 * runner side lives in `durable-runtime.ts`; this module starts runners and loads no Durable runtime module.
 */
import { fork } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, hostMetadata, type CatalogRecord } from "./catalog.ts";
import { GATE_PASSED, isPhase, PROCEED, COLD_STOP_GATE_WAIT_MS } from "./cold-stop.ts";
import { deliveryWakePath } from "./delivery-wake.ts";
import { HostError, type HostMetadata } from "./host-protocol.ts";

/** What a cold delivery did for its recipients. */
export interface ColdDeliveryResult {
	/** The storage holds a task that a host stopped while it ran; only an execution host may open it. */
	readonly interrupted?: true;
	/** The scheduler state when the writer closed: a cold delivery never starts it. */
	readonly scheduling: "paused" | "running" | "closing";
	/** Recipient storages of this delivery that still hold pending rows: parked, refused or held for retry. */
	readonly remaining: readonly string[];
}

/** The routes that an index publication found for one storage. */
export interface ColdIndexResult {
	readonly routes: Readonly<Record<string, "execution" | "delivery">>;
}

type Reply<T> = { readonly busy: true } | { readonly result: T };

export interface ColdWriterOptions {
	readonly signal?: AbortSignal;
	readonly gateWaitMs?: number;
	/** Runner entry path. Defaults to the sibling `durable-runner.ts`. */
	readonly runner?: string;
	/** Extra runner environment; merged over the current environment. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

function writerError(mode: string, code: number | null, signal: NodeJS.Signals | null, diagnostic: string): Error {
	return new HostError(
		`The ${mode} writer ended without a confirmed result (exit ${code ?? signal}): ${diagnostic.trim() || "no result"}`,
		"unavailable",
	);
}

/**
 * Run one cold writer mode in a runner process. Until the writer passes the start gate it has changed nothing, so
 * the caller's signal or the gate bound ends it without effect; after that the writer finishes on its own.
 */
function runColdWriter<T>(
	metadata: HostMetadata,
	mode: "deliver" | "index",
	args: readonly string[],
	options: ColdWriterOptions = {},
): Promise<Reply<T>> {
	options.signal?.throwIfAborted();
	if (!statSync(metadata.cwd, { throwIfNoEntry: false })?.isDirectory())
		return Promise.reject(new HostError(`The agent's working directory no longer exists: ${metadata.cwd}`, "invalid"));
	const runner = options.runner ?? fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	const child = fork(runner, [JSON.stringify(metadata), mode, ...args], {
		cwd: metadata.cwd,
		execArgv: [],
		detached: true,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
	});
	return new Promise((resolveReply, reject) => {
		let reply: unknown;
		let diagnostic = "";
		let gatePassed = false;
		let withdrawn: Error | undefined;
		const withdraw = (reason: Error) => {
			if (gatePassed || withdrawn) return;
			withdrawn = reason;
			child.kill("SIGKILL");
		};
		const gateTimer = setTimeout(
			() =>
				withdraw(new HostError(`A host of this storage is still starting; the ${mode} writer left.`, "unavailable")),
			options.gateWaitMs ?? COLD_STOP_GATE_WAIT_MS,
		);
		const aborted = () => withdraw(new Error(`The ${mode} writer was withdrawn before it opened the storage.`));
		options.signal?.addEventListener("abort", aborted, { once: true });
		const passGate = () => {
			gatePassed = true;
			clearTimeout(gateTimer);
			options.signal?.removeEventListener("abort", aborted);
		};
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			diagnostic = (diagnostic + chunk).slice(-2048);
		});
		child.on("message", (message: unknown) => {
			if (isPhase(message, GATE_PASSED.phase)) {
				if (withdrawn) return;
				passGate();
				if (child.connected) child.send(PROCEED, () => undefined);
			} else reply = message;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			passGate();
			if (withdrawn) return reject(withdrawn);
			const value = reply as { busy?: unknown; result?: unknown; unconfirmed?: unknown } | undefined;
			if (code === 0 && value?.busy === true) return resolveReply({ busy: true });
			if (code === 0 && value !== undefined && "result" in value) return resolveReply({ result: value.result as T });
			reject(writerError(mode, code, signal, diagnostic));
		});
	});
}

/** Deliver the rows of one storage to the named recipient storages, without its scheduler. */
export function deliverColdStorage(
	metadata: HostMetadata,
	recipients: readonly string[],
	options: ColdWriterOptions = {},
): Promise<Reply<ColdDeliveryResult>> {
	return runColdWriter(metadata, "deliver", [JSON.stringify(recipients)], options);
}

/** Publish the recipient hints of one storage from its retained rows, without its scheduler. */
export function indexColdStorage(
	metadata: HostMetadata,
	options: ColdWriterOptions = {},
): Promise<Reply<ColdIndexResult>> {
	return runColdWriter(metadata, "index", [], options);
}

/** The outcome of one index build over a catalogue. */
export interface RecipientHintBuild {
	readonly candidates: number;
	readonly indexed: Readonly<Record<string, ColdIndexResult["routes"]>>;
	/** Storages whose writer lease another process held: a running host keeps its own hints current. */
	readonly busy: readonly string[];
	readonly failed: Readonly<Record<string, string>>;
}

/** Index one catalogue record when an earlier release could have left a route without a hint. */
async function indexCandidate(
	sessionsRoot: string,
	catalog: AgentCatalog,
	storageId: string,
	build: {
		candidates: number;
		indexed: Record<string, ColdIndexResult["routes"]>;
		busy: string[];
		failed: Record<string, string>;
	},
	options: ColdWriterOptions & { readonly packageDir?: string; readonly apply?: boolean },
): Promise<void> {
	let record: CatalogRecord;
	try {
		record = catalog.read(storageId);
	} catch (error) {
		build.failed[storageId] = error instanceof Error ? error.message : String(error);
		return;
	}
	const wake = lstatSync(deliveryWakePath(sessionsRoot, storageId), { throwIfNoEntry: false }) !== undefined;
	if (record.recoveryDue !== true && !wake) return;
	build.candidates++;
	if (options.apply !== true) return;
	try {
		const outcome = await indexColdStorage(hostMetadata(record, options.packageDir), options);
		if ("busy" in outcome) build.busy.push(storageId);
		else build.indexed[storageId] = outcome.result.routes;
	} catch (error) {
		build.failed[storageId] = error instanceof Error ? error.message : String(error);
	}
}

/** Catalogue records checked in one page of the build. */
const BUILD_PAGE = 64;

/**
 * Index the storages that an earlier release left without recipient hints. A candidate has a delivery wake file
 * or a recovery marker; each is indexed under its own writer lease from its retained rows, so a repeated build
 * gives the same hints. Only an explicit build reads the catalogue for this; registration never does.
 */
export async function buildRecipientHints(
	sessionsRoot: string,
	options: ColdWriterOptions & {
		readonly packageDir?: string;
		readonly storage?: string;
		readonly apply?: boolean;
	} = {},
): Promise<RecipientHintBuild> {
	const catalog = new AgentCatalog(sessionsRoot);
	const identities = options.storage === undefined ? await catalog.identities() : [options.storage];
	const build = { candidates: 0, indexed: {}, busy: [], failed: {} } as {
		candidates: number;
		indexed: Record<string, ColdIndexResult["routes"]>;
		busy: string[];
		failed: Record<string, string>;
	};
	for (let first = 0; first < identities.length; first += BUILD_PAGE) {
		for (const storageId of identities.slice(first, first + BUILD_PAGE)) {
			options.signal?.throwIfAborted();
			await indexCandidate(sessionsRoot, catalog, storageId, build, options);
		}
	}
	return build;
}

function argument(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const argv = process.argv.slice(2);
	const agentDir = argument(argv, "--agent-dir");
	const sessionsRoot = resolve(
		agentDir !== undefined
			? join(agentDir, "agent-sessions")
			: (process.env.PI_AGENT_SESSIONS_DIR ?? join(getAgentDir(), "agent-sessions")),
	);
	const storage = argument(argv, "--storage");
	void buildRecipientHints(sessionsRoot, {
		apply: argv.includes("--apply"),
		packageDir: getPackageDir(),
		...(storage === undefined ? {} : { storage }),
	}).then(
		(build) => {
			process.stdout.write(`${JSON.stringify(build, null, 2)}\n`);
			process.exitCode = Object.keys(build.failed).length > 0 || build.busy.length > 0 ? 2 : 0;
		},
		(error: unknown) => {
			process.stderr.write(`Recipient hint build failed: ${String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
