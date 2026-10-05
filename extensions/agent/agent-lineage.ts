import type { Context } from "@earendil-works/chord";
import type { ConversationDocToken, ConversationId, JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";

const MAX_CREATED_AGENTS = 20;
const MAX_NAME_LENGTH = 160;

/** Creation provenance is separate from current work and authority. */
export const CreatedAgentsSchema = Type.Object({
	agents: Type.Array(Type.Object({
		identity: Type.String(),
		name: Type.Optional(Type.String({ maxLength: MAX_NAME_LENGTH + 1 })),
		kind: Type.Union([Type.Literal("conversation"), Type.Literal("storage")]),
	}, { additionalProperties: false }), { maxItems: MAX_CREATED_AGENTS }),
	omitted: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type CreatedAgents = Static<typeof CreatedAgentsSchema>;

type LineageChild = {
	readonly name?: string;
	readonly conversationId?: ConversationId;
	readonly foreignSessionId?: string;
};

/** Read creation records newest first; retained names do not describe live state. */
export async function readCreatedAgents<T extends JsonObject & { children: LineageChild[] }>(
	api: Pick<ToolExecutionApi, "snapshot">,
	childrenDoc: ConversationDocToken<T>,
	caller: { readonly storageId: string; readonly conversationId: ConversationId },
	context: Context,
): Promise<CreatedAgents | undefined> {
	const state = await api.snapshot(childrenDoc, caller.conversationId, context);
	const children = state?.children ?? [];
	if (children.length === 0) return undefined;
	const rows = children.slice(-MAX_CREATED_AGENTS).reverse().map((child) => ({
		identity: child.foreignSessionId ?? `${caller.storageId}:${child.conversationId}`,
		kind: child.foreignSessionId === undefined ? "conversation" as const : "storage" as const,
		...(child.name === undefined ? {} : { name: child.name.length > MAX_NAME_LENGTH ? `${child.name.slice(0, MAX_NAME_LENGTH)}…` : child.name }),
	}));
	return { agents: rows, omitted: children.length - rows.length };
}

export function renderCreatedAgents(created: CreatedAgents): string {
	const rows = created.agents.map((child) => {
		const kind = child.kind === "conversation" ? "conversation in this storage" : "storage with own host";
		return `- ${child.identity}${child.name === undefined ? "" : ` ${JSON.stringify(child.name)}`}: ${kind}`;
	});
	return ["Created agents (newest first; retained creation labels):", ...rows,
		...(created.omitted > 0 ? [`${created.omitted} more omitted.`] : [])].join("\n");
}
