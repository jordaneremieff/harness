/**
 * registry: the native Pi Durable form of the lookup.
 *
 * The contribution reads Pi Durable's own facts instead of a Pi session: the
 * tool task's registry snapshot and resolved agent, the host's cwd-bound
 * resource loader, the host's model runtime, and the host's contribution
 * inventory. The query, projection, and output logic is the ordinary lookup.
 *
 * The tool is read-only and `replay: "safe"`: a rerun after process loss reads
 * the same host state again and repeats no external effect. Cursors are keyed
 * to one host incarnation and one conversation, so a restart or a different
 * conversation cannot resume an old page.
 */

import { randomUUID } from "node:crypto";
import type * as Durable from "@earendil-works/pi-durable";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import { REGISTRY_DESCRIPTION, REGISTRY_PROMPT_GUIDELINES, REGISTRY_PROMPT_SNIPPET, RegistryParams } from "./contract.ts";
import type { ContextSnapshot } from "./host.ts";
import { type DurableLookupContext, lookup } from "./lookup.ts";
import { readDurableModels, type DurableModelReader } from "./models.ts";
import { ObservationStore, type ObservableOptions } from "./observer.ts";
import { RegistryOutputSchema } from "./output.ts";
import { decodeCursor, type RawParams } from "./query.ts";
import type { HostSnapshot, ObservationSnapshot, SurfaceAvailability } from "./records.ts";

/** One configured skill, as the host resource loader reports it. */
export interface DurableSkillFact {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly baseDir: string;
	readonly sourceInfo: SourceInfo;
	readonly disableModelInvocation: boolean;
}

/** One configured prompt template, as the host resource loader reports it. */
export interface DurablePromptFact {
	readonly name: string;
	readonly description: string;
	readonly sourceInfo: SourceInfo;
}

/** One configured Pi extension, as the host resource loader reports it. */
export interface DurableLoadedExtensionFact {
	readonly path: string;
	readonly resolvedPath: string;
	readonly sourceInfo: SourceInfo;
}

/** Read-only host services fields this contribution uses. */
export interface RegistryDurableServices {
	readonly resourceLoader: {
		getSkills(): { skills: readonly DurableSkillFact[] };
		getPrompts(): { prompts: readonly DurablePromptFact[] };
		getAgentsFiles(): { agentsFiles: readonly { path: string; content: string }[] };
		getExtensions(): { extensions: readonly DurableLoadedExtensionFact[] };
		getSystemPrompt(): string | undefined;
		getAppendSystemPrompt(): readonly string[];
	};
	readonly modelRuntime: DurableModelReader;
}

/** One contribution the host installed, with its command metadata. */
export interface DurableInventoryContribution {
	readonly name: string;
	readonly source: string;
	readonly commands: readonly { readonly name: string; readonly description: string }[];
}

/** Everything the host installs, complete before the first `create()` call. */
export interface RegistryDurableInventory {
	readonly contributions: readonly DurableInventoryContribution[];
	readonly ordinaryOnly: readonly string[];
}

/** Host facts one Durable contribution instance receives. */
export interface RegistryDurableHost {
	readonly durable: typeof Durable;
	readonly services: RegistryDurableServices;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	readonly signal: AbortSignal;
	readonly inventory: RegistryDurableInventory;
}

export interface RegistryDurableContribution {
	readonly name: "registry";
	/** Absolute path of the emitting extension entrypoint. */
	readonly source: string;
	create(host: RegistryDurableHost): Durable.Extension | Promise<Durable.Extension>;
}

interface ResourceFacts {
	readonly skills: readonly DurableSkillFact[];
	readonly prompts: readonly DurablePromptFact[];
	readonly agentsFiles: readonly { path: string; content: string }[];
	readonly systemPrompt: string | undefined;
	readonly appendSystemPrompt: readonly string[];
	readonly extensions: readonly DurableLoadedExtensionFact[];
}

function readResourceFacts(services: RegistryDurableServices): ResourceFacts | null {
	try {
		const loader = services.resourceLoader;
		return {
			skills: loader.getSkills().skills,
			prompts: loader.getPrompts().prompts,
			agentsFiles: loader.getAgentsFiles().agentsFiles,
			systemPrompt: loader.getSystemPrompt(),
			appendSystemPrompt: loader.getAppendSystemPrompt(),
			extensions: loader.getExtensions().extensions,
		};
	} catch {
		/* A failed resource read is unavailable, never an empty inventory. */
		return null;
	}
}

