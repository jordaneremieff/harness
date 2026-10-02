/**
 * agent/durable-services: native Pi Durable bootstrap for one cwd-bound agent host.
 *
 * The bootstrap creates Pi's public cwd-bound services with its own EventBus,
 * so the configured extension set of a primary session at that directory loads
 * with the same settings, package routing, and project-trust resolution. The
 * caller may name the running Pi installation with `packageDir`; the bootstrap
 * then loads that installation's public package entry instead of the copy this
 * module resolves by itself. While the factories run, configured extensions
 * that have a native Durable form emit one contribution on
 * `durable:contribution`. The bootstrap matches every contribution's source
 * against the resolved paths of the loaded extensions, records the configured
 * extensions that emitted nothing, and installs a Durable registry whose
 * built-in extension supplies the coding tools and the resource-derived prompt
 * sections. A contribution whose source matches no loaded extension entrypoint
 * is reported and never installed.
 *
 * The inventory is complete before any contribution's `create()` runs. The
 * caller reports it in agent status; the built-in prompt section names every
 * ordinary-only extension to the model. The caller owns the registry, the
 * services, and the Durable storage lifecycle. It opens the Harness with
 * `durable` from this result and the returned registry, calls `install(harness)`
 * before scheduling starts, and closes storage after `close()`. `close()` aborts
 * the host signal, then awaits the registered close work in reverse registration
 * order and releases every execution environment it created.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import * as Durable from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import {
	ProjectTrustStore,
	SettingsManager,
	createAgentSessionServices,
	createEventBus,
	createReadTool,
	formatSkillsForPrompt,
	getAgentDir,
	hasTrustRequiringProjectResources,
	type AgentSessionServices,
	type InlineExtension,
	type LoadExtensionsResult,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createProjectTrustResolver, type ProjectTrustDecision } from "./trust-support.ts";

/** One command invocation as the host dispatches it. */
export interface DurableCommandCall {
	readonly args: string;
	readonly conversation: Durable.Conversation;
	/** The host's open Harness, for task-level control such as `abortTask()`. */
	readonly harness: Durable.Harness;
	readonly context: Context;
	/** The host that runs the command. Key per-host bindings by it, because one process can run several hosts. */
	readonly host: DurableContributionHost;
	/**
	 * Unique per invocation and stable when the caller retries the same
	 * invocation. Derive request IDs from it, never from the arguments alone:
	 * two identical invocations are two requests.
	 */
	readonly invocationId: string;
}

/** Commands that agent controls invoke by name against one conversation. */
export interface DurableCommand {
	readonly name: string;
	readonly description: string;
	/** Run against one conversation. The result text returns to the caller. */
	run(call: DurableCommandCall): Promise<string>;
}

/** One native Durable form emitted by a configured extension factory. */
export interface DurableContribution {
	readonly name: string;
	/** Absolute path of the emitting extension's entrypoint, such as `fileURLToPath(import.meta.url)`. */
	readonly source: string;
	create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
	readonly commands?: readonly DurableCommand[];
}

/** Session host passed to every contribution `create()` call. */
export interface DurableContributionHost {
	/** The bootstrap's pi-durable module. Take every pi-durable runtime value from it. */
	readonly durable: typeof Durable;
	/** Pi's cwd-bound services: settings, resources, and model runtime. Read-only use. */
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	/** The agent storage: one root conversation plus its forks and child agents. */
	readonly storageId: string;
	/**
	 * The host's open Harness. The host opens it before the first `create()`
	 * call and starts scheduling only after it installs every contribution.
	 */
	readonly harness: Durable.Harness;
	/** Aborted when the host starts to shut down. */
	readonly signal: AbortSignal;
	/**
	 * Register final work, such as a flush. At close the host aborts `signal`,
	 * then awaits every registered function in reverse registration order
	 * before storage closes. A failure is reported and does not stop the others.
	 */
	onClose(dispose: () => void | Promise<void>): void;
	/** Everything the host installs. Complete before the first `create()` call. */
	readonly inventory: DurableInventory;
}

