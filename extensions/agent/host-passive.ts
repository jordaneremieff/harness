/** Read and observation operations protect an in-flight reply but do not keep a writer resident. */
const PASSIVE_HOST_OPERATIONS: ReadonlySet<string> = new Set([
	"receipts",
	"inspect",
	"status",
	"list",
	"profile-read",
	"profile-list",
	"timer-list",
	"dashboard",
	"snapshot",
	"observe-open",
	"observe-frame",
	"observe-close",
	"changes",
	"collaboration-list",
	"collaboration-read",
	"models",
]);

/** Unknown operations and explicit attachment are not passive. */
export function isPassiveHostOperation(method: string): boolean {
	return PASSIVE_HOST_OPERATIONS.has(method);
}
