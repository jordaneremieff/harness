import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { hostname } from "node:os";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { arr, obj, str, opt, int, num, bool, lit, union, type Static } from "@earendil-works/pi-schema";
import { toolDisplay } from "./display.ts";
import type { Context } from "@earendil-works/chord/context";
import { previousNative } from "./native-responses.ts";
import { hasPaneRevision, paneCommand } from "./pane-command.ts";
import { withLiveShow } from "./live-launch.ts";
import type { LiveConfig } from "./live-protocol.ts";
import { previousOrdinary, responseSnapshotWrite, type ResponseSnapshot } from "./responses.ts";
import { settings, type AgentPane } from "./settings.ts";
import {
	digest,
	INSPECTION_FAILURES,
	LIMITS,
	type MarkdownStore,
	StoreError,
	validateInput,
	type AssetRecord,
	type ContentOrigin,
	type ErrorCode,
	type InspectionFailure,
	type PublicationPlan,
	type ReferenceInventory,
	type StoredDocument,
	type WriteInput,
	type WriteResult,
} from "./store.ts";

import { checkWriting, describeFindings, type Finding } from "./checks.ts";
import { RULE_IDS, describeRules } from "./check-rules.ts";
import { buildBrief, formatBrief, type WritingBrief } from "./brief.ts";
import {
	BRIEF_GUIDANCE,
	makeBrief,
	nativeBrief,
	ordinaryBriefMessages,
	WritingBriefSchema,
	type BriefBuilder,
} from "./brief-tool.ts";
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
			show?: string[];
			paneInput?: string;
			showUnavailable?: string;
			panes?: number;
			checks?: { findings: Finding[] };
	  }
	| {
			ok: false;
			error: {
				code: ErrorCode | "checks";
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
		show: opt(arr(str())),
		paneInput: opt(str()),
		showUnavailable: opt(str()),
		panes: opt(int()),
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
				].map((code) => lit(code)),
			),
			message: str(),
			currentRevision: opt(int()),
			currentDigest: opt(str()),
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
	"For a question from a live Markdown Ask card, give the substantive answer in your final message. The existing card shows that text; do not publish or open another pane just to answer it.";
const READER_MATERIAL =
	"a reply with headings, a table, three or more explained points, or more than about ten lines; or a document, comparison, or diagram";
const REPORT =
	"Give the coordinating session a complete report. If you publish a document, include its ID and title so the coordinator can show it without copying it.";
const PLACEMENT: Record<AgentPane, string> = {
	split: "a split on the right of your pane",
	float: "a floating pane that stays in place",
};
const USE_PANE =
	"Use the exact show command as the program of the new pane, with no target, and close the pane when its program ends. Respect the operator's requested placement. Do not take focus unless the operator asked to see it now.";
export const NATIVE_PUBLISH_GUIDANCE = `Publish silently when a document helps the recipient. ${REPORT} Do not open or navigate a reader pane unless the operator explicitly asks you to show the material. For that request, reuse the reader pane you already opened. If you need a new pane, use a split on the right of the inherited pane. ${USE_PANE} ${BRIEF_GUIDANCE} ${ASK_REPLY}`;
export const publishGuideline = (pane: AgentPane): string =>
	`If you work for another agent or run without an interactive conversation, publish silently and do not open or navigate a reader pane unless the operator explicitly asks you to show the material. ${REPORT} In the interactive session with the operator, show material that is hard to read in a terminal without waiting to be asked: ${READER_MATERIAL}. Choose which findings from other agents to show. Publish your synthesis or use markdown_read with the reported document ID. Reuse your reader pane across reports. For a new pane, use ${PLACEMENT[pane]}. ${USE_PANE} Say what the pane holds and give the answer and any needed decision in chat. A plain answer of a few sentences stays in chat. ${BRIEF_GUIDANCE} ${ASK_REPLY}`;
/**
 * How an agent learns that the operator closed a reader pane. Ordinary conversations also receive
 * a notice when a pane closes; native conversations learn it from the update result only.
 */
