import { realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const REAL_ROOT_LIMIT = 64;
/**
 * Owners of one generation of the thread address memo. A scan over a catalog with at most this many
 * distinct owners hashes none of them again; a root keeps at most twice this number of addresses
 * (about 130 bytes each), and only a process that saw that many owners holds them.
 */
export const THREAD_ID_GENERATION = 65_536;
const realRoots = new Map<string, string>();

/**
 * A bounded memo that never empties at once: a full generation becomes the previous one, and a key
 * found there moves to the current one without a computation. Only a key in neither is computed.
 * A hit in the current generation is one map read.
 */
export class GenerationMemo<V> {
	private current = new Map<string, V>();
	private previous = new Map<string, V>();
	private readonly generation: number;
	constructor(generation: number) {
		this.generation = generation;
	}
	get(key: string, compute: () => V): V {
		const known = this.current.get(key);
		if (known !== undefined) return known;
		const value = this.previous.get(key) ?? compute();
		if (this.current.size >= this.generation) {
			this.previous = this.current;
			this.current = new Map();
		}
		this.current.set(key, value);
		return value;
	}
}
/** Thread storage addresses by owner, per catalog root path. */
const threadIds = new Map<string, GenerationMemo<string>>();
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
		// A catalog that does not exist yet holds no storage; an address that names a record comes from
		// the catalog after it made the directory.
		root = resolve(catalogRoot);
	}
	let memo = threadIds.get(root);
	if (memo === undefined) {
		if (threadIds.size >= REAL_ROOT_LIMIT) threadIds.clear();
		memo = new GenerationMemo(THREAD_ID_GENERATION);
		threadIds.set(root, memo);
	}
	return memo.get(ownerId, () => {
		const hex = createHash("sha256").update(`pi.agent.threads\u0000${root}\u0000${ownerId}`).digest("hex");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
	});
}
/** A scan over a whole catalog calls this once per record: after the first call per owner it reads three maps. */
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
/** Why an input that an earlier host admitted into a thread storage ends without an answer. */
export function threadStorageUnanswered(storageId: string, ownerId: string): string {
	return `${storageId} is a thread storage of ${ownerId}; it holds threads and runs no agent work, so this input started no run. Use agent_collaborate with a threadId it holds, or message its owner ${ownerId}`;
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
