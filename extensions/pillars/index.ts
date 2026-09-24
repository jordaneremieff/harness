import { writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ACCESS_DESCRIPTION, access, parseAccess } from "./access.ts";
import { InputError } from "./input.ts";
import { type Catalog, loadCatalog, readBody, type Resource, resourceById, resourceByPath } from "./catalog.ts";
import { Collector, utcDay } from "./collector.ts";
import { COMMAND_HELP, commandCompletions, judgmentPrompt, parseJudgmentRequest } from "./commands.ts";
import { exportLocal, parseCommand } from "./export.ts";
import { accessEvidence, Deduplicator, type DeliveryExtent, extract, readEvidence, type ResultEvidence } from "./observation.ts";
import { accessRenderers, usageMarkdown, usageRenderers } from "./presentation.ts";
import { createReader, errorResponse, parseRequest, TOOL_DESCRIPTION } from "./readback.ts";
import { PillarsStore } from "./store.ts";

export default function pillarsExtension(pi: ExtensionAPI): void {
	let catalog: Catalog | undefined;
	let collector: Collector | undefined;
	let enabled = process.env.PI_PILLARS_COLLECT !== "0";
	const store = new PillarsStore(process.env.PI_PILLARS_DIR ?? join(getAgentDir(), "pillars"));
	const reader = createReader((signal) => store.capture(utcDay(), signal), { enabled: () => enabled });
	const dedup = new Deduplicator();
	const delivered = new Map<string, DeliveryExtent>();
	let sourceWarned = false;
	function diagnostic(ctx: ExtensionContext, text: string): void {
		if (ctx.hasUI) ctx.ui.notify(text, "warning");
		else process.stderr.write(`${text}\n`);
	}
	async function discover(signal?: AbortSignal): Promise<void> {
		try {
			catalog = await loadCatalog(signal);
		} catch {
			catalog = undefined;
		}
	}
	pi.on("session_start", async (event, ctx) => {
		enabled = process.env.PI_PILLARS_COLLECT !== "0";
		if (process.env.PI_PILLARS_COLLECT !== undefined && !["0", "1"].includes(process.env.PI_PILLARS_COLLECT)) {
			enabled = false;
			diagnostic(ctx, "PI_PILLARS_COLLECT requires 0 or 1. The collector is disabled.");
		}
		collector = new Collector(store, { diagnostic: (text) => diagnostic(ctx, text) });
		dedup.newTurn();
		sourceWarned = false;
		if (enabled && event.reason === "fork") collector.incident("forkResets");
		await discover(ctx.signal);
		if (!catalog && !sourceWarned) {
			sourceWarned = true;
			diagnostic(ctx, "The loaded Pillars source is unavailable. Access attribution remains unavailable.");
		}
	});
	pi.on("turn_start", () => {
		dedup.newTurn();
		delivered.clear();
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (enabled) await collector?.flush(false, ctx.signal);
	});
	pi.on("session_shutdown", async () => {
		if (enabled) await collector?.shutdown();
		reader.clear();
		delivered.clear();
		catalog = undefined;
	});
	interface ObservedToolEvent {
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
		content?: unknown;
		isError?: boolean;
	}
	function ownsPillarsTool(event: ObservedToolEvent): boolean {
		if (event.toolName !== "pillars") return true;
		const tools = pi.getAllTools();
		if (tools.length > 256) return false;
		const source = tools.find((tool) => tool.name === "pillars")?.sourceInfo;
		if (!source) return false;
		return resolve(source.path) === fileURLToPath(import.meta.url);
	}
	function ownedResource(event: ObservedToolEvent, source: Catalog): Resource | undefined {
		return ownsPillarsTool(event) ? resourceById(source, event.input.resource ?? "inventory") : undefined;
	}
	function observedResult(
		event: ObservedToolEvent,
		resource: Resource,
		reference: Buffer | undefined,
	): ResultEvidence | undefined {
		if (event.toolName === "pillars")
			return accessEvidence(event.content, resource.resourceId, event.isError ?? false, delivered.get(event.toolCallId));
		if (event.toolName === "read") return readEvidence(event.content, reference, event.isError ?? false);
		return undefined;
	}
	function admitObservation(event: ObservedToolEvent, stage: "tool_request" | "tool_result", ctx: ExtensionContext): boolean {
		const admission = dedup.admit(event.toolCallId, stage);
		if (admission === "admitted") return true;
		if (admission === "saturated" && dedup.warnOnce())
			diagnostic(ctx, "Pillars callback deduplication reached its limit. Unpersisted loss remains unknown.");
		return false;
	}
	function observationCell(
		event: ObservedToolEvent,
		ctx: ExtensionContext,
		stage: "tool_request" | "tool_result",
		resource: Resource,
		reference: Buffer | undefined,
	) {
		const result = stage === "tool_result" ? observedResult(event, resource, reference) : undefined;
		if (stage === "tool_result") delivered.delete(event.toolCallId);
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		return extract({
			stage,
			day: utcDay(),
			resource,
			model,
			reasoning: ctx.thinkingLevel,
			piVersion: VERSION,
			reference,
			result,
		});
	}
	async function observe(event: ObservedToolEvent, ctx: ExtensionContext, stage: "tool_request" | "tool_result"): Promise<void> {
		if (!enabled || !collector || !catalog || !["read", "pillars"].includes(event.toolName)) return;
		try {
			const resource = event.toolName === "pillars"
				? ownedResource(event, catalog)
				: await resourceByPath(catalog, event.input.path, ctx.cwd);
			if (!resource || !admitObservation(event, stage, ctx)) return;
			let reference: Buffer | undefined;
			try {
				reference = await readBody(resource.path, ctx.signal);
			} catch {
				collector.incident("unresolvedAccessEvents");
			}
			const cell = observationCell(event, ctx, stage, resource, reference);
			if (collector.admit(cell)) await collector.observed(ctx.signal);
		} catch {
			diagnostic(ctx, "Pillars observation was unavailable. Unpersisted loss remains unknown.");
		}
	}
	pi.on("tool_call", async (event, ctx) => {
		await observe(event, ctx, "tool_request");
	});
	pi.on("tool_result", async (event, ctx) => {
		await observe(event, ctx, "tool_result");
	});
	pi.registerTool({
		name: "pillars",
		label: "Pillars",
		description: ACCESS_DESCRIPTION,
		promptSnippet: "Read the Pillars inventory, consultation rules, and selected corpus entries",
		promptGuidelines: [
			"Call pillars at judgment moments: design or architecture decisions, trade-offs, option menus, verification depth, information placement, and prose tells.",
			'Read resource:"governance" before applying any corpus entry.',
		],
		parameters: Type.Object(
			{
				resource: Type.Optional(
					Type.String({ maxLength: 64, description: "Resource identifier from the inventory; defaults to inventory" }),
				),
				offset: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 1048576, description: "UTF-8 byte offset from nextOffset" }),
				),
				referenceBodyDigest: Type.Optional(
					Type.String({
						pattern: "^[a-f0-9]{64}$",
						description: "Required for continuation; prevents mixing source revisions",
					}),
				),
			},
			{ additionalProperties: false },
		),
		...accessRenderers(),
		prepareArguments(input) {
			try {
				const { referenceBodyDigest, ...args } = parseAccess(input, catalog);
				return { ...args, ...(referenceBodyDigest === undefined ? {} : { referenceBodyDigest }) };
			} catch (error) {
				if (!(error instanceof InputError)) throw error;
				throw new Error(JSON.stringify({ schema: "pillars-source-error", code: "invalid_input", message: error.message }));
			}
		},
		async execute(id, args, signal) {
			const result = await access(catalog, args, signal);
			if (result.schema === "pillars-source" && delivered.size < 4096 && Buffer.byteLength(id) <= 256) {
				const { resource, offset, endOffset, bodyBytes, referenceBodyDigest } = result;
				delivered.set(id, { resource, offset, endOffset, bodyBytes, referenceBodyDigest });
			}
			if (result.schema === "pillars-source-error") throw new Error(JSON.stringify(result));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	pi.registerTool({
		name: "pillars_usage",
		label: "Pillars access evidence",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object(
			{
				view: Type.Optional(StringEnum(["overview", "revisions"] as const)),
				windowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
				cursor: Type.Optional(Type.String({ minLength: 4, maxLength: 256, pattern: "^[-_A-Za-z0-9]+$" })),
			},
			{ additionalProperties: false },
		),
		...usageRenderers(),
		prepareArguments(input) {
			try { return parseRequest(input); }
			catch (error) {
				if (!(error instanceof InputError)) throw error;
				throw new Error(JSON.stringify(errorResponse("invalid_input", error.message)));
			}
		},
		async execute(_id, args, signal) {
			const result = await reader.read(args, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	pi.registerEntryRenderer<{ text: string }>(
		"pillars-view",
		(entry) => new Markdown(entry.data?.text ?? "Pillars view unavailable.", 0, 0, getMarkdownTheme()),
	);
	// Print mode takes over process.stdout.write and redirects it to stderr so that
	// model and extension output cannot corrupt the text or JSON stream. The real
	// stdout file descriptor is still the destination for command output, so write
	// there directly only in explicit print mode. Every other mode keeps appendEntry.
	function writePrintOutput(text: string): void {
		const bytes = Buffer.from(text, "utf8");
		let written = 0;
		while (written < bytes.length) {
			const count = writeSync(1, bytes, written, bytes.length - written);
			if (count <= 0) throw new Error("Pillars output was unavailable.");
			written += count;
		}
	}
	function display(content: string, ctx: ExtensionContext): void {
		if (ctx.mode === "print") writePrintOutput(`${content}\n`);
		else pi.appendEntry("pillars-view", { text: content });
	}
	const READ_PATTERN = /^read ([a-z0-9][a-z0-9-]{0,63})(?: ([0-9]{1,7}) ([a-f0-9]{64}))?$/;
	async function readSource(input: string, ctx: ExtensionContext): Promise<void> {
		const match = input.startsWith("read ") ? READ_PATTERN.exec(input) : undefined;
		if (input.startsWith("read ") && !match) throw new Error("invalid_command");
		const result = await access(
			catalog,
			match ? { resource: match[1], offset: match[2] ? Number(match[2]) : 0, referenceBodyDigest: match[3] } : {},
			ctx.signal,
		);
		if (result.schema === "pillars-source-error") {
			display(`Pillars source: ${result.code}. ${result.message ?? ""}`.trimEnd(), ctx);
			return;
		}
		const continuation =
			result.nextOffset !== undefined
				? `Continue: /pillars read ${result.resource} ${result.nextOffset} ${result.referenceBodyDigest}`
				: "Read an entry: /pillars read <resource>. Read consultation rules: /pillars read governance. View access evidence: /pillars usage.";
		display(`${result.text}\n\nSource: ${result.resource}; SHA-256: ${result.referenceBodyDigest}.\n${continuation}`, ctx);
	}
	async function usageOrExport(input: string, ctx: ExtensionContext): Promise<void> {
		const parsed = parseCommand(input === "usage" ? "" : input.startsWith("usage ") ? input.slice(6) : input);
		if (parsed.kind === "export") {
			const document = await reader.exportCapture(parsed.windowDays, ctx.signal);
			if (document.schema !== "pillars-export") {
				display(usageMarkdown(document), ctx);
				return;
			}
			display(JSON.stringify(await exportLocal(parsed.path, document, { signal: ctx.signal })), ctx);
			return;
		}
		display(usageMarkdown(await reader.read({ view: parsed.kind, windowDays: parsed.windowDays }, ctx.signal)), ctx);
	}
	pi.registerCommand("pillars", {
		description:
			"Check alignment and continue the corrected work, derive candidates, review guidance, or browse Pillars. Use /pillars for help; judgment actions accept an optional hint.",
		getArgumentCompletions: async (prefix) => {
			if (/^read\s+[^\s]*$/.test(prefix)) await discover();
			return commandCompletions(prefix, catalog);
		},
		handler: async (args, ctx) => {
			const request = parseJudgmentRequest(args);
			if (request) {
				pi.sendMessage(
					{ customType: "pillars-request", content: judgmentPrompt(request), display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				);
				return;
			}
			const input = args.trim();
			if (!input || input === "help") {
				display(COMMAND_HELP, ctx);
				if (input === "help") return;
			}
			await discover(ctx.signal);
			try {
				if (!input || input === "browse" || input.startsWith("read ")) {
					await readSource(input, ctx);
					return;
				}
				if (input.startsWith("next ")) {
					display(usageMarkdown(await reader.read({ cursor: input.slice(5) }, ctx.signal)), ctx);
					return;
				}
				await usageOrExport(input, ctx);
			} catch {
				display(
					`The Pillars command did not complete. Check the command syntax and source or export availability.\n\n${COMMAND_HELP}`,
					ctx,
				);
			}
		},
	});
}
