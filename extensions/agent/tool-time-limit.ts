/**
 * A time limit for each native tool execution in a Durable host. A tool that never settles would otherwise keep its
 * conversation's run, and with it the host, alive without end: the host cannot retire while native work is pending.
 * The limit cancels the call's context, so a tool that honours cancellation stops its work, and ends the call with an
 * error result that names the limit. A park ends an execution, so a parked call's wait does not count.
 */
import { awaitWithContext, type Context, withCancel } from "@earendil-works/chord/context";
import type * as Durable from "@earendil-works/pi-durable";

/** The error result of a call that reached the limit. */
export class ToolTimeLimitError extends Error {
	constructor(tool: string, limitMs: number) {
		const minutes = limitMs / 60_000;
		const limit = Number.isInteger(minutes) ? `${minutes} minutes` : `${limitMs} ms`;
		super(
			`The ${tool} call did not finish within ${limit}, the most one tool call may run in a Durable host (agent.toolCallMaxMinutes); the call was cancelled.`,
		);
		this.name = "ToolTimeLimitError";
	}
}

type Tool = Durable.ToolRegistration;

/** The tool with its execution bounded; a limit of zero or less leaves it unchanged. */
export function limitToolTime<T extends Tool>(tool: T, limitMs: number): T {
	if (!(limitMs > 0)) return tool;
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		async execute(args: Parameters<T["execute"]>[0], api: Parameters<T["execute"]>[1], context: Context) {
			const bounded = withCancel(context);
			const timer = setTimeout(() => bounded.cancel(new ToolTimeLimitError(tool.name, limitMs)), limitMs);
			timer.unref?.();
			try {
				return await awaitWithContext(execute(args, api, bounded.context), bounded.context);
			} catch (error) {
				// The caller's own cancellation keeps its reason; only the limit becomes the limit error.
				if (context.abortSignal?.aborted !== true && bounded.context.abortSignal?.aborted === true)
					throw new ToolTimeLimitError(tool.name, limitMs);
				throw error;
			} finally {
				clearTimeout(timer);
			}
		},
	} as T;
}

/**
 * The extension with every tool it provides or wraps bounded by the limit. An extension can compute its tools and
 * other fields when they are read, as an MCP server's extension does once the server lists its tools, so the result
 * keeps every property descriptor and bounds the tools at each read; a tool keeps one bounded form while it stays.
 */
export function limitExtensionToolTime(extension: Durable.Extension, limitMs: number): Durable.Extension {
	if (!(limitMs > 0)) return extension;
	const bounded = new WeakMap<Tool, Tool>();
	const limit = (tool: Tool): Tool => {
		let result = bounded.get(tool);
		if (result === undefined) {
			result = limitToolTime(tool, limitMs);
			bounded.set(tool, result);
		}
		return result;
	};
	const result = Object.defineProperties({}, Object.getOwnPropertyDescriptors(extension)) as Durable.Extension;
	Object.defineProperties(result, {
		tools: { enumerable: true, configurable: true, get: () => extension.tools?.map(limit) },
		wraps: {
			enumerable: true,
			configurable: true,
			get: () =>
				extension.wraps?.map((wrap) =>
					"tool" in wrap ? { tool: wrap.tool, wrap: (base: Tool) => limitToolTime(wrap.wrap(base), limitMs) } : wrap,
				),
		},
	});
	return result;
}
