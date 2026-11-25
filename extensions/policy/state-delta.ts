import type { JsonValue } from "@earendil-works/chord/json";
import { isDeepStrictEqual } from "node:util";

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A rolling window drops a prefix and appends samples. Keep its surviving run in place.
function survivingRun(target: JsonValue[], next: JsonValue[], start: number, oldEnd: number, newEnd: number) {
	for (let from = start + 1; from < oldEnd; from++) {
		if (!isDeepStrictEqual(target[from], next[start])) continue;
		const length = Math.min(oldEnd - from, newEnd - start);
		let matched = 1;
		while (matched < length && isDeepStrictEqual(target[from + matched], next[start + matched])) matched++;
		if (matched === length) return { drop: from - start, length };
	}
}

function writeArray(target: JsonValue[], next: JsonValue[]): void {
	let start = 0;
	let oldEnd = target.length;
	let newEnd = next.length;
	while (start < oldEnd && start < newEnd && isDeepStrictEqual(target[start], next[start])) start++;
	while (oldEnd > start && newEnd > start && isDeepStrictEqual(target[oldEnd - 1], next[newEnd - 1])) {
		oldEnd--;
		newEnd--;
	}

	const run = start < newEnd ? survivingRun(target, next, start, oldEnd, newEnd) : undefined;
	if (run) {
		target.splice(start, run.drop);
		oldEnd -= run.drop;
		start += run.length;
	}

	for (; start < oldEnd && start < newEnd; start++) {
		if (!writeContents(target[start], next[start])) target[start] = next[start];
	}
	if (start < oldEnd || start < newEnd) target.splice(start, oldEnd - start, ...next.slice(start, newEnd));
}

/** Copy a detached observation value into compatible draft containers. Return false if the caller must replace it. */
export function writeContents(target: JsonValue | undefined, next: JsonValue): boolean {
	if (target === next) return true;
	if (Array.isArray(target) && Array.isArray(next)) {
		writeArray(target, next);
		return true;
	}
	if (!isObject(target) || !isObject(next)) return false;
	for (const key of Object.keys(target)) {
		if (!Object.hasOwn(next, key)) delete target[key];
	}
	for (const [key, value] of Object.entries(next)) {
		if (!Object.hasOwn(target, key) || !writeContents(target[key], value)) target[key] = value;
	}
	return true;
}
