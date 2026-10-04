/** Host projection of the first interactive input, independent of declared intent. */
export const EFFORT_PURPOSE_ENTRY = "agent.effort-purpose";
export function purposeExcerpt(text: string): string {
	return Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 256).join("");
}

/** Only this extension's attributed input projection survives resume as observed input. */
export function retainedPurpose(entries: readonly unknown[]): { text?: string; complete: boolean } {
	for (const value of entries.slice(0, 256)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as { type?: unknown; customType?: unknown; data?: { source?: unknown; text?: unknown } };
		if (entry.type === "custom" && entry.customType === EFFORT_PURPOSE_ENTRY && entry.data?.source === "interactive" && typeof entry.data.text === "string") {
			const text = purposeExcerpt(entry.data.text);
			return text ? { text, complete: true } : { complete: false };
		}
	}
	return { complete: entries.length <= 256 };
}