/** Pi-registered provenance for a contribution's absolute source, or a synthetic label. */
function extensionSourceInfo(source: string, extensions: readonly DurableLoadedExtensionFact[]): SourceInfo {
	const match = extensions.find(
		(extension) =>
			extension.resolvedPath === source || extension.path === source || extension.sourceInfo.path === source,
	);
	if (match) return { ...match.sourceInfo };
	return { path: source, source: "local", scope: "temporary", origin: "top-level" };
}

/** Provenance for a tool of an installed Durable extension. */
function installedToolSourceInfo(
	extensionName: string,
	inventory: RegistryDurableInventory,
	extensions: readonly DurableLoadedExtensionFact[],
): SourceInfo {
	const contribution = inventory.contributions.find((entry) => entry.name === extensionName);
	if (contribution) return extensionSourceInfo(contribution.source, extensions);
	return { path: `<durable:${extensionName}>`, source: "durable", scope: "temporary", origin: "top-level" };
}

function buildObservation(
	facts: ResourceFacts,
	agent: Durable.Agent | undefined,
	cwd: string,
	at: number,
): ObservationSnapshot | null {
	try {
		const options: ObservableOptions = {
			cwd,
			...(typeof facts.systemPrompt === "string" ? { customPrompt: facts.systemPrompt } : {}),
			...(facts.appendSystemPrompt.length > 0 ? { appendSystemPrompt: facts.appendSystemPrompt.join("\n\n") } : {}),
			selectedTools: agent?.tools.map((tool) => tool.name) ?? [],
			contextFiles: facts.agentsFiles.map((file) => ({ path: file.path, content: file.content })),
			skills: facts.skills.map((skill) => ({
				name: skill.name,
				filePath: skill.filePath,
				baseDir: skill.baseDir,
				disableModelInvocation: skill.disableModelInvocation,
				sourceInfo: { ...skill.sourceInfo },
			})),
		};
		const store = new ObservationStore();
		store.observe(options, at);
		return store.snapshot();
	} catch {
		return null;
	}
}

/**
 * Project the Durable host's facts into the host snapshot the lookup consumes.
 *
 * Installed tools come from the tool task's registry snapshot; the resolved
 * agent's tools are the offered set. Commands come from the host contribution
 * inventory; skills and prompts come from the host resource loader.
 */
function readDurableSnapshot(
	host: RegistryDurableHost,
	registry: Durable.RegistrySnapshot,
	agent: Durable.Agent | undefined,
	at: number,
): HostSnapshot {
	const facts = readResourceFacts(host.services);
	const extensions = facts?.extensions ?? [];
	const availability: SurfaceAvailability = {
		tools: false,
		activeTools: agent !== undefined,
		commands: facts !== null,
	};

	let tools: HostSnapshot["tools"] = [];
	try {
		tools = registry.tools().map(({ extension, tool }) => ({
			name: tool.name,
			description: tool.description,
			sourceInfo: installedToolSourceInfo(extension.name, host.inventory, extensions),
			parameters: tool.parameters,
		}));
		availability.tools = true;
	} catch {
		/* A failed registry read is unavailable, never an empty tool set. */
	}

	const commands: HostSnapshot["commands"] = [];
	for (const contribution of host.inventory.contributions) {
		const sourceInfo = extensionSourceInfo(contribution.source, extensions);
		for (const command of contribution.commands) {
			commands.push({
				name: command.name,
				description: command.description,
				source: "extension",
				sourceInfo,
				invocation: null,
			});
		}
	}
	for (const skill of facts?.skills ?? []) {
		commands.push({
			name: skill.name,
			description: skill.description,
			source: "skill",
			sourceInfo: skill.sourceInfo,
			invocation: `skill:${skill.name}`,
		});
	}
	for (const prompt of facts?.prompts ?? []) {
		commands.push({
			name: prompt.name,
			description: prompt.description,
			source: "prompt",
			sourceInfo: prompt.sourceInfo,
			invocation: null,
		});
	}

	return {
		tools,
		activeTools: agent?.tools.map((tool) => tool.name) ?? [],
		commands,
		observation: facts === null ? null : buildObservation(facts, agent, host.cwd, at),
		availability,
		at,
	};
}

/** The query layer reads this only for a no-argument summary. */
function durableContext(agent: Durable.Agent | undefined, at: number): ContextSnapshot {
	return {
		at,
		evidence: "host_estimate",
		state: "unavailable",
		model: agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : null,
		thinkingLevel: agent?.thinkingLevel ?? null,
		tokens: null,
		contextWindow: null,
		percent: null,
	};
}

