import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function savedTranscript(directory: string, sessionId: string): string {
	const file = join(directory, `${sessionId}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
	return file;
}
