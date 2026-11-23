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
	"Brief an agent with a standard task brief. The fields render into one brief with fixed sections: objective, purpose, quoted operator decisions, context, sources, permitted acts, restrictions, checks, end condition and result. Without sessionId it creates an agent as agent_spawn does; with sessionId it admits the brief to an existing agent as new work, or as a steer. It checks named source paths relative to the recipient's cwd and refuses missing paths. preview renders and checks the brief without sending it. Result references and placement match agent_spawn and agent_send.";

const items = (description: string) => opt(arr(str(), { description }));

export function briefParameters<const P extends Properties, C extends Properties[string]>(
	creation: P,
	checkInMinutes: C,
) {
	return obj({
		kind: opt(
			briefEnum(
				BRIEF_KINDS,
				"Brief kind. task: a bounded contribution. lead: ownership of a composed outcome, with freedom to divide the work. review: an independent judgment of a claim, change or artifact. partner: a shared inquiry with room to challenge the approach. handoff: continuation of existing work.",
			),
		),
		objective: str({ description: "The outcome to deliver, stated as an observable end state." }),
		purpose: opt(str({ description: "Why the work matters and which decision or larger goal the result feeds." })),
		operator: opt(
			arr(
				obj({
					quote: str({ description: "The operator's exact words." }),
					source: str({ description: "Where and when the operator gave them (session, date, thread or file)." }),
					scope: opt(str({ description: "What the decision covers, when that is narrower than the whole task." })),
				}),
				{
					description:
						"Operator decisions you carry, each quoted verbatim with its source and scope. Your own proposals and interpretations do not belong here.",
				},
			),
		),
		context: items("Verified facts the agent needs, each with its source. Say which facts the agent must check again."),
		sources: items(
			"Files, URLs, commits or threads to read first, each followed by what it establishes. Start an entry with its path to have the path checked.",
		),
		permitted: items("Edits and acts the task authorises: paths, branches, commits."),
		restrictions: items("What the agent must not touch or do, and decisions reserved to others."),
		checks: items("Commands or observations that establish the result, with time limits."),
		endCondition: str({
			description: "The observable state at which the agent stops and reports, including the form of a blocker report.",
		}),
		result: str({ description: "What the final message contains: form, sections and length." }),
		sessionId: opt(
			str({
				minLength: 1,
				description:
					"Existing agent identity or @handle that receives the brief. Omit it to create an agent with the creation fields.",
			}),
		),
		mode: opt(
			briefEnum(
				["followUp", "steer"],
				"With sessionId only. followUp (default): new work. steer: the brief replaces the agent's current work at its next tool boundary.",
			),
		),
		...creation,
		checkInMinutes,
		preview: opt(
			bool({ description: "Render and check the brief without sending it; return the text and every problem found." }),
		),
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
