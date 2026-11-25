/** A creation prompt without text starts no work: the agent is created idle, as when the prompt is omitted. */
export function blankPrompt(prompt: unknown): boolean {
	return typeof prompt === "string" && prompt.trim() === "";
}

/** The input without a blank prompt. Request identities keep the input as given; only the work omits the prompt. */
export function withoutBlankPrompt<T extends { readonly prompt?: string }>(input: T): T {
	if (!blankPrompt(input.prompt)) return input;
	const { prompt: _prompt, ...idle } = input;
	return idle as T;
}

/** A prompt that starts work. */
export function startsWork(prompt: unknown): boolean {
	return prompt !== undefined && !blankPrompt(prompt);
}
