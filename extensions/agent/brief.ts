import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { arr, bool, obj, opt, str, type Properties, type Schema } from "@earendil-works/pi-schema";
import type { AgentCatalog } from "./catalog.ts";
import { assertHandleCwd, canonicalAgentCwd } from "./identity.ts";

export const briefEnum = <const T extends readonly string[]>(values: T, description?: string): Schema<T[number]> => ({
	type: "string",
	enum: [...values],
	...(description === undefined ? {} : { description }),
});

const KIND_SENTENCES = {
	task: "",
	lead: "You lead this outcome. Do the work yourself, divide it, or use helpers selectively. Keep the exact result reference of each delegated part and let results arrive as events. Return one answer that covers the whole result and names any gap.",
	review:
		"This is an independent review. Test the claim, its omitted cases and its evidence against the defining sources, not against the author's conclusion; repeating the author's commands alone is not independent review. Give each finding a disposition and its evidence.",
	partner:
		"This is a shared inquiry. Challenge the framing and the approach where the evidence supports it, and propose a better route or a changed division of work when you find one.",
	handoff:
		"This hands over existing work. Continue from the state below, keep its open references, and do not repeat finished steps.",
} as const;

type BriefKind = keyof typeof KIND_SENTENCES;
export const BRIEF_KINDS = Object.keys(KIND_SENTENCES) as BriefKind[];
export const BRIEF_SECTIONS = [
	"objective",
	"purpose",
	"operator",
	"context",
	"sources",
	"permitted",
	"restrictions",
	"checks",
	"endCondition",
	"result",
] as const;

const titles: Record<(typeof BRIEF_SECTIONS)[number], string> = {
	objective: "Objective",
	purpose: "Purpose",
	operator: "Operator decisions",
	context: "Context",
	sources: "Sources",
	permitted: "Permitted",
	restrictions: "Restrictions",
	checks: "Checks",
	endCondition: "End condition",
	result: "Result",
};

export const BRIEF_DESCRIPTION =
	"Assign a checked brief to a new or existing agent. Named paths must exist relative to the recipient's cwd. preview checks without dispatch. Creation, placement and result receipts match spawn or send.";

const items = (description: string) => opt(arr(str(), { description }));

export function briefParameters<const P extends Properties, C extends Properties[string]>(
	creation: P,
	checkInMinutes: C,
) {
	return obj({
		kind: opt(
			briefEnum(
				BRIEF_KINDS,
				"task: bounded contribution; lead: own and divide the outcome; review: independent judgment; partner: shared inquiry; handoff: continue existing work.",
			),
		),
		objective: str({ description: "Observable outcome." }),
		purpose: opt(str({ description: "Decision or goal the result serves." })),
		operator: opt(
			arr(
				obj({
					quote: str({ description: "The operator's exact words." }),
					source: str({ description: "Where and when the operator gave the decision." }),
					scope: opt(str({ description: "Limits of the decision." })),
				}),
				{
					description: "Only the operator's decisions, not your interpretations.",
				},
			),
		),
		context: items("Verified facts and sources; mark facts to recheck."),
		sources: items("Files, URLs, commits or threads and what each establishes. Lead with the path to check it."),
		permitted: items("Edits and acts the task authorises: paths, branches, commits."),
		restrictions: items("Prohibited acts and reserved decisions."),
		checks: items("Checks that establish the result and their time limits."),
		endCondition: str({
			description: "When to stop and report, including blockers.",
		}),
		result: str({ description: "What the final message contains: form, sections and length." }),
		sessionId: opt(
			str({
				minLength: 1,
				description: "Existing agent ID or @handle. Omit to create.",
			}),
		),
		mode: opt(
			briefEnum(
				["followUp", "steer"],
				"Existing agent only: followUp adds work (default); steer redirects it at the next tool boundary.",
			),
		),
		...creation,
		checkInMinutes,
		preview: opt(bool({ description: "Return the brief and any problems without dispatch." })),
	});
}

