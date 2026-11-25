import { type Theme, type ToolDefinition, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const EXPAND = "app.tools.expand";
const DISPLAY_LIMIT = 32_000;
const PREVIEW_ROWS = 5;
type Fields = Record<string, unknown>;
type CardState = { hasResult?: boolean; hidesArguments?: (width: number) => boolean };
type CardContext = Omit<Parameters<NonNullable<ToolDefinition["renderCall"]>>[2], "state"> & { state: CardState };

function record(value: unknown): Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
}

function safeText(value: string): string {
	return stripTerminalSequences(value.replace(/\r\n/g, "\n"))
		.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""))
		.replaceAll("\t", "   ");
}

function field(value: unknown): string {
	return typeof value === "string" ? safeText(value).replace(/\s+/gu, " ").trim() : "";
}

function pathField(value: unknown): string {
	const path = field(value);
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function recordName(entry: Fields): string {
	return entry.kind === "context_file" ? pathField(entry.path ?? entry.name) : field(entry.name);
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: number, noun: string, plural = `${noun}s`): string {
	return `${value} ${value === 1 ? noun : plural}`;
}

function boolean(value: unknown, yes: string, no: string): string {
	return value === true ? yes : value === false ? no : "";
}

function join(...parts: string[]): string {
	return parts.filter(Boolean).join(" · ");
}

function clipLine(value: string, width: number): string {
	return stripTerminalSequences(truncateToWidth(value, width, "…"));
}

function wrapped(value: string, width: number): readonly string[] {
	return truncateToVisualLines(value, Infinity, width, 0, "start").visualLines;
}

function bounded(value: string): { text: string; limit?: string } {
	if (value.length <= DISPLAY_LIMIT) return { text: value };
	const chars = Array.from(value);
	if (chars.length <= DISPLAY_LIMIT) return { text: value };
	return {
		text: chars.slice(0, DISPLAY_LIMIT).join(""),
		limit: `[Truncated: showing ${DISPLAY_LIMIT} of ${chars.length} characters]`,
	};
}

function component(draw: (width: number) => string[]): Component {
	let cache: { width: number; rows: string[] } | undefined;
	return {
		render(width) {
			if (width < 1) return [];
			if (cache?.width !== width) cache = { width, rows: draw(width) };
			return cache.rows;
		},
		invalidate() {
			cache = undefined;
		},
	};
}

function hint(theme: Theme, context: CardContext, width: number, hidden = 0): string {
	const prefix = hidden > 0 ? `... (${count(hidden, "more line")}, ` : "... (";
	const key = context.keyText(EXPAND);
	const plain = `${prefix}${key ? `${key} to expand` : "click to expand"})`;
	if (!key || visibleWidth(plain) > width) return theme.fg("muted", clipLine(plain, width));
	return theme.fg("muted", prefix) + context.keyHint(EXPAND, "to expand") + theme.fg("muted", ")");
}

function hiddenSelector(key: string, value: unknown, labels: Record<string, string>): boolean {
	if (Object.hasOwn(labels, key)) return value !== labels[key] || !labels[key];
	switch (key) {
		case "match":
			return value !== "substring" && value !== "exact";
		case "available":
		case "detail":
		case "health":
			return typeof value !== "boolean";
		case "limit":
			return number(value) === undefined;
		default:
			return true;
	}
}

function matchMode(value: unknown): string {
	if (value === "substring") return "substring";
	return value === "exact" ? "exact match" : "";
}

function callFacts(args: Fields): { subject: string; facts: string; unshown: boolean } {
	const name = args.kind === "context_file" ? pathField(args.name) : field(args.name);
	const search = field(args.search);
	const contains = field(args.contains);
	const kind = field(args.kind);
	const cursor = field(args.cursor);
	const provider = field(args.provider);
	const limit = number(args.limit);
	const subject =
		name ||
		(search && `search ${JSON.stringify(search)}`) ||
		(contains && `contains ${JSON.stringify(contains)}`) ||
		kind ||
		(cursor ? "continuation" : "session overview");
	return {
		subject,
		facts: join(
			kind !== subject ? kind : "",
			name && search ? `search ${JSON.stringify(search)}` : "",
			(name || search) && contains ? `contains ${JSON.stringify(contains)}` : "",
			matchMode(args.match),
			boolean(args.detail, "tool details", "no tool details"),
			provider ? `provider ${provider}` : "",
			boolean(args.available, "cached available only", "cached unavailable only"),
			boolean(args.health, "local catalog review", "standard catalog lookup"),
			limit === undefined ? "" : `limit ${limit}`,
		),
		unshown: Object.entries(args).some(([key, value]) =>
			hiddenSelector(key, value, { name, kind, search, contains, provider }),
		),
	};
}

export const renderRegistryCall: NonNullable<ToolDefinition["renderCall"]> = (value, theme, context: CardContext) => {
	const args = record(value);
	const { subject, facts, unshown } = callFacts(args);
	const headingWidth = visibleWidth(`registry ${subject}`);
	const factsWidth = visibleWidth(facts);
	const argumentsText = context.expanded
		? bounded(
				Object.entries(args)
					.map(([key, value]) => {
						const text = typeof value === "string" ? safeText(value) : safeText(JSON.stringify(value, null, 2) ?? "");
						return `  ${field(key)}: ${text.replaceAll("\n", "\n    ")}`;
					})
					.join("\n"),
			)
		: undefined;
	context.state.hidesArguments = (width) =>
		Object.keys(args).length > 0 && (unshown || headingWidth > width || factsWidth > width);
	// Pi constructs the call first. Defer the hint until both renderers have seen the card state.
	context.state.hasResult = false;
	return component((width) => {
		const room = width - "registry ".length;
		const title = (text: string) => theme.fg("toolTitle", theme.bold(text));
		const rows = [
			room > 0
				? `${title("registry")} ${theme.fg("accent", clipLine(subject, room))}`
				: title(clipLine("registry", width)),
		];
		if (facts) rows.push(theme.fg("muted", clipLine(facts, width)));
		if (argumentsText?.text) rows.push(...wrapped(argumentsText.text, width).map((line) => theme.fg("muted", line)));
		if (argumentsText?.limit) rows.push(theme.fg("warning", clipLine(argumentsText.limit, width)));
		if (
			!context.expanded &&
			context.state.hidesArguments?.(width) &&
			!context.state.hasResult &&
			context.keyText(EXPAND)
		) {
			rows.push(hint(theme, context, width));
		}
		return rows;
	});
};

function modelFacts(entry: Fields): string {
	const context = number(entry.contextWindow);
	const levels = Array.isArray(entry.supportedThinkingLevels)
		? entry.supportedThinkingLevels.map(field).filter(Boolean).join(", ")
		: "";
	return join(
		entry.selected === true ? "selected" : "",
		boolean(entry.available, "available (cached)", "unavailable (cached)"),
		boolean(
			entry.configuredAuth,
			"auth configured",
			entry.authSource === "stored" ? "stored credential unresolved" : "no configured auth",
		),
		context && context > 0 ? `${context.toLocaleString("en-US")} context` : "",
		levels ? `thinking ${levels}` : "",
	);
}

function recordLine(entry: Fields): string {
	const line = number(entry.line);
	if (line !== undefined) return join(`Line ${line}`, field(entry.text));
	const name = recordName(entry);
	if (!name) return "";
	switch (entry.kind) {
		case "tool":
			return join(
				`Tool ${name}`,
				boolean(entry.configured, "configured", "not configured"),
				boolean(entry.active, "active", "inactive"),
				boolean(entry.callable, "callable in this host", "not callable in this host"),
				field(entry.exposure),
			);
		case "model": {
			const findings = Array.isArray(entry.findings)
				? entry.findings.map((finding) => field(record(finding).reason)).filter(Boolean)
				: [];
			return join(name, field(entry.currentThinkingLevel), ...findings, modelFacts(entry));
		}
		case "context_file":
			return name;
		case "setting":
			return join(name, field(entry.status), field(entry.origin), field(entry.secretState));
		case "command":
			return join(`Command ${name}`, field(entry.invocation));
		case "skill":
			return join(
				`Skill ${name}`,
				boolean(record(entry.modelInvocable).value, "model-invocable", "not model-invocable"),
			);
		case "prompt":
			return `Prompt ${name}`;
		default:
			return name;
	}
}

function hostFacts(details: Fields): string[] {
	const context = record(details.context);
	const model = join(field(context.model), field(context.thinkingLevel));
	const percent = number(context.percent);
	const counts = record(details.counts);
	const availability = record(details.availability);
	const inventory = (key: string) => {
		const value = number(counts[key]);
		return value ? count(value, key) : "";
	};
	const tools = inventory("tool");
	const active = number(details.activeToolCount);
	const activeFact = active ? `${active} active` : active === 0 && tools ? "no active tools" : "";
	return [
		join(model, percent === undefined ? "" : `context ${Math.round(percent)}%`),
		availability.tools === false ? "Tool registry unavailable" : join(tools, activeFact),
		availability.activeTools === false ? "Active tool registry unavailable" : "",
		availability.commands === false
			? "Command registry unavailable"
			: join(inventory("command"), inventory("skill"), inventory("prompt")),
		boolean(details.observed, "Prior resource observation recorded", "No resource observation recorded"),
	].filter(Boolean);
}

function continuation(details: Fields): string {
	if (details.pageBlocked === true || details.continuationStatus === "blocked") return "page cannot advance";
	if (details.continuationStatus === "available" && typeof details.cursor === "string") return "continuation available";
	if (details.continuationStatus === "unavailable") return "continuation unavailable";
	if (details.continuationStatus === "complete") return "no further known matches";
	return "";
}

const OUTCOMES = new Set([
	"ok",
	"host_summary",
	"missing",
	"ambiguous",
	"unavailable",
	"partial",
	"cancelled",
	"stale_cursor",
	"io_error",
	"invalid_arguments",
]);

function isOutcome(value: unknown): value is string {
	return typeof value === "string" && OUTCOMES.has(value);
}

function diagnostic(details: Fields): string {
	if (details.outcome === "stale_cursor") {
		const reason = field(details.reason);
		if (reason) return `The cursor is stale because ${reason}`;
		// Discovery and settings report staleness from their source fingerprints.
		if (details.settingsCoverage) return "The configured settings or publication coverage changed; start a new query.";
		if (details.catalogBoundary || record(details.query).kind === "context_file") {
			return "The source snapshot changed. Reissue the original query.";
		}
		return "Stale cursor. Reissue the original query.";
	}
	return field(details.message) || field(details.ioError);
}

function isChatCatalog(details: Fields): boolean {
	return typeof details.catalogBoundary === "string";
}

function isContextPathQuery(details: Fields): boolean {
	return record(details.query).kind === "context_file";
}

function isHealthReview(details: Fields): boolean {
	return record(details.health).evidence === "local_catalog_review";
}

function unavailableLead(details: Fields): string {
	if (details.settingsCoverage !== undefined) return "Settings snapshot unavailable";
	if (isContextPathQuery(details) && details.observed === false) return "Context paths not yet observed";
	if (isChatCatalog(details)) {
		if (details.catalogAvailable === false) return "Chat model catalog unavailable";
		if (details.availableSnapshot === false) return "Cached model availability unavailable";
	}
	if (details.scanned === true) return "File metadata unavailable";
	return "Source unavailable";
}

function pageLead(details: Fields, scope: string): string {
	switch (details.outcome) {
		case "missing":
			return isContextPathQuery(details) ? "No observed context paths match" : "No matches";
		case "ambiguous":
			return "The query needs one resource";
		case "unavailable":
			return unavailableLead(details);
		case "partial":
			if (details.scanned === true) return "Partial file scan";
			if (details.settingsCoverage !== undefined) return "Partial configuration snapshot";
			return "Source coverage is partial";
		default:
			if (scope) return "Returned";
			if (isHealthReview(details) && details.total === 0) return "No flagged records in the local catalog review";
			return "Registry read completed";
	}
}

function pageScope(details: Fields): string {
	const total = number(details.total) ?? number(details.candidates);
	const shown = number(details.returnedRecords);
	const incomplete = details.outcome === "partial" || details.outcome === "unavailable";
	if (shown === undefined || total === undefined || total === 0) return "";
	const noun = isHealthReview(details) ? "flagged record" : details.candidates === undefined ? "match" : "candidate";
	const plural = noun === "match" ? "matches" : `${noun}s`;
	const qualifier = incomplete ? "known " : "";
	return `${shown} of ${count(total, qualifier + noun, qualifier + plural)}`;
}

function pageOutcome(details: Fields): string {
	const scope = pageScope(details);
	const lead = pageLead(details, scope);
	const resolved = record(details.resolved);
	const target = [field(resolved.kind), field(resolved.name)].filter(Boolean).join(" ");
	const offset = number(details.offset);
	const page = [
		scope && lead === "Returned" ? `Returned ${scope}` : scope ? `${lead}; ${scope}` : lead,
		target && `in ${target}`,
		offset !== undefined && offset > 0 ? `(offset ${offset})` : "",
	]
		.filter(Boolean)
		.join(" ");
	const next = continuation(details);
	return next ? `${page}; ${next}` : page;
}

function catalogCoverage(details: Fields): string[] {
	if (!isChatCatalog(details)) return [];
	const boundary = "Chat models only";
	if (!isHealthReview(details)) return [boundary];
	const health = record(details.health);
	const matched = number(health.matchedRecords);
	const unflagged = number(health.unflaggedRecords);
	return [
		boundary,
		join(
			"Local catalog review",
			matched ? count(matched, "matched record") : "",
			unflagged ? `${unflagged} unflagged` : "",
			"remote health not checked",
		),
	];
}

function publicationCoverage(value: unknown): string[] {
	if (value === undefined) return [];
	const settings = record(value);
	const collection = record(settings.collection);
	const publishers = Array.isArray(settings.respondingSlices)
		? settings.respondingSlices.map(field).filter(Boolean)
		: [];
	return [
		join("Configuration snapshot; responding publishers only", publishers.join(", ")),
		...(["malformed", "omitted"] as const).flatMap((key) => {
			const value = number(collection[key]);
			return value ? [`${count(value, "publication")} ${key}`] : [];
		}),
	];
}

function bytesRead(details: Fields): string {
	const bytes = number(details.bytesRead);
	const size = number(details.fileSize);
	if (bytes === undefined || size === undefined) return "";
	if (bytes === 0 && size === 0 && details.partialScan === false) return "Empty file scanned";
	return `${bytes} of ${size} bytes read${details.partialScan === false ? "; whole file scanned" : ""}`;
}

function coverage(details: Fields): string[] {
	if (details.outcome === "host_summary") return hostFacts(details);
	const surfaces = Array.isArray(details.unavailableSurfaces)
		? details.unavailableSurfaces.map(field).filter(Boolean)
		: [];
	const omitted = number(details.omittedRecordBlocks);
	return [
		...catalogCoverage(details),
		isContextPathQuery(details) && details.observed === true
			? "Prior context path observation; no file content read"
			: "",
		...publicationCoverage(details.settingsCoverage),
		...surfaces.map((surface) => `${surface} unavailable`),
		field(details.reason),
		bytesRead(details),
		field(details.continuationReason),
		omitted && details.resultBounded === true ? `${count(omitted, "record")} omitted from this page` : "",
		details.omittedDetails === true ? "Result metadata exceeds the producer bound" : "",
	].filter(Boolean);
}

function coverageWarning(details: Fields): string | undefined {
	if (
		details.partialScan === true ||
		details.observationPartial === true ||
		details.outcome === "partial" ||
		details.incompleteInventory === true
	) {
		return "[Coverage is partial; absence is not established]";
	}
}

function sourceRows(details: Fields, entries: Fields[]): string[] {
	const rows = entries.flatMap((entry) => {
		const path = pathField(record(entry.sourceInfo).path);
		return path ? [`Source for ${recordName(entry)}: ${path}`] : [];
	});
	const scanPath = pathField(record(record(details.resolved).sourceInfo).path);
	if (scanPath) rows.push(`Scanned source: ${scanPath}`);
	return rows;
}

function isPage(details: Fields): boolean {
	return ["host_summary", "ok", "missing", "ambiguous", "unavailable", "partial"].includes(String(details.outcome));
}

type View = {
	outcome: ReturnType<typeof bounded>;
	preview: ReturnType<typeof bounded>;
	evidence: ReturnType<typeof bounded>;
	warning?: string;
};

function pageView(details: Fields, raw: string): View {
	const outcome = bounded(details.outcome === "host_summary" ? "Session overview" : pageOutcome(details));
	const entries = Array.isArray(details.records) ? details.records.map(record) : [];
	const preview = [...coverage(details), ...entries.map(recordLine)].filter(Boolean).join("\n");
	const cursor = details.continuationStatus === "available" ? details.cursor : undefined;
	const evidence = [
		typeof cursor === "string" ? safeText(`Next call: registry ${JSON.stringify({ cursor })}`) : "",
		preview,
		sourceRows(details, entries).join("\n"),
		raw !== outcome.text && raw !== preview ? raw : "",
	]
		.filter(Boolean)
		.join("\n\n");
	return { outcome, preview: bounded(preview), evidence: bounded(evidence), warning: coverageWarning(details) };
}

function resultView(result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0], isError: boolean): View {
	const raw = safeText(
		result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
	).trim();
	const details = record(result.details);
	if (!isError && isPage(details)) return pageView(details, raw);
	const structured = isOutcome(details.outcome);
	const cancelled = details.outcome === "cancelled" && details.cancelled === true;
	const [first, ...tail] = raw.split("\n");
	const lead = cancelled ? "Cancelled" : structured ? diagnostic(details) : "";
	const firstLine = field(first);
	const heading =
		lead || firstLine || (isError ? "Registry returned no diagnostic." : "Registry returned no result text.");
	const remainder = heading === firstLine ? tail.join("\n") : raw;
	const evidence = bounded(remainder);
	return {
		outcome: bounded(heading),
		preview: !structured && isError ? evidence : { text: "" },
		evidence,
	};
}

