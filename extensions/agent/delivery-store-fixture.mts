import { onStoredCommit } from "./commit-observation.ts";
/** Native delivery mutations for fixtures that need exact retained or malformed rows. */
import type { Context } from "@earendil-works/chord/context";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import type { AgentDeliveryState } from "./durable-controls.ts";
import { deliveryState, readDeliveryDraft, writeDeliveryDraft } from "./delivery-store.ts";

export async function editDeliveryFixture<T>(tx: Tx, change: (state: AgentDeliveryState) => T | Promise<T>): Promise<T> {
	const state = await readDeliveryDraft(tx, true);
	const result = await change(state);
	await writeDeliveryDraft(tx, state);
	return result;
}

/** Observe actual native commits without depending on one document representation. */
export function waitForDeliveryFixture<T>(harness: Harness, context: Context, select: (state: AgentDeliveryState) => T | undefined): Promise<T> {
	return new Promise((resolve, reject) => {
		let checking = false, dirty = false, finished = false;
		let unsubscribe = () => {}, offClose = () => {};
		const finish = (outcome: { value: T } | { error: unknown }) => {
			if (finished) return;
			finished = true; unsubscribe(); offClose();
			if ("error" in outcome) reject(outcome.error); else resolve(outcome.value);
		};
		const check = async () => {
			if (checking) { dirty = true; return; }
			checking = true;
			try {
				do {
					dirty = false;
					const value = select(await deliveryState(harness, context, true));
					if (value !== undefined) { finish({ value }); return; }
				} while (dirty && !finished);
			} catch (error) { finish({ error }); }
			finally { checking = false; }
		};
		unsubscribe = onStoredCommit(harness, (publication) => { if (publication.changes.length) void check(); });
		offClose = harness.subscribeClose(() => finish({ error: new Error("Fixture harness closed before delivery") }));
		void check();
	});
}
