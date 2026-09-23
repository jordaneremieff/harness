import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Package contract: docs/conventions/session-host-roles.md. A positive claim excludes primary registration. */
export function isManagedChild(bus: EventBus, sessionId: string): boolean {
	let claimed = false;
	const off = bus.on("harness:session-host:role", (data: unknown) => {
		if (!data || typeof data !== "object") return;
		const value = data as Record<string, unknown>;
		if (value.version === 1 && value.sessionId === sessionId && value.role === "managed-child") claimed = true;
	});
	try { bus.emit("harness:session-host:request", { version: 1, sessionId }); }
	finally { off(); }
	return claimed;
}
