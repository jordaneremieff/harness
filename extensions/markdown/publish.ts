import { open, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { arr, bool, int, lit, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { buildBrief, formatBrief, type WritingBrief } from "./brief.ts";
import {
	BRIEF_GUIDANCE,
	type BriefBuilder,
	makeBrief,
	nativeBrief,
	ordinaryBriefMessages,
	WritingBriefSchema,
} from "./brief-tool.ts";
import { describeRules, RULE_IDS } from "./check-rules.ts";
import { checkWriting, describeFindings, type Finding } from "./checks.ts";
import { toolDisplay } from "./display.ts";
import { type ShowInput, type ShowResult, ShowResultSchema } from "./live-show.ts";
import type { LocalShow, NativeShow } from "./live-tool.ts";
import { previousNative } from "./native-responses.ts";
import { type PaneInventory, PaneInventorySchema, type ShowRequest, ShowRequestSchema } from "./pane-state.ts";
import { previousOrdinary, type ResponseSnapshot, responseSnapshotWrite } from "./responses.ts";
import { type AgentPane, settings } from "./settings.ts";
import {
	type AssetRecord,
	type ContentOrigin,
	digest,
	type ErrorCode,
	INSPECTION_FAILURES,
	type InspectionFailure,
	LIMITS,
	type MarkdownStore,
	type PublicationPlan,
	type ReferenceInventory,
	type StoredDocument,
	StoreError,
	validateInput,
	type WriteInput,
	type WriteResult,
} from "./store.ts";
import { loadLexicon, WritingConfigError, type WritingOptions } from "./writing-config.ts";

export const PublishParameters = obj(
	{
		title: opt(
			str({ minLength: 1, maxLength: 200, description: "One-line document title. Required with text or file." }),
		),
		text: opt(str({ description: "Exact Markdown source. Supply one of text, file or response." })),
		file: opt(
			str({
				minLength: 1,
				description:
					"Explicit local UTF-8 source path, relative to the working directory or absolute. The source file stays unchanged.",
			}),
		),
		response: opt(
			lit("previous", {
				description:
					"Save the exact earlier answer instead of new text: the newest assistant response with text before the newest user message. Takes no title, document, expectedRevision or reuseKey.",
			}),
		),
		document: opt(str({ description: "Stable ID of a published document to update." })),
		expectedRevision: opt(int({ minimum: 1 })),
		reuseKey: opt(
			str({
				minLength: 1,
				maxLength: 256,
				description: "Explicit request identity. Equal input reuses the first publication; different input conflicts.",
			}),
		),
		show: opt(
			bool({
				description:
					"After the save, show the saved document in your reader pane in this call, exactly as markdown_live show does. Use it only when you may show material.",
			}),
		),
	},
	{ open: false },
);
export type PublishInput = Static<typeof PublishParameters>;
/**
 * Reference coverage of a saved revision. `truncated` and `omitted` qualify an inspected inventory;
 * `reason` says why inspection did not run; `unavailableItems` names the first unavailable images;
 * `kept` counts the retained images that a text update kept from the revision it edits.
 */
export type ReferenceSummary = {
	state: "inspected" | "uninspected";
	truncated: boolean;
	omitted: number;
	retained: number;
	embedded: number;
	external: number;
	unavailable: number;
	localLinks: number;
	reason?: InspectionFailure;
	unavailableItems?: { reference: string; reason: string }[];
	kept?: { revision: number; images: number };
};
type PaneQuery = () => Promise<PaneInventory | undefined>;
const PaneStateSchema = union([
	obj({ status: lit("unknown") }),
	obj({ status: lit("observed"), inventory: PaneInventorySchema, showing: arr(str()) }),
]);
type PaneState = Static<typeof PaneStateSchema>;
const RecoverySchema = union([
	obj({ op: lit("list") }),
	obj({ op: lit("read"), handle: str() }),
	obj({ document: str(), revision: int() }),
]);
export type PublishOutcome =
	| {
			ok: true;
			documentId: string;
			revision: number;
			digest: string;
			bytes: number;
			title: string;
			kind: "published" | "response";
			created: boolean;
			replayed: boolean;
			selfContained?: boolean;
			references: ReferenceSummary;
			provenance: ContentOrigin;
			open: string;
			show: ShowRequest;
			paneState: PaneState;
			/** The show that the request asked for, when no pane already reported the saved revision. */
			shown?: ShowResult;
			checks?: { findings: Finding[] };
	  }
	| {
			ok: false;
			error: {
				code: ErrorCode | "checks" | "live-editor" | "live-state-unavailable";
				currentMatches?: "source" | "source-title-references";
				currentFromEditor?: boolean;
				next?: Static<typeof RecoverySchema>;
				paneState?: PaneState;
				findings?: Finding[];
				brief?: WritingBrief;
				message: string;
				currentRevision?: number;
				currentDigest?: string;
			};
	  };
const OriginSchema = obj({ kind: str(), capturedAt: str() }, { open: true });
export const ReferenceSummarySchema = obj({
	state: union([lit("inspected"), lit("uninspected")]),
	truncated: bool(),
	omitted: int(),
	retained: int(),
	embedded: int(),
	external: int(),
	unavailable: int(),
	localLinks: int(),
	reason: opt(union(INSPECTION_FAILURES.map((reason) => lit(reason)))),
	unavailableItems: opt(arr(obj({ reference: str(), reason: str() }))),
	kept: opt(obj({ revision: int(), images: int() })),
});
const FindingsSchema = arr(
	obj({
		rule: union(RULE_IDS.map((rule) => lit(rule))),
		count: num(),
		limit: num(),
		examples: arr(obj({ line: int(), text: str() })),
		unlisted: opt(int()),
	}),
);
export const PublishOutcomeSchema = union([
	obj({
		ok: lit(true),
		documentId: str(),
		revision: int(),
		digest: str(),
		bytes: int(),
		title: str(),
		kind: union([lit("published"), lit("response")]),
		created: bool(),
		replayed: bool(),
		selfContained: opt(bool()),
		references: ReferenceSummarySchema,
		provenance: OriginSchema,
		open: str(),
		show: ShowRequestSchema,
		paneState: PaneStateSchema,
		shown: opt(ShowResultSchema),
		checks: opt(obj({ findings: FindingsSchema })),
	}),
	obj({
		ok: lit(false),
		error: obj({
			code: union(
				[
					"invalid",
					"too-large",
					"not-found",
					"conflict",
					"replay-conflict",
					"file-unreadable",
					"store-failure",
					"checks",
					"live-editor",
					"live-state-unavailable",
				].map((code) => lit(code)),
			),
			message: str(),
			currentRevision: opt(int()),
			currentDigest: opt(str()),
			currentMatches: opt(union([lit("source"), lit("source-title-references")])),
			currentFromEditor: opt(bool()),
			next: opt(RecoverySchema),
			paneState: opt(PaneStateSchema),
			findings: opt(FindingsSchema),
			brief: opt(WritingBriefSchema),
		}),
	}),
]);
const BUILD = "node extensions/markdown/native/build.mts";
const INSPECTION_TEXT: Record<InspectionFailure, string> = {
	"app-missing": `the reader app is not installed; build it with ${BUILD}`,
	"app-incompatible": `the installed reader app is incompatible or incomplete; rebuild it with ${BUILD}`,
	"tool-failed": `the reference tool failed; retry, or rebuild the reader app with ${BUILD}`,
	"tool-timeout": "the reference tool timed out after 10 seconds; retry",
	"output-invalid": `the reference tool returned invalid or oversized output; rebuild the reader app with ${BUILD}`,
};
const ASK_REPLY =
	"A question from a reader Ask card names its pane. Answer it by editing that document with markdown_live apply, then say in one or two sentences what changed. If the question clearly asks for no change to the document, answer briefly in your final message; the Ask card shows that message. Do not publish another document, open another pane or write a long final message to answer an Ask.";
const READER_MATERIAL =
	"a reply with headings, a table, three or more explained points, or more than about ten lines; or a document, comparison, or diagram";
const REPORT =
	"Give the coordinating session a complete report. If you publish a document, include its ID and title so the coordinator can show it without copying it.";
const PLACEMENT: Record<AgentPane, string> = {
	split: "a split on the left of your pane",
	float: "a floating pane that stays in place",
};
const USE_PANE =
	"To show what you publish, call markdown_publish with show: true; it saves and shows in one call. To show a stored document, use markdown_live show with its ID. Status navigated confirms the document, revision and pane. Status launch gives a one-use argv: run it unchanged as the program of a new pane, with no target, and close the pane when its program ends. Then call markdown_live list once to confirm the document and revision. For a pending or uncertain show, list panes; never start another pane. Respect the operator's requested placement. Do not take focus unless the operator asked to see it now.";
const CHAT_BESIDE_PANE =
	"When a reader pane shows your material, the chat reply is at most three sentences: the answer or the decision you need, and what the pane holds. Do not summarise or repeat the pane in chat.";
export const NATIVE_PUBLISH_GUIDANCE = `Publish silently when a document helps the recipient. ${REPORT} Do not open or navigate a reader pane unless the operator explicitly asks you to show the material. For that request, reuse a reader pane you opened. For a new pane, use a split on the left of the inherited pane. ${USE_PANE} ${BRIEF_GUIDANCE} ${ASK_REPLY}`;
export const publishGuideline = (pane: AgentPane): string =>
	`If you work for another agent or run without an interactive conversation, publish silently and do not open or navigate a reader pane unless the operator explicitly asks you to show the material. ${REPORT} In the interactive session with the operator, show material that is hard to read in a terminal without waiting to be asked: ${READER_MATERIAL}. Choose which findings from other agents to show. Publish your synthesis or use markdown_read with the reported document ID. Reuse your reader pane across reports. For a new pane, use ${PLACEMENT[pane]}. ${USE_PANE} Say that the pane holds the material only after a navigated result or a confirming list. ${CHAT_BESIDE_PANE} A plain answer of a few sentences stays in chat without a document. ${BRIEF_GUIDANCE} ${ASK_REPLY}`;
const EDITORIAL_POLICY =
	"Writing checks apply to new full publications and replacements, not to live edits, private drafts, Undo, recovery, exact captures or saved replays. If publication checks refuse your text, repair it rather than switching to live edits. Use markdown_live for a requested change to the actual buffer.";
const describePublication = (guidance: string, paneNotices: boolean) =>
	`Save an exact Markdown document silently. Supply a title and one source: text or an explicit local file. To capture the earlier answer exactly, use response "previous" alone. For a diagram, publish a Markdown file that references the SVG or PNG beside it. To revise a stored draft, use its document ID and expectedRevision. Read the current revision with markdown_read if you do not hold its text. A clean editor permits a stored revision. On conflict, follow the receipt: preserve unsaved edits, check the current stored revision, and never retry an older replacement blindly. ${EDITORIAL_POLICY} ${guidance} Without show, publication does not open or navigate panes. paneState.showing identifies only panes that reported the saved revision. Check the observations before you claim a pane shows it.${paneNotices ? " When a reader pane connected to this conversation closes, a notice identifies the departed pane." : ""} The operator can also open a document under Published in the Markdown view or with the open command in ordinary Pi.`;
export const publishDescription = (pane: AgentPane, paneNotices = false): string =>
	describePublication(publishGuideline(pane), paneNotices);
export type {
	InspectionOptions,
	InspectionResult,
	KeptImages,
	ReferenceInspection,
	ReferenceRunner,
} from "./reference-capture.ts";
export { captureReferences, inspectReferences } from "./reference-capture.ts";

import {
	boundedFile,
	captureReferences,
	type InspectionOptions,
	inspectReferences,
	type KeptImages,
} from "./reference-capture.ts";
export type PublishOptions = InspectionOptions & {
	store: MarkdownStore;
	cwd: string;
	provenance?: Partial<ContentOrigin>;
	plan?: PublicationPlan;
	previousResponse?: () => Promise<ResponseSnapshot>;
	observePanes?: PaneQuery;
	writing?: WritingOptions;
	brief?: BriefBuilder;
};
/** Checks a publication's parameters and returns its title. */
function validateParameters(value: PublishInput): string {
	if (!value || typeof value !== "object" || typeof value.title !== "string")
		throw new StoreError("invalid", "A title and one source are required.");
	if (value.response !== undefined) throw new StoreError("invalid", "Supply exactly one of text, file or response.");
	if ((typeof value.text === "string") === (typeof value.file === "string"))
		throw new StoreError("invalid", "Supply exactly one of text or file.");
	if ((value.document === undefined) !== (value.expectedRevision === undefined))
		throw new StoreError("invalid", "Updates require document and expectedRevision together.");
	if (
		value.expectedRevision !== undefined &&
		(!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)
	)
		throw new StoreError("invalid", "Expected revision must be a positive integer.");
	if (
		value.reuseKey !== undefined &&
		(typeof value.reuseKey !== "string" ||
			!value.reuseKey ||
			value.reuseKey.length > 256 ||
			/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value.reuseKey))
	)
		throw new StoreError("invalid", "Reuse key must be nonempty text of at most 256 characters.");
	return value.title;
}
export function invocationDigest(params: PublishInput, cwd: string): string {
	return digest(
		JSON.stringify({
			title: params.title,
			...(params.file === undefined ? { text: params.text } : { file: resolve(cwd, params.file) }),
			...(params.document === undefined
				? {}
				: { document: params.document, expectedRevision: params.expectedRevision }),
			...(params.reuseKey === undefined ? {} : { reuseKey: params.reuseKey }),
		}),
	);
}
/** The failure names the resolved path and its cause, so the caller can fix the path or the file. */
function unreadableReason(path: string, cwd: string, error: unknown): string {
	if (!path || /[\p{Cc}\ud800-\udfff]/u.test(path)) return "The source path is empty or has control characters.";
	const at = resolve(cwd, path);
	const code = (error as { code?: unknown } | undefined)?.code;
	if (code === "ENOENT" || code === "ENOTDIR")
		return `No file exists at ${at}. Write the file first or correct the path.`;
	if (code === "EACCES" || code === "EPERM") return `The file at ${at} is not readable.`;
	if (error instanceof TypeError) return `The file at ${at} is not valid UTF-8.`;
	if (error instanceof StoreError) return `The source at ${at} is not a regular file.`;
	return `The file at ${at} is unavailable.`;
}
async function readFileSource(path: string, cwd: string): Promise<{ resolved: string; source: string }> {
	let resolved: string;
	let source: string;
	try {
		if (!path || /[\p{Cc}\ud800-\udfff]/u.test(path)) throw new Error("Invalid path");
		resolved = await realpath(resolve(cwd, path));
		source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			(await boundedFile(resolved, LIMITS.sourceBytes)).data,
		);
	} catch (error) {
		if (error instanceof StoreError && error.code === "too-large") throw error;
		throw new StoreError("file-unreadable", unreadableReason(path, cwd, error));
	}
	return { resolved, source };
}
export async function fileSnapshotInput(
	path: string,
	options: InspectionOptions & { cwd: string },
): Promise<WriteInput> {
	const { resolved, source } = await readFileSource(path, options.cwd);
	const captured = await captureReferences(await inspectReferences(source, options), dirname(resolved));
	return {
		title: basename(resolved),
		source,
		contentOrigin: { kind: "file", path: resolved, cwd: options.cwd, capturedAt: new Date().toISOString() },
		...captured,
	};
}
class WritingRefusal extends Error {
	readonly findings: Finding[];
	readonly brief: WritingBrief;
	constructor(findings: Finding[], brief: WritingBrief) {
		super("I did not save the document. The passages below need changes.");
		this.findings = findings;
		this.brief = brief;
	}
}
async function checkSource(input: WriteInput, options: PublishOptions): Promise<Finding[]> {
	const writing = options.writing ?? { mode: settings.fields.checks.default };
	if (writing.mode === "off") return [];
	const lexicon = await loadLexicon(writing);
	const findings = checkWriting(input.source, writing.overrides, lexicon);
	if (writing.mode === "block" && findings.length) {
		const brief = await (options.brief ?? makeBrief(writing))(input.title, lexicon, true).catch(() =>
			buildBrief({ title: input.title, checks: describeRules(writing.mode, writing.overrides) }),
		);
		throw new WritingRefusal(findings, brief);
	}
	return findings;
}
async function preparePublication(
	params: PublishInput,
	options: PublishOptions,
): Promise<{ input: WriteInput; findings: Finding[] }> {
	const title = validateParameters(params);
	const file = params.file === undefined ? undefined : await readFileSource(params.file, options.cwd);
	const input: WriteInput = {
		title,
		source: file?.source ?? params.text ?? "",
		contentOrigin: {
			...options.provenance,
			kind: file ? "file" : "tool",
			...(file ? { path: file.resolved } : {}),
			cwd: options.cwd,
			capturedAt: new Date().toISOString(),
			host: hostname(),
		},
		invocationDigest: invocationDigest(params, options.cwd),
	};
	validateInput(input);
	if (!input.source.trim()) throw new StoreError("invalid", "Publication source must not be empty.");
	const findings = await checkSource(input, options);
	const kept =
		!file && params.document && params.expectedRevision
			? await keptImages(options.store, params.document, params.expectedRevision)
			: undefined;
	Object.assign(
		input,
		await captureReferences(
			await inspectReferences(input.source, options),
			file ? dirname(file.resolved) : undefined,
			open,
			kept,
		),
	);
	validateInput(input);
	return { input, findings };
}
/**
 * A text update reads no image files, so an image reference that the edited revision retained
 * keeps that revision's checked bytes. A reference that the edited revision did not retain, or
 * whose retained bytes fail their check, stays unavailable without a folder.
 */
