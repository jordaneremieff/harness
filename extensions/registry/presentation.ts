import { homedir } from "node:os";
import { type Theme, type ToolDefinition, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const EXPAND = "app.tools.expand";
const DISPLAY_LIMIT = 32_000;
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

function hint(theme: Theme, context: CardContext, width: number): string {
	const key = context.keyText(EXPAND);
	const plain = `... (${key ? `${key} to expand` : "click to expand"})`;
	if (!key || visibleWidth(plain) > width) return theme.fg("muted", clipLine(plain, width));
	return theme.fg("muted", "... (") + context.keyHint(EXPAND, "to expand") + theme.fg("muted", ")");
}

function callSubject(args: Fields): { subject: string; unshown: boolean } {
	for (const key of ["name", "search", "contains", "kind"] as const) {
		const value = key === "name" && args.kind === "context_file" ? pathField(args[key]) : field(args[key]);
		if (!value) continue;
		const subject = key === "search" || key === "contains" ? `${key} ${JSON.stringify(value)}` : value;
		return { subject, unshown: value !== args[key] || Object.keys(args).some((argument) => argument !== key) };
	}
	return {
		subject: field(args.cursor) ? "continuation" : "session overview",
		unshown: Object.keys(args).length > 0,
	};
}

export const renderRegistryCall: NonNullable<ToolDefinition["renderCall"]> = (value, theme, context: CardContext) => {
	const args = record(value);
	const { subject, unshown } = callSubject(args);
	const headingWidth = visibleWidth(`registry ${subject}`);
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
	context.state.hidesArguments = (width) => Object.keys(args).length > 0 && (unshown || headingWidth > width);
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
			if (isContextPathQuery(details)) return "No observed context paths match";
			return hasPartialCoverage(details) ? "No known matches" : "No matches";
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

function hasPartialCoverage(details: Fields): boolean {
	return (
		details.outcome === "partial" ||
		details.partialScan === true ||
		details.observationPartial === true ||
		details.incompleteInventory === true
	);
}

function pageScope(details: Fields): string {
	const total = number(details.total) ?? number(details.candidates);
	const shown = number(details.returnedRecords);
	const incomplete = hasPartialCoverage(details) || details.outcome === "unavailable";
	if (shown === undefined || total === undefined || total === 0) return "";
	const noun = isHealthReview(details) ? "flagged record" : details.candidates === undefined ? "match" : "candidate";
	const plural = noun === "match" ? "matches" : `${noun}s`;
	const qualifier = incomplete ? "known " : "";
	return `${shown} of ${count(total, qualifier + noun, qualifier + plural)}`;
}

function singleRecordOutcome(entry: Fields): string {
	const name = recordName(entry);
	if (!name) return "";
	if (entry.kind === "tool") {
		return join(
			`Tool ${name}`,
			boolean(entry.active, "active", "inactive") || boolean(entry.configured, "configured", "not configured"),
			boolean(entry.callable, "callable here", "not callable here"),
		);
	}
	if (entry.kind === "model") {
		const finding = Array.isArray(entry.findings) ? field(record(entry.findings[0]).reason) : "";
		return join(
			name,
			finding || (entry.selected === true ? join("selected", field(entry.currentThinkingLevel)) : ""),
			boolean(entry.available, "available (cached)", "unavailable (cached)"),
			boolean(
				entry.configuredAuth,
				"auth configured",
				entry.authSource === "stored" ? "stored credential unresolved" : "no configured auth",
			),
		);
	}
	if (entry.kind === "context_file") return join(name, "observed path only");
	return recordLine(entry);
}

function overviewOutcome(details: Fields): string {
	const model = field(record(details.context).model);
	const tools = number(record(details.counts).tool);
	const active = number(details.activeToolCount);
	const inventory = tools === undefined ? "" : count(tools, "tool");
	const unavailable = record(details.availability).tools === false;
	return join(
		"Session overview",
		unavailable ? "tool registry unavailable" : inventory,
		unavailable || active === undefined ? "" : `${active} active`,
		model,
	);
}

function exactPageRecord(details: Fields, entries: Fields[]): Fields | undefined {
	const { continuationStatus } = details;
	if (
		details.outcome === "ok" &&
		!hasPartialCoverage(details) &&
		details.total === 1 &&
		details.returnedRecords === 1 &&
		entries.length === 1 &&
		details.scanned !== true &&
		details.pageBlocked !== true &&
		(continuationStatus === undefined || continuationStatus === "complete")
	) {
		return entries[0];
	}
}

function pageOutcome(details: Fields, entries: Fields[]): string {
	if (details.outcome === "host_summary") return overviewOutcome(details);
	const exact = exactPageRecord(details, entries);
	if (exact) {
		const single = singleRecordOutcome(exact);
		if (single) return single;
	}
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
	const coverage = hasPartialCoverage(details) && details.outcome !== "partial" && details.outcome !== "unavailable";
	const next = continuation(details);
	const qualified = coverage ? `Partial coverage; ${page[0].toLowerCase()}${page.slice(1)}` : page;
	return next ? `${qualified}; ${next}` : qualified;
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
	const limits: string[] = [];
	if (hasPartialCoverage(details)) limits.push("absence is not established");
	if (details.settingsCoverage !== undefined && details.outcome !== "unavailable") {
		limits.push("responding publishers only");
	}
	if (isHealthReview(details)) limits.push("remote health not checked");
	else if (isChatCatalog(details)) limits.push("chat models only");
	if (details.outcome === "host_summary" && record(details.availability).activeTools === false) {
		limits.push("active tools unavailable");
	}
	if (details.outcome === "host_summary" && record(details.availability).commands === false) {
		limits.push("command registry unavailable");
	}
	if (limits.length) return `[${limits.join("; ")}]`;
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
	evidence: ReturnType<typeof bounded>;
	warning?: string;
};

function pageView(details: Fields, raw: string): View {
	const entries = Array.isArray(details.records) ? details.records.map(record) : [];
	const outcome = bounded(pageOutcome(details, entries));
	const facts = [...coverage(details), ...entries.map(recordLine)]
		.filter((line) => line && line !== outcome.text)
		.join("\n");
	const cursor = details.continuationStatus === "available" ? details.cursor : undefined;
	const evidence = [
		typeof cursor === "string" ? safeText(`Next call: registry ${JSON.stringify({ cursor })}`) : "",
		facts,
		sourceRows(details, entries).join("\n"),
		raw !== outcome.text && raw !== facts ? raw : "",
	]
		.filter(Boolean)
		.join("\n\n");
	return { outcome, evidence: bounded(evidence), warning: coverageWarning(details) };
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
	return { outcome: bounded(heading), evidence: bounded(remainder) };
}

function expandedResult(view: View, theme: Theme, width: number, color: "error" | "toolOutput"): string[] {
	return [
		"",
		...wrapped(view.outcome.text, width).map((line) => theme.fg(color, line)),
		...(view.evidence.text ? wrapped(view.evidence.text, width).map((line) => theme.fg(color, line)) : []),
		...[view.warning, view.outcome.limit, view.evidence.limit].flatMap((limit) =>
			limit ? wrapped(limit, width).map((line) => theme.fg("warning", line)) : [],
		),
	];
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
	return component((width) => {
		if (options.expanded) return expandedResult(view, theme, width, color);
		const lead = view.outcome.text;
		const warning = view.warning ?? view.outcome.limit;
		const inline = warning && visibleWidth(`${lead} ${warning}`) <= width;
		const outcome = theme.fg(color, clipLine(lead, width));
		const rows = ["", inline ? `${outcome} ${theme.fg("warning", warning)}` : outcome];
		if (warning && !inline) rows.push(theme.fg("warning", clipLine(warning, width)));
		if (
			view.evidence.text ||
			visibleWidth(lead) > width ||
			(warning && visibleWidth(warning) > width) ||
			context.state.hidesArguments?.(width)
		) {
			rows.push(hint(theme, context, width));
		}
		return rows;
	});
};
