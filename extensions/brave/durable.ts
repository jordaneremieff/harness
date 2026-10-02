/**
 * Native Pi Durable form of the brave web tools.
 *
 * The ordinary entrypoint emits this contribution from its factory. The Durable
 * session host installs the returned extension; an ordinary session has no
 * listener on the channel, so the emission has no effect there.
 */

import type { Context, JsonValue } from "@earendil-works/chord";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import {
	BRAVE_WEB_READ_DESCRIPTION,
	BRAVE_WEB_READ_GUIDELINES,
	BRAVE_WEB_READ_PARAMETERS,
	BRAVE_WEB_READ_SNIPPET,
	BRAVE_WEB_SEARCH_DESCRIPTION,
	BRAVE_WEB_SEARCH_GUIDELINES,
	BRAVE_WEB_SEARCH_PARAMETERS,
	BRAVE_WEB_SEARCH_SNIPPET,
	runWebSearch,
} from "./capability.ts";
import { readWebPage } from "./page-reader.ts";

/** Everything the host installs, complete before the first `create()` call. */
export interface DurableInventory {
	readonly contributions: readonly {
		readonly name: string;
		readonly source: string;
		readonly commands: readonly { readonly name: string; readonly description: string }[];
	}[];
	/** Resolved paths of configured extensions that emitted no contribution. */
	readonly ordinaryOnly: readonly string[];
}

export interface DurableContributionHost {
	/** The host's pi-durable module; every pi-durable runtime value comes from here. */
	readonly durable: typeof Durable;
	/** Pi's cwd-bound services, for read-only use. */
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	/** The agent storage: one root conversation plus its forks and child agents. */
	readonly storageId: string;
	/** Aborted when the host shuts down. */
	readonly signal: AbortSignal;
	readonly inventory: DurableInventory;
}

export interface DurableContribution {
	/** Durable extension name; unique across contributions. */
	readonly name: string;
	/** Absolute path of the emitting extension entrypoint. */
	readonly source: string;
	/** Build the native extension for one session host; called once per host. */
	create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
}

/** Strict JSON for durable tool results; absent optional values are dropped rather than stored as undefined. */
function jsonDetails(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((item) => jsonDetails(item));
	if (typeof value === "object") {
		const result: { [key: string]: JsonValue } = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (item !== undefined) result[key] = jsonDetails(item);
		}
		return result;
	}
	throw new Error(`Brave tool details are not strict JSON (${typeof value}).`);
}

/** Model-facing tool guidance; the ordinary session carries the same text as prompt guidelines. */
function guidanceSection(): string {
	return [
		`web_read: ${BRAVE_WEB_READ_SNIPPET}`,
		`web_search: ${BRAVE_WEB_SEARCH_SNIPPET}`,
		"Guidelines:",
		...BRAVE_WEB_READ_GUIDELINES.map((guideline) => `- ${guideline}`),
		...BRAVE_WEB_SEARCH_GUIDELINES.map((guideline) => `- ${guideline}`),
	].join("\n");
}

/**
 * The brave contribution. `create()` reads no ordinary session API and keeps
 * no durable conversation state; both tools perform stateless public reads.
 */
export function braveDurableContribution(source: string): DurableContribution {
	return {
		name: "brave",
		source,
		create(host) {
			const { defineExtension, defineTool, section } = host.durable;
			return defineExtension({
				name: "brave",
				tools: [
					defineTool({
						name: "web_read",
						description: BRAVE_WEB_READ_DESCRIPTION,
						parameters: BRAVE_WEB_READ_PARAMETERS,
						// A rerun repeats one idempotent public GET with no credential and no external mutation.
						replay: "safe",
						execute: async (args, _api, context: Context) => {
							const result = await readWebPage(args, context.abortSignal);
							return { content: result.content, details: jsonDetails(result.details) };
						},
					}),
					defineTool({
						name: "web_search",
						description: BRAVE_WEB_SEARCH_DESCRIPTION,
						parameters: BRAVE_WEB_SEARCH_PARAMETERS,
						// A rerun would repeat a billed Brave query; an interrupted search receives an interrupted result.
						replay: "unsafe",
						execute: async (args, _api, context: Context) => {
							const result = await runWebSearch(args, context.abortSignal);
							return { content: result.content, details: jsonDetails(result.details) };
						},
					}),
				],
				sections: [section("web-guidance", () => guidanceSection())],
			});
		},
	};
}