function durableLookupContext(host: RegistryDurableHost): DurableLookupContext {
	const coverage = {
		contributions: host.inventory.contributions.map((entry) => entry.name),
		ordinaryOnly: [...host.inventory.ordinaryOnly],
	};
	return {
		coverage,
		recordSourceLine: "source: Durable registry snapshot, resolved agent tools, host resource loader, and contribution inventory",
		commandSurface: "resource loader and contribution inventory",
		boundaries: {
			toolSchema:
				"Configured presence is not offered or activation authority. The resolved agent's tools are the offered set. Tool-call checks still apply; output schemas are not shown here.",
			commandDispatch:
				"Contributed commands are invoked through the host's agent controls, not as slash commands; registration is not dispatch. Skill and prompt records come from the host resource loader.",
			inventory:
				"Not a complete inventory: extensions without registered resources are excluded. Full settings and resource load rejection reasons are excluded. Configured extensions without a Durable form are named in the no-argument summary.",
			...(coverage.ordinaryOnly.length > 0
				? {
						coverage: `Configured extensions without a Durable form are not invokable in this conversation (${coverage.ordinaryOnly.length}).`,
					}
				: {}),
		},
	};
}

function emptySnapshot(at: number): HostSnapshot {
	return {
		tools: [],
		activeTools: [],
		commands: [],
		observation: null,
		availability: { tools: false, activeTools: false, commands: false },
		at,
	};
}

function combineSignals(toolSignal: AbortSignal | undefined, hostSignal: AbortSignal): AbortSignal {
	return toolSignal === undefined ? hostSignal : AbortSignal.any([toolSignal, hostSignal]);
}

/** Chord context a tool call receives. */
type ToolContext = Parameters<Durable.ToolExecutionApi["agent"]>[0];

/** The query is a model query when the fresh kind says so or its cursor carries one. */
function modelQueryOf(args: { readonly kind?: string; readonly cursor?: string }): boolean {
	if (args.kind === "model") return true;
	if (args.cursor === undefined) return false;
	try {
		return decodeCursor(args.cursor).query.kind === "model";
	} catch {
		/* The query layer returns the bounded validation error. */
		return false;
	}
}

/** Read the call's native facts; an aborted call probes nothing. */
async function resolveCall(
	host: RegistryDurableHost,
	api: Durable.ToolExecutionApi,
	context: ToolContext,
	signal: AbortSignal,
	at: number,
): Promise<{ snapshot: HostSnapshot; agent: Durable.Agent | undefined }> {
	if (signal.aborted) return { snapshot: emptySnapshot(at), agent: undefined };
	let agent: Durable.Agent | undefined;
	try {
		agent = await api.agent(context);
	} catch {
		/* An unresolved agent leaves the offered-tool surface unavailable. */
	}
	return { snapshot: readDurableSnapshot(host, api.registry, agent, at), agent };
}

export function createRegistryDurableContribution(source: string): RegistryDurableContribution {
	return {
		name: "registry",
		source,
		create(host) {
			const durable = host.durable;
			const hostEpoch = randomUUID();
			const tool = durable.defineTool({
				name: "registry",
				description: REGISTRY_DESCRIPTION,
				parameters: RegistryParams,
				replay: "safe",
				execute: async (args, api, context) => {
					const at = Date.now();
					const signal = combineSignals(context.abortSignal, host.signal);
					const { snapshot, agent } = await resolveCall(host, api, context, signal, at);
					const result = await lookup({
						params: args as RawParams,
						snapshot,
						session: { cwd: host.cwd },
						readContext: () => durableContext(agent, at),
						...(modelQueryOf(args) && !signal.aborted
							? { models: readDurableModels(host.services.modelRuntime, agent ?? {}, at) }
							: {}),
						epoch: `${hostEpoch}:${String(api.conversationId)}`,
						signal,
						durable: durableLookupContext(host),
					});
					const details = JSON.parse(
						JSON.stringify({ ...result.details, structuredContent: result.structuredContent }),
					) as Durable.JsonObject;
					return { content: [{ type: "text", text: result.text }], details };
				},
			});
			const guidance = durable.section("registry", (input) =>
				input.agent.tools.some((candidate) => candidate.name === "registry")
					? [REGISTRY_PROMPT_SNIPPET, ...REGISTRY_PROMPT_GUIDELINES].join("\n")
					: undefined,
			);
			const registration: Durable.ToolRegistration & { outputSchema: typeof RegistryOutputSchema } = {
				...tool,
				outputSchema: RegistryOutputSchema,
			};
			return durable.defineExtension({
				name: "registry",
				tools: [registration],
				sections: [guidance],
			});
		},
	};
}