export function recordBriefInput(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const punctuate = (value: string): string => (/[.?!]$/u.test(value) ? value : `${value}.`);
const lines = (value: string): string[] => value.split(/\r\n|\n|\r/u);

export function renderBrief(input: Record<string, unknown>) {
	const kind = BRIEF_KINDS.find((kind) => kind === input.kind) ?? "task";
	const parts = [`# ${kind[0]?.toUpperCase()}${kind.slice(1)} brief`];
	if (KIND_SENTENCES[kind]) parts.push(KIND_SENTENCES[kind]);
	const sections: (typeof BRIEF_SECTIONS)[number][] = [];
	const counts: Partial<Record<(typeof BRIEF_SECTIONS)[number], number>> = {};
	for (const name of BRIEF_SECTIONS) {
		let body: string;
		if (name === "operator") {
			const decisions = list(input.operator).flatMap((item) => {
				const { quote, source, scope } = recordBriefInput(item);
				const words = text(quote);
				const citation = text(source);
				const boundary = text(scope);
				if (!words && !citation) return [];
				const metadata = `Source: ${punctuate(citation)}${boundary ? ` Scope: ${punctuate(boundary)}` : ""}`;
				return [
					`${lines(words)
						.map((line) => `> ${line}`)
						.join("\n")}\n${metadata}`,
				];
			});
			if (!decisions.length) continue;
			counts.operator = decisions.length;
			body = [
				"These are the operator's words, quoted with their source and scope. The rest of this brief is the requester's direction.",
				...decisions,
			].join("\n\n");
		} else if (name === "objective" || name === "purpose" || name === "endCondition" || name === "result") {
			body = text(input[name]);
		} else {
			const entries = list(input[name]).map(text).filter(Boolean);
			counts[name] = entries.length;
			body = entries.map((item) => `- ${lines(item).join("\n  ")}`).join("\n");
		}
		if (!body) continue;
		sections.push(name);
		parts.push(`## ${titles[name]}\n${body}`);
	}
	parts.push(
		"Make every other tool call first. Give the complete result in your last message, or in the agent_work complete report when you declared open work.",
	);
	const rendered = parts.join("\n\n");
	return { text: rendered, brief: { kind, characters: Array.from(rendered).length, sections }, counts };
}

export function briefInputProblems(input: Record<string, unknown>, creationKeys: readonly string[]): string[] {
	const problems: string[] = [];
	if (input.sessionId !== undefined) {
		const conflicts = creationKeys.filter((key) => input[key] !== undefined);
		if (conflicts.length) problems.push(`sessionId cannot be combined with creation fields: ${conflicts.join(", ")}.`);
	} else if (input.mode !== undefined) {
		problems.push("mode requires sessionId.");
	}
	for (const name of BRIEF_SECTIONS) {
		if (name === "objective" || name === "endCondition" || name === "result") {
			if (!text(input[name])) problems.push(`${name} must not be blank.`);
		} else if (name === "operator") {
			list(input.operator).forEach((item, index) => {
				for (const field of ["quote", "source"]) {
					if (!text(recordBriefInput(item)[field])) problems.push(`operator[${index}].${field} must not be blank.`);
				}
			});
		} else if (name !== "purpose") {
			list(input[name]).forEach((item, index) => {
				if (!text(item)) problems.push(`${name}[${index}] must not be blank.`);
			});
		}
	}
	return problems;
}

export function briefSourceToken(entry: string): string | undefined {
	const token = (entry.trim().split(/\s/u, 1)[0] ?? "")
		.replace(/^[`'"<(]+|[`'">).,;:]+$/gu, "")
		.replace(/#.*$/u, "")
		.replace(/:\d+(?::\d+)?$/u, "");
	if (token.includes(":") || /[*?[\]{}]/u.test(token)) return undefined;
	if (/^(?:\/|~\/|\.{1,2}\/)/u.test(token)) return token;
	const file = token.slice(token.lastIndexOf("/") + 1);
	const dot = file.lastIndexOf(".");
	const extension = file.slice(dot + 1);
	return dot > 0 && /^[a-z\d]{1,8}$/iu.test(extension) && /[a-z]/iu.test(extension) ? token : undefined;
}

function relativeSource(token: string): boolean {
	return !isAbsolute(token) && !token.startsWith("~/");
}

function briefNeedsTargetDirectory(input: Record<string, unknown>): boolean {
	return list(input.sources).some((entry) => {
		const token = briefSourceToken(text(entry));
		return token !== undefined && relativeSource(token);
	});
}

export function briefCreationDirectory(
	input: Record<string, unknown>,
	callerCwd: string,
	catalog?: AgentCatalog,
): string {
	const cwd = canonicalAgentCwd(callerCwd, typeof input.cwd === "string" ? input.cwd : undefined);
	if (typeof input.handle !== "string") return cwd;
	if (!catalog) throw new Error("Handle resolution requires the host catalog namespace");
	const retained = catalog.readHandle(input.handle);
	if (retained) assertHandleCwd(input.handle, cwd, retained.cwd);
	return cwd;
}

/**
 * A cwd that names the recipient's own directory changes nothing, so it is dropped and only a different
 * cwd refuses as a creation field. A blank cwd names no directory, and an unresolvable cwd or recipient
 * keeps the field for that refusal. Cancellation propagates.
 */
export async function withoutRecipientCwd<T extends Record<string, unknown>>(
	input: T,
	callerCwd: string,
	directory: () => string | Promise<string>,
	signal?: AbortSignal,
): Promise<T> {
	if (input.sessionId === undefined || typeof input.cwd !== "string" || input.cwd.trim() === "") return input;
	try {
		if (canonicalAgentCwd(callerCwd, input.cwd) !== canonicalAgentCwd(await directory())) return input;
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
		return input;
	}
	const { cwd: _cwd, ...rest } = input;
	return rest as T;
}

export async function briefTargetDirectory(sessionId: string, catalog?: AgentCatalog): Promise<string> {
	if (!catalog) throw new Error("Target directory lookup requires the host catalog namespace");
	try {
		return catalog.read(sessionId).cwd;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const { readPrimaryEndpointDescriptor } = await import("./primary-channel.ts");
		const primary = readPrimaryEndpointDescriptor(dirname(catalog.root), sessionId).info;
		if (primary) return primary.cwd;
		throw new Error(`No directory is retained for ${sessionId}`);
	}
}

const MISSING_SOURCE = "Source path does not exist:";

export function briefSourceProblems(input: Record<string, unknown>, cwd?: string): string[] {
	return list(input.sources).flatMap((entry) => {
		const token = briefSourceToken(text(entry));
		if (token === undefined || (cwd === undefined && relativeSource(token))) return [];
		const path = token.startsWith("~/") ? resolve(homedir(), token.slice(2)) : resolve(cwd ?? "/", token);
		return existsSync(path) ? [] : [`${MISSING_SOURCE} ${token} (resolved ${path})`];
	});
}

export async function checkBriefSources(
	input: Record<string, unknown>,
	directory: () => string | Promise<string>,
): Promise<string[]> {
	if (input.sessionId !== undefined && !briefNeedsTargetDirectory(input)) return briefSourceProblems(input);
	let cwd: string;
	try {
		cwd = await directory();
	} catch (error) {
		return [
			`Cannot resolve brief cwd: ${error instanceof Error ? error.message : String(error)}`,
			...briefSourceProblems(input),
		];
	}
	return briefSourceProblems(input, cwd);
}

export function briefRefusal(inputProblems: readonly string[], sourceProblems: readonly string[]): string {
	return [
		...inputProblems,
		...sourceProblems,
		...(sourceProblems.some((problem) => problem.startsWith(MISSING_SOURCE))
			? ["Correct each path, or move a path that does not exist yet from sources into context."]
			: []),
	].join("\n");
}

export interface BriefPreview {
	preview: true;
	brief: ReturnType<typeof renderBrief>["brief"] & { text: string };
	problems: string[];
}

export function briefPreview(rendered: ReturnType<typeof renderBrief>, problems: string[]): BriefPreview {
	return { preview: true, brief: { ...rendered.brief, text: rendered.text }, problems };
}

export function briefPreviewText(preview: BriefPreview): string {
	return [preview.brief.text, "\nNothing was sent.", ...preview.problems].join("\n");
}

export function briefCreationInput(input: Record<string, unknown>, creationKeys: readonly string[]) {
	return Object.fromEntries(creationKeys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}
