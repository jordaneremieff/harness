import { realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const REAL_ROOT_LIMIT = 64;
const THREAD_ID_LIMIT = 4096;
const realRoots = new Map<string, string>();
const threadIds = new Map<string, string>();
/**
 * The real path of a catalog root. A process keeps the first resolution of an absolute root, so an
 * identity check costs no filesystem call after it. A root that does not exist rejects and is not kept.
 */
function realCatalogRoot(catalogRoot: string): string {
	const known = realRoots.get(catalogRoot);
	if (known !== undefined) return known;
	const real = realpathSync(catalogRoot);
	if (isAbsolute(catalogRoot)) {
		if (realRoots.size >= REAL_ROOT_LIMIT) realRoots.clear();
		realRoots.set(catalogRoot, real);
	}
	return real;
}

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
		.update(`pi.agent.handle\u0000${realCatalogRoot(catalogRoot)}\u0000${handleSlug(handle)}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/**
 * One thread storage per owner identity in the selected catalog. The address alone marks it: the
 * catalog record keeps the ordinary host metadata shape, so every host and manager can open it.
 */
export function threadStorageId(ownerId: string, catalogRoot: string): string {
	let root: string;
	try {
		root = realCatalogRoot(catalogRoot);
	} catch {
		// A catalog that does not exist yet holds no storage; creation resolves the real path first.
		root = resolve(catalogRoot);
	}
	const key = `${root}\u0000${ownerId}`;
	const known = threadIds.get(key);
	if (known !== undefined) return known;
	const hex = createHash("sha256").update(`pi.agent.threads\u0000${key}`).digest("hex");
	const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
	if (threadIds.size >= THREAD_ID_LIMIT) threadIds.clear();
	threadIds.set(key, id);
	return id;
}
/** A scan over a whole catalog calls this once per record: after the first call per owner it reads two maps. */
export function isThreadStorage(record: { storageId: string; ownerId?: string }, catalogRoot: string): boolean {
	return record.ownerId !== undefined && record.storageId === threadStorageId(record.ownerId, catalogRoot);
}
/**
 * Host operations a thread storage serves: its threads, observation, the delivery state of its
 * notices, and stops. Every other operation would admit agent work or agent input into it.
 */
const THREAD_STORAGE_OPERATIONS: ReadonlySet<string> = new Set([
	"collaboration-list",
	"collaboration-read",
	"collaboration-mutate",
	"inspect",
	"status",
	"list",
	"snapshot",
	"dashboard",
	"models",
	"profile-read",
	"profile-list",
	"run-scope",
	"observe-open",
	"observe-frame",
	"observe-close",
	"changes",
	"recovery-state",
	"receipts",
	"acknowledge",
	"timer-list",
	"timer-cancel",
	"abort",
	"release",
	"run-stop",
	"request-cancel",
	"close",
]);
/** An attach that selects a model configures an agent; a plain attach only observes. */
export function threadStorageServes(operation: string, params?: { readonly model?: unknown }): boolean {
	return operation === "attach" ? params?.model === undefined : THREAD_STORAGE_OPERATIONS.has(operation);
}
export function threadStorageRefusal(storageId: string, ownerId: string): string {
	return `${storageId} is a thread storage of ${ownerId}; it holds threads and runs no agent work. Use agent_collaborate with a threadId it holds, or message its owner ${ownerId}`;
}
/** A route that names a thread storage as the recipient of an answer, a report or a notice. */
export function threadStorageRecipientRefusal(field: string, storageId: string, ownerId: string): string {
	return `${field} ${storageId} is a thread storage of ${ownerId}; it holds threads and receives no agent input. Name its owner ${ownerId} instead`;
}
/** Explicit handles never fall through to fuzzy names or primary endpoints. */
export function targetIdentity(selector: string, catalogRoot?: string): string {
	if (!selector.startsWith("@")) return selector;
	if (catalogRoot === undefined) throw new Error("Handle resolution requires the host catalog namespace");
	return handleStorageId(selector.slice(1), catalogRoot);
}
