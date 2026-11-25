import { toolDisplayPublisher } from "./tool-display.ts";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { publishSettings, readSettings, type ReadOptions } from "./settings.ts";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { int, obj, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";
import {
	ACCESS_DESCRIPTION,
	access,
	CONSULT_GUIDANCE,
	GOVERNANCE_GUIDANCE,
	parseAccess,
	PROMPT_SNIPPET,
} from "./access.ts";
import type { Frame } from "./frame.ts";
import { browserEntries } from "./inventory.ts";
import type { PillarsViewState } from "./operator-view.ts";
import { InputError } from "./input.ts";
import { type Catalog, loadCatalog, readBody, type Resource, resourceById, resourceByPath } from "./catalog.ts";
import { Collector, utcDay, type DiagnosticNotice } from "./collector.ts";
import { COMMAND_HELP, commandCompletions, judgmentPrompt, parseJudgmentRequest } from "./commands.ts";
import {
	DRAFT_GUIDANCE,
	DraftInputError,
	draftAssessment,
	DraftSchema,
	freshReading,
	type Reading,
	requestText,
	splitDraft,
} from "./draft.ts";
import { toolDisplay } from "./display.ts";
import { pillarsDurableContribution } from "./durable.ts";
import {
	JUDGMENT_REQUEST_MESSAGE,
	renderJudgmentRequestMessage,
	renderViewEntry,
	VIEW_ENTRY,
	type ViewEntryData,
} from "./request-card.ts";
import { CommandSyntaxError, exportLocal, parseCommand } from "./export.ts";
import {
	accessEvidence,
	Deduplicator,
	type DeliveryExtent,
	extract,
	readEvidence,
	type ResultEvidence,
} from "./observation.ts";
import { exportTitle, oneLine, usageMarkdown } from "./presentation.ts";
import { createReader, errorResponse, parseRequest, TOOL_DESCRIPTION, type Response } from "./readback.ts";
import { PillarsStore } from "./store.ts";

const PillarsParameters = obj(
	{
		resource: opt(
			str({
				maxLength: 64,
				description:
					'Canonical identifier from the inventory, not a filename or path. For governance use {"resource":"governance"}; omit for inventory.',
			}),
		),
		offset: opt(
			int({
				minimum: 0,
				maximum: 1048576,
				description: "Copy nextOffset with referenceBodyDigest from the same page; omit both fields for a fresh read.",
			}),
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

/**
 * Pi gives a call that another tool makes the id `<calling id>/<n>` and keeps its arguments out
 * of the transcript. A model-issued id of that form only restores the copied draft.
 */
function nestedCall(toolCallId: string): boolean {
	return /\/\d+$/.test(toolCallId);
}

const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({
	type: "string",
	enum: [...values],
});
const PillarsUsageParameters = obj(
	{
		view: opt(StringEnum(["overview", "revisions"])),
		windowDays: opt(int({ minimum: 1, maximum: 30 })),
		cursor: opt(
			str({
				minLength: 4,
				maxLength: 256,
				pattern: "^[-_A-Za-z0-9]+$",
				description: "Copy nextCursor unchanged and send cursor alone, without view or windowDays.",
			}),
		),
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
	let enabled =
		snapshot.values.collect && snapshot.records.find((record) => record.key === "collect")?.status !== "invalid";
	const store = new PillarsStore(snapshot.values.dir);
	const stopSettings = publishSettings(pi.events, options);
	pi.events.emit(
		"durable:contribution",
		pillarsDurableContribution(fileURLToPath(import.meta.url), { bus: pi.events, stopFactory: stopSettings }),
	);
	const reader = createReader((signal) => store.capture(utcDay(), signal), { enabled: () => enabled });
	const dedup = new Deduplicator();
	const delivered = new Map<string, DeliveryExtent>();
	let sourceWarned = false;
	function diagnostic(ctx: ExtensionContext, text: string, notice?: DiagnosticNotice): void {
		if (ctx.hasUI) ctx.ui.notify(oneLine(notice?.text ?? text), notice?.level ?? "warning");
		else process.stderr.write(`${text}\n`);
	}
	async function discover(signal?: AbortSignal, retainCatalog = false): Promise<boolean> {
		try {
			catalog = await loadCatalog(signal, options);
			return true;
		} catch {
			if (!retainCatalog) catalog = undefined;
			return false;
		}
	}
	pi.on("session_start", async (event, ctx) => {
		const current = readSettings(options);
		const invalidCollect = current.records.find((record) => record.key === "collect")?.status === "invalid";
		enabled = current.values.collect && !invalidCollect;
		for (const issue of current.diagnostics)
			diagnostic(ctx, `${issue.field}: ${issue.message}`, {
				text: `Pillars configuration (${issue.field}): ${issue.message}`,
			});
		if (invalidCollect)
			diagnostic(
				ctx,
				"pillars.collect requires a boolean (environment: 0, 1, false, or true). The collector is disabled.",
				{
					text: "The Pillars collector is disabled because pillars.collect needs a boolean (0, 1, false or true in the environment).",
				},
			);
		collector = new Collector(store, { diagnostic: (text, notice) => diagnostic(ctx, text, notice) });
		dedup.newTurn();
		sourceWarned = false;
		if (enabled && event.reason === "fork") collector.incident("forkResets");
		await discover(ctx.signal);
		if (!catalog && !sourceWarned) {
			sourceWarned = true;
			diagnostic(ctx, "The loaded Pillars source is unavailable. Access attribution remains unavailable.", {
				text: "Pillars cannot attribute access because the source is unavailable.",
			});
		}
	});
	pi.on("turn_start", () => {
		dedup.newTurn();
		delivered.clear();
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (enabled) await collector?.flush(true, ctx.signal);
	});
	let frame: Frame | undefined;
	let closed = false;
	pi.on("session_shutdown", async () => {
		closed = true;
		frame?.close();
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
	/** Attribution follows the registered source of the `pillars` name, whatever the size of the tool catalog. */
	function ownsPillarsTool(event: ObservedToolEvent): boolean {
		if (event.toolName !== "pillars") return true;
		const source = pi.getAllTools().find((tool) => tool.name === "pillars")?.sourceInfo;
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
			return accessEvidence(
				event.content,
				resource.resourceId,
				event.isError ?? false,
				delivered.get(event.toolCallId),
			);
		if (event.toolName === "read") return readEvidence(event.content, reference, event.isError ?? false);
		return undefined;
	}
	function admitObservation(
		event: ObservedToolEvent,
		stage: "tool_request" | "tool_result",
		ctx: ExtensionContext,
	): boolean {
		const admission = dedup.admit(event.toolCallId, stage);
		if (admission === "admitted") return true;
		if (admission === "saturated" && dedup.warnOnce())
			diagnostic(ctx, "Pillars callback deduplication reached its limit. Unpersisted loss remains unknown.", {
				text: "Pillars reached its limit for tracking duplicate callbacks; unpersisted loss remains unknown.",
			});
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
	async function observe(
		event: ObservedToolEvent,
		ctx: ExtensionContext,
		stage: "tool_request" | "tool_result",
	): Promise<void> {
		if (!enabled || !collector || !catalog || !["read", "pillars"].includes(event.toolName)) return;
		try {
			const resource =
				event.toolName === "pillars"
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
			diagnostic(ctx, "Pillars observation was unavailable. Unpersisted loss remains unknown.", {
				text: "Pillars failed to observe an access event; unpersisted loss remains unknown.",
				level: "error",
			});
		}
	}
	function sendAssessment(toolCallId: string, draft: string, reading: Reading): void {
		pi.sendMessage(
			{
				customType: "pillars-draft",
				content: draftAssessment(draft, reading, nestedCall(toolCallId) ? "nested" : "model"),
				display: false,
			},
			{ triggerTurn: false },
		);
	}
	/** The session's own model reads the request, the draft and the inventory without this conversation. */
	function readDraft(
		ctx: ExtensionContext,
		draft: string,
		inventory: string,
		signal: AbortSignal | undefined,
	): Promise<Reading> {
		const model = ctx.model;
		const messages = ctx.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
		return freshReading(
			model === undefined
				? "the session has no selected model"
				: (context, streamOptions) => ctx.modelRegistry.streamSimple(model, context, streamOptions).result(),
			{ request: requestText(messages), draft, inventory },
			signal,
		);
	}
	/** The assessment task follows the result; cancellation before it is sent leaves none. */
	async function assessDraft(
		ctx: ExtensionContext,
		toolCallId: string,
		draft: string,
		inventory: string,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (signal?.aborted) return;
		const reading = await readDraft(ctx, draft, inventory, signal);
		if (!signal?.aborted) sendAssessment(toolCallId, draft, reading);
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
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: [CONSULT_GUIDANCE, GOVERNANCE_GUIDANCE, DRAFT_GUIDANCE],
		parameters: PillarsParameters,
		...displayRecords.get("pillars"),
		prepareArguments(input) {
			try {
				const { source, draft } = splitDraft(input);
				if (draft !== undefined) return { draft };
				const { referenceBodyDigest, ...args } = parseAccess(source, catalog);
				return { ...args, ...(referenceBodyDigest === undefined ? {} : { referenceBodyDigest }) };
			} catch (error) {
				if (!(error instanceof InputError) && !(error instanceof DraftInputError)) throw error;
				throw new Error(
					JSON.stringify({ schema: "pillars-source-error", code: "invalid_input", message: error.message }),
				);
			}
		},
		async execute(id, args: Static<typeof PillarsParameters>, signal, _onUpdate, ctx) {
			let input: ReturnType<typeof splitDraft>;
			try {
				input = splitDraft(args);
			} catch (error) {
				if (!(error instanceof DraftInputError)) throw error;
				throw new Error(
					JSON.stringify({ schema: "pillars-source-error", code: "invalid_input", message: error.message }),
				);
			}
			const result = await access(catalog, input.source, signal);
			if (result.schema === "pillars-source" && delivered.size < 4096 && Buffer.byteLength(id) <= 256) {
				const { resource, offset, endOffset, bodyBytes, referenceBodyDigest } = result;
				delivered.set(id, { resource, offset, endOffset, bodyBytes, referenceBodyDigest });
			}
			if (result.schema === "pillars-source-error")
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: true };
			if (input.draft !== undefined) await assessDraft(ctx, id, input.draft, result.text, signal);
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
			try {
				return parseRequest(input);
			} catch (error) {
				if (!(error instanceof InputError)) throw error;
				throw new Error(JSON.stringify(errorResponse("invalid_input", error.message)));
			}
		},
		async execute(_id, args: Static<typeof PillarsUsageParameters>, signal) {
			const result = await reader.read(args, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
				isError: result.kind === "error",
			};
		},
	});
	pi.registerEntryRenderer<ViewEntryData>(VIEW_ENTRY, renderViewEntry);
	pi.registerMessageRenderer(JUDGMENT_REQUEST_MESSAGE, renderJudgmentRequestMessage);
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
	/** Shows command output: plain text in print mode, otherwise a transcript entry titled by what it shows. */
	function display(content: string, view: Omit<ViewEntryData, "text">, ctx: ExtensionContext): void {
		if (ctx.mode === "print") writePrintOutput(`${content}\n`);
		else pi.appendEntry(VIEW_ENTRY, { text: content, ...view } satisfies ViewEntryData);
	}
	const READ_PATTERN = /^read ([a-z0-9][a-z0-9-]{0,63})(?: ([0-9]{1,7}) ([a-f0-9]{64}))?$/;
	async function readSource(input: string, ctx: ExtensionContext): Promise<void> {
		const explicit = input.startsWith("read ");
		const match = explicit ? READ_PATTERN.exec(input) : null;
		if (explicit && !match) throw new CommandSyntaxError();
		const result = await access(
			catalog,
			{ resource: match?.[1], offset: Number(match?.[2] ?? 0), referenceBodyDigest: match?.[3] },
			ctx.signal,
		);
		if (result.schema === "pillars-source-error") {
			display(
				`Pillars source: ${result.code}. ${result.message ?? ""}`.trimEnd(),
				{ title: "Source read did not complete", subject: match?.[1], facts: [result.code] },
				ctx,
			);
			return;
		}
		const continuation =
			result.nextOffset !== undefined
				? `Continue: /pillars read ${result.resource} ${result.nextOffset} ${result.referenceBodyDigest}`
				: "Read an entry: /pillars read <resource>. Read consultation rules: /pillars read governance. View access evidence: /pillars usage.";
		display(
			`${result.text}\n\nSource: ${result.resource}; SHA-256: ${result.referenceBodyDigest}.\n${continuation}`,
			{
				title: "Source page",
				subject: result.resource,
				facts: [
					`${result.endOffset - result.offset} of ${result.bodyBytes} bytes`,
					...(result.nextOffset !== undefined ? ["continuation available"] : []),
				],
			},
			ctx,
		);
	}
	async function usageOrExport(input: string, ctx: ExtensionContext): Promise<void> {
		const parsed = parseCommand(input === "usage" ? "" : input.startsWith("usage ") ? input.slice(6) : input);
		if (parsed.kind === "export") {
			const document = await reader.exportCapture(parsed.windowDays, ctx.signal);
			if (document.schema !== "pillars-export") {
				display(
					usageMarkdown(document),
					{ title: "Access evidence export did not capture data", facts: [document.code] },
					ctx,
				);
				return;
			}
			const receipt = await exportLocal(parsed.path, document, { signal: ctx.signal });
			display(JSON.stringify(receipt), { title: exportTitle(receipt), receipt }, ctx);
			return;
		}
		displayUsage(await reader.read({ view: parsed.kind, windowDays: parsed.windowDays }, ctx.signal), ctx);
	}
	function displayUsage(response: Response, ctx: ExtensionContext): void {
		display(
			usageMarkdown(response),
			response.kind === "error"
				? { title: "Access evidence read did not complete", facts: [response.code] }
				: { title: "Access evidence page", subject: response.view },
			ctx,
		);
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
	let opening = false;
	/** Return false when only the text route applies. */
	async function openBrowser(ctx: ExtensionContext): Promise<boolean> {
		if (ctx.mode !== "tui" || !catalog) return false;
		if (opening || closed) return true;
		opening = true;
		try {
			const [{ openFrame }, module] = await Promise.all([import("./frame.ts"), import("./operator-view.ts")]);
			if (closed) return true;
			const id = ctx.sessionManager.getSessionId();
			const state = viewStates.get(id) ?? module.createPillarsViewState();
			viewStates.set(id, state);
			await openFrame(
				ctx,
				(host) => module.pillarsView(host, browserOperations, state),
				(current) => {
					frame = current;
				},
			);
		} finally {
			opening = false;
		}
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
			displayUsage(await reader.read({ cursor: input.slice(5) }, ctx.signal), ctx);
			return;
		}
		await usageOrExport(input, ctx);
	}
	async function refreshJudgment(ctx: ExtensionContext): Promise<void> {
		if (await discover(ctx.signal, true)) return;
		diagnostic(
			ctx,
			catalog
				? "Pillars catalogue refresh failed. The judgment uses the last available catalogue; source reads still verify current body bytes."
				: "Pillars catalogue refresh failed. No catalogue is available; check the configured corpus and retry.",
			{
				text: catalog
					? "Pillars could not refresh the catalogue and will use the last one for judgment while source reads still verify current bytes."
					: "Pillars could not load a catalogue; check the configured corpus and retry.",
			},
		);
	}
	pi.registerCommand("pillars", {
		description:
			"Check alignment and continue the corrected work, derive candidates, review guidance, or browse Pillars. Use /pillars for help; judgment actions accept an optional hint.",
		getArgumentCompletions: (prefix) => commandCompletions(prefix, catalog),
		handler: async (args, ctx) => {
			const request = parseJudgmentRequest(args);
			if (request) {
				await refreshJudgment(ctx);
				pi.sendMessage(
					{ customType: JUDGMENT_REQUEST_MESSAGE, content: judgmentPrompt(request), display: true, details: request },
					{ triggerTurn: true, deliverAs: "steer" },
				);
				return;
			}
			const input = args.trim();
			if (!input || input === "help") {
				display(COMMAND_HELP, { title: "Command help" }, ctx);
				if (input === "help") return;
			}
			await discover(ctx.signal);
			try {
				await route(input, ctx);
			} catch (error) {
				display(
					`The Pillars command did not complete. Check the command syntax and source or export availability.\n\n${COMMAND_HELP}`,
					{ title: error instanceof CommandSyntaxError ? "Command syntax is invalid" : "Command did not complete" },
					ctx,
				);
			}
		},
	});
	displayPublisher.publish();
}