/** What the host installs, complete before the first contribution `create()` call. */
export interface DurableInventory {
	/** Contributions in load order, with their command metadata. */
	readonly contributions: readonly {
		readonly name: string;
		readonly source: string;
		readonly commands: readonly { readonly name: string; readonly description: string }[];
	}[];
	/** Resolved paths of configured extensions that emitted no contribution. */
	readonly ordinaryOnly: readonly string[];
}

/** Inputs for the cwd-bound Durable bootstrap. */
export interface CreateDurableServicesOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	/** The agent storage identity passed to contributions. */
	readonly storageId: string;
	/** Aborted when the owning host shuts down; also aborts the bootstrap signal. */
	readonly signal?: AbortSignal;
	/**
	 * Root directory of the running Pi installation whose services and resources
	 * this bootstrap uses. Its public package root export is loaded dynamically;
	 * absent means the installation this module resolves by itself.
	 */
	readonly packageDir?: string;
	readonly settingsManager?: SettingsManager;
	/** A runtime that already carries inherited providers. The bootstrap registers loaded providers into it. */
	readonly modelRuntime?: ModelRuntime;
	/** Additional extension resource paths, as the CLI `-e` paths of the configured set. */
	readonly extensionPaths?: readonly string[];
	readonly skillPaths?: readonly string[];
	/** Inline extension factories that supply built-in registrations such as codemode. */
	readonly extensionFactories?: readonly InlineExtension[];
	/**
	 * Native built-in extensions to install after the host's coding and prompt
	 * built-in and before every contribution, in this order. Called once per
	 * host after the inventory is complete, so the callback can build
	 * inventory-aware built-ins for codemode, MCP, or agent controls. Accepts
	 * plain extensions or a bundle whose `close` releases their resources when
	 * `DurableServices.close()` runs.
	 */
	readonly buildBuiltin?: (host: DurableContributionHost) => Durable.Extension | readonly Durable.Extension[] | DurableBuiltinExecution | Promise<Durable.Extension | readonly Durable.Extension[] | DurableBuiltinExecution>;
	/** Explicit project-trust decision. Absent: project handlers, saved decisions, then the default setting. */
	readonly trusted?: boolean;
	/** Saved project-trust decisions consulted when `trusted` is absent. */
	readonly trustStore?: ProjectTrustStore;
	/** Route one unresolved project-trust ask to the primary session; undefined refuses. */
	readonly askPrimary?: (cwd: string) => Promise<ProjectTrustDecision | undefined>;
	/** Full project-trust resolution, for a caller that already owns that logic. */
	readonly resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
	/** Receives non-fatal bootstrap failures: load errors and unmatched contributions. Must not throw. */
	readonly onReport?: (error: unknown) => void;
}

/** Native built-in extensions plus the release for the resources they hold. */
export interface DurableBuiltinExecution {
	readonly extensions: Durable.Extension | readonly Durable.Extension[];
	/** Bounded initial capability readiness; settled before any generation resumes. */
	readonly ready?: Promise<void>;
	close?(): void | Promise<void>;
}

/** Cwd-bound services, the installed Durable registry, and the host inventory. */
export interface DurableServices {
	/** The bootstrap's pi-durable module, for the caller's own runtime values and the Harness. */
	readonly durable: typeof Durable;
	readonly services: AgentSessionServices;
	/** The exact host passed to contributions; command callers pass it to `DurableCommand.run`. */
	readonly contributionHost: DurableContributionHost;
	readonly registry: Durable.Registry;
	readonly inventory: DurableInventory;
	readonly commands: ReadonlyMap<string, DurableCommand>;
	/** Harness settings read through the settings manager at every resolution. */
	readonly settings: Durable.HarnessSettings;
	/** Execution environments by conversation cwd. `close()` cleans every one. */
	readonly env: NonNullable<Durable.HarnessOptions["env"]>;
	/**
	 * Install every native contribution against the host's open Harness. The
	 * caller opens the Harness with `registry` and no resume, calls this once
	 * before scheduling starts, and closes storage after `close()`.
	 */
	install(harness: Durable.Harness): Promise<void>;
	close(): Promise<void>;
}

