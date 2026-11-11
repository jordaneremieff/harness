import { toolDisplayPublisher } from "./tool-display.ts";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { publishSettings, readSettings, type ReadOptions } from "./settings.ts";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { int, obj, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";
import { ACCESS_DESCRIPTION, access, parseAccess } from "./access.ts";
import { LoadingView, openOperatorFrame, publishOperatorViews, type OperatorView, type ViewHost } from "../../operator-ui/registration.ts";
import { browserEntries } from "./inventory.ts";
import type { PillarsViewState } from "./operator-view.ts";
import { InputError } from "./input.ts";
import { type Catalog, loadCatalog, readBody, type Resource, resourceById, resourceByPath } from "./catalog.ts";
import { Collector, utcDay } from "./collector.ts";
import { COMMAND_HELP, commandCompletions, judgmentPrompt, parseJudgmentRequest } from "./commands.ts";
import { DRAFT_GUIDANCE, DraftInputError, draftAssessment, DraftSchema, splitDraft } from "./draft.ts";
import { toolDisplay } from "./display.ts";
import { pillarsDurableContribution } from "./durable.ts";
import { exportLocal, parseCommand } from "./export.ts";
import { accessEvidence, Deduplicator, type DeliveryExtent, extract, readEvidence, type ResultEvidence } from "./observation.ts";
import { usageMarkdown } from "./presentation.ts";
import { createReader, errorResponse, parseRequest, TOOL_DESCRIPTION } from "./readback.ts";
import { PillarsStore } from "./store.ts";

const PillarsParameters = obj(
	{
		resource: opt(
			str({ maxLength: 64, description: "Canonical identifier from the inventory, not a filename or path. For governance use {\"resource\":\"governance\"}; omit for inventory." }),
		),
		offset: opt(
			int({ minimum: 0, maximum: 1048576, description: "Copy nextOffset with referenceBodyDigest from the same page; omit both fields for a fresh read." }),
		),
		referenceBodyDigest: opt(
			str({
				pattern: "^[a-f0-9]{64}$",
				description: "Required for continuation; prevents mixing source revisions",
			}),
		),
		draft: opt(DraftSchema),
	},
	{ open: false },
);

const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({ type: "string", enum: [...values] });
const PillarsUsageParameters = obj(
	{
		view: opt(StringEnum(["overview", "revisions"])),
		windowDays: opt(int({ minimum: 1, maximum: 30 })),
		cursor: opt(str({ minLength: 4, maxLength: 256, pattern: "^[-_A-Za-z0-9]+$", description: "Copy nextCursor unchanged and send cursor alone, without view or windowDays." })),
	},
	{ open: false },
);

export default function pillarsExtension(pi: ExtensionAPI, options: ReadOptions = { agentDir: getAgentDir() }): void {
	const displayPublisher = toolDisplayPublisher(pi);
	// One record set: the registrations spread the same renderer records the pure display module returns.
	const displayRecords = new Map(toolDisplay().tools.map((record) => [record.name, record]));
	let catalog: Catalog | undefined;
	let collector: Collector | undefined;
	const snapshot = readSettings(options);
	let enabled = snapshot.values.collect && snapshot.records.find((record) => record.key === "collect")?.status !== "invalid";
	const store = new PillarsStore(snapshot.values.dir);
	const stopSettings = publishSettings(pi.events, options);
	pi.events.emit("durable:contribution", pillarsDurableContribution(fileURLToPath(import.meta.url), { bus: pi.events, stopFactory: stopSettings }));
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
			catalog = await loadCatalog(signal, options);
		} catch {
			catalog = undefined;
		}
	}
	pi.on("session_start", async (event, ctx) => {
		const current = readSettings(options);
		const invalidCollect = current.records.find((record) => record.key === "collect")?.status === "invalid";
		enabled = current.values.collect && !invalidCollect;
		for (const issue of current.diagnostics) diagnostic(ctx, `${issue.field}: ${issue.message}`);
		if (invalidCollect) diagnostic(ctx, "pillars.collect requires a boolean (environment: 0, 1, false, or true). The collector is disabled.");
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
		if (enabled) await collector?.flush(true, ctx.signal);
	});
	pi.on("session_shutdown", async () => {
		stopSettings();
		displayPublisher.stop();
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
		description: `${ACCESS_DESCRIPTION} ${DRAFT_GUIDANCE}`,
		promptSnippet: "Read Pillars and assess an agent-authored draft before delivery",
		promptGuidelines: [
			"Call pillars at judgment moments: design or architecture decisions, trade-offs, option menus, verification depth, information placement, and prose tells.",
			'Read resource:"governance" before applying any corpus entry.',
			DRAFT_GUIDANCE,
		],
		parameters: PillarsParameters,
		...displayRecords.get("pillars"),
		prepareArguments(input) {
			try {
				const { source, draft } = splitDraft(input);
				const { referenceBodyDigest, ...args } = parseAccess(source, catalog);
				return { ...args, ...(referenceBodyDigest === undefined ? {} : { referenceBodyDigest }), ...(draft === undefined ? {} : { draft }) };
			} catch (error) {
				if (!(error instanceof InputError) && !(error instanceof DraftInputError)) throw error;
				throw new Error(JSON.stringify({ schema: "pillars-source-error", code: "invalid_input", message: error.message }));
			}
		},
		async execute(id, args: Static<typeof PillarsParameters>, signal) {
			let input: ReturnType<typeof splitDraft>;
			try { input = splitDraft(args); }
			catch (error) {
				if (!(error instanceof DraftInputError)) throw error;
				throw new Error(JSON.stringify({ schema: "pillars-source-error", code: "invalid_input", message: error.message }));
			}
			const result = await access(catalog, input.source, signal);
			if (result.schema === "pillars-source" && delivered.size < 4096 && Buffer.byteLength(id) <= 256) {
				const { resource, offset, endOffset, bodyBytes, referenceBodyDigest } = result;
				delivered.set(id, { resource, offset, endOffset, bodyBytes, referenceBodyDigest });
			}
			if (result.schema === "pillars-source-error") throw new Error(JSON.stringify(result));
			if (input.draft !== undefined && !signal?.aborted)
				pi.sendMessage({ customType: "pillars-draft", content: draftAssessment(input.draft), display: false }, { triggerTurn: false });
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	pi.registerTool({
		name: "pillars_usage",
		label: "Pillars access evidence",
		description: TOOL_DESCRIPTION,
		parameters: PillarsUsageParameters,
		...displayRecords.get("pillars_usage"),
		prepareArguments(input) {
			try { return parseRequest(input); }
			catch (error) {
				if (!(error instanceof InputError)) throw error;
				throw new Error(JSON.stringify(errorResponse("invalid_input", error.message)));
			}
		},
		async execute(_id, args: Static<typeof PillarsUsageParameters>, signal) {
			const result = await reader.read(args, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: result.kind === "error" };
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
	/** Corpus reads behind the browser; the catalogue is discovered on first use. */
	const browserOperations = {
		inventory: async (signal: AbortSignal) => {
			await discover(signal);
			const current = catalog;
			if (!current) throw new Error("The Pillars catalogue is unavailable");
			return browserEntries(current, (request, readSignal) => access(current, request, readSignal), signal);
		},
		read: async (request: Parameters<typeof access>[1], signal: AbortSignal) => {
			await discover(signal);
			return access(catalog, request, signal);
		},
	};
	const viewStates = new Map<string, PillarsViewState>();
	/** The view module loads when the destination opens, not when this factory runs. */
	const loadView = async (ctx: ExtensionContext, host: ViewHost): Promise<OperatorView> => {
		const module = await import("./operator-view.ts");
		const id = ctx.sessionManager.getSessionId();
		let state = viewStates.get(id);
		if (!state) {
			state = module.createPillarsViewState();
			viewStates.set(id, state);
		}
		return module.pillarsView(host, browserOperations, state);
	};
	/** Open the read-only browser in the interactive terminal; it returns false when only the text route applies. */
	async function openBrowser(ctx: ExtensionContext): Promise<boolean> {
		if (ctx.mode !== "tui" || !catalog) return false;
		await openOperatorFrame(pi, ctx, { owner: OWNER, id: "pillars" });
		return true;
	}
	/** Browse opens the reader when a TUI is present; every other input keeps its text route. */
	async function route(input: string, ctx: ExtensionContext): Promise<void> {
		const browse = !input || input === "browse";
		if (browse && (await openBrowser(ctx))) return;
		if (browse || input.startsWith("read ")) {
			await readSource(input, ctx);
			return;
		}
		if (input.startsWith("next ")) {
			display(usageMarkdown(await reader.read({ cursor: input.slice(5) }, ctx.signal)), ctx);
			return;
		}
		await usageOrExport(input, ctx);
	}
	pi.registerCommand("pillars", {
		description:
			"Check alignment and continue the corrected work, derive candidates, review guidance, or browse Pillars. Use /pillars for help; judgment actions accept an optional hint.",
		getArgumentCompletions: (prefix) => commandCompletions(prefix, catalog),
		handler: async (args, ctx) => {
			const request = parseJudgmentRequest(args);
			if (request) {
				await discover(ctx.signal);
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
				await route(input, ctx);
			} catch {
				display(
					`The Pillars command did not complete. Check the command syntax and source or export availability.\n\n${COMMAND_HELP}`,
					ctx,
				);
			}
		},
	});
	displayPublisher.publish();
	// Package contract: docs/conventions/operator-panels.md. Browse is a harmless read; the judgment verbs stay in command search.
	publishOperatorViews(pi, {
		version: 2,
		owner: OWNER,
		views: [{ id: "pillars", label: "Pillars", command: { name: "pillars", args: "browse" }, order: 40, view: (ctx, host) => new LoadingView("Pillars", host, () => loadView(ctx, host)) }],
	});
}

/** This extension's entrypoint; the ordinary frame binds the published view to its /pillars registration. */
const OWNER = fileURLToPath(import.meta.url);
