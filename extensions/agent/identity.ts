import { realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function canonicalAgentCwd(callerCwd: string, cwd?: string): string {
	const directory = realpathSync(resolve(callerCwd, cwd ?? "."));
	if (!statSync(directory).isDirectory()) throw new Error("Agent cwd must be a directory");
	return directory;
}

export function assertHandleCwd(handle: string, requested: string, retained: string): void {
	if (requested === retained) return;
	throw new Error(
		`@${handle} is retained in a different cwd: ${retained}. Requested cwd: ${requested}. ` +
			`Pass cwd: ${JSON.stringify(retained)} to reuse it, target @${handle} directly with agent_send or agent_brief(sessionId), or omit handle to create a local agent.`,
	);
}

export const HANDLE_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
export function handleSlug(value: unknown): string {
	if (typeof value !== "string" || value.length > 64 || !new RegExp(HANDLE_PATTERN, "u").test(value))
		throw new Error("handle requires a lowercase concern slug of 1..64 letters, digits, and single hyphens");
	return value;
}
/** The handle namespace is local to the selected catalog; creator and model do not change its address. */
export function handleStorageId(handle: string, catalogRoot: string): string {
	const hex = createHash("sha256")
		.update(`pi.agent.handle\u0000${realpathSync(catalogRoot)}\u0000${handleSlug(handle)}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/**
 * One thread storage per owner identity in the selected catalog. The address alone marks it: the
 * catalog record keeps the ordinary host metadata shape, so every host and manager can open it.
 */
export function threadStorageId(ownerId: string, catalogRoot: string): string {
	let root = resolve(catalogRoot);
	try {
		root = realpathSync(root);
	} catch {
		// A catalog that does not exist yet holds no storage; creation resolves the real path first.
	}
	const hex = createHash("sha256").update(`pi.agent.threads\u0000${root}\u0000${ownerId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function isThreadStorage(record: { storageId: string; ownerId?: string }, catalogRoot: string): boolean {
	return record.ownerId !== undefined && record.storageId === threadStorageId(record.ownerId, catalogRoot);
}
/** Explicit handles never fall through to fuzzy names or primary endpoints. */
export function targetIdentity(selector: string, catalogRoot?: string): string {
	if (!selector.startsWith("@")) return selector;
	if (catalogRoot === undefined) throw new Error("Handle resolution requires the host catalog namespace");
	return handleStorageId(selector.slice(1), catalogRoot);
}