/** The public Pi package exports this bootstrap needs from the selected installation. */
interface PiRuntime {
	createAgentSessionServices: typeof createAgentSessionServices;
	createEventBus: typeof createEventBus;
	createReadTool: typeof createReadTool;
	formatSkillsForPrompt: typeof formatSkillsForPrompt;
	getAgentDir: typeof getAgentDir;
	hasTrustRequiringProjectResources: typeof hasTrustRequiringProjectResources;
	ProjectTrustStore: typeof ProjectTrustStore;
	SettingsManager: typeof SettingsManager;
}

const localRuntime: PiRuntime = {
	createAgentSessionServices,
	createEventBus,
	createReadTool,
	formatSkillsForPrompt,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
};

/** Read the `import` target of one package `exports` value, then the `default` target. */
function rootExportTarget(exports: unknown): string | undefined {
	if (typeof exports === "string") return exports;
	if (typeof exports !== "object" || exports === null) return undefined;
	const entry = (exports as Record<string, unknown>)["."];
	if (typeof entry === "string") return entry;
	if (typeof entry !== "object" || entry === null) return undefined;
	const conditions = entry as Record<string, unknown>;
	if (typeof conditions.import === "string") return conditions.import;
	if (typeof conditions.default === "string") return conditions.default;
	return undefined;
}

/** Resolve the public root export of a Pi package directory from its own manifest. */
function resolvePackageEntry(packageDir: string): string {
	const manifestPath = join(packageDir, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; main?: string; exports?: unknown };
	if (manifest.name !== "@earendil-works/pi-coding-agent") throw new Error(`packageDir ${packageDir} is not @earendil-works/pi-coding-agent`);
	const target = rootExportTarget(manifest.exports) ?? manifest.main;
	if (typeof target !== "string") throw new Error(`packageDir ${packageDir} declares no importable package root export`);
	return resolve(packageDir, target);
}

/** Load the services and resource code of the selected running Pi installation. */
async function loadPiRuntime(packageDir: string | undefined): Promise<PiRuntime> {
	if (packageDir === undefined) return localRuntime;
	const entry = resolvePackageEntry(packageDir);
	const loaded = await import(pathToFileURL(entry).href) as Record<string, unknown>;
	for (const name of ["createAgentSessionServices", "createEventBus", "createReadTool", "formatSkillsForPrompt", "getAgentDir", "hasTrustRequiringProjectResources", "ProjectTrustStore", "SettingsManager"] as const) {
		if (typeof loaded[name] !== "function") throw new Error(`packageDir ${packageDir} does not export ${name}`);
	}
	return loaded as unknown as PiRuntime;
}

/** Read a required non-empty string field of a contribution record. */
function requiredString(record: Record<string, unknown>, key: string, message: string): string {
	const value = record[key];
	if (typeof value !== "string" || value === "") throw new Error(message);
	return value;
}

/** Read and validate the command list of one emitted contribution. */
function readCommandList(contribution: string, raw: unknown): DurableCommand[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) throw new Error(`durable contribution "${contribution}" commands must be an array`);
	return raw.map((input) => {
		if (typeof input !== "object" || input === null) throw new Error(`durable contribution "${contribution}" has a malformed command`);
		const command = input as Record<string, unknown>;
		const name = requiredString(command, "name", `durable contribution "${contribution}" has a command without a name`);
		if (typeof command.description !== "string") throw new Error(`durable command "${name}" requires a description`);
		if (typeof command.run !== "function") throw new Error(`durable command "${name}" requires a run function`);
		return input as DurableCommand;
	});
}

