import { redactCredentials } from "./credentials.ts";

function editDistance(left: string, right: string): number {
	let row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 0; i < left.length; i++) {
		const next = [i + 1];
		for (let j = 0; j < right.length; j++) {
			next.push(Math.min(row[j + 1] + 1, next[j] + 1, row[j] + Number(left[i] !== right[j])));
		}
		row = next;
	}
	return row[right.length];
}

function spellingSuggestion(key: string, allowed: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = 3;
	const lower = key.toLowerCase();
	for (const candidate of allowed) {
		const limit = candidate.length < 4 ? 1 : 2;
		if (Math.abs(lower.length - candidate.length) > limit) continue;
		const distance = editDistance(lower, candidate.toLowerCase());
		if (distance > limit || distance > bestDistance) continue;
		best = distance < bestDistance ? candidate : undefined;
		bestDistance = distance;
	}
	return best;
}

export function assertKnownArgumentKeys(
	input: unknown,
	allowed: readonly string[],
	path?: string,
): asserts input is Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new Error(`${path ?? "options"} must be an object`);
	}
	const unknown = Object.keys(input).find((key) => !allowed.includes(key));
	if (unknown === undefined) return;
	const prefix = path === undefined ? "" : `${path}.`;
	const key = redactCredentials(unknown).replace(/[\u007f-\u009f\p{Cf}\u2028\u2029]/gu, " ");
	const bounded = key.length > 80 ? `${key.slice(0, 80)}…` : key;
	const suggestion = key === unknown && unknown.length <= 80 ? spellingSuggestion(unknown, allowed) : undefined;
	throw new Error(
		`unknown option: ${JSON.stringify(prefix + bounded)}${suggestion === undefined ? "" : `. Did you mean ${JSON.stringify(prefix + suggestion)}?`}`,
	);
}
