/**
 * The operator's choice of one policy data action, shared by the ordinary `/policy` route and the
 * attached-terminal panel. It only builds the argument text the owner's data command parses; every
 * check and the change itself stay with that command.
 */

import type { RuleSnapshot } from "./local-rules.ts";

export interface DataArgumentDialogs {
	select(title: string, options: readonly string[]): Promise<string | undefined>;
	editor(title: string, initial: string): Promise<string | undefined>;
}

export const DATA_ACTIONS = ["list", "show", "set", "set-file", "remove"] as const;

/** A set request without `expectedRevision` binds to the revision of the named data the operator sees. */
export function supplyDataRevision(json: string, snapshot: RuleSnapshot): string {
	const supplied: unknown = JSON.parse(json);
	if (
		!supplied ||
		typeof supplied !== "object" ||
		Array.isArray(supplied) ||
		Object.hasOwn(supplied, "expectedRevision")
	)
		return json;
	const value = supplied as Record<string, unknown>;
	const data = value.data as { name?: unknown } | undefined;
	if (!data || typeof data.name !== "string") return json;
	return JSON.stringify({ ...value, expectedRevision: snapshot.data.get(data.name)?.revision ?? null });
}

async function dataEditor(dialogs: DataArgumentDialogs, action: "set" | "set-file", snapshot: RuleSnapshot): Promise<string | undefined> {
	const json = await dialogs.editor(
		action === "set" ? "Data JSON: data (current target revision is supplied)" : "Data file JSON: path",
		"",
	);
	if (!json?.trim()) return undefined;
	return `${action} ${action === "set" ? supplyDataRevision(json, snapshot) : json}`;
}

/**
 * Complete `supplied` into one data command: choose the action, the named data for show and remove
 * (remove binds the binding revision shown), or edit the JSON for set and set-file. Undefined cancels.
 */
export async function chooseDataArguments(dialogs: DataArgumentDialogs, supplied: string, snapshot: RuleSnapshot): Promise<string | undefined> {
	const args = supplied || (await dialogs.select("Policy data action", DATA_ACTIONS));
	if (!args) return undefined;
	if (args === "set" || args === "set-file") return dataEditor(dialogs, args, snapshot);
	const tokens = args.split(/\s+/);
	if (tokens[0] !== "show" && tokens[0] !== "remove") return args;
	if (!tokens[1]) {
		const name = await dialogs.select("Select policy data", [...snapshot.data.keys()]);
		if (!name) return undefined;
		tokens.push(name);
	}
	if (tokens[0] === "remove" && tokens.length === 2) {
		const binding = snapshot.data.get(tokens[1]);
		if (!binding) throw new Error(`No policy data named ${tokens[1]}.`);
		tokens.push(binding.revision);
	}
	return tokens.join(" ");
}
