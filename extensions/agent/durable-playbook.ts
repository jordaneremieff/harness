import { createHash } from "node:crypto";
import { defineDoc, defineDocFamily, type ConversationId, type section, type Tx } from "@earendil-works/pi-durable";
import { readPlaybookCatalog } from "./playbook-catalog.ts";
import { renderPlaybook, requirePlaybook } from "./playbook.ts";
import { playbookName } from "./playbook-files.ts";

export type NativePlaybook = { name: string | null; origin: "operator" | "creator" | "unset"; actor?: string };
export type NativePlaybookCreation = { ownerId: string; origin: "operator" | "model"; requestId: string; playbook: string };
export type PlaybookActor = { identity: string; origin: "operator" | "model" };
export const NativePlaybookDoc = defineDoc<NativePlaybook & { creation?: { requestId: string; value: NativePlaybook } }>({
	kind: "agent.playbook", version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false,
	initial: () => ({ name: null, origin: "unset" }),
});

export const NativePlaybookRequest = defineDocFamily<{ digest?: string; outcome?: string }, null>({
	kind: "agent.playbook-request", family: true, version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false,
	initial: () => ({}),
});

/** Keeps tool receipts separate from the existing child registry. */
export const NativeForeignSpawnReceipt = defineDocFamily<{ digest?: string; outcome?: string }, null>({
	kind: "agent.foreign-spawn-receipt", family: true, version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false,
	initial: () => ({}),
});

export function playbookRequestKey(requestId: string): string {
	return createHash("sha256").update(requestId).digest("hex");
}

export function projectNativePlaybook(value: NativePlaybook | undefined): NativePlaybook {
	if (value === undefined) return { name: null, origin: "unset" };
	return { name: value.name, origin: value.origin, ...(value.actor === undefined ? {} : { actor: value.actor }) };
}

export function nativePlaybookSelection(agentDir: string, name: string, actor: PlaybookActor, clearing: boolean): NativePlaybook {
	if (!playbookName(name) && !(clearing && name === "off")) throw new Error("Expected an exact playbook name");
	return { name: name === "off" ? null : requirePlaybook(readPlaybookCatalog(agentDir, { initialize: true }), name), origin: actor.origin === "operator" ? "operator" : "creator", actor: actor.identity };
}

export function nativePlaybookSection(register: typeof section, agentDir: string) {
	return register("agent-playbook", async (input, context) => {
		try {
			const name = (await input.read.snapshot(NativePlaybookDoc, input.conversationId, context))?.name;
			return name == null ? undefined : renderPlaybook(readPlaybookCatalog(agentDir), name);
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			return undefined;
		}
	});
}

export async function writeNativePlaybook(tx: Tx, id: ConversationId, value: NativePlaybook): Promise<void> {
	Object.assign(await tx.doc(NativePlaybookDoc, id), value);
}
