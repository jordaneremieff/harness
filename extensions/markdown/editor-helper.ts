import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EDITOR_REQUEST_BYTES, editorWrite, type EditorOutcome } from "./editor-write.ts";

function invalid(message: string): EditorOutcome {
	return { version: 1, ok: false, outcome: "not-committed", error: { code: "invalid", message } };
}
/** One bounded JSON value on stdin and one JSON receipt on stdout. No caller-supplied command or parser path. */
export async function runEditorHelper(input: AsyncIterable<Uint8Array>, app: string): Promise<EditorOutcome> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of input) {
		size += chunk.byteLength;
		if (size > EDITOR_REQUEST_BYTES) return invalid("Editor request exceeds the byte limit.");
		chunks.push(chunk);
	}
	let request: unknown;
	try {
		request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		return invalid("Editor request must be one UTF-8 JSON value.");
	}
	return editorWrite(request, { app });
}

async function main(): Promise<void> {
	// The installed module lives in Contents/Resources/editor-writer.
	const app = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
	const receipt =
		process.argv.length === 2
			? await runEditorHelper(process.stdin, app)
			: invalid("The editor helper takes its request on stdin, not command arguments.");
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
	process.stdin.destroy();
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch(() => {
		process.stdout.write(
			`${JSON.stringify({ version: 1, ok: false, outcome: "unknown", error: { code: "store-failure", message: "The editor helper failed. Keep the draft and reconcile the save." } })}\n`,
		);
		process.exitCode = 1;
	});
}
