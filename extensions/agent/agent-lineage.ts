import type { Context } from "@earendil-works/chord";
import type { ConversationDocToken, ConversationId, JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";

const MAX_CHILDREN = 20;
const MAX_NAME_LENGTH = 160;

/** Tool projection only; native ownership remains in the caller's child document. */
export const AgentLineageSchema = Type.Object({
	children: Type.Array(Type.Object({
		identity: Type.String(),
		name: Type.Optional(Type.String({ maxLength: MAX_NAME_LENGTH + 1 })),
		kind: Type.Union([Type.Literal("native-child"), Type.Literal("storage")]),
	}, { additionalProperties: false }), { maxItems: MAX_CHILDREN }),
	omitted: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type AgentLineage = Static<typeof AgentLineageSchema>;

type LineageChild = {
	readonly name?: string;
	readonly conversationId?: ConversationId;
	readonly foreignSessionId?: string;
};

/** Read direct children in reverse creation order; names are retained creation labels, not live state. */
export async function readAgentLineage<T extends JsonObject & { children: LineageChild[] }>(
	api: Pick<ToolExecutionApi, "snapshot">,
	childrenDoc: ConversationDocToken<T>,
	caller: { readonly storageId: string; readonly conversationId: ConversationId },
	context: Context,
): Promise<AgentLineage | undefined> {
	const state = await api.snapshot(childrenDoc, caller.conversationId, context);
	const children = state?.children ?? [];
	if (children.length === 0) return undefined;
	const rows = children.slice(-MAX_CHILDREN).reverse().map((child) => ({
		identity: child.foreignSessionId ?? `${caller.storageId}:${child.conversationId}`,
		kind: child.foreignSessionId === undefined ? "native-child" as const : "storage" as const,
		...(child.name === undefined ? {} : { name: child.name.length > MAX_NAME_LENGTH ? `${child.name.slice(0, MAX_NAME_LENGTH)}…` : child.name }),
	}));
	return { children: rows, omitted: children.length - rows.length };
}

export function renderAgentLineage(lineage: AgentLineage): string {
	const rows = lineage.children.map((child) => {
		const kind = child.kind === "native-child" ? "native child conversation" : "storage with own host";
		return `- ${child.identity}${child.name === undefined ? "" : ` ${JSON.stringify(child.name)}`}: ${kind}`;
	});
	return ["Your agents (direct children, newest first; retained creation labels):", ...rows,
		...(lineage.omitted > 0 ? [`${lineage.omitted} more omitted.`] : [])].join("\n");
}