const PANE_CLOSURE = {
	notice:
		"The operator can close a reader pane at any time. When a reader pane connected to this conversation closes, a notice in the conversation says so and how many panes remain connected; the result of an update gives the same count. With no pane connected, nothing that you save reaches the operator by itself: show the document in a new pane if the operator should read it now, or answer in chat and say that it is saved, and never tell the operator that a pane shows it.",
	result:
		"The operator can close a reader pane at any time. The result of an update says how many reader panes are still connected to this conversation; when none is, no pane of yours shows the update, so do not tell the operator that a pane shows it.",
};
const describePublication = (guidance: string, paneNotices: boolean) =>
	`Save an exact Markdown document silently for the native reader. Supply a title and exactly one of text or an explicit local file. Updates require document and expectedRevision. No window opens. Configured writing checks return findings and can refuse new source; repair the sentence rather than swapping forms. ${guidance} Use markdown_live to change a connected pane's actual buffer; reserve document/expectedRevision updates for stored publications rather than live collaboration. ${PANE_CLOSURE[paneNotices ? "notice" : "result"]} When the result offers paneInput, use it to show the current revision in a reader pane that you opened instead of opening another pane. The pane keeps its place and saves the earlier document's reading position. Use a pinned show command in a new pane for an exact replay revision. Type into or close only reader panes that you opened yourself, never the operator's or another session's panes. To show a stored document again later, run the same command with that document's ID: the reader returns to the saved reading position. To show an earlier answer exactly, use response "previous" instead of retyping it. To explain something visually, write an SVG or PNG diagram beside a Markdown file, reference it with a relative image link, and publish the file: the revision keeps the image. Before you update a document whose current text you do not hold, read it with markdown_read; after a conflict, read the current revision that the conflict names. The operator can also open a published document from the Markdown view under Published, or with the result's open command in an ordinary Pi session.`;
export const publishDescription = (pane: AgentPane, paneNotices = false): string =>
	describePublication(publishGuideline(pane), paneNotices);