/** Parse one emitted contribution, rejecting contract violations at the emitting factory. */
function readContribution(data: unknown, existing: readonly DurableContribution[]): DurableContribution {
	if (typeof data !== "object" || data === null) throw new Error("durable:contribution payload must be an object");
	const record = data as Record<string, unknown>;
	const name = requiredString(record, "name", "durable:contribution requires a non-empty name");
	const source = requiredString(record, "source", `durable contribution "${name}" requires an absolute source path`);
	if (!isAbsolute(source)) throw new Error(`durable contribution "${name}" requires an absolute source path`);
	if (typeof record.create !== "function") throw new Error(`durable contribution "${name}" requires a create function`);
	if (existing.some((contribution) => contribution.name === name)) throw new Error(`durable contribution name "${name}" is already emitted`);
	if (existing.some((contribution) => contribution.source === source)) throw new Error(`extension ${source} emitted more than one durable contribution`);
	const commands = readCommandList(name, record.commands);
	return { name, source, create: record.create as DurableContribution["create"], ...(commands === undefined ? {} : { commands }) };
}

/** Local calendar date for the prompt preamble. */
function localDate(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Build the durable read tool from the selected installation's public read tool, which returns images. */
function durableReadTool(pi: PiRuntime, cwd: string, hostSignal: AbortSignal): Durable.ToolRegistration {
	const piRead = pi.createReadTool(cwd);
	return Durable.defineTool({
		name: piRead.name,
		description: piRead.description,
		parameters: piRead.parameters,
		replay: "safe",
		async execute(args, api, context) {
			const signal = context.abortSignal === undefined ? hostSignal : AbortSignal.any([hostSignal, context.abortSignal]);
			const result = await piRead.execute(api.callId, args, signal);
			const truncation = (result.details as { truncation?: object } | undefined)?.truncation;
			const details: JsonValue | undefined = truncation === undefined ? undefined : { ...truncation };
			return {
				content: result.content,
				...(details === undefined ? {} : { details }),
				...(result.isError === undefined ? {} : { isError: result.isError }),
			};
		},
	});
}

/** The host built-in extension: coding tools and resource-derived prompt sections. */
function buildBuiltin(pi: PiRuntime, services: AgentSessionServices, inventory: DurableInventory, signal: AbortSignal): Durable.Extension {
	return Durable.defineExtension({
		name: "pi.host",
		tools: [
			durableReadTool(pi, services.cwd, signal),
			{ ...createWriteTool(), replay: "unsafe" },
			{ ...createEditTool(), replay: "unsafe" },
			{ ...createBashTool(), replay: "unsafe" },
		],
		sections: [
			Durable.section("preamble", () => [
				"You are an expert coding assistant operating inside the Pi agent harness.",
				"Read files before you change them, keep changes focused on the task, and state what you changed.",
				`Today's date is ${localDate()}.`,
				"You work for an owning session. When the host appends owner metadata, treat that owner as your caller and report your result to it.",
			].join("\n"), { tag: false }),
			Durable.section("addendum", () => {
				const text = services.resourceLoader.getAppendSystemPrompt().filter((prompt) => prompt.trim() !== "").join("\n\n");
				return text === "" ? undefined : text;
			}),
			Durable.section("project_context", () => {
				const files = services.resourceLoader.getAgentsFiles().agentsFiles;
				if (files.length === 0) return undefined;
				return [
					"Project-specific instructions and guidelines:",
					...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
				].join("\n\n");
			}),
			Durable.section("skills", () => {
				const { skills } = services.resourceLoader.getSkills();
				if (skills.length === 0) return undefined;
				const text = pi.formatSkillsForPrompt(skills, "read").trim();
				return text === "" ? undefined : text;
			}),
			Durable.section("cwd", () => services.cwd.replaceAll("\\", "/")),
			Durable.section("ordinary_only", () => {
				if (inventory.ordinaryOnly.length === 0) return undefined;
				return [
					"Configured extensions with no native Durable form in this conversation:",
					...inventory.ordinaryOnly.map((path) => `- ${path}`),
				].join("\n");
			}),
		],
	});
}

/** Keep only the contributions whose source is a configured extension entrypoint. */
function matchContributions(contributions: readonly DurableContribution[], loadedPaths: readonly string[]): DurableContribution[] {
	const loaded = new Set(loadedPaths);
	return contributions.filter((contribution) => loaded.has(contribution.source));
}

/** Build the inventory from emitted contributions and the loaded extension paths. */
function buildInventory(contributions: readonly DurableContribution[], loadedPaths: readonly string[]): DurableInventory {
	const emitted = new Set(contributions.map((contribution) => contribution.source));
	return {
		contributions: contributions.map((contribution) => ({
			name: contribution.name,
			source: contribution.source,
			commands: (contribution.commands ?? []).map((command) => ({ name: command.name, description: command.description })),
		})),
		ordinaryOnly: loadedPaths.filter((path) => !emitted.has(path)),
	};
}

/** Map command names to their run functions, rejecting duplicate names. */
function buildCommands(contributions: readonly DurableContribution[]): Map<string, DurableCommand> {
	const commands = new Map<string, DurableCommand>();
	for (const contribution of contributions) {
		for (const command of contribution.commands ?? []) {
			if (commands.has(command.name)) throw new Error(`durable command "${command.name}" is declared more than once`);
			commands.set(command.name, command);
		}
	}
	return commands;
}

/** Install each contribution's native extension after the built-ins, in load order. */
async function installContributions(registry: Durable.Registry, contributions: readonly DurableContribution[], host: DurableContributionHost, installed: Set<string>): Promise<void> {
	for (const contribution of contributions) {
		let extension: Durable.Extension;
		try {
			extension = await contribution.create(host);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`durable contribution "${contribution.name}" failed to create its extension: ${detail}`, { cause: error });
		}
		validateExtension(extension, installed, `durable contribution "${contribution.name}"`);
		installed.add(extension.name);
		registry.install(extension);
	}
}

