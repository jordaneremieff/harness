import { isDeepStrictEqual } from "node:util";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const REVIEW_KEYS = ["review_policy", "review_after", "review_flag", "last_review", "retirement"] as const;
export const MAX_REVIEW_BYTES = 4 * 1024;
export const MAX_HEADER_BYTES = 8 * 1024;
export type ReviewPolicy = "on-change" | "before-use";
export type Concern = { date: string; reason: string; sources: string };
export type ReviewRecord = { date: string; digest: string; sources: string };
export type Freshness = {
	evaluatedOn: string;
	verified: boolean | null;
	verifiedDate: string | null;
	policy: ReviewPolicy | "unclassified" | "unknown";
	reviewAfter: string | null;
	deadline: "due" | "not-due" | "unscheduled" | "unknown";
	concern: Concern | null;
	lastReview: ReviewRecord | null;
	retirement: Concern | null;
	problems: string[];
};

export function isDate(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().slice(0, 10) === value
	);
}

export function isReviewPolicy(value: unknown): value is ReviewPolicy {
	return value === "on-change" || value === "before-use";
}

function boundedText(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= max &&
		!/[\uD800-\uDFFF\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
	);
}

function reviewRecord(value: unknown, kind: "concern" | "confirmation"): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const fields = value as Record<string, unknown>;
	const keys = kind === "confirmation" ? ["date", "digest", "sources"] : ["date", "reason", "sources"];
	return (
		Object.keys(fields).length === keys.length &&
		keys.every((key) => Object.hasOwn(fields, key)) &&
		isDate(fields.date) &&
		boundedText(fields.sources, 1500) &&
		(kind === "confirmation"
			? typeof fields.digest === "string" && /^[a-f0-9]{64}$/.test(fields.digest)
			: boundedText(fields.reason, 600))
	);
}

function reviewFieldValid(key: (typeof REVIEW_KEYS)[number], value: unknown): boolean {
	if (key === "review_policy") return isReviewPolicy(value);
	if (key === "review_after") return value === null || isDate(value);
	return value === null || reviewRecord(value, key === "last_review" ? "confirmation" : "concern");
}

export function reviewMetadataProblems(meta: Record<string, unknown>): string[] {
	const problems: string[] = [];
	for (const key of REVIEW_KEYS) {
		if (!Object.hasOwn(meta, key)) continue;
		if (!reviewFieldValid(key, meta[key])) problems.push(`Invalid ${key}`);
	}
	if (problems.length === 0) {
		const added = Object.fromEntries(
			REVIEW_KEYS.filter((key) => Object.hasOwn(meta, key)).map((key) => [key, meta[key]]),
		);
		if (Buffer.byteLength(JSON.stringify(added)) > MAX_REVIEW_BYTES) problems.push("Review metadata exceeds 4 KiB");
	}
	return problems;
}

/** A mutable owned field must stand alone; parsing it cannot depend on another key or change one. */
export function independentField(
	header: string,
	key: string,
	meta: Record<string, unknown>,
): { start: number; end: number; newline: string } | undefined {
	const matches = [...header.matchAll(new RegExp(`^${key}:[^\\r\\n]*(?:\\r?\\n|$)`, "gm"))];
	if (matches.length === 0 && !Object.hasOwn(meta, key)) return undefined;
	if (matches.length !== 1) throw new Error(`${key} requires an independent plain top-level key`);
	const match = matches[0];
	const line = match[0].replace(/\r?\n$/, "");
	const value = line.slice(key.length + 1).trim();
	if (!value || /^[&*!|>]/.test(value)) throw new Error(`${key} requires an independent plain top-level key`);
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(`---\n${line}\n---\n`);
		if (
			parsed.body !== "" ||
			Object.keys(parsed.frontmatter).length !== 1 ||
			!isDeepStrictEqual(parsed.frontmatter[key], meta[key])
		)
			throw new Error("Dependent field");
	} catch {
		throw new Error(`${key} requires an independent plain top-level key`);
	}
	return { start: match.index, end: match.index + match[0].length, newline: match[0].endsWith("\r\n") ? "\r\n" : "\n" };
}

type UsableField = (key: string) => boolean;

function readVerification(meta: Record<string, unknown>, usable: UsableField, today: string, problems: string[]) {
	let verified: boolean | null = null;
	let verifiedDate: string | null = null;
	if (usable("verified") && typeof meta.verified === "boolean") verified = meta.verified;
	else problems.push("Verification flag is missing or invalid");
	if (usable("verified_date") && (meta.verified_date === null || isDate(meta.verified_date)))
		verifiedDate = meta.verified_date as string | null;
	else problems.push("Verification date is missing or invalid");
	if (verified === true && verifiedDate === null) problems.push("Verified declaration lacks a valid date");
	if (verified === false && verifiedDate !== null) problems.push("Unverified declaration carries a date");
	if (verifiedDate !== null && verifiedDate > today) problems.push("Verification date is in the future");
	return { verified, verifiedDate };
}

function readReviewTiming(
	meta: Record<string, unknown>,
	usable: UsableField,
	today: string,
): Pick<Freshness, "policy" | "reviewAfter" | "deadline"> {
	const policy = !Object.hasOwn(meta, "review_policy")
		? "unclassified"
		: usable("review_policy") && isReviewPolicy(meta.review_policy)
			? meta.review_policy
			: "unknown";
	if (!Object.hasOwn(meta, "review_after")) return { policy, reviewAfter: null, deadline: "unscheduled" };
	if (!usable("review_after")) return { policy, reviewAfter: null, deadline: "unknown" };
	if (meta.review_after === null) return { policy, reviewAfter: null, deadline: "unscheduled" };
	if (isDate(meta.review_after))
		return { policy, reviewAfter: meta.review_after, deadline: meta.review_after <= today ? "due" : "not-due" };
	return { policy, reviewAfter: null, deadline: "unknown" };
}

function readReviewRecords(meta: Record<string, unknown>, usable: UsableField, result: Freshness): void {
	for (const [key, output] of [
		["review_flag", "concern"],
		["last_review", "lastReview"],
		["retirement", "retirement"],
	] as const) {
		if (!Object.hasOwn(meta, key) || !usable(key) || meta[key] === null) continue;
		if (!reviewRecord(meta[key], key === "last_review" ? "confirmation" : "concern")) continue;
		if (output === "lastReview") result.lastReview = meta[key] as ReviewRecord;
		else result[output] = meta[key] as Concern;
		if ((meta[key] as Concern).date > result.evaluatedOn) result.problems.push(`${key} date is in the future`);
	}
}

/** Dates describe declarations and review timing, never the truth of a stored claim. */
export function sourceFreshness(
	meta: Record<string, unknown> | undefined,
	header: string,
	today = new Date().toISOString().slice(0, 10),
): Freshness {
	const result: Freshness = {
		evaluatedOn: today,
		verified: null,
		verifiedDate: null,
		policy: "unknown",
		reviewAfter: null,
		deadline: "unknown",
		concern: null,
		lastReview: null,
		retirement: null,
		problems: [],
	};
	if (!meta || Buffer.byteLength(header) > MAX_HEADER_BYTES) {
		result.problems.push("Freshness requires a complete valid header within 8 KiB");
		return result;
	}
	result.problems.push(...reviewMetadataProblems(meta));
	const usable = (key: string) => {
		try {
			return independentField(header, key, meta) !== undefined;
		} catch {
			result.problems.push(`Ambiguous ${key}`);
			return false;
		}
	};
	Object.assign(result, readVerification(meta, usable, today, result.problems), readReviewTiming(meta, usable, today));
	readReviewRecords(meta, usable, result);
	return result;
}