export { captureReferences, inspectReferences } from "./reference-capture.ts";
export type {
	ReferenceRunner,
	InspectionOptions,
	ReferenceInspection,
	InspectionResult,
	KeptImages,
} from "./reference-capture.ts";
import {
	boundedFile,
	captureReferences,
	inspectReferences,
	type InspectionOptions,
	type KeptImages,
} from "./reference-capture.ts";
export type PublishOptions = InspectionOptions & {
	store: MarkdownStore;
	cwd: string;
	provenance?: Partial<ContentOrigin>;
	plan?: PublicationPlan;
	previousResponse?: () => Promise<ResponseSnapshot>;
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
		throw new StoreError("file-unreadable", "Source file is unavailable, nonregular or not UTF-8.");
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
	return publicationOutcome(
		await options.store.snapshot(sourceKey, "response", input),
		options.store.root,
		options.app,
	);
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
export function publicationOutcome(
	result: WriteResult,
	root: string,
	app: string | undefined,
	kept?: ReferenceSummary["kept"],
): PublishOutcome {
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
		...paneCommand(app, root, revision.document, result.replayed ? revision : undefined),
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
async function save(params: PublishInput, input: WriteInput, options: PublishOptions): Promise<PublishOutcome> {
	if (params.document)
		return publicationOutcome(
			await options.store.update(params.document, params.expectedRevision ?? 0, input, {
				plan: options.plan,
				reuseKey: params.reuseKey,
			}),
			options.store.root,
			options.app,
			keptSummary(input),
		);
	return publicationOutcome(
		await options.store.create(input, { plan: options.plan, reuseKey: params.reuseKey }),
		options.store.root,
		options.app,
	);
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
	try {
		if (params?.response !== undefined) return await snapshotPrevious(params, options);
		params = await normaliseInvocation(params, options.store);
		const plan = await previousPlan(params, options);
		const saved = plan ? await savedPlan(options.store, plan) : undefined;
		if (saved) return publicationOutcome(saved, options.store.root, options.app);
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
function nextText(outcome: Extract<PublishOutcome, { ok: true }>): string {
	if (!outcome.show)
		return `It cannot be shown in a pane: ${outcome.showUnavailable ?? "no reader command is available."}`;
	const command = JSON.stringify(outcome.show);
	const input =
		outcome.paneInput && outcome.panes !== 0
			? `type ${JSON.stringify(outcome.paneInput.trimEnd())} and Enter into a reader pane that you opened, or `
			: "";
	if (outcome.replayed) {
		if (hasPaneRevision(outcome.show))
			return `To show revision ${outcome.revision}, run ${command} as the program of a new pane.`;
		return `Current revision only: this reader build cannot pin revision ${outcome.revision}. To show the current revision, ${input}run ${command} as the program of a new pane.`;
	}
	if (outcome.kind !== "published" || outcome.revision < 2)
		return `To show it now, ${input}run ${command} as the program of a new pane.`;
	if (outcome.panes === 0)
		return `No reader pane is connected to this conversation now; the operator may have closed it. No pane of yours shows this revision. To show it now, run ${command} as the program of a new pane.`;
	const open =
		outcome.panes === undefined
			? ""
			: `${outcome.panes} reader ${outcome.panes === 1 ? "pane is" : "panes are"} connected to this conversation. `;
	return `${open}A reader pane that still shows ${outcome.documentId} follows this revision by itself; the operator can close a pane at any time. To show it elsewhere, ${input}run ${command} as the program of a new pane.`;
}
function failureText(error: Extract<PublishOutcome, { ok: false }>["error"]): string {
	if (error.code === "checks" && error.findings)
		return [
			error.message,
			...describeFindings(error.findings, true),
			...(error.brief ? ["", formatBrief(error.brief)] : []),
			"Fix the passages and publish again.",
		].join("\n");
	const text = `Markdown publication failed (${error.code}): ${error.message}`;
	if (error.code === "conflict" && error.currentRevision !== undefined)
		return `${text} Revision ${error.currentRevision} (${error.currentDigest ?? "digest unknown"}) is current. Read it with markdown_read (this document, revision ${error.currentRevision}), apply your change to that text, and publish again with expectedRevision ${error.currentRevision}. Text based on an older revision would undo its changes.`;
	if (error.code === "replay-conflict")
		return `${text} This reuseKey already names other input; use a new reuseKey for new input.`;
	return text;
}
/**
 * Counts the reader panes connected to this conversation, when the show command carries the live
 * connection through which a pane reports itself. A pane leaves the count when it closes.
 */
export async function withPanes(
	outcome: PublishOutcome,
	panes?: () => Promise<number | undefined>,
): Promise<PublishOutcome> {
	if (!outcome.ok || !panes || !outcome.show?.includes("--live")) return outcome;
	const count = await panes().catch(() => undefined);
	return count === undefined ? outcome : { ...outcome, panes: count };
}
export function createPublishTool(
	options: Omit<PublishOptions, "cwd"> & {
		cwd?: string;
		connection?: (context: ExtensionContext) => Promise<LiveConfig>;
		panes?: (context: ExtensionContext) => Promise<number | undefined>;
		pane?: AgentPane;
		/** The conversation receives a notice when a connected reader pane closes. */
		paneNotices?: boolean;
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
		promptSnippet:
			"Save an exact Markdown document for the native reader; its show command puts the reader over a terminal pane.",
		promptGuidelines: [publishGuideline(pane)],
		parameters: PublishParameters,
		outputSchema: PublishOutcomeSchema,
		async execute(_id, params, _signal, _update, context) {
			let outcome = await publish(params as PublishInput, {
				...options,
				writing,
				brief: makeBrief(writing, () => ordinaryBriefMessages(context.sessionManager)),
				cwd: context.cwd,
				provenance: {
					...options.provenance,
					session: context.sessionManager.getSessionId(),
					...(context.model ? { model: `${context.model.provider}/${context.model.id}` } : {}),
				},
				previousResponse: async () => previousOrdinary(context.sessionManager),
			});
			const { connection, panes } = options;
			if (outcome.ok)
				outcome = await withLiveShow(outcome, options.app, connection ? () => connection(context) : undefined, _signal);
			outcome = await withPanes(outcome, panes ? () => panes(context) : undefined);
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
	options: Omit<PublishOptions, "cwd" | "plan"> & {
		connection?: (conversation: Durable.ConversationId, context: Context) => Promise<LiveConfig>;
		panes?: (conversation: Durable.ConversationId) => Promise<number | undefined>;
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
				let outcome =
					params?.response !== undefined
						? await snapshotPrevious(params, {
								...options,
								cwd: api.env?.cwd ?? host.cwd,
								previousResponse: () => nativePrevious(host, api, context),
							})
						: await nativePublication(params, api, context, host, options);
				const { connection, panes } = options;
				if (outcome.ok)
					outcome = await withLiveShow(
						outcome,
						options.app,
						connection ? () => connection(api.conversationId, context) : undefined,
						context.abortSignal,
					);
				outcome = await withPanes(outcome, panes ? () => panes(api.conversationId) : undefined);
				return nativeResult(outcome);
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
	if (saved) return publicationOutcome(saved, options.store.root, options.app);
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
