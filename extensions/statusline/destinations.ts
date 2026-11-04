/**
 * Consumer of the operator-destination announcements (docs/conventions/operator-panels.md).
 * Owners announce harmless browser destinations as data; this registry keeps them by id and
 * resolves each one to a current extension-command registration at the moment the menu opens.
 * Nothing here parses a description or infers a destination from a command name.
 */

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export interface OperatorDestination {
	readonly id: string;
	readonly label: string;
	readonly command: { readonly name: string; readonly args?: string };
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
		destinations.push({ id: entry.id, label: entry.label.trim(), command: { name: entry.command.name, ...(entry.command.args === undefined ? {} : { args: entry.command.args }) } });
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

/** Bind each destination to the exact current registration of its command; an absent one stays listed as unavailable. */
export function resolveDestinations(destinations: readonly OperatorDestination[], commands: readonly SlashCommandInfo[]): ResolvedDestination[] {
	return destinations.map((destination) => {
		const registration = commands.find((command) => command.source === "extension" && command.name === destination.command.name);
		return registration ? { ...destination, registration } : { ...destination, unavailable: `/${destination.command.name} is not registered in this session` };
	});
}
