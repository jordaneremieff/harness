import type { Context } from "@earendil-works/chord";
import type { ConversationDocToken, ConversationId, JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";

const MAX_CHILDREN = 20;
const MAX_NAME_LENGTH = 160;

type LineageChild = {
	readonly name?: string;
	readonly conversationId?: ConversationId;
	readonly foreignSessionId?: string;
};

/** Read the caller's retained child registry, in reverse creation order. */
export async function renderAgentLineage<T extends JsonObject & { children: LineageChild[] }>(
	api: Pick<ToolExecutionApi, "snapshot">,
	childrenDoc: ConversationDocToken<T>,
	caller: { readonly storageId: string; readonly conversationId: ConversationId },
	context: Context,
): Promise<string> {
	const state = await api.snapshot(childrenDoc, caller.conversationId, context);
	const children = state?.children ?? [];
	if (children.length === 0) return "";
	const rows = children.slice(-MAX_CHILDREN).reverse().map((child) => {
		const identity = child.foreignSessionId ?? `${caller.storageId}:${child.conversationId}`;
		const kind = child.foreignSessionId === undefined ? "native child conversation" : "storage with own host";
		const name = child.name === undefined ? "" : ` ${JSON.stringify(child.name.length > MAX_NAME_LENGTH ? `${child.name.slice(0, MAX_NAME_LENGTH)}…` : child.name)}`;
		return `- ${identity}${name}: ${kind}`;
	});
	const omitted = children.length - rows.length;
	return ["Your agents (newest first):", ...rows, ...(omitted > 0 ? [`${omitted} more omitted.`] : [])].join("\n");
}
