export function answerText(message: unknown, otherInputs = 0): string | undefined {
	if (message === null || typeof message !== "object") return;
	const result = message as { role?: unknown; stopReason?: unknown; content?: unknown };
	if (
		result.role !== "assistant" ||
		result.stopReason === "aborted" ||
		result.stopReason === "error" ||
		result.stopReason === "toolUse" ||
		!Array.isArray(result.content)
	)
		return;
	const text = result.content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.join("\n")
		.replace(/\u0000/g, "\uFFFD")
		.trim();
	if (!text) return;
	const shared =
		otherInputs > 0
			? `\n\n[This answer also addressed ${otherInputs} other ${otherInputs === 1 ? "input" : "inputs"}.]`
			: "";
	const limit = 4096;
	if (Buffer.byteLength(text + shared) <= limit) return text + shared;
	const marker = "\n\n[Answer truncated in Editor.]";
	let end = 0,
		remaining = limit - Buffer.byteLength(shared + marker);
	for (const character of text) {
		remaining -= Buffer.byteLength(character);
		if (remaining < 0) break;
		end += character.length;
	}
	return text.slice(0, end).trimEnd() + marker + shared;
}
