import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Host projection of the first interactive input, independent of declared intent. */
export const EFFORT_PURPOSE_ENTRY = "agent.effort-purpose";
export function purposeExcerpt(text: string): string {
	return Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 256).join("");
}

/** Only this extension's attributed input projection survives resume as observed input. */
export function retainedPurpose(session: Pick<SessionManager, "getLeafId" | "getEntry">): { text?: string; complete: boolean } {
	let id = session.getLeafId();
	for (let visited = 0; id !== null && visited < 256; visited++) {
		const entry = session.getEntry(id);
		if (!entry) return { complete: false };
		if (entry.type === "custom" && entry.customType === EFFORT_PURPOSE_ENTRY) {
			const data = entry.data as { source?: unknown; text?: unknown } | undefined;
			if (data?.source === "interactive" && typeof data.text === "string") {
				const text = purposeExcerpt(data.text);
				return text ? { text, complete: true } : { complete: false };
			}
		}
		id = entry.parentId;
	}
	return { complete: id === null };
}
