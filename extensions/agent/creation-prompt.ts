/** A creation prompt without text starts no work: the agent is created idle, as when the prompt is omitted. */
export function blankPrompt(prompt: unknown): boolean {
	return typeof prompt === "string" && prompt.trim() === "";
}
