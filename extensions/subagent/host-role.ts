import { createEventBus } from "@earendil-works/pi-coding-agent";

/** Package contract: docs/conventions/session-host-roles.md. The native host owns this listener. */
export function createManagedHostBus(sessionId: string, ownsSession: () => boolean) {
	const bus = createEventBus();
	const dispose = bus.on("harness:session-host:request", (request: unknown) => {
		if (!request || typeof request !== "object") return;
		const value = request as Record<string, unknown>;
		if (value.version !== 1 || value.sessionId !== sessionId || !ownsSession()) return;
		bus.emit("harness:session-host:role", { version: 1, sessionId, role: "managed-child" });
	});
	return { bus, dispose };
}