/** Install the extensions a native built-in hook returned, before every contribution. */
function installBuiltins(registry: Durable.Registry, built: Durable.Extension | readonly Durable.Extension[], installed: Set<string>): void {
	for (const extension of Array.isArray(built) ? built : [built]) {
		validateExtension(extension, installed, "durable built-in");
		installed.add(extension.name);
		registry.install(extension);
	}
}

/** A built-in bundle carries a named extension collection instead of one extension. */
function isBuiltinExecution(built: Durable.Extension | readonly Durable.Extension[] | DurableBuiltinExecution): built is DurableBuiltinExecution {
	return typeof built === "object" && built !== null && !Array.isArray(built) && "extensions" in built;
}

/** Install a native built-in hook result and register its release on the host, when it carries one. */
async function installBuiltinHook(registry: Durable.Registry, hook: NonNullable<CreateDurableServicesOptions["buildBuiltin"]>, host: DurableContributionHost, installed: Set<string>): Promise<void> {
	const built = await hook(host);
	if (!isBuiltinExecution(built)) {
		installBuiltins(registry, built, installed);
		return;
	}
	installBuiltins(registry, built.extensions, installed);
	if (built.close !== undefined) host.onClose(built.close.bind(built));
	await built.ready;
}

/** Await every registered close callback in reverse order; report and collect every failure. */
async function drainClosers(closers: Array<() => void | Promise<void>>, report: (error: unknown) => void): Promise<unknown[]> {
	const failures: unknown[] = [];
	while (closers.length > 0) {
		const dispose = closers.pop();
		if (dispose === undefined) break;
		try {
			await dispose();
		} catch (error) {
			failures.push(error);
			report(error);
		}
	}
	return failures;
}

