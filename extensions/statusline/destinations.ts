/**
 * Consumer of the operator-destination announcements (docs/conventions/operator-panels.md).
 * Owners announce harmless browser destinations as data; this registry keeps them by id and
 * resolves each one to the current registration of its own command at the moment the menu
 * opens. Nothing here parses a description or infers a destination from a command name.
 */

import { realpathSync } from "node:fs";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export interface OperatorDestination {
	readonly id: string;
	readonly label: string;
	/** The owner's own command name as registered, before Pi adds a collision suffix. */
	readonly command: { readonly name: string; readonly args?: string };
	/** Resolved module path of the announcing extension; only its registration of the command counts. */
	readonly owner: string;
}

/** A destination as the menu shows it: either an exact current registration or the reason it cannot open. */
export interface ResolvedDestination extends OperatorDestination {
	readonly registration?: SlashCommandInfo;
	readonly unavailable?: string;
}

const MAX_LABEL = 24;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Accept one version-1 publication; a malformed entry is dropped, never guessed. */
export function readDestinations(value: unknown): OperatorDestination[] | undefined {
	if (!record(value) || value.version !== 1 || !Array.isArray(value.destinations)) return undefined;
	const destinations: OperatorDestination[] = [];
	for (const entry of value.destinations) {
		if (!record(entry) || typeof entry.id !== "string" || !ID.test(entry.id) || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > MAX_LABEL) continue;
		if (!record(entry.command) || typeof entry.command.name !== "string" || !entry.command.name || (entry.command.args !== undefined && typeof entry.command.args !== "string")) continue;
		if (typeof entry.owner !== "string" || !entry.owner) continue;
		destinations.push({ id: entry.id, label: entry.label.trim(), command: { name: entry.command.name, ...(entry.command.args === undefined ? {} : { args: entry.command.args }) }, owner: entry.owner });
	}
	return destinations;
}

export interface DestinationBus {
	on(event: string, handler: (value: unknown) => void): unknown;
	emit(event: string, value: unknown): unknown;
}

/** Subscribe before the request so both load orders meet; later publications replace entries by id. */
export function collectDestinations(bus: DestinationBus): () => OperatorDestination[] {
	const known = new Map<string, OperatorDestination>();
	bus.on("harness:operator-destination:publish", (value) => {
		for (const destination of readDestinations(value) ?? []) known.set(destination.id, destination);
	});
	bus.emit("harness:operator-destination:request", { version: 1 });
	return () => [...known.values()];
}

/** Pi appends `:<n>` to the invocation name when several extensions register one command name. */
function registeredName(invocationName: string): string {
	return invocationName.replace(/:\d+$/u, "");
}

/** Two module paths name one file when they are equal or resolve to the same real path. */
function samePath(left: string, right: string, real: Map<string, string>): boolean {
	if (left === right) return true;
	const resolve = (value: string) => {
		const known = real.get(value);
		if (known !== undefined) return known;
		let resolved = value;
		try { resolved = realpathSync(value); } catch { /* an unresolvable path only matches itself */ }
		real.set(value, resolved);
		return resolved;
	};
	return resolve(left) === resolve(right);
}

/**
 * Bind each destination to its owner's current registration of the named command, keeping Pi's
 * actual invocation name. No registration from the owner, or more than one, leaves the
 * destination listed as unavailable with the reason.
 */
export function resolveDestinations(destinations: readonly OperatorDestination[], commands: readonly SlashCommandInfo[]): ResolvedDestination[] {
	const real = new Map<string, string>();
	return destinations.map((destination) => {
		const owned = commands.filter((command) => command.source === "extension" && registeredName(command.name) === destination.command.name && samePath(command.sourceInfo.path, destination.owner, real));
		if (owned.length === 1) return { ...destination, registration: owned[0] };
		if (owned.length === 0) return { ...destination, unavailable: `/${destination.command.name} is not registered by its owner in this session` };
		return { ...destination, unavailable: `/${destination.command.name} is registered more than once by its owner` };
	});
}