function hidesReadback(view: View, width: number): boolean {
	return (
		view.evidence.text !== view.preview.text ||
		view.evidence.limit !== view.preview.limit ||
		visibleWidth(view.outcome.text) > width
	);
}

export const renderRegistryResult: NonNullable<ToolDefinition["renderResult"]> = (
	result,
	options,
	theme,
	context: CardContext,
) => {
	context.state.hasResult = true;
	if (options.isPartial) {
		return component((width) => [
			"",
			theme.fg("muted", clipLine("Reading the registry…", width)),
			...(!options.expanded && context.state.hidesArguments?.(width) ? [hint(theme, context, width)] : []),
		]);
	}
	const view = resultView(result, context.isError);
	const color = context.isError ? "error" : "toolOutput";
	const body = options.expanded ? view.evidence : view.preview;
	const warning = view.outcome.limit ?? body.limit ?? view.warning;
	return component((width) => {
		const outcomeRows = options.expanded ? wrapped(view.outcome.text, width) : [clipLine(view.outcome.text, width)];
		const drawn = options.expanded
			? { visualLines: wrapped(body.text, width), skippedCount: 0 }
			: truncateToVisualLines(body.text, PREVIEW_ROWS, width, 0, "start");
		const rows = [
			"",
			...outcomeRows.map((line) => theme.fg(color, line)),
			...drawn.visualLines.map((line) => theme.fg(color, line)),
		];
		if (warning) rows.push(theme.fg("warning", clipLine(warning, width)));
		if (
			!options.expanded &&
			(drawn.skippedCount || hidesReadback(view, width) || context.state.hidesArguments?.(width))
		) {
			rows.push(hint(theme, context, width, drawn.skippedCount));
		}
		return rows;
	});
};