/** Release every registered close callback and execution environment, reporting every failure. */
async function releaseServices(closers: Array<() => void | Promise<void>>, envs: Map<string, NodeExecutionEnv>, report: (error: unknown) => void): Promise<void> {
	const failures = await drainClosers(closers, report);
	const cleanup = await Promise.allSettled([...envs.values()].map((environment) => environment.cleanup(BACKGROUND_CONTEXT)));
	envs.clear();
	for (const result of cleanup) if (result.status === "rejected") { failures.push(result.reason); report(result.reason); }
	failures.push(...await drainClosers(closers, report));
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "durable services cleanup failed");
}

/** Reject a malformed or duplicate-name extension before it enters the registry. */
function validateExtension(extension: Durable.Extension, installed: ReadonlySet<string>, owner: string): void {
	if (extension === null || typeof extension !== "object" || typeof extension.name !== "string") throw new Error(`${owner} did not return an extension`);
	if (installed.has(extension.name)) throw new Error(`${owner} installs the duplicate extension name "${extension.name}"`);
}

/** Report the non-fatal bootstrap failures named by the contract. */
function reportIssues(report: (error: unknown) => void, collection: readonly Error[], services: AgentSessionServices, loaded: LoadExtensionsResult, contributions: readonly DurableContribution[]): void {
	for (const error of collection) report(error);
	for (const item of services.diagnostics) if (item.type === "error") report(new Error(item.message));
	for (const item of loaded.errors) report(new Error(`${item.path}: ${item.error}`));
	const matched = new Set(loaded.extensions.map((extension) => extension.resolvedPath));
	for (const contribution of contributions) {
		if (!matched.has(contribution.source)) report(new Error(`durable contribution "${contribution.name}" from ${contribution.source} matches no loaded extension entrypoint`));
	}
}

