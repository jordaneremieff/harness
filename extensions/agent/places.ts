/**
 * agent/places: durable bindings from a working area to the agent session that
 * owns it.
 *
 * A place is a directory plus the session that carries the reasoning about it.
 * The binding lives beside the sessions, so the same session answers for the
 * same area across primary sessions and machines restarts. Resolution is by
 * longest matching directory, so a session bound to a subdirectory wins over a
 * session bound to its parent.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** One area-to-session binding. */
export interface PlaceBinding {
	/** Absolute directory the session owns. */
	area: string;
	sessionId: string;
	/** Operator description of the concern; absent when none was given. */
	topic?: string;
	boundAt: string;
}

interface PlaceFile {
	places: PlaceBinding[];
}

function isBinding(value: unknown): value is PlaceBinding {
	const candidate = value as Partial<PlaceBinding> | null;
	return (
		!!candidate &&
		typeof candidate.area === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.boundAt === "string" &&
		(candidate.topic === undefined || typeof candidate.topic === "string")
	);
}

/** Directory containment: equal paths, or `path` inside `area`. */
function contains(area: string, path: string): boolean {
	return path === area || path.startsWith(area.endsWith(sep) ? area : area + sep);
}

/**
 * The bindings file for one agent store.
 *
 * Reads tolerate a damaged file by reporting no bindings: a place is a
 * convenience index over durable sessions, and refusing every session because
 * one JSON file is malformed is worse than rebinding.
 */
export class PlaceBook {
	readonly file: string;

	constructor(root: string) {
		this.file = join(root, "places.json");
	}

	read(): PlaceBinding[] {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		try {
			const parsed = JSON.parse(raw) as Partial<PlaceFile>;
			return Array.isArray(parsed.places) ? parsed.places.filter(isBinding) : [];
		} catch {
			return [];
		}
	}

	/** The binding whose area contains `path`, longest area first. */
	resolve(path: string): PlaceBinding | undefined {
		const target = resolve(path);
		return this.read()
			.filter((binding) => contains(binding.area, target))
			.sort((left, right) => right.area.length - left.area.length)[0];
	}

	/** The binding for exactly this area. */
	exact(area: string): PlaceBinding | undefined {
		const target = resolve(area);
		return this.read().find((binding) => binding.area === target);
	}

	bind(area: string, sessionId: string, topic?: string): PlaceBinding {
		const target = resolve(area);
		const binding: PlaceBinding = {
			area: target,
			sessionId,
			...(topic ? { topic } : {}),
			boundAt: new Date().toISOString(),
		};
		this.write([...this.read().filter((existing) => existing.area !== target), binding]);
		return binding;
	}

	unbind(area: string): PlaceBinding | undefined {
		const target = resolve(area);
		const current = this.read();
		const removed = current.find((binding) => binding.area === target);
		if (removed) this.write(current.filter((binding) => binding.area !== target));
		return removed;
	}

	private write(places: PlaceBinding[]): void {
		const ordered = [...places].sort((left, right) => left.area.localeCompare(right.area));
		mkdirSync(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ places: ordered } satisfies PlaceFile, null, 2)}\n`, "utf8");
		renameSync(temporary, this.file);
	}
}