async function keptImages(store: MarkdownStore, document: string, revision: number): Promise<KeptImages | undefined> {
	let base: StoredDocument;
	try {
		base = await store.get(document, revision);
	} catch (error) {
		if (error instanceof StoreError && error.code === "not-found") return undefined;
		throw error;
	}
	const retained = new Map(
		base.revision.references.items
			.filter((item) => item.kind === "image" && item.state === "retained")
			.map((item) => [item.reference, item]),
	);
	return async (reference) => {
		const item = retained.get(reference);
		if (!item) return undefined;
		try {
			return { record: { ...item }, data: await store.retainedAsset(document, revision, item), keptFrom: revision };
		} catch {
			return undefined;
		}
	};
}
/** Saves the earlier answer exactly as a response snapshot; the same response always names the same snapshot. */
async function snapshotPrevious(params: PublishInput, options: PublishOptions): Promise<PublishOutcome> {
	if (params.text !== undefined || params.file !== undefined)
		throw new StoreError("invalid", "Supply exactly one of text, file or response.");
	if (
		params.title !== undefined ||
		params.document !== undefined ||
		params.expectedRevision !== undefined ||
		params.reuseKey !== undefined
	)
		throw new StoreError("invalid", "A response snapshot takes no title, document, expectedRevision or reuseKey.");
	if (!options.previousResponse) throw new StoreError("invalid", "This host cannot read earlier responses.");
	let response: ResponseSnapshot;
	try {
		response = await options.previousResponse();
	} catch (error) {
		throw new StoreError("not-found", error instanceof Error ? error.message : String(error));
	}
	const { sourceKey, input } = responseSnapshotWrite(response);
	return publicationOutcome(await options.store.snapshot(sourceKey, "response", input));
}
const SUMMARY_ITEMS = 5;
const SUMMARY_REFERENCE_CHARS = 120;
/** Bounded coverage of a stored inventory; the revision record keeps the complete inventory. */
export function referenceSummary(references: ReferenceInventory): ReferenceSummary {
	const { items } = references;
	const count = (state: AssetRecord["state"]) => items.filter((item) => item.state === state).length;
	const unavailable = items
		.filter((item) => item.state === "unavailable")
		.slice(0, SUMMARY_ITEMS)
		.map((item) => ({
			reference: [...item.reference].slice(0, SUMMARY_REFERENCE_CHARS).join(""),
			reason: item.reason ?? "unknown",
		}));
	return {
		state: references.state,
		truncated: references.truncated,
		omitted: references.omitted,
		retained: count("retained"),
		embedded: count("embedded"),
		external: count("external"),
		unavailable: count("unavailable"),
		localLinks: count("local-only"),
		...(references.reason ? { reason: references.reason } : {}),
		...(unavailable.length ? { unavailableItems: unavailable } : {}),
	};
}
export function publicationOutcome(result: WriteResult, kept?: ReferenceSummary["kept"]): PublishOutcome {
	const { revision } = result;
	return {
		ok: true,
		documentId: revision.document,
		revision: revision.revision,
		digest: revision.digest,
		bytes: revision.bytes,
		title: revision.title,
		kind: result.document.kind === "response" ? "response" : "published",
		created: result.created,
		replayed: result.replayed,
		...(revision.selfContained === undefined ? {} : { selfContained: revision.selfContained }),
		references: { ...referenceSummary(revision.references), ...(kept && !result.replayed ? { kept } : {}) },
		provenance: revision.contentOrigin,
		open: `/markdown ${revision.document}`,
		show: {
			op: "show",
			document: revision.document,
			...(result.replayed || result.document.kind === "response" ? { revision: revision.revision } : {}),
		},
		paneState: { status: "unknown" },
	};
}
/** The images that a text update kept from the revision it edits. */
function keptSummary(input: WriteInput): ReferenceSummary["kept"] {
	const kept = (input.assets ?? []).filter((asset) => asset.keptFrom !== undefined);
	return kept.length ? { revision: kept[0]?.keptFrom ?? 0, images: kept.length } : undefined;
}
/** One line of capture qualifications, or nothing when the saved revision needs none. */
export function coverageText(summary: ReferenceSummary, origin: ContentOrigin["kind"]): string | undefined {
	if (summary.state === "uninspected") return uninspectedText(summary, origin);
	const parts = [
		summary.retained
			? `${plural(summary.retained, "image")} retained${summary.kept ? ` (${summary.kept.images} kept from revision ${summary.kept.revision}: a text publication reads no image files, so an unchanged reference keeps that revision's image; publish a file to change an image)` : ""}`
			: "",
		summary.external ? plural(summary.external, "external image") : "",
		summary.unavailable ? unavailableText(summary) : "",
		summary.truncated || summary.omitted ? partialText(summary) : "",
	].filter(Boolean);
	return parts.length ? `References: ${parts.join("; ")}.` : undefined;
}
/** Response capture never inspects references, so its uninspected inventory is not a qualification. */
function uninspectedText(summary: ReferenceSummary, origin: ContentOrigin["kind"]): string | undefined {
	if (origin === "ordinary-response" || origin === "native-response") return undefined;
	return `References not inspected: ${summary.reason ? INSPECTION_TEXT[summary.reason] : "no inspection result was recorded"}.${origin === "file" ? " Local images are not retained." : ""}`;
}
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function unavailableText(summary: ReferenceSummary): string {
	const listed = summary.unavailableItems ?? [];
	return `${summary.unavailable} unavailable (${listed.map((item) => `${JSON.stringify(item.reference)}: ${item.reason}`).join(", ")}${summary.unavailable > listed.length ? ", …" : ""})`;
}
function partialText(summary: ReferenceSummary): string {
	return `inventory partial${summary.omitted ? `: ${plural(summary.omitted, "reference")} not listed` : ""}${summary.truncated ? "; the parser stopped at its destination limit" : ""}`;
}
function failure(error: unknown): PublishOutcome {
	if (error instanceof WritingRefusal)
		return {
			ok: false,
			error: { code: "checks", message: error.message, findings: error.findings, brief: error.brief },
		};
	if (error instanceof WritingConfigError)
		return { ok: false, error: { code: "invalid", message: error.message.slice(0, 300) } };
	if (!(error instanceof StoreError))
		return { ok: false, error: { code: "store-failure", message: "Private document store is unavailable." } };
	return {
		ok: false,
		error: {
			code: error.code,
			message: error.message.slice(0, 300),
			...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
			...(error.currentDigest === undefined ? {} : { currentDigest: error.currentDigest }),
		},
	};
}
async function normaliseInvocation(
	params: PublishInput,
	store: MarkdownStore,
	remembered?: PublicationPlan,
): Promise<PublishInput> {
	validateParameters(params);
	if (!params.document) return params;
	const identity = remembered?.documentId.startsWith(params.document) ? remembered.documentId : params.document;
	const stored = await store.get(identity);
	if (stored.document.kind !== "published")
		throw new StoreError("invalid", "Only published documents accept explicit updates.");
	return { ...params, document: stored.document.id };
}
type StoredTarget = { document: string; revision: number; digest?: string; kind: "published" | "response" };
async function observe(
	query: PaneQuery | undefined,
	storeId: string | undefined,
	target: StoredTarget,
): Promise<PaneState> {
	let inventory: PaneInventory | undefined;
	try {
		inventory = await query?.();
	} catch {
		return { status: "unknown" };
	}
	return classifyPanes(inventory, storeId, target);
}
function classifyPanes(
	inventory: PaneInventory | undefined,
	storeId: string | undefined,
	target: StoredTarget,
): PaneState {
	if (!inventory) return { status: "unknown" };
	const showing = inventory.panes
		.filter(
			({ view }) =>
				storeId !== undefined &&
				view.storeId === storeId &&
				view.kind === target.kind &&
				view.documentId === target.document &&
				view.revision === target.revision &&
				(!view.digest || !target.digest || view.digest === target.digest) &&
				!view.dirty &&
				!view.conflict,
		)
		.map(({ handle }) => handle);
	return { status: "observed", inventory, showing };
}
function editor(state: PaneState, storeId: string | undefined, document: string) {
	return state.status === "observed"
		? state.inventory.panes.find(
				({ view }) =>
					view.documentId === document &&
					(!view.storeId || !storeId || view.storeId === storeId) &&
					(view.kind === "loading" || (view.kind === "published" && (view.dirty || view.conflict))),
			)
		: undefined;
}
async function save(params: PublishInput, input: WriteInput, options: PublishOptions): Promise<PublishOutcome> {
	const { store, plan, observePanes } = options;
	const { document, expectedRevision, reuseKey } = params;
	if (!document) return publicationOutcome(await store.create(input, { plan, reuseKey }));
	const storeId = (await store.identity())?.storeId;
	const target = { document, revision: expectedRevision ?? 0, kind: "published" } as const;
	const paneState = await observe(observePanes, storeId, target);
	if (observePanes && paneState.status === "unknown")
		return {
			ok: false,
			error: {
				code: "live-state-unavailable",
				message: "Pane state is unavailable. List the panes in this conversation before a stored update.",
				paneState,
				next: { op: "list" },
			},
		};
	const active = editor(paneState, storeId, document);
	if (active) {
		const current = await store.get(document);
		if (current.revision.revision !== target.revision && paneState.status === "observed") {
			const state = classifyPanes(paneState.inventory, storeId, {
				...target,
				revision: current.revision.revision,
				digest: current.revision.digest,
			});
			return stalePublication(input, current, state, active.handle);
		}
		return {
			ok: false,
			error: {
				code: "live-editor",
				message: `Pane ${active.handle} ${active.view.kind === "loading" ? "has not confirmed its state" : "reports unsaved changes or a conflict"} for ${document}. No stored update was made.`,
				currentRevision: current.revision.revision,
				currentDigest: current.revision.digest,
				paneState,
				next: { op: "read", handle: active.handle },
			},
		};
	}
	try {
		return publicationOutcome(
			await store.update(document, target.revision, input, { plan, reuseKey, expectedStoreId: storeId }),
			keptSummary(input),
		);
	} catch (error) {
		if (!(error instanceof StoreError) || error.code !== "conflict" || error.currentRevision === undefined) throw error;
		const current = await store.get(document);
		const state = await observe(observePanes, storeId, {
			...target,
			revision: current.revision.revision,
			digest: current.revision.digest,
		});
		return stalePublication(input, current, state, editor(state, storeId, document)?.handle, !!observePanes);
	}
}
function stalePublication(
	input: WriteInput,
	current: StoredDocument,
	paneState: PaneState,
	handle?: string,
	observed = true,
): PublishOutcome {
	const { revision } = current;
	return {
		ok: false,
		error: {
			code: "conflict",
			message: "Expected revision is stale. No stored update was made.",
			currentRevision: revision.revision,
			currentDigest: revision.digest,
			paneState,
			...(current.source === input.source
				? {
						currentFromEditor: revision.contentOrigin.kind === "editor",
						currentMatches:
							revision.title === input.title && isDeepStrictEqual(revision.references, input.references)
								? "source-title-references"
								: "source",
					}
				: {}),
			...(handle
				? { next: { op: "read", handle } as const }
				: observed && paneState.status === "unknown"
					? { next: { op: "list" } as const }
					: { next: { document: revision.document, revision: revision.revision } }),
		},
	};
}
async function savedPlan(store: MarkdownStore, plan: PublicationPlan): Promise<WriteResult | undefined> {
	try {
		const found = await store.get(plan.documentId, plan.revision);
		if (found.revision.publication === plan.publicationId)
			return { ...found, created: plan.revision === 1, replayed: true };
	} catch (error) {
		if (!(error instanceof StoreError) || error.code !== "not-found") throw error;
	}
	return undefined;
}
async function previousPlan(params: PublishInput, options: PublishOptions): Promise<PublicationPlan | undefined> {
	const inputDigest = invocationDigest(params, options.cwd);
	if (options.plan && options.plan.inputDigest !== inputDigest)
		throw new StoreError("replay-conflict", "Request identity already names different input.");
	return params.reuseKey === undefined
		? options.plan
		: ((await options.store.reusePlan(params.reuseKey, inputDigest)) ?? options.plan);
}
function withFindings(outcome: PublishOutcome, findings: Finding[], writing?: WritingOptions): PublishOutcome {
	return outcome.ok && !outcome.replayed && writing?.mode === "warn" ? { ...outcome, checks: { findings } } : outcome;
}
export async function publish(params: PublishInput, options: PublishOptions): Promise<PublishOutcome> {
	return withPanes(await publication(params, options), options);
}
async function publication(params: PublishInput, options: PublishOptions): Promise<PublishOutcome> {
	try {
		if (params?.response !== undefined) return await snapshotPrevious(params, options);
		params = await normaliseInvocation(params, options.store);
		const plan = await previousPlan(params, options);
		const saved = plan ? await savedPlan(options.store, plan) : undefined;
		if (saved) return publicationOutcome(saved);
		const { input, findings } = await preparePublication(params, options);
		return withFindings(await save(params, input, { ...options, plan }), findings, options.writing);
	} catch (error) {
		return failure(error);
	}
}
/**
 * A receipt names the saved identity and revision, material capture qualifications and the next
 * action; the tool description holds the stable guidance. Failures add the recovery step.
 */
export function publicationText(outcome: PublishOutcome): string {
	if (!outcome.ok) return failureText(outcome.error);
	const coverage = coverageText(outcome.references, outcome.provenance.kind);
	return [
		savedText(outcome),
		...(coverage ? [coverage] : []),
		...(outcome.checks?.findings.length
			? ["The document has these writing problems:", ...describeFindings(outcome.checks.findings, false)]
			: []),
		nextText(outcome),
	].join("\n");
}
function savedText(outcome: Extract<PublishOutcome, { ok: true }>): string {
	const identity = `${outcome.documentId} revision ${outcome.revision} (${outcome.bytes} bytes, ${outcome.digest})`;
	if (outcome.kind === "response")
		return outcome.replayed
			? `This response is already saved as ${identity}. No window opened.`
			: `Saved the response as ${identity}. No window opened.`;
	if (outcome.replayed)
		return `Returned the earlier publication ${identity}: this request was already saved, so later changes to its text, file or images are not in it. No window opened.`;
	return `Saved ${outcome.created ? "new document " : ""}${identity}. No window opened.`;
}
function paneText(state: PaneState): string {
	if (state.status === "unknown") return "Reader pane state is unknown for this conversation.";
	const observedRevision = (view: PaneInventory["panes"][number]["view"]) => {
		if (view.revision === undefined) return "";
		return ` ${view.dirty || view.conflict ? "base revision" : "revision"} ${view.revision}`;
	};
	const rows = state.inventory.panes.map(({ handle, view }) => {
		const target = view.documentId ?? view.kind;
		const revision = observedRevision(view);
		const follow =
			view.follows === undefined ? "follow policy unknown" : view.follows ? "follow latest on" : "follow latest off";
		const store = view.storeId ? `, store ${view.storeId}` : "";
		return `Pane ${handle} last reported ${JSON.stringify(view.title)} (${target}${revision}, ${view.mode}${view.dirty ? ", unsaved" : ""}${view.conflict ? ", conflict" : ""}, ${follow}${store}).${state.showing.includes(handle) ? " It reported the saved revision." : " It did not confirm the saved revision."}`;
	});
	const pending = state.inventory.pending.map(
		(item) =>
			`Launch ${item.launchId} (${item.documentId ?? "target unknown"}): ${item.status}. No connected pane confirmed by this launch.`,
	);
	return [...(rows.length ? rows : ["No connected reader pane was observed in this conversation."]), ...pending].join(
		"\n",
	);
}
function showText(shown: ShowResult): string {
	switch (shown.status) {
		case "navigated": {
			const revision = shown.view.revision === undefined ? "" : ` revision ${shown.view.revision}`;
			return `Shown: pane ${shown.handle} confirmed ${shown.view.documentId ?? shown.view.kind}${revision}.`;
		}
		case "launch":
			return `Show: no agent pane is connected, so launch ${shown.launchId} is reserved. ${shown.message} argv: ${JSON.stringify(shown.argv)}`;
		case "pending":
			return `Show not run: ${shown.message}`;
		default:
			return `Show did not complete (${shown.status}): ${shown.message} The document is saved; do not publish it again to show it.`;
	}
}
function nextText(outcome: Extract<PublishOutcome, { ok: true }>): string {
	if (outcome.shown) return showText(outcome.shown);
	return [
		paneText(outcome.paneState),
		...(outcome.paneState.status === "observed" && outcome.paneState.showing.length
			? []
			: [`Not shown. To show this saved revision, call markdown_live with ${JSON.stringify(outcome.show)}.`]),
	].join("\n");
}
type PublishError = Extract<PublishOutcome, { ok: false }>["error"];
function currentText(error: PublishError): string {
	if (error.currentRevision === undefined) return "";
	const revision = ` Revision ${error.currentRevision} (${error.currentDigest ?? "digest unknown"}) is current.`;
	if (!error.currentMatches) return revision;
	const origin = error.currentFromEditor ? " from the editor" : "";
	const match =
		error.currentMatches === "source-title-references"
			? "the requested source, title and reference inventory"
			: "the requested source; its title or reference inventory differs";
	return `${revision} The stored revision${origin} already contains ${match}.`;
}
function failureText(error: PublishError): string {
	if (error.code === "checks" && error.findings)
		return [
			error.message,
			...describeFindings(error.findings, true),
			...(error.brief ? ["", formatBrief(error.brief)] : []),
			"Fix the passages and publish again.",
		].join("\n");
	const text = `Markdown publication failed (${error.code}): ${error.message}`;
	const current = currentText(error);
	if (error.next && "op" in error.next) {
		const state = error.paneState ? `\n${paneText(error.paneState)}` : "";
		const advice =
			error.next.op === "read"
				? "Keep the live draft. Use markdown_live to edit it. For a stored update, first let the editor save or resolve its conflict. Read the resulting revision before you compose the update. Never publish a page of the live buffer as the whole document."
				: "Check the pane state before changing the document. Do not retry the old replacement.";
		return `${text}${current}${state}\nUse markdown_live with ${JSON.stringify(error.next)}. ${advice}`;
	}
	if (error.currentMatches === "source-title-references") return `${text}${current} No duplicate revision is needed.`;
	if (error.code === "conflict" && error.currentRevision !== undefined)
		return `${text}${current} Read it with markdown_read (this document, revision ${error.currentRevision}), apply your change to that text, and publish again with expectedRevision ${error.currentRevision}. Text based on an older revision would undo its changes.`;
	if (error.code === "replay-conflict")
		return `${text} This reuseKey already names other input; use a new reuseKey for new input.`;
	return text;
}
async function withPanes(
	outcome: PublishOutcome,
	{ store, observePanes }: Pick<PublishOptions, "store" | "observePanes">,
): Promise<PublishOutcome> {
	if (!outcome.ok || !observePanes) return outcome;
	const storeId = (await store.identity().catch(() => undefined))?.storeId;
	return {
		...outcome,
		paneState: await observe(observePanes, storeId, {
			document: outcome.documentId,
			revision: outcome.revision,
			digest: outcome.digest,
			kind: outcome.kind,
		}),
	};
}
/**
 * A requested show runs after the save unless a pane already reported the saved revision. A show
 * failure leaves the publication intact and reports the failure beside its receipt.
 */
async function withShow(
	outcome: PublishOutcome,
	requested: boolean | undefined,
	run: ((request: ShowInput) => Promise<ShowResult>) | undefined,
): Promise<PublishOutcome> {
	if (requested !== true || !outcome.ok) return outcome;
	if (outcome.paneState.status === "observed" && outcome.paneState.showing.length) return outcome;
	const { op: _op, ...request } = outcome.show;
	const shown: ShowResult = run
		? await run(request).catch((error: unknown) => ({
				status: "error" as const,
				message: `The show failed: ${error instanceof Error ? error.message : String(error)} List panes before another show.`,
			}))
		: { status: "error", message: "This host has no live show route." };
	return { ...outcome, shown };
}
export function createPublishTool(
	options: Omit<PublishOptions, "cwd" | "observePanes"> & {
		/** Shows the saved document for a request with show: true. */
		show?: LocalShow;
		cwd?: string;
		panes?: (context: ExtensionContext) => Promise<PaneInventory | undefined>;
		pane?: AgentPane;
		/** The conversation receives a notice when a connected reader pane closes. */
		paneNotices?: boolean;
		/** Reports a stored document that this session published; see docs/conventions/work-references.md. */
		workReference?: (sessionId: string, document: { id: string; title: string }) => void;
	},
): ToolDefinition<typeof PublishParameters, PublishOutcome> {
	const presentation = toolDisplay().tools.find((tool) => tool.name === "markdown_publish");
	const pane = options.pane ?? settings.fields.agentPane.default;
	const writing = options.writing ?? { mode: settings.fields.checks.default };
	return {
		...presentation,
		name: "markdown_publish",
		label: "Markdown Publish",
		description: publishDescription(pane, options.paneNotices),
		promptSnippet: "Save an exact Markdown document silently and report the stored revision and observed pane state.",
		promptGuidelines: [publishGuideline(pane)],
		parameters: PublishParameters,
		outputSchema: PublishOutcomeSchema,
		async execute(_id, params, signal, _update, context) {
			const { panes, show } = options;
			const session = context.sessionManager.getSessionId();
			const observePanes = panes
				? async () => {
						if (context.sessionManager.getSessionId() !== session) return undefined;
						const inventory = await panes(context);
						return context.sessionManager.getSessionId() === session ? inventory : undefined;
					}
				: undefined;
			const outcome = await publish(params as PublishInput, {
				...options,
				observePanes,
				writing,
				brief: makeBrief(writing, () => ordinaryBriefMessages(context.sessionManager)),
				cwd: context.cwd,
				provenance: {
					...options.provenance,
					session,
					...(context.model ? { model: `${context.model.provider}/${context.model.id}` } : {}),
				},
				previousResponse: async () => previousOrdinary(context.sessionManager),
			}).then((saved) =>
				withShow(saved, (params as PublishInput).show, show && ((request) => show(context, request, signal))),
			);
			if (outcome.ok) options.workReference?.(session, { id: outcome.documentId, title: outcome.title });
			return {
				content: [{ type: "text", text: publicationText(outcome) }],
				details: outcome,
				structuredContent: outcome,
				isError: !outcome.ok,
			};
		},
	};
}
type NativeHost = {
	durable: typeof Durable;
	cwd: string;
	storageId?: string;
	harness?: Pick<Durable.Harness, "conversation">;
};
export function createNativePublishTool(
	host: NativeHost,
	options: Omit<PublishOptions, "cwd" | "plan" | "observePanes"> & {
		panes?: (conversation: Durable.ConversationId) => Promise<PaneInventory | undefined>;
		/** Shows the saved document for a request with show: true, once per task. */
		show?: NativeShow;
	},
): Durable.ToolRegistration<typeof PublishParameters, Durable.JsonObject> {
	return host.durable.defineTool({
		name: "markdown_publish",
		description: describePublication(NATIVE_PUBLISH_GUIDANCE, false),
		parameters: PublishParameters,
		structuredOutputSchema: PublishOutcomeSchema,
		replay: "safe",
		async execute(params, api, context) {
			try {
				const { panes } = options;
				const local = { ...options, observePanes: panes ? () => panes(api.conversationId) : undefined };
				const outcome =
					params?.response !== undefined
						? await snapshotPrevious(params, {
								...options,
								cwd: api.env?.cwd ?? host.cwd,
								previousResponse: () => nativePrevious(host, api, context),
							})
						: await nativePublication(params, api, context, host, local);
				const { show } = options;
				return nativeResult(
					await withShow(
						await withPanes(outcome, local),
						params?.show,
						show && ((request) => show(api, context, request)),
					),
				);
			} catch (error) {
				return nativeResult(failure(error));
			}
		},
	});
}
/** A native publication memoises its random plan in the tool task before the document write. */
async function nativePublication(
	params: PublishInput,
	api: Durable.ToolExecutionApi,
	context: Context,
	host: NativeHost,
	options: Omit<PublishOptions, "cwd" | "plan">,
): Promise<PublishOutcome> {
	const remembered = await api.memo<PublicationPlan>("markdown.publication", context);
	params = await normaliseInvocation(params, options.store, remembered);
	const cwd = api.env?.cwd ?? host.cwd;
	const previous = await previousPlan(params, { ...options, cwd, plan: remembered });
	if (previous) await api.memo("markdown.publication", previous, context);
	const saved = previous ? await savedPlan(options.store, previous) : undefined;
	if (saved) return publicationOutcome(saved);
	const agent = await api.agent(context);
	const writing = options.writing ?? { mode: settings.fields.checks.default };
	const local = {
		...options,
		writing,
		brief: nativeBrief(host, writing, api.conversationId, context),
		cwd,
		provenance: {
			...options.provenance,
			session: host.storageId,
			conversation: String(api.conversationId),
			...(agent.model ? { model: `${agent.model.provider}/${agent.model.modelId}` } : {}),
		},
	};
	const { input, findings } = await preparePublication(params, local);
	const candidate = await options.store.preparePlan(input, {
		document: params.document,
		expectedRevision: params.expectedRevision,
		reuseKey: params.reuseKey,
	});
	const plan = await api.memo("markdown.publication", previous ?? candidate, context);
	return withFindings(await save(params, input, { ...local, plan }), findings, writing);
}
function nativeResult(outcome: PublishOutcome) {
	return {
		output: [{ type: "text" as const, text: publicationText(outcome) }],
		structuredOutput: outcome,
		details: outcome,
		isError: !outcome.ok,
	};
}
/** The earlier answer in the calling native conversation. */
async function nativePrevious(
	host: NativeHost,
	api: Pick<Durable.ToolExecutionApi, "conversationId" | "env">,
	context: Context,
): Promise<ResponseSnapshot> {
	const conversation = await host.harness?.conversation(api.conversationId, context);
	if (!conversation) throw new Error("The calling conversation is not readable.");
	return previousNative(
		{ conversation, durable: host.durable, storageId: host.storageId ?? "", cwd: api.env?.cwd ?? host.cwd },
		context,
	);
}