/** Build the public trust resolver for one cwd and saved store. */
function projectTrustResolver(pi: PiRuntime, options: CreateDurableServicesOptions, cwd: string, settingsManager: SettingsManager, agentDir: string, report: (error: unknown) => void): (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean> {
	if (options.resolveProjectTrust !== undefined) return options.resolveProjectTrust;
	const trustStore = options.trustStore ?? new pi.ProjectTrustStore(agentDir);
	return createProjectTrustResolver({
		cwd,
		settingsManager,
		trustStore,
		requiresTrust: pi.hasTrustRequiringProjectResources,
		...(options.trusted === undefined ? {} : { trusted: options.trusted }),
		...(options.askPrimary === undefined ? {} : { askPrimary: options.askPrimary }),
		onReport: report,
	});
}

/**
 * Create cwd-bound Pi services, collect native Durable contributions from the
 * loaded configured extensions, and install the Durable registry.
 */
export async function createDurableServices(options: CreateDurableServicesOptions): Promise<DurableServices> {
	const pi = await loadPiRuntime(options.packageDir);
	const cwd = resolve(options.cwd);
	const agentDir = options.agentDir === undefined ? pi.getAgentDir() : resolve(options.agentDir);
	const settingsManager = options.settingsManager ?? pi.SettingsManager.create(cwd, agentDir);

	const bus = pi.createEventBus();
	const contributions: DurableContribution[] = [];
	const collectionErrors: Error[] = [];
	const unsubscribe = bus.on("durable:contribution", (data) => {
		try {
			contributions.push(readContribution(data, contributions));
		} catch (error) {
			collectionErrors.push(error instanceof Error ? error : new Error(String(error)));
		}
	});
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) controller.abort(options.signal.reason);
	else options.signal?.addEventListener("abort", forwardAbort, { once: true });

	const report = options.onReport ?? (() => {});
	const resolveTrust = projectTrustResolver(pi, options, cwd, settingsManager, agentDir, report);
	let services: AgentSessionServices;
	try {
		services = await pi.createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
			resourceLoaderOptions: {
				eventBus: bus,
				...(options.extensionPaths === undefined ? {} : { additionalExtensionPaths: [...options.extensionPaths] }),
				...(options.skillPaths === undefined ? {} : { additionalSkillPaths: [...options.skillPaths] }),
				...(options.extensionFactories === undefined ? {} : { extensionFactories: [...options.extensionFactories] }),
			},
			resourceLoaderReloadOptions: { resolveProjectTrust: resolveTrust },
		});
	} catch (error) {
		unsubscribe();
		options.signal?.removeEventListener("abort", forwardAbort);
		throw error;
	}
	unsubscribe();

	const envs = new Map<string, NodeExecutionEnv>();
	const closers: Array<() => void | Promise<void>> = [];
	let closed = false;
	let harnessValue: Durable.Harness | undefined;
	let installed = false;
	let closePromise: Promise<void> | undefined;
	/** A registration after shutdown already drained the list runs immediately. */
	const onClose = (dispose: () => void | Promise<void>): void => {
		if (!closed) {
			closers.push(dispose);
			return;
		}
		void Promise.resolve().then(dispose).catch(report);
	};
	/** Abort the host signal, then release every registered callback and environment. Idempotent. */
	const closeNow = async (): Promise<void> => {
		if (closePromise) return closePromise;
		options.signal?.removeEventListener("abort", forwardAbort);
		controller.abort();
		closePromise = (async () => {
			try {
				await releaseServices(closers, envs, report);
			} finally {
				closed = true;
			}
		})();
		return closePromise;
	};
	const env: NonNullable<Durable.HarnessOptions["env"]> = (target) => {
		if (closed) throw new Error("durable services are closed");
		const targetCwd = target.cwd ?? services.cwd;
		let environment = envs.get(targetCwd);
		if (environment === undefined) {
			environment = new NodeExecutionEnv({ cwd: targetCwd });
			envs.set(targetCwd, environment);
		}
		return environment;
	};

	try {
		const loaded = services.resourceLoader.getExtensions();
		reportIssues(report, collectionErrors, services, loaded, contributions);
		const loadedPaths = loaded.extensions.map((extension) => extension.resolvedPath);
		const matched = matchContributions(contributions, loadedPaths);
		const inventory = buildInventory(matched, loadedPaths);
		const commands = buildCommands(matched);
		const builtin = buildBuiltin(pi, services, inventory, controller.signal);
		const registry = Durable.createRegistry();
		registry.install(builtin);
		const host: DurableContributionHost = {
			durable: Durable,
			services,
			cwd: services.cwd,
			agentDir: services.agentDir,
			storageId: options.storageId,
			get harness() {
				if (harnessValue === undefined) throw new Error("the durable contribution host has no open Harness yet");
				return harnessValue;
			},
			signal: controller.signal,
			onClose,
			inventory,
		};
		/** Install every native contribution against the open Harness, before scheduling starts. */
		const install = async (harness: Durable.Harness): Promise<void> => {
			if (installed) throw new Error("durable contributions are already installed");
			if (closed) throw new Error("durable services are closed");
			installed = true;
			harnessValue = harness;
			try {
				const installedNames = new Set([builtin.name]);
				if (options.buildBuiltin !== undefined) await installBuiltinHook(registry, options.buildBuiltin, host, installedNames);
				await installContributions(registry, matched, host, installedNames);
			} catch (error) {
				try {
					await closeNow();
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "durable bootstrap and cleanup failed");
				}
				throw error;
			}
		};

		const settings: Durable.HarnessSettings = {
			get retry() { return services.settingsManager.getRetrySettings(); },
			get compaction() { return services.settingsManager.getCompactionSettings(); },
			get steeringMode() { return services.settingsManager.getSteeringMode(); },
			get followUpMode() { return services.settingsManager.getFollowUpMode(); },
		};

		return {
			durable: Durable,
			services,
			contributionHost: host,
			registry,
			inventory,
			commands,
			settings,
			env,
			install,
			close: closeNow,
		};
	} catch (error) {
		try {
			await closeNow();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "durable bootstrap and cleanup failed");
		}
		throw error;
	}
}
